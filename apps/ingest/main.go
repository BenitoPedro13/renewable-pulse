// Command ingest polls ONS's generation-by-plant dataset and publishes
// normalized readings to Redpanda's "readings" topic
// (docs/tasks/TASK-ingest-spine.md). It also runs one-off historical
// backfills over the same pipeline (docs/tasks/TASK-historical-backfill.md).
package main

import (
	"context"
	"flag"
	"fmt"
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
	backfill := flag.String("backfill", "", `run a one-off historical backfill instead of live polling: "ons", "entsoe", or "eia" (docs/tasks/TASK-historical-backfill.md)`)
	backfillFrom := flag.String("backfill-from", "", "ISO date (YYYY-MM-DD), inclusive lower bound for --backfill; required with --backfill")
	backfillTo := flag.String("backfill-to", "", "ISO date (YYYY-MM-DD), upper bound for --backfill (default: now)")
	backfillResumeFrom := flag.String("backfill-resume-from", "", "ISO date (YYYY-MM-DD) to resume an interrupted --backfill from (overrides --backfill-to), set from the last logged chunk boundary")
	backfillRateLimitDelay := flag.Duration("backfill-rate-limit-delay", 0, "delay between --backfill chunk requests (default: a conservative provider-specific value)")
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

	if *backfill != "" {
		if *backfillFrom == "" {
			log.Fatalf("ingest: --backfill-from is required with --backfill")
		}
		if err := runBackfill(ctx, pub, *backfill, *backfillFrom, *backfillTo, *backfillResumeFrom, *backfillRateLimitDelay); err != nil {
			log.Fatalf("ingest: backfill failed: %v", err)
		}
		return
	}

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

// pollONS fetches the current month's ONS file and publishes it via
// fetchAndPublishONSMonthFn, the same helper the backfill driver uses.
func pollONS(ctx context.Context, pub *publish.Publisher) error {
	now := time.Now().In(ons.Location)
	ingestedAt := time.Now().UTC()

	published, skipped, err := fetchAndPublishONSMonthFn(ctx, pub, now.Year(), now.Month(), ingestedAt)
	if err != nil {
		return err
	}

	log.Printf("ingest: ons: poll complete: published=%d skipped=%d", published, skipped)
	return nil
}

// fetchAndPublishONSMonthFn is a var (not a plain function) so tests can
// swap in a stub and exercise the backfill driver's chunk-boundary logic
// without a real network call, the same seam eia's client_test.go uses for
// baseURL.
var fetchAndPublishONSMonthFn = fetchAndPublishONSMonth

// fetchAndPublishONSMonth fetches, normalizes, and publishes one calendar
// month of ONS data. Rows that fail to normalize (unmapped generation type,
// unparseable value, a DST-ambiguous timestamp) are logged and skipped
// rather than blocking the rest of the file — the same posture Phase 2's DLQ
// formalizes downstream (docs/architecture.md §5).
func fetchAndPublishONSMonth(ctx context.Context, pub *publish.Publisher, year int, month time.Month, ingestedAt time.Time) (published, skipped int, err error) {
	body, err := ons.FetchMonth(ctx, year, month)
	if err != nil {
		return 0, 0, err
	}
	defer body.Close()

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
	return published, skipped, err
}

// entsoeLookback bounds how far back each live ENTSO-E poll cycle looks —
// the idempotent upsert makes re-processing overlap safe (same posture as
// ONS's whole-month re-fetch, docs/architecture.md §3), so this only needs
// to be wide enough to survive one missed poll cycle without gapping data.
const entsoeLookback = 2 * time.Hour

// pollEntsoeFn returns a poller that fetches actual generation per type for
// every configured zone (entsoe.Zones) over a trailing window and publishes
// each successfully-normalized reading via fetchAndPublishEntsoeWindow, the
// same helper the backfill driver uses.
func pollEntsoeFn(token string) func(ctx context.Context, pub *publish.Publisher) error {
	return func(ctx context.Context, pub *publish.Publisher) error {
		ingestedAt := time.Now().UTC()
		end := ingestedAt
		start := end.Add(-entsoeLookback)

		var published, skipped int
		for _, zone := range entsoe.Zones {
			p, s, err := fetchAndPublishEntsoeWindow(ctx, pub, token, zone, start, end, ingestedAt)
			if err != nil {
				log.Printf("ingest: entsoe: fetching %s: %v", zone.Code, err)
				continue
			}
			published += p
			skipped += s
		}

		log.Printf("ingest: entsoe: poll complete: published=%d skipped=%d", published, skipped)
		return nil
	}
}

// fetchAndPublishEntsoeWindow fetches, normalizes, and publishes one zone's
// actual-generation-per-type data over [start, end).
func fetchAndPublishEntsoeWindow(ctx context.Context, pub *publish.Publisher, token string, zone entsoe.Zone, start, end, ingestedAt time.Time) (published, skipped int, err error) {
	doc, err := entsoe.FetchActualGeneration(ctx, token, zone.EIC, start, end)
	if err != nil {
		return 0, 0, err
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
	return published, skipped, pubErr
}

// eiaLookback uses the five-day overlap required by TASK-live-dashboard.md.
const eiaLookback = 5 * 24 * time.Hour

// pollEIAFn returns a poller that fetches hourly generation-by-fuel-type
// rows for every respondent in eia.Respondents over a trailing window and
// publishes each successfully-normalized reading via
// fetchAndPublishEIAWindow, the same helper the backfill driver uses.
func pollEIAFn(apiKey string) func(ctx context.Context, pub *publish.Publisher) error {
	return func(ctx context.Context, pub *publish.Publisher) error {
		ingestedAt := time.Now().UTC()
		end := ingestedAt
		start := end.Add(-eiaLookback)

		published, skipped, err := fetchAndPublishEIAWindow(ctx, pub, apiKey, start, end, ingestedAt)
		if err != nil {
			return err
		}

		log.Printf("ingest: eia: poll complete: published=%d skipped=%d", published, skipped)
		return nil
	}
}

// fetchAndPublishEIAWindow fetches, normalizes, and publishes every
// configured respondent's hourly generation-by-fuel-type rows over
// [start, end).
func fetchAndPublishEIAWindow(ctx context.Context, pub *publish.Publisher, apiKey string, start, end, ingestedAt time.Time) (published, skipped int, err error) {
	rows, err := eia.FetchFuelTypeData(ctx, apiKey, start, end)
	if err != nil {
		return 0, 0, err
	}

	for _, row := range rows {
		reading, normErr := eia.Normalize(row, ingestedAt)
		if normErr != nil {
			skipped++
			log.Printf("ingest: eia: skipping row: %v", normErr)
			continue
		}
		if pubErr := pub.Publish(ctx, reading); pubErr != nil {
			return published, skipped, pubErr
		}
		published++
	}

	return published, skipped, nil
}

// Default inter-chunk delays for --backfill-rate-limit-delay, used when the
// flag is unset (0). None of the three providers' exact rate limits are
// pinned down for this project's own usage; these are deliberately
// conservative starting points to observe real throttling behavior against
// during a pilot run, not measured guarantees (docs/tasks/
// TASK-historical-backfill.md §2.2):
//   - ENTSO-E: a static, per-token 400 req/min cap is documented; 1s between
//     per-zone chunk requests keeps sustained throughput far under that.
//   - EIA: no numeric limit found; a request already paginates internally,
//     so 2s between date-range chunks is conservative padding on top of that.
//   - ONS: a static S3 file GET, not a metered API, but backfilling ~25
//     years of monthly files is still hundreds of requests — 2s keeps it a
//     polite, sequential crawl rather than a burst.
const (
	onsDefaultBackfillDelay    = 2 * time.Second
	entsoeDefaultBackfillDelay = 1 * time.Second
	eiaDefaultBackfillDelay    = 2 * time.Second
)

// entsoeBackfillChunk and eiaBackfillChunk are both 30 days: ENTSO-E's A75
// document type accepts up to a year per request (verified against ENTSO-E's
// own Transparency Platform documentation, docs/tasks/
// TASK-historical-backfill.md §2.2), so 30 days is a wide safety margin, not
// the tightest chunk that still fits; EIA's 30-day choice mirrors the live
// poller's already-proven pagination headroom (§2.2).
const (
	entsoeBackfillChunk = 30 * 24 * time.Hour
	eiaBackfillChunk    = 30 * 24 * time.Hour
)

const isoDateLayout = "2006-01-02"

func parseISODate(s string) (time.Time, error) {
	t, err := time.Parse(isoDateLayout, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing %q as an ISO date (YYYY-MM-DD): %w", s, err)
	}
	return t.UTC(), nil
}

func rateLimitDelayOrDefault(flagValue, fallback time.Duration) time.Duration {
	if flagValue > 0 {
		return flagValue
	}
	return fallback
}

// runBackfill dispatches --backfill to the requested provider's driver.
// Every driver reuses the same fetch-normalize-publish helpers as live
// polling (docs/tasks/TASK-historical-backfill.md §2.1), walks newest to
// oldest so an interrupted run always leaves a strictly more useful dataset
// than before it started, and logs one line per completed chunk so an
// operator can resume with --backfill-resume-from after a restart.
func runBackfill(ctx context.Context, pub *publish.Publisher, source, fromStr, toStr, resumeFromStr string, rateLimitDelay time.Duration) error {
	from, err := parseISODate(fromStr)
	if err != nil {
		return fmt.Errorf("--backfill-from: %w", err)
	}

	to := time.Now().UTC()
	if toStr != "" {
		to, err = parseISODate(toStr)
		if err != nil {
			return fmt.Errorf("--backfill-to: %w", err)
		}
	}

	var resumeFrom *time.Time
	if resumeFromStr != "" {
		t, err := parseISODate(resumeFromStr)
		if err != nil {
			return fmt.Errorf("--backfill-resume-from: %w", err)
		}
		resumeFrom = &t
	}

	var failedChunks int
	switch source {
	case "ons":
		failedChunks, err = backfillONS(ctx, pub, from, to, resumeFrom, rateLimitDelayOrDefault(rateLimitDelay, onsDefaultBackfillDelay))
	case "entsoe":
		token := os.Getenv("ENTSOE_API_TOKEN")
		if token == "" {
			return fmt.Errorf("ENTSOE_API_TOKEN must be set for --backfill=entsoe")
		}
		failedChunks, err = backfillEntsoe(ctx, pub, token, from, to, resumeFrom, rateLimitDelayOrDefault(rateLimitDelay, entsoeDefaultBackfillDelay))
	case "eia":
		apiKey := os.Getenv("EIA_API_KEY")
		if apiKey == "" {
			return fmt.Errorf("EIA_API_KEY must be set for --backfill=eia")
		}
		failedChunks, err = backfillEIA(ctx, pub, apiKey, from, to, resumeFrom, rateLimitDelayOrDefault(rateLimitDelay, eiaDefaultBackfillDelay))
	default:
		return fmt.Errorf(`unknown --backfill=%q (want "ons", "entsoe", or "eia")`, source)
	}
	if err != nil {
		return err
	}
	log.Printf("ingest: %s: backfill complete, failed_chunks=%d", source, failedChunks)
	if failedChunks > 0 {
		log.Printf("ingest: %s: %d chunk(s) failed and were skipped — re-run with a narrow --backfill-from/--backfill-to to fill those gaps", source, failedChunks)
	}
	return nil
}

// sleepBetweenChunks pauses for delay, or returns ctx.Err() if the process
// is asked to stop first — so an operator's Ctrl+C / SIGTERM lands within
// one delay window instead of after the next chunk completes.
func sleepBetweenChunks(ctx context.Context, delay time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(delay):
	}
	return nil
}

// backfillONS walks backward one calendar month at a time from `to` (or
// resumeFrom, if set) down to `from`, inclusive. A single chunk's fetch
// failure is logged and skipped rather than aborting the whole run — over
// hundreds of chunks and hours of wall-clock time, an upstream provider's
// own transient hiccup (a timeout, a 5xx) is expected, not exceptional, and
// treating it as fatal would make a multi-hour backfill impossible to
// finish unattended. A skipped chunk just leaves a gap an operator can
// re-run later with a narrow --backfill-from/--backfill-to targeting it —
// the same "logged and skipped, never silently faked" posture the DLQ
// already applies to individual bad rows (docs/architecture.md §5).
func backfillONS(ctx context.Context, pub *publish.Publisher, from, to time.Time, resumeFrom *time.Time, delay time.Duration) (failedChunks int, err error) {
	cursor := to
	if resumeFrom != nil {
		cursor = *resumeFrom
	}
	floor := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC)

	for {
		chunkStart := time.Date(cursor.Year(), cursor.Month(), 1, 0, 0, 0, 0, time.UTC)
		if chunkStart.Before(floor) {
			return failedChunks, nil
		}

		ingestedAt := time.Now().UTC()
		published, skipped, fetchErr := fetchAndPublishONSMonthFn(ctx, pub, chunkStart.Year(), chunkStart.Month(), ingestedAt)
		if fetchErr != nil {
			failedChunks++
			log.Printf("ingest: ons: backfill chunk FAILED, skipping: month=%04d-%02d: %v", chunkStart.Year(), int(chunkStart.Month()), fetchErr)
		} else {
			log.Printf("ingest: ons: backfill chunk complete: month=%04d-%02d published=%d skipped=%d", chunkStart.Year(), int(chunkStart.Month()), published, skipped)
		}

		cursor = chunkStart.AddDate(0, -1, 0)
		if cursor.Before(floor) {
			return failedChunks, nil
		}
		if sleepErr := sleepBetweenChunks(ctx, delay); sleepErr != nil {
			return failedChunks, sleepErr
		}
	}
}

