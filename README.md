# Infrastructure AWS as Code — VPC, ECS Fargate, ALB

Infrastructure cloud provisionnée en Terraform, déployée et testée sur AWS : réseau isolé, application conteneurisée sur ECS Fargate, exposée via un Application Load Balancer. Le déploiement est automatisé par un pipeline GitLab CI.

## Objectif du projet

Réalisé dans le cadre de ma préparation à un stage de fin d'études (PFE) en Cloud/DevOps. Le projet a volontairement un périmètre maîtrisable de bout en bout : chaque ressource, chaque choix et chaque incident rencontré peuvent être expliqués en détail.

## Application déployée

L'infrastructure héberge une API concrète plutôt qu'une image de démonstration générique : un petit tracker de candidatures de stage (Node.js/Express, connecté à PostgreSQL).

**Endpoints :**
- `GET /health` — vérification de santé, utilisée par le health check ALB/ECS (ne touche pas la base de données, pour ne pas faire échouer le health check sur un problème de connexion DB temporaire).
- `GET /applications` — liste les candidatures enregistrées.
- `POST /applications` — ajoute une candidature (`company`, `position`, `status`).
- `PATCH /applications/:id` — met à jour le statut d'une candidature.

La table est créée automatiquement au démarrage du conteneur si elle n'existe pas encore. L'application se connecte à PostgreSQL via `DATABASE_URL`, résolu en `localhost` grâce au partage d'interface réseau entre les deux conteneurs de la tâche ECS (voir plus bas).

## Architecture

```
                        Internet
                            │
                            ▼
                    ┌───────────────┐
                    │  ALB (public) │
                    └───────┬───────┘
                            │
        Sous-réseaux publics (2 AZ — exigence ALB)
                            │
              Sous-réseau privé (1 AZ)
                            │
                    ┌───────▼───────┐
                    │  ECS Fargate  │
                    │ ┌───────────┐ │
                    │ │    app    │ │
                    │ └─────┬─────┘ │
                    │       │       │
                    │ ┌─────▼─────┐ │
                    │ │ postgres  │ │
                    │ └───────────┘ │
                    └───────────────┘
```

