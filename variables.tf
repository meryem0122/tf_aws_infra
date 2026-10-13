variable "aws_region" {
  type    = string
  default = "eu-west-3"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zone" {
  type    = string
  default = "eu-west-3a"
}

variable "container_image" {
  description = "Image Docker à déployer"
  type        = string
  default     = "nginx:latest"
}