// backfillEntsoe walks every configured zone independently, backward in
// entsoeBackfillChunk windows from `to` (or resumeFrom, if set) down to
// `from`. A single chunk's fetch failure is logged and skipped rather than
// aborting the whole run — see backfillONS's doc comment for why.
func backfillEntsoe(ctx context.Context, pub *publish.Publisher, token string, from, to time.Time, resumeFrom *time.Time, delay time.Duration) (failedChunks int, err error) {
	end := to
	if resumeFrom != nil {
		end = *resumeFrom
	}

	for _, zone := range entsoe.Zones {
		cursor := end
		for cursor.After(from) {
			start := cursor.Add(-entsoeBackfillChunk)
			if start.Before(from) {
				start = from
			}

			ingestedAt := time.Now().UTC()
			published, skipped, fetchErr := fetchAndPublishEntsoeWindow(ctx, pub, token, zone, start, cursor, ingestedAt)
			if fetchErr != nil {
				failedChunks++
				log.Printf("ingest: entsoe: backfill chunk FAILED, skipping: zone=%s start=%s end=%s: %v", zone.Code, start.Format(time.RFC3339), cursor.Format(time.RFC3339), fetchErr)
			} else {
				log.Printf("ingest: entsoe: backfill chunk complete: zone=%s start=%s end=%s published=%d skipped=%d", zone.Code, start.Format(time.RFC3339), cursor.Format(time.RFC3339), published, skipped)
			}

			cursor = start
			if !cursor.After(from) {
				break
			}
			if sleepErr := sleepBetweenChunks(ctx, delay); sleepErr != nil {
				return failedChunks, sleepErr
			}
		}
	}
	return failedChunks, nil
}

