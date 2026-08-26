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

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/eia"
	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/entsoe"
	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
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

	pollers := buildPollers()

	pollAll(ctx, pub, pollers)
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
			pollAll(ctx, pub, pollers)
		}
	}
}

// namedPoller pairs a source name with its poll function, so pollAll can log
// which source failed without each poller repeating that boilerplate.
type namedPoller struct {
	name string
	poll func(ctx context.Context, pub *publish.Publisher) error
}

// buildPollers returns ONS's poller unconditionally, plus ENTSO-E's and
// EIA's only when their required credential env var is set — so local dev/
// CI keeps working on ONS alone while those credentials are pending
// (docs/tasks/TASK-entsoe-eia-pollers.md §2).
func buildPollers() []namedPoller {
	pollers := []namedPoller{{name: "ons", poll: pollONS}}

	if token := os.Getenv("ENTSOE_API_TOKEN"); token != "" {
		pollers = append(pollers, namedPoller{name: "entsoe", poll: pollEntsoeFn(token)})
	} else {
		log.Printf("ingest: ENTSOE_API_TOKEN not set, skipping ENTSO-E poller")
	}

	if apiKey := os.Getenv("EIA_API_KEY"); apiKey != "" {
		pollers = append(pollers, namedPoller{name: "eia", poll: pollEIAFn(apiKey)})
	} else {
		log.Printf("ingest: EIA_API_KEY not set, skipping EIA poller")
	}

	return pollers
}

func pollAll(ctx context.Context, pub *publish.Publisher, pollers []namedPoller) {
	for _, p := range pollers {
		if err := p.poll(ctx, pub); err != nil {
			log.Printf("ingest: %s poll failed: %v", p.name, err)
		}
	}
}

// pollONS fetches the current month's ONS file, normalizes every row, and
// publishes each successfully-normalized reading. Rows that fail to
// normalize (unmapped generation type, unparseable value) are logged and
// skipped rather than blocking the rest of the file — the same posture
// Phase 2's DLQ formalizes downstream (docs/architecture.md §5).
func pollONS(ctx context.Context, pub *publish.Publisher) error {
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
			log.Printf("ingest: ons: skipping row: %v", normErr)
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

	log.Printf("ingest: ons: poll complete: published=%d skipped=%d", published, skipped)
	return nil
}

// entsoeLookback bounds how far back each ENTSO-E poll cycle looks — the
// idempotent upsert makes re-processing overlap safe (same posture as ONS's
// whole-month re-fetch, docs/architecture.md §3), so this only needs to be
// wide enough to survive one missed poll cycle without gapping data.
const entsoeLookback = 2 * time.Hour

// pollEntsoeFn returns a poller that fetches actual generation per type for
// every Norwegian bidding zone (entsoe.Zones) over a trailing window and
// publishes each successfully-normalized reading.
func pollEntsoeFn(token string) func(ctx context.Context, pub *publish.Publisher) error {
	return func(ctx context.Context, pub *publish.Publisher) error {
		ingestedAt := time.Now().UTC()
		end := ingestedAt
		start := end.Add(-entsoeLookback)

		var published, skipped int
		for _, zone := range entsoe.Zones {
			doc, err := entsoe.FetchActualGeneration(ctx, token, zone.EIC, start, end)
			if err != nil {
				log.Printf("ingest: entsoe: fetching %s: %v", zone.Code, err)
				continue
			}

			var pubErr error
			entsoe.Normalize(doc, zone.Code, ingestedAt, func(reading event.Reading, normErr error) {
				if pubErr != nil {
					return
				}
				if normErr != nil {
					skipped++
					log.Printf("ingest: entsoe: skipping reading: %v", normErr)
					return
				}
				if err := pub.Publish(ctx, reading); err != nil {
					pubErr = err
					return
				}
				published++
			})
			if pubErr != nil {
				return pubErr
			}
		}

		log.Printf("ingest: entsoe: poll complete: published=%d skipped=%d", published, skipped)
		return nil
	}
}

// eiaLookback mirrors entsoeLookback's reasoning.
const eiaLookback = 2 * time.Hour

// pollEIAFn returns a poller that fetches hourly generation-by-fuel-type
// rows for eia.Respondent over a trailing window and publishes each
// successfully-normalized reading.
func pollEIAFn(apiKey string) func(ctx context.Context, pub *publish.Publisher) error {
	return func(ctx context.Context, pub *publish.Publisher) error {
		ingestedAt := time.Now().UTC()
		end := ingestedAt
		start := end.Add(-eiaLookback)

		rows, err := eia.FetchFuelTypeData(ctx, apiKey, start, end)
		if err != nil {
			return err
		}

		var published, skipped int
		for _, row := range rows {
			reading, normErr := eia.Normalize(row, ingestedAt)
			if normErr != nil {
				skipped++
				log.Printf("ingest: eia: skipping row: %v", normErr)
				continue
			}
			if pubErr := pub.Publish(ctx, reading); pubErr != nil {
				return pubErr
			}
			published++
		}

		log.Printf("ingest: eia: poll complete: published=%d skipped=%d", published, skipped)
		return nil
	}
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
