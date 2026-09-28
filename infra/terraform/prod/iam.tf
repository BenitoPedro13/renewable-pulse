# Instance role. Scoped to what Phase 1 needs: SSM (Session Manager + Run Command for deploys)
# and pulling images from ECR. Backup-bucket and CloudWatch-agent permissions are added by their
# own phases (TASK-aws-infra.md §2.7), not preemptively.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "renewable-pulse-app"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Read this stack's own SSM secrets (decryption with the AWS-managed aws/ssm key is granted by
# that key's policy for calls made through SSM, so no kms:Decrypt statement is needed), and
# read/write the backup bucket only.
data "aws_iam_policy_document" "app_inline" {
  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*", "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}"]
  }

  statement {
    sid       = "ListBackupBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }

  statement {
    sid       = "ReadWriteBackups"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
}

resource "aws_iam_role_policy" "app_inline" {
  name   = "renewable-pulse-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app_inline.json
}

resource "aws_iam_instance_profile" "app" {
  name = "renewable-pulse-app"
  role = aws_iam_role.app.name
}