// backfillEIA walks backward in eiaBackfillChunk windows from `to` (or
// resumeFrom, if set) down to `from`, across every configured respondent in
// one request per chunk (eia.FetchFuelTypeData already fans out
// facets[respondent][] in a single call). A single chunk's fetch failure is
// logged and skipped rather than aborting the whole run — see backfillONS's
// doc comment for why.
func backfillEIA(ctx context.Context, pub *publish.Publisher, apiKey string, from, to time.Time, resumeFrom *time.Time, delay time.Duration) (failedChunks int, err error) {
	cursor := to
	if resumeFrom != nil {
		cursor = *resumeFrom
	}

	for cursor.After(from) {
		start := cursor.Add(-eiaBackfillChunk)
		if start.Before(from) {
			start = from
		}

		ingestedAt := time.Now().UTC()
		published, skipped, fetchErr := fetchAndPublishEIAWindow(ctx, pub, apiKey, start, cursor, ingestedAt)
		if fetchErr != nil {
			failedChunks++
			log.Printf("ingest: eia: backfill chunk FAILED, skipping: start=%s end=%s: %v", start.Format(time.RFC3339), cursor.Format(time.RFC3339), fetchErr)
		} else {
			log.Printf("ingest: eia: backfill chunk complete: start=%s end=%s published=%d skipped=%d", start.Format(time.RFC3339), cursor.Format(time.RFC3339), published, skipped)
		}

		cursor = start
		if !cursor.After(from) {
			break
		}
		if sleepErr := sleepBetweenChunks(ctx, delay); sleepErr != nil {
			return failedChunks, sleepErr
		}
	}
	return failedChunks, nil
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
