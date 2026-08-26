# Thin wrapper around the official image, solely to run as root on Railway.
# Railway provisions a fresh volume owned by root; the upstream image's
# declared USER redpanda (non-root) can't chown/mkdir into it on first boot
# (confirmed live: "Operation not permitted" even when the start command
# tries to chown it first — a non-root user can't chown a path it doesn't
# own). Local dev is unaffected — infra/docker-compose.yml still uses the
# upstream image directly, where Docker Desktop's volume handling doesn't
# hit this. See docs/tasks/TASK-railway-deploy.md §2.1.
#
# Pulled from Docker Hub (redpandadata/redpanda), not docker.redpanda.com —
# confirmed live that Railway's build fleet can't reach docker.redpanda.com
# at all (FROM docker.redpanda.com/... fails near-instantly with no build
# log output whatsoever); the same image is mirrored to Docker Hub, which
# Railway's builder can reach.
FROM redpandadata/redpanda:v26.2.2
USER root
