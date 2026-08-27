package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/publish"
)

func TestEIALookbackCoversFiveDayOverlap(t *testing.T) {
	if eiaLookback < 5*24*time.Hour {
		t.Fatalf("eiaLookback = %s, want at least five days", eiaLookback)
	}
}

func TestParseISODate(t *testing.T) {
	got, err := parseISODate("2018-11-04")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := time.Date(2018, 11, 4, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestParseISODate_RejectsUnparseableInput(t *testing.T) {
	if _, err := parseISODate("not-a-date"); err == nil {
		t.Fatal("want error for unparseable input, got nil")
	}
}

func TestRateLimitDelayOrDefault(t *testing.T) {
	if got := rateLimitDelayOrDefault(0, 2*time.Second); got != 2*time.Second {
		t.Fatalf("want fallback when unset, got %s", got)
	}
	if got := rateLimitDelayOrDefault(5*time.Second, 2*time.Second); got != 5*time.Second {
		t.Fatalf("want operator override to win, got %s", got)
	}
}

// TestRunBackfill_RejectsUnknownSource confirms an unrecognized --backfill
// value fails fast with a clear error rather than silently doing nothing.
func TestRunBackfill_RejectsUnknownSource(t *testing.T) {
	err := runBackfill(context.Background(), nil, "not-a-real-source", "2020-01-01", "", "", 0)
	if err == nil {
		t.Fatal("want error for unknown --backfill source, got nil")
	}
}

func TestRunBackfill_RequiresCredentialEnvVars(t *testing.T) {
	t.Setenv("ENTSOE_API_TOKEN", "")
	t.Setenv("EIA_API_KEY", "")

	if err := runBackfill(context.Background(), nil, "entsoe", "2020-01-01", "", "", 0); err == nil {
		t.Fatal("want error when ENTSOE_API_TOKEN is unset, got nil")
	}
	if err := runBackfill(context.Background(), nil, "eia", "2020-01-01", "", "", 0); err == nil {
		t.Fatal("want error when EIA_API_KEY is unset, got nil")
	}
}

// TestBackfillONS_WalksBackwardMonthlyThroughFrom confirms the ONS backfill
// driver visits exactly the inclusive [from, to] month range, newest to
// oldest, without needing a real network call — fetchAndPublishONSMonth is
// exercised indirectly via a from/to range narrow enough that any off-by-one
// in the loop boundary shows up as a wrong number of HTTP attempts.
func TestBackfillONS_StopsAtFloorMonthInclusive(t *testing.T) {
	from := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2000, 3, 15, 0, 0, 0, 0, time.UTC)

	var visited []string
	origFetch := fetchAndPublishONSMonthFn
	fetchAndPublishONSMonthFn = func(_ context.Context, _ *publish.Publisher, year int, month time.Month, _ time.Time) (int, int, error) {
		visited = append(visited, time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).Format("2006-01"))
		return 0, 0, nil
	}
	t.Cleanup(func() { fetchAndPublishONSMonthFn = origFetch })

	if err := backfillONS(context.Background(), nil, from, to, nil, time.Millisecond); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{"2000-03", "2000-02", "2000-01"}
	if len(visited) != len(want) {
		t.Fatalf("visited %v, want %v", visited, want)
	}
	for i := range want {
		if visited[i] != want[i] {
			t.Fatalf("visited %v, want %v", visited, want)
		}
	}
}

func TestBackfillONS_PropagatesFetchError(t *testing.T) {
	origFetch := fetchAndPublishONSMonthFn
	fetchAndPublishONSMonthFn = func(context.Context, *publish.Publisher, int, time.Month, time.Time) (int, int, error) {
		return 0, 0, errors.New("boom")
	}
	t.Cleanup(func() { fetchAndPublishONSMonthFn = origFetch })

	from := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2000, 1, 15, 0, 0, 0, 0, time.UTC)
	if err := backfillONS(context.Background(), nil, from, to, nil, time.Millisecond); err == nil {
		t.Fatal("want error to propagate from a failed chunk, got nil")
	}
}
