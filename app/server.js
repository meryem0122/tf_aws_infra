const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Création de la table au démarrage si elle n'existe pas
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      company TEXT NOT NULL,
      position TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Utilisé par le health check de l'ALB/target group
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Liste toutes les candidatures
app.get('/applications', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM applications ORDER BY applied_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Ajoute une nouvelle candidature
app.post('/applications', async (req, res) => {
  const { company, position, status } = req.body;
  if (!company || !position) {
    return res.status(400).json({ error: 'company and position are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO applications (company, position, status) VALUES ($1, $2, $3) RETURNING *',
      [company, position, status || 'sent']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Met à jour le statut d'une candidature
app.patch('/applications/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }
  try {
    const result = await pool.query(
      'UPDATE applications SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 8080;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });