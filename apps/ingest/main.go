// Command ingest polls ONS's generation-by-plant dataset and publishes
// normalized readings to Redpanda's "readings" topic
// (docs/tasks/TASK-ingest-spine.md).
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/ons"
	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/publish"
)

func main() {
	once := flag.Bool("once", false, "poll a single time and exit, instead of running on an interval")
	flag.Parse()

	brokers := envList("REDPANDA_BROKERS", []string{"localhost:19092"})
	topic := envString("READINGS_TOPIC", "readings")
	interval := envDuration("POLL_INTERVAL", time.Hour)
	maxInFlight := envInt("MAX_IN_FLIGHT", 64)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pub, err := publish.New(brokers, topic, maxInFlight)
	if err != nil {
		log.Fatalf("ingest: %v", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := pub.Close(closeCtx); err != nil {
			log.Printf("ingest: closing publisher: %v", err)
		}
	}()

	if err := poll(ctx, pub); err != nil {
		log.Printf("ingest: poll failed: %v", err)
	}
	if *once {
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := poll(ctx, pub); err != nil {
				log.Printf("ingest: poll failed: %v", err)
			}
		}
	}
}

// poll fetches the current month's ONS file, normalizes every row, and
// publishes each successfully-normalized reading. Rows that fail to
// normalize (unmapped generation type, unparseable value) are logged and
// skipped rather than blocking the rest of the file — the same posture
// Phase 2's DLQ formalizes downstream (docs/architecture.md §5).
func poll(ctx context.Context, pub *publish.Publisher) error {
	body, err := ons.FetchCurrentMonth(ctx, ons.Location)
	if err != nil {
		return err
	}
	defer body.Close()

	ingestedAt := time.Now().UTC()
	var published, skipped int

	err = ons.ParseRows(body, func(row ons.Row) error {
		reading, normErr := ons.Normalize(row, ingestedAt)
		if normErr != nil {
			skipped++
			log.Printf("ingest: skipping row: %v", normErr)
			return nil
		}
		if pubErr := pub.Publish(ctx, reading); pubErr != nil {
			return pubErr
		}
		published++
		return nil
	})
	if err != nil {
		return err
	}

	log.Printf("ingest: poll complete: published=%d skipped=%d", published, skipped)
	return nil
}

func envString(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envList(key string, fallback []string) []string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return strings.Split(v, ",")
}

func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Printf("ingest: invalid %s=%q, using default %s", key, v, fallback)
		return fallback
	}
	return d
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		log.Printf("ingest: invalid %s=%q, using default %d", key, v, fallback)
		return fallback
	}
	return n
}
