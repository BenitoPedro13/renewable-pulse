# TASK-aws-infra

> Supersedes `docs/tasks/TASK-railway-deploy.md` (kept for history). Written 2026-09-27.

## 1. Current scenario

- **Railway is gone.** The ONS full-depth backfill filled the Railway TimescaleDB volume (5 GB,
  Postgres `53100 disk_full`). The database was deleted, and then the whole Railway project was
  deleted too. All backfilled history (ENTSO-E 2015→, EIA 2018-07→) is lost. It is re-fetchable
  from the providers; that is deferred and out of scope here.
- **Everything runs locally today** (verified 2026-09-27):
  - `infra/docker-compose.yml` (Redpanda + TimescaleDB on :5434)
  - `go run .` for `apps/ingest`
  - `pnpm dev` for `apps/consumer`
  - `pnpm dev` for `apps/api`, on **:3011**, because `apps/web/.env.local` points there
  - Live polling only: ~780k ONS rows, ~10k EIA, ~90 ENTSO-E. `dlqDepth=0`, `consumerLag=0`.
- **Leftover Railway artifacts:**
  - `.railway/` (plus an uncommitted 5000→20000 MB resize in `railway.ts`)
  - the `railway` devDependency in the root `package.json`
  - the `deploy` job in `.github/workflows/ci.yml`
  - the Railway comments in the four Dockerfiles
- **The user created a new AWS account and is staying on the Free plan** (decided 2026-09-27).
  Its terms drive this whole design, per
  [AWS Billing docs](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html):
  - **Credits:** USD 100 sign-up credit, plus up to USD 100 more from "Explore AWS" activities.
  - **The account closes automatically** after **6 months** or when credits run out, whichever
    comes first. Content is retained 90 days, then permanently deleted unless upgraded to Paid.
  - **Only "select services and features"** are available. For EC2, the instance types marked
    Free-tier eligible for accounts created on/after 2025-07-15 are `t3.micro`, `t3.small`,
    `t4g.micro`, `t4g.small`, `c7i-flex.large`, `m7i-flex.large`
    ([EC2 docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)).
  - **Resolved 2026-09-27, account `860897618882`:**
    - `describe-instance-types --filters Name=free-tier-eligible,Values=true` lists
      `c7i-flex.large m7i-flex.large t3.micro t3.small t4g.micro t4g.small t8i.micro t8i.small`.
    - `run-instances --dry-run` returned `DryRunOperation` ("would have succeeded") for
      `t4g.small` On-Demand and Spot, and also for `t4g.medium`.
    - Dry-run validates IAM permissions and parameters. It is not proof that the Free plan
      allows a non-eligible type at real launch time, so this design stays on the eligible
      `t4g.small`.
    - vCPU quotas: 5 for "Running On-Demand Standard instances" (`L-1216C47A`) and 5 for "All
      Standard Spot Instance Requests" (`L-34B43A08`). Enough for one 2-vCPU instance.
    - `t4g.small` Spot price over the last hour, per AZ: 1a 0.0064, 1b 0.0061, **1c 0.0055**,
      1d 0.0066, 1f 0.0089 USD/h. The data volume is AZ-bound, so the subnet is pinned to
      **us-east-1c**.
- **Tooling on the Mac:** `kubectl` is installed. There is no `aws` CLI, no `terraform`, and no
  `~/.aws`.
- **The repo is public** (`BenitoPedro13/renewable-pulse`), so GitHub's hosted arm64 runners are
  available free.

## 2. Planned changes

### 2.0 Shape of the target

One Graviton EC2 instance running the same services as local dev under Docker Compose, with
everything around it (network, IAM, storage, backups, alarms, CI identity) declared in Terraform.

```
                    GitHub Actions (OIDC, no stored AWS keys)
                      │  build arm64 images → ECR
                      │  deploy → SSM Run Command
                      ▼
 Vercel (web, Hobby) ──HTTPS/WSS──▶ EC2 t4g.small (us-east-1, public subnet, Elastic IP)
                                     ├─ caddy        :80/:443 (TLS, reverse proxy → api)
                                     ├─ api          (REST + /live)
                                     ├─ consumer     (persist group)
                                     ├─ ingest       (pollers)
                                     ├─ redpanda     (internal only)
                                     └─ timescaledb  (internal only; data on its own EBS volume)
                                           │
                     nightly pg_dump → S3 ─┤ DLM daily snapshots of the data volume
                                           │ weekly pull of the latest dump to the Mac
                     CloudWatch agent → alarms (disk, memory, status) → SNS email
```

**Deliberately not in this design**, each for a stated reason:

| Not used | Why |
|---|---|
| Kubernetes (k3s/EKS) | Measured locally: Redpanda ≈ 730 MiB and TimescaleDB ≈ 240 MiB idle. A 2 GiB box has no room for a k8s control plane. EKS costs ~USD 73/mo for the control plane alone. |
| RDS | RDS does not offer the TimescaleDB extension. `[VERIFY: re-check the current RDS PostgreSQL supported-extensions list before finalizing]` |
| MSK | Far beyond the budget. Redpanda runs on the box as it does locally. |
| NAT Gateway / ALB | Hourly-billed. The public subnet + security group + Caddy cover the same needs at USD 0. |
| SSH / port 22 | Shell access is SSM Session Manager only. No key pairs exist. |

Learning Kubernetes is a separate, optional, local-only track (k3d/kind on the Mac, reusing
these same images). It is not part of this task.

### 2.1 Cost model (us-east-1, prices checked 2026-09-27)

