output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_eip.app.public_ip
}

output "ecr_repository_urls" {
  value = { for name, repo in aws_ecr_repository.app : name => repo.repository_url }
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "ssm_session_command" {
  description = "Open a shell on the instance (needs the session-manager-plugin installed)"
  value       = "aws ssm start-session --target ${aws_instance.app.id}"
}
