resource "aws_ecr_repository" "app" {
  for_each = var.ecr_repositories

  name = "renewable-pulse/${each.key}"

  # Tags are git SHAs (TASK-aws-infra.md §2.5); an immutable tag always means the same image.
  image_tag_mutability = "IMMUTABLE"

  # Lets the exit runbook's `terraform destroy` remove repos that still hold images.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}