| Item | Unit price | Monthly |
|---|---|---|
| `t4g.small` Spot (2 vCPU, 2 GiB, arm64) | ~USD 0.007/h ([Vantage](https://instances.vantage.sh/aws/ec2/t4g.small?region=us-east-1), third-party, fluctuates) | ~USD 5.10 |
| — or On-Demand fallback | USD 0.017/h | ~USD 12.40 |
| Elastic IP (public IPv4, in use) | USD 0.005/h ([VPC pricing](https://aws.amazon.com/vpc/pricing/)) | USD 3.65 |
| EBS gp3: 12 GiB root + 20 GiB data | USD 0.08/GB-mo ([EBS pricing](https://aws.amazon.com/ebs/pricing/)) | USD 2.56 |
| EBS snapshots (7 daily, incremental) | USD 0.05/GB-mo | ~USD 0.50 |
| CloudWatch agent: 2 custom metrics | `[VERIFY: USD 0.30/metric-mo, and whether the always-free tier covers it]` | ≤ USD 0.60 |
| ECR (~1–2 GB after lifecycle policy) | `[VERIFY: USD 0.10/GB-mo]` | ≤ USD 0.20 |
| S3 backups (≤ 14 dumps, lifecycle-expired) | `[VERIFY]` | < USD 0.10 |
| Vercel Hobby (web) | free | USD 0 |
| **Total** | | **~USD 12 (Spot) / ~USD 19 (On-Demand)** |

- USD 100 lasts ~8 months on Spot or ~5 months On-Demand. The Free plan's 6-month cap binds
  first in the Spot case.
- The **§2.9 exit runbook runs by month 5**, whichever way.

### 2.2 Phase 0 — account hygiene (user, in the console, before any Terraform)

1. MFA on the root user (**done 2026-09-27**). Root is not used again after step 2.
2. **An IAM user, not IAM Identity Center.**
   - **Why not Identity Center:** on a standalone account, only an *organization instance* grants
     access to AWS accounts
     ([Identity Center docs](https://docs.aws.amazon.com/singlesignon/latest/userguide/identity-center-instances.html)),
     and that requires AWS Organizations. Joining Organizations **auto-upgrades a Free-plan
     account to Paid** (§1 billing docs).
   - **What to do instead:** create an IAM user `benito-admin` with console access,
     `AdministratorAccess`, and its own MFA.
   - **No access keys are ever created for it.** CLI access uses `aws login` (AWS CLI ≥ 2.32),
     which exchanges the console sign-in for auto-rotating short-lived credentials
     ([AWS Security Blog](https://aws.amazon.com/blogs/security/simplified-developer-access-to-aws-with-aws-login)).
3. AWS Budgets. **Done 2026-09-27 via CLI:** `renewable-pulse-monthly`, USD 20/month.
   - Email alerts to the account owner at ACTUAL > 50% / 85% / 100% and FORECASTED > 100%.
   - `CostTypes.IncludeCredit=false`, so it tracks gross usage. Otherwise credits net every
     alert to USD 0.
   - It is deliberately kept outside Terraform: the cost alarm must survive a
     `terraform destroy` or a broken state.
   - Creating a budget may also be one of the credit-earning "Explore AWS" activities; check
     that widget in the console.
4. Install the AWS CLI with the **official `.pkg` installer**, not Homebrew, and Terraform with
   `brew install hashicorp/tap/terraform`. Then run `aws login` signed in as `benito-admin`.
   - Why not Homebrew for the AWS CLI: on macOS 26.2, Homebrew's `awscli` (via its `python@3.14`
     3.14.7 bottle) fails at startup with `Symbol not found: _XML_SetAllocTrackerActivationThreshold`
     in `/usr/lib/libexpat.1.dylib`. The bottle was built against a newer system libexpat.
   - The official installer bundles its own Python. **Done 2026-09-27:** `aws-cli/2.37.4`, and
     `sts get-caller-identity` returns `user/benito-admin` with 0 access keys.
5. Run both `[VERIFY]` checks from §1 (Spot allowed, vCPU quota). Request a quota increase if
   needed.

### 2.3 Phase 1 — Terraform foundation

Layout:

```
infra/terraform/
  bootstrap/        # local state; creates only the remote-state bucket
    main.tf
  prod/             # remote state in that bucket
    versions.tf     # terraform + aws provider pins, S3 backend
    network.tf      # VPC, 1 public subnet, IGW, route table, security group
    compute.tf      # EC2, Elastic IP, data volume + attachment, IAM instance profile
    ecr.tf          # 3 repos (ingest, consumer, api) + lifecycle policy
    backups.tf      # S3 backup bucket + lifecycle, DLM snapshot policy
    observability.tf# SNS topic + email subscription, CloudWatch alarms
    github-oidc.tf  # OIDC provider + deploy role scoped to repo:BenitoPedro13/renewable-pulse:ref:refs/heads/main
    ssm.tf          # SSM parameter *names* only (values set out-of-band, see §2.6)
    user-data.sh.tftpl
    outputs.tf
```

**State.** An S3 backend with native lockfile locking (`use_lockfile = true`) instead of the
older DynamoDB lock table.
- `[VERIFY: against the current Terraform S3 backend docs. Native locking landed in 1.10, and
  DynamoDB locking was deprecated after that.]`
- The bucket has versioning on, public access blocked, and SSE-S3.

**Network.**
- A single-AZ VPC `10.20.0.0/16` with one public subnet `10.20.1.0/24` in `us-east-1c` (§1) and
  an internet gateway.
- Security group inbound: 80/tcp and 443/tcp from `0.0.0.0/0` (Caddy only). No other port.
- Outbound: all.
- Redpanda (9092) and Postgres (5432) are bound to the compose network only, never published on
  the host.

**Compute.**
- Instance: `aws_instance`, `t4g.small`, latest Amazon Linux 2023 arm64 AMI via SSM parameter
  `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`. The SSM agent comes
  preinstalled.
- `instance_market_options { market_type = "spot" spot_options { spot_instance_type =
  "persistent", instance_interruption_behavior = "stop" } }`. On interruption the instance
  **stops** (EBS kept) instead of terminating, and restarts when capacity returns.
- A variable `use_spot` (default `true`) removes that block for the On-Demand fallback.
- `metadata_options { http_tokens = "required" }` (IMDSv2 only).
- Root: 12 GiB gp3, encrypted, `delete_on_termination = true`. It holds the OS, Docker images
  (~3 GB for this stack), and a 2 GiB swapfile. 8 GiB left too little headroom.
- **Data: a separate 20 GiB gp3 `aws_ebs_volume`** attached as `/dev/sdf` and mounted at
  `/data`, with `lifecycle { prevent_destroy = true }`. Holds the TimescaleDB and Redpanda data
  dirs. Replacing or rebuilding the instance never touches the data.
- Elastic IP, so the API hostname stays stable across stop/start.
- Instance role:
  - `AmazonSSMManagedInstanceCore`
  - `AmazonEC2ContainerRegistryReadOnly`
  - `CloudWatchAgentServerPolicy`
  - an inline policy: `s3:PutObject`/`GetObject`/`ListBucket` on the backup bucket only, and
    `ssm:GetParameters` on `/renewable-pulse/prod/*` only

**user-data** (cloud-init, first boot):
1. Install Docker + the compose plugin and enable the service.
2. Create and enable the 2 GiB swapfile.
3. Format `/dev/sdf` only if it has no filesystem (`blkid` check, never an unconditional
   `mkfs`). Mount it at `/data` via an fstab entry with `nofail`.
4. Install and start the CloudWatch agent (§2.7).
5. Place `/opt/renewable-pulse/` (the compose file, a `deploy.sh`, and the backup script) from
   the repo's `infra/aws/`.

**ECR.**
- 3 repos: `renewable-pulse/ingest`, `/consumer`, `/api`. `web` is on Vercel, and Caddy uses the
  upstream image.
- `image_tag_mutability = IMMUTABLE`, scan on push.
- Lifecycle policy: keep the last 5 images.

### 2.4 Phase 2 — production compose on the box

`infra/aws/compose.prod.yml`. Local `infra/docker-compose.yml` stays unchanged for dev.

| Service | Image | Memory cap (`mem_limit`) | Notes |
|---|---|---|---|
| redpanda | `redpandadata/redpanda:v26.2.2` (same as local) | 700m | `--mode dev-container --smp 1 --memory 512M`; internal listener only. Dev mode enforces no memory minimum ([docs](https://docs.redpanda.com/current/reference/rpk/rpk-redpanda/rpk-redpanda-start/)). `[VERIFY: 512M holds under the hourly ONS burst of ~390k messages]` |
| timescaledb | `timescale/timescaledb:latest-pg17` → **pin a digest** | 450m | `TS_TUNE_MEMORY=400MB`, `TS_TUNE_NUM_CPUS=2`. `[VERIFY: env var names against the image README]` |
| consumer | ECR `consumer:<sha>` | 256m | |
| api | ECR `api:<sha>` | 256m | `PORT=3001`, `ALLOWED_ORIGINS=<vercel prod origin>` |
| ingest | ECR `ingest:<sha>` | 300m | `[VERIFY: peak RSS during an ONS poll on Linux via docker stats. Local macOS RSS was not a usable measurement.]` |
| caddy | `caddy:2` | 64m | Auto-HTTPS for the API hostname, reverse proxy to `api:3001`, WebSocket passthrough for `/live` |

- The caps sum to ~2 GiB, with the swapfile as a safety margin. Any service that is OOM-killed
  gets investigated and its cap raised deliberately, not silently.
- Every service has `restart: unless-stopped` and a healthcheck.
- **Secrets never appear in the compose file or the repo.** `deploy.sh` reads
  `/renewable-pulse/prod/*` from SSM at deploy time into a root-only env file
  (`/opt/renewable-pulse/.env`, mode 0600).

**API hostname: `renewable-pulse.duckdns.org`** (decided 2026-09-27). It needs HTTPS: the
Vercel page is HTTPS, so REST and `/live` must be `https://`/`wss://`.
- It is a free DuckDNS name whose A record was set once, by hand, to the EIP `52.5.78.81`. The
  EIP never changes, so no dynamic-DNS updater runs on the host.
- `duckdns.org` is on the Public Suffix List, so Let's Encrypt rate limits are per-name.
- Caddy issues standard 90-day certificates over HTTP-01.
- **Rejected along the way:**
  - `sslip.io` is *not* on the PSL, so its Let's Encrypt rate limit is shared by every user.
  - A Let's Encrypt **IP-address certificate** on the bare EIP (GA since 2026-01-15, shortlived
    profile only) was actually tried on Caddy 2.11.4 with `issuer acme { profile shortlived }`.
    The adapted JSON config did carry `"profile":"shortlived"`, and the HTTP-01 challenge
    validated from 5 vantage points. But finalize returned
    `403 urn:ietf:params:acme:error:unauthorized - authorizations for these identifiers not
    valid: 52.5.78.81`. Not pursued further.

### 2.5 Phase 3 — CI/CD

Replace the `deploy` job in `.github/workflows/ci.yml` (the `ts`/`go` jobs stay as-is).

1. **`images` job**
   - Runs after `ts` and `go`, on `main` pushes only.
   - `runs-on: ubuntu-24.04-arm`, a free native arm64 runner for public repos, so there is no
     QEMU emulation of the librdkafka node-gyp build.
   - Uses `aws-actions/configure-aws-credentials` with `role-to-assume` (OIDC,
     `permissions: id-token: write`). **No AWS keys stored in GitHub.**
   - Builds `ingest`/`consumer`/`api` with the existing Dockerfiles and pushes
     `:<git-sha>` to ECR.
2. **`deploy` job** runs
   `aws ssm send-command --document-name AWS-RunShellScript` on the tagged instance, executing
   `deploy.sh <git-sha>`, which:
   - logs in to ECR
   - pulls the new images
   - refreshes the env file from SSM
   - runs `docker compose up -d`
   - waits for `GET /pipeline-health` to return 200, and exits non-zero otherwise, which fails
     the job
3. **The OIDC trust policy** is conditioned on
   `token.actions.githubusercontent.com:sub = repo:BenitoPedro13/renewable-pulse:ref:refs/heads/main`.
   PRs and forks cannot assume it.
4. **Role permissions:**
   - ECR push on the 3 repos
   - `ssm:SendCommand` on that one instance and the `AWS-RunShellScript` document
   - `ssm:GetCommandInvocation`
5. **Terraform checks:** add a `terraform fmt -check` + `terraform validate` job, which needs no
   AWS credentials. `plan`/`apply` stay manual from the Mac for now, a deliberate choice for a
   single-operator project.

### 2.6 Phase 4 — secrets

- `/renewable-pulse/prod/ENTSOE_API_TOKEN`, `/EIA_API_KEY`, and `/POSTGRES_PASSWORD` are SSM
  `SecureString`s using the AWS-managed key.
- Terraform declares the names with `lifecycle { ignore_changes = [value] }` and a placeholder.
  The real values are set once from the Mac with `aws ssm put-parameter --overwrite`, so **secret
  values never land in Terraform state**.
- The Postgres password is new and random. The local `renewable_pulse/renewable_pulse` default
  is dev-only.

### 2.7 Phase 5 — backups, restore drill, monitoring

**Backups.** The Railway incident's root cause was having no backup and no alert, not the size
limit.

1. **Nightly logical dump.**
   - A systemd timer on the host runs `pg_dump -Fc` inside the timescaledb container, then
     uploads to `s3://<backup-bucket>/pg/<date>.dump`.
   - It follows TimescaleDB's documented backup procedure.
     `[VERIFY: the current docs for pg_dump of hypertables and
     timescaledb_pre_restore()/timescaledb_post_restore() on the restore side]`
   - S3 lifecycle expires dumps after 14 days.
2. **Snapshots.** A DLM policy takes daily snapshots of the data volume (by tag) and keeps 7.
3. **Off-AWS copy.** `scripts/pull-latest-backup.sh` runs from the Mac weekly and downloads the
   newest dump. This is mandatory given the Free plan's account-closure behavior (§1).
4. **Restore drill** (a verification step, not optional):
   - The *first* use of the restore procedure migrates today's local database (~780k rows) into
     AWS: `pg_dump` locally, upload, `pg_restore` on the box.
   - Afterwards, restore the latest S3 dump into a scratch container on the box and compare row
     counts per source.

**Monitoring.**
- The CloudWatch agent publishes `disk_used_percent` (for `/data`) and `mem_used_percent`.
- Alarms go to SNS email for:
  - `/data` disk ≥ 80%, the alarm Railway lacked
  - memory ≥ 90% for 10 min
  - `StatusCheckFailed` ≥ 1
  - `[VERIFY: an alarm or EventBridge rule on the Spot interruption warning / instance state
    change to "stopped", so a Spot stop is noticed]`

### 2.8 Phase 6 — web on Vercel + Railway cleanup

**Web on Vercel.**
- A Vercel project for `apps/web` (Hobby plan). `NEXT_PUBLIC_API_BASE_URL=https://<api host>`,
  plus `NEXT_PUBLIC_MAPBOX_TOKEN`.
- `ALLOWED_ORIGINS` on the API is set to the Vercel production origin.

**Railway cleanup.**
- Delete `.railway/` and the uncommitted `railway.ts` diff. The project it describes no longer
  exists.
- Remove the `railway` devDependency.
- Rewrite the Railway-specific comments in the four Dockerfiles.
- Mark `TASK-railway-deploy.md` as superseded at its top. It is not deleted.

### 2.9 Exit runbook (by account month 5)

1. Run `scripts/pull-latest-backup.sh`, then verify that the dump restores locally.
2. `terraform destroy` in `prod`. The data volume's `prevent_destroy` must be removed
   deliberately first. That friction is intended.
3. Empty and destroy the backup and state buckets (`bootstrap`).
4. Point `apps/web` on Vercel at a local or new API, or pause it.

Coming back later (new account or Paid plan) is `terraform apply` + restore. That is the payoff
of doing this as IaC.

## 3. Why

- **Why IaC.** Every resource is reviewable in Git, reproducible with `apply`, and removable with
  `destroy`. That last one matters concretely here: the account has a hard 6-month end date.
- **Why Terraform.** It is the most widely used IaC tool and is cloud-agnostic, so the skill
  transfers beyond AWS.
- **Why Compose on one box instead of Kubernetes.** Measured memory, not preference (§2.0). The
  professional practices that matter most here are all still present:
  - OIDC instead of stored keys
  - immutable, SHA-tagged images
  - secrets outside Git and outside state
  - separate data volume
  - tested restores
  - alarms before the disk fills
  - no SSH
- **Why Spot with `stop` interruption behavior.** It is less than half the On-Demand price. The
  persistent data volume and stop-not-terminate make an interruption a pause, not data loss.
  During a stop, EIA's 5-day poll lookback (`apps/ingest/main.go` `eiaLookback`) self-heals the
  gap. `[VERIFY: ONS and ENTSO-E live-poll lookback windows cover a multi-hour stop]`
- **Invariants kept.**
  - No synthetic data: nothing here generates readings.
  - Idempotent writes and the DLQ are unchanged.
  - `packages/contracts` is untouched.

## 4. Affected files

**New:**
- `infra/terraform/bootstrap/*`
- `infra/terraform/prod/*`
- `infra/aws/compose.prod.yml`
- `infra/aws/Caddyfile`
- `infra/aws/deploy.sh`
- `infra/aws/backup.sh` + its systemd unit/timer
- `infra/aws/cloudwatch-agent.json`
- `scripts/pull-latest-backup.sh`

**Modified:**
- `.github/workflows/ci.yml` (replace `deploy`, add `images` + terraform checks)
- `apps/{api,consumer,ingest,web}/Dockerfile` (comments only)
- root `package.json` (drop `railway`)
- `.gitignore` (`*.tfstate*`, `.terraform/`, `*.tfvars` except `*.tfvars.example`)
- `.env.example`, if any new var is read
- `README.md` (status + deploy section)
- `CLAUDE.md` (stack table: deploy target, and the Railway status line)
- `docs/architecture.md` (deployment section)
- `docs/tasks/TASK-railway-deploy.md` (superseded banner)

**Deleted:** `.railway/`.

## 5. Verification

Each phase is done only when its checks pass. "Works" is not a criterion.

- **Phase 0:**
  - `aws sts get-caller-identity` returns `arn:aws:iam::<id>:user/benito-admin`, not root.
  - IAM → Users → `benito-admin` → Security credentials shows 0 access keys.
  - Both §1 `[VERIFY]` quota/Spot checks are resolved and recorded in this doc.
- **Phase 1:**
  - `terraform plan` on a clean `prod` shows 0 changes after `apply`.
  - `aws ssm start-session --target <id>` opens a shell.
  - `nc -zv <eip> 22`, `5432`, and `9092` all fail from the Mac; 443 succeeds after Phase 2.
  - `findmnt /data` shows the separate volume.
  - `swapon --show` lists 2 GiB.
  - **Done 2026-09-27.**
    - `bootstrap` applied: 6 resources; its own state was migrated into the bucket
      (`bootstrap/terraform.tfstate`).
    - `prod` applied: 25 resources. `terraform plan` afterwards reports no changes.
    - Instance `i-044f3e0dad659d507` is `running`, lifecycle `spot`, in `us-east-1c`, behind
      EIP `52.5.78.81`. SSM ping status is `Online`.
    - On the host, via SSM Run Command: cloud-init `status: done`; `/data` is xfs on
      `/dev/nvme1n1` (20G); swapfile 2G; Docker 25.0.14 (AL2023 repo); Compose v5.5.1; root
      4.2G/12G used.
    - **Port checks from the dev Mac are not trustworthy.** `nc -z` reported *every* port open,
      including a random 47123, so something on the local network path accepts any TCP connect.
      The authoritative check is the security group's rules, via `describe-security-group-rules`:
      ingress tcp/80 and tcp/443 only, egress all.
    - sshd still listens on :22 on the host (the AL2023 default) but is unreachable (no SG
      rule). `[DECIDE: disable sshd via SSM as defense-in-depth]`
- **Phase 2:**
  - `docker compose ps` shows all 6 services healthy.
  - `curl https://<api host>/pipeline-health` returns `dlqDepth=0`, and `lastSuccessAt` is set
    for ONS, ENTSOE and EIA within one `POLL_INTERVAL`.
  - `docker stats` peak during an ONS poll is recorded here, per service, and no service has
    been OOM-killed (`docker inspect --format '{{.State.OOMKilled}}'`).
  - **Done 2026-09-27.** Image tag `ff8223501d754cb0aa0ce07dfbc8902a0fcbe283`, built on the
    Mac: native arm64, one-off before CI exists.
  - **Restore:**
    - Rehearsed first in a throwaway local container with the same image digest: 0
      `pg_restore` errors, and counts equal to the dump.
    - The rehearsal also caught the continuous-aggregate "concurrent refresh" race after
      `timescaledb_post_restore()`. `deploy.sh` now retries it, and it hit and passed that retry
      in prod too.
    - Prod restore of `migration/local-2026-09-27.dump` (8.5 MB): 0 errors; ONS 773,472,
      EIA 9,882, ENTSOE 220, identical to the dump.
  - **Services:**
    - All 6 are up; api, redpanda and timescaledb are `healthy`.
    - `/pipeline-health` shows `dlqDepth=0`, `consumerLag=0`, and a fresh `lastSuccessAt` for
      ONS, ENTSOE and EIA.
    - The consumer logged `persisted=41` of 64 on overlapping readings (idempotent upserts
      over restored rows, no duplicates).
  - **Memory after the first full poll cycle** (`docker stats`):

    | Service | Used / cap |
    |---|---|
    | redpanda | 198 / 700 MiB |
    | timescaledb | 207 / 450 MiB |
    | api | 84 / 256 MiB |
    | consumer | 61 / 256 MiB |
    | caddy | 37 / 96 MiB |
    | ingest | 12 / 300 MiB (idle, after the poll; the peak during an ONS poll is still unmeasured) |

    Host: 626 of 1841 MiB used, swap 6 MiB.
  - **External checks from the Mac:**
    - `https://renewable-pulse.duckdns.org/pipeline-health` returns 200.
    - The certificate is Let's Encrypt `YE2`, subject `CN=renewable-pulse.duckdns.org`, valid
      2026-09-27 to 2026-12-26.
    - `Access-Control-Allow-Origin: https://renewable-pulse.vercel.app`.
    - `wss://renewable-pulse.duckdns.org/live` opens and delivers a `heartbeat` frame.
  - **Browser `/live` failures after the Vercel switch (2026-09-28), diagnosed:**
    - **Cause: a browser extension (ad blocker) on the user's Chrome.** In an incognito
      window (no extensions) `/live` connects: api `req-eq`, no error.
    - Evidence the server was correct:
      - a WS upgrade with `Origin: https://renewable-pulse.vercel.app` returns 101, and one
        with a foreign origin returns 500 "Origin not allowed"
      - the same page's REST calls reach Caddy with the right Origin and get 200
      - the blocked WS attempts never appeared in Caddy's or the api's logs at all
    - Ruled out: HTTP/2 WebSockets (RFC 8441). Caddy's SETTINGS frame does not advertise
      `ENABLE_CONNECT_PROTOCOL` (0x8), so Chrome opens `/live` over HTTP/1.1.
    - Visitors whose blocker lists flag dynamic-DNS domains will hit the same thing. If that
      matters, the fix is a real domain instead of `duckdns.org`.
    - Two api "Origin not allowed" rejections at 00:37 predate Caddy's access log, so their
      Origin is unknown. The access log (now on) will show any recurrence.
  - **Caddyfile reload bug, fixed.**
    - The Caddyfile is a single-file bind mount. `remote-deploy.sh` replaces the file (new
      inode), which a running container never sees, so config edits silently didn't apply.
    - `deploy.sh` now writes `CADDYFILE_SHA256` into the env file, and `compose.prod.yml`
      passes it to caddy. Any content change recreates the container (verified: "Recreated").
  - **Follow-ups found:**
    - The api and consumer images are ~830 MB each (dev dependencies and the node-gyp toolchain
      ship in the runner stage). Slimming them is Phase 3 work.
    - The ECR lifecycle rule `tagStatus=any, keep 5` also counts the untagged child/attestation
      manifests of each image index. ECR never expires a manifest a tagged index still
      references, so this is safe but keeps fewer releases than intended. Change it to "5 tagged
      + expire untagged after 1 day" in Phase 3.
- **Phase 3:**
  - A push to `main` produces 3 ECR images tagged with that SHA.
  - The deploy job goes green and `/pipeline-health` still answers.
  - A PR run cannot assume the role: the OIDC step fails on a PR from a branch.
  - `grep -r AKIA .github` is empty.
- **Phase 4:**
  - `terraform show -json | grep -c <token prefix>` = 0.
  - The API and ingest read real tokens: ENTSO-E rows arrive.
- **Phase 5:**
  - Restored row counts per source equal the source counts at dump time.
  - A dump exists in S3 for each of 2 consecutive nights.
  - A test alarm (`aws cloudwatch set-alarm-state`) delivers an email.
  - `pull-latest-backup.sh` fetches a file that `pg_restore --list` reads.
- **Phase 6:**
  - The Vercel URL renders the dashboard with live data.
  - The browser console shows a `wss://` `/live` connection and no CORS errors.
  - `grep -ri railway` over the repo shows only the superseded banner and git history.
- **Cost:** after 7 days, Cost Explorer's daily run-rate × 30 is within ±30% of the §2.1 total.
