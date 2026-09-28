# Secret *names* only (TASK-aws-infra.md §2.6). Terraform creates each parameter with a
# placeholder and then ignores its value; the real values are set once from the Mac with
# `aws ssm put-parameter --overwrite`, so secret values never land in Terraform state.
# infra/aws/deploy.sh reads the whole path at deploy time into a root-only env file.

locals {
  ssm_prefix = "/renewable-pulse/prod"

  secret_names = toset([
    "ENTSOE_API_TOKEN",
    "EIA_API_KEY",
    "POSTGRES_PASSWORD",
  ])
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secret_names

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "SecureString" # encrypted with the AWS-managed aws/ssm key (no KMS charge)
  value = "UNSET"

  lifecycle {
    ignore_changes = [value]
  }
}