- **VPC** avec un sous-réseau privé (application) et deux sous-réseaux publics dans deux zones de disponibilité différentes.
- **Internet Gateway** pour le trafic du sous-réseau public.
- **NAT Gateway** pour permettre au sous-réseau privé de sortir vers internet (pull d'images Docker) sans être joignable depuis l'extérieur.
- **ALB (Application Load Balancer)**, seul point d'entrée du trafic.
- **ECS Fargate** : une tâche unique contenant deux conteneurs — `app` et `postgres` — qui communiquent via `localhost` grâce au mode réseau `awsvpc`.
- **CloudWatch Logs** pour les deux conteneurs.

## Pourquoi ces choix

### Un seul fichier Terraform, sans modules
Le code est volontairement regroupé dans un seul `main.tf` plutôt que découpé en modules réutilisables. Pour un projet à un seul environnement, ça garde le code simple à lire et à expliquer intégralement, sans couche d'abstraction supplémentaire.

### État Terraform local
Pas de backend S3 distant pour cette version : l'état reste local, ce qui convient à un projet porté par une seule personne, sans travail d'équipe concurrent à gérer.

### Deux sous-réseaux publics (deux AZ)
Contrainte imposée par AWS, pas un choix : un Application Load Balancer doit être réparti sur au moins deux zones de disponibilité différentes. Le sous-réseau privé (application) reste sur une seule AZ, suffisant pour ce projet.

### ECS Fargate plutôt qu'EC2
Fargate supprime la gestion de serveurs (patchs, dimensionnement) : on décrit uniquement le conteneur et ses ressources, AWS gère l'exécution.

### Deux security groups distincts (ALB / ECS)
Le security group de l'ALB accepte le trafic HTTP public. Le security group des tâches ECS n'accepte que le trafic **venant du security group de l'ALB**, jamais d'une plage IP directe.

### PostgreSQL en conteneur, dans la même tâche ECS
Les deux conteneurs partagent la même tâche ECS et donc la même interface réseau (`network_mode = "awsvpc"`), ce qui permet à `app` de joindre `postgres` via `localhost:5432`. Un `healthCheck` sur `postgres` et une dépendance `dependsOn: HEALTHY` sur `app` garantissent que la base est prête avant que l'application ne démarre.

**Limite connue :** les données Postgres ne sont pas persistées au-delà du cycle de vie de la tâche (pas de volume EFS attaché).

### Authentification AWS par clé d'accès
Le pipeline GitLab CI s'authentifie auprès d'AWS via une paire de clés d'accès stockée en variables CI protégées et masquées.

## Pipeline CI/CD (GitLab CI)

```
fmt_check / validate ──► plan ──► apply (manuel)
```

- **`fmt_check`** : vérifie que le code est formaté (`terraform fmt -check`).
- **`validate`** : vérifie la cohérence syntaxique du code, sans contacter AWS.
- **`plan`** : calcule les changements à appliquer et sauvegarde le plan en artefact, pour que `apply` exécute exactement ce qui a été calculé.
- **`apply`** : déclenchement **manuel uniquement**, jamais automatique, pour éviter toute création d'infrastructure réelle sans validation humaine explicite.

## Déploiement réel et incidents rencontrés

Ce projet a été déployé pour de vrai sur AWS (pas seulement validé en théorie). Trois incidents concrets ont été rencontrés et résolus pendant ce déploiement :

**1. L'ALB a refusé de se créer** avec l'erreur `At least two subnets in two different Availability Zones must be specified`. AWS exige qu'un ALB soit réparti sur au moins deux zones de disponibilité, même si le reste de l'infrastructure n'en utilise qu'une. Correction : ajout d'un second sous-réseau public dans une seconde AZ.

**2. L'application renvoyait une erreur 502 Bad Gateway** après le premier déploiement réussi. Cause : décalage entre le port réellement écouté par le conteneur (`nginx` écoute sur le port 80) et le port configuré dans le security group, le target group et le mapping de port (réglés sur 8080 par erreur). Correction : alignement de toute la chaîne sur le port 80.

**3. Un conflit est apparu en modifiant le port du target group** : AWS refuse de changer le port d'un target group existant, donc Terraform devait le recréer — mais tentait de détruire l'ancien avant que le listener et le service ECS ne soient reconfigurés pour utiliser le nouveau, provoquant une erreur `ResourceInUse`. Correction : ajout d'un bloc `lifecycle { create_before_destroy = true }` sur le target group, et renommage (`tg-dev` → `tg-dev-v2`) pour éviter un conflit de nom pendant la transition.

Après ces corrections, le test de bout en bout a confirmé le bon fonctionnement de la chaîne complète : requête HTTP vers l'ALB → routage vers ECS → réponse du conteneur applicatif.

**4. Le port a changé une seconde fois (8080 → 80 → 8080), et ce n'est pas un aller-retour arbitraire.** La première correction (incident 2) avait aligné toute la chaîne sur le port 80, parce que le test initial utilisait l'image `nginx:latest`, qui écoute nativement sur ce port. Une fois `nginx` remplacé par l'API Node.js réellement développée pour ce projet (qui écoute sur 8080 via `process.env.PORT || 8080`), le port correct est redevenu 8080. La leçon generale, pas spécifique à un chiffre : **le port configuré dans Terraform (security group, target group, mapping de conteneur) doit toujours correspondre exactement au port réellement exposé par l'image utilisée**, pas à une valeur choisie par convention avant de vérifier le code ou le Dockerfile de l'application.

### Confirmation du déploiement de l'application réelle

Après le passage de `nginx:latest` à l'image réelle de l'API (`pfe-tracker`), l'infrastructure a été redéployée (`terraform apply`) avec cette image, et testée de bout en bout via l'ALB — pas seulement l'image placeholder :

```bash
curl http://<alb_dns_name>/health
# {"status":"ok"}

curl -X POST http://<alb_dns_name>/applications \
  -H "Content-Type: application/json" \
  -d '{"company":"EXEMPLE SA","position":"Stage PFE DevOps"}'

curl http://<alb_dns_name>/applications
```

Le trafic a été confirmé fonctionnel sur toute la chaîne (Internet → ALB → target group → tâche ECS → conteneur `app` → conteneur `postgres` via `localhost`), avec une écriture et une lecture réelles en base de données — pas seulement un `200 OK` générique. L'infrastructure a ensuite été détruite (`terraform destroy`) pour éviter les coûts du NAT Gateway en dehors des phases de test.

## Structure des dépôts

Le code applicatif et l'infrastructure sont séparés, chacun dans son propre dépôt.

**`tf_aws_infra/` (ce dépôt) :**
```
tf_aws_infra/
├── main.tf
├── variables.tf
├── terraform.tfvars         # valeurs réelles (non commité)
├── terraform.tfvars.example # exemple de valeurs à fournir
├── .gitlab-ci.yml
└── README.md
```

**`app/` (code applicatif) :**
```
app/
├── server.js
├── package.json
├── Dockerfile
└── .dockerignore
```

## Reproduire ce projet

```bash
cp terraform.tfvars.example terraform.tfvars
# éditer terraform.tfvars avec vos propres valeurs
terraform init
terraform plan
terraform apply
```

**Détruire l'infrastructure** (recommandé après chaque session de test, pour limiter les coûts — notamment la NAT Gateway, facturée en continu) :
```bash
terraform destroy
```

## Améliorations possibles

- Modules Terraform réutilisables et état distant (S3 + verrouillage), pour un contexte multi-environnements ou multi-personnes.
- Authentification OIDC entre GitLab CI et AWS, à la place de la clé d'accès.
- Scan de sécurité IaC (Checkov).
- Base de données managée (RDS) à la place de PostgreSQL conteneurisé.
- HTTPS sur l'ALB (certificat ACM) une fois un nom de domaine disponible.

## Stack technique

Terraform · AWS (VPC, ECS Fargate, ALB, IAM, CloudWatch) · Docker · GitLab CI · Node.js/Express · PostgreSQL