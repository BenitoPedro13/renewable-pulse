terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
  }

  # Bucket created by ../bootstrap. Native S3 lockfile locking (no DynamoDB table).
  backend "s3" {
    bucket       = "renewable-pulse-tfstate-860897618882"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "renewable-pulse"
      ManagedBy = "terraform"
      Stack     = "prod"
    }
  }
}
