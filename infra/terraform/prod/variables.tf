variable "region" {
  type    = string
  default = "us-east-1"
}

# Pinned, not "any AZ": the data volume is AZ-bound, and 1c had the lowest t4g.small Spot price
# when this was written (TASK-aws-infra.md §1).
variable "availability_zone" {
  type    = string
  default = "us-east-1c"
}

variable "instance_type" {
  type    = string
  default = "t4g.small"

  # Free-plan accounts: only types marked free-tier eligible (TASK-aws-infra.md §1). arm64
  # only, since the images are built for Graviton.
  validation {
    condition     = contains(["t4g.micro", "t4g.small"], var.instance_type)
    error_message = "Use a free-tier-eligible Graviton type (t4g.micro or t4g.small)."
  }
}

# false = On-Demand fallback (~USD 12.40/mo instead of ~USD 4-5/mo), e.g. if Spot capacity in
# the pinned AZ dries up.
variable "use_spot" {
  type    = bool
  default = true
}

# OS + Docker images (~3 GB for this stack) + 2 GiB swapfile, with headroom.
variable "root_volume_gb" {
  type    = number
  default = 12
}

# TimescaleDB + Redpanda data. Grows online (gp3 resize) if the disk alarm fires.
variable "data_volume_gb" {
  type    = number
  default = 20
}

variable "compose_version" {
  type    = string
  default = "v5.5.1"
}

# sha256 of docker-compose-linux-aarch64 for compose_version, from the release's .sha256 asset.
variable "compose_sha256" {
  type    = string
  default = "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7"
}

variable "ecr_repositories" {
  type    = set(string)
  default = ["ingest", "consumer", "api"]
}
