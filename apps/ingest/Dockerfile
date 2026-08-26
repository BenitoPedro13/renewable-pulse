# Self-contained Go module — no monorepo/pnpm involvement, so the build
# context is just apps/ingest itself (Railway Root Directory = apps/ingest).
FROM golang:1.26-bookworm AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# franz-go is a pure-Go Kafka client — CGO_ENABLED=0 keeps the binary static
# so it can run on a distroless base with no libc dependency.
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/ingest .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/ingest /ingest
ENTRYPOINT ["/ingest"]
