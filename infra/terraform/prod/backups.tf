# Logical-dump bucket (TASK-aws-infra.md §2.7). Created in Phase 2 rather than Phase 5 because
# its first use is migrating the local database into this box. The nightly dump timer, the DLM
# snapshot policy, and the alarms still land in Phase 5.

resource "aws_s3_bucket" "backups" {
  bucket = "renewable-pulse-backups-${data.aws_caller_identity.current.account_id}"

  # The exit runbook (§2.9) downloads the last dump first; after that, destroying a bucket
  # that still holds objects is intended.
  force_destroy = true
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-nightly-dumps"
    status = "Enabled"

    filter {
      prefix = "pg/"
    }

    expiration {
      days = 14
    }
  }

  # One-off dumps (e.g. the local -> AWS migration) don't need to live forever either.
  rule {
    id     = "expire-migration-dumps"
    status = "Enabled"

    filter {
      prefix = "migration/"
    }

    expiration {
      days = 30
    }
  }
}
