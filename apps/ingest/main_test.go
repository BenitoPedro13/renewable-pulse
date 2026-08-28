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
	from := time.Date(2022, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2022, 3, 15, 0, 0, 0, 0, time.UTC)

	var visited []string
	origFetch := fetchAndPublishONSMonthFn
	fetchAndPublishONSMonthFn = func(_ context.Context, _ *publish.Publisher, year int, month time.Month, _ time.Time) (int, int, error) {
		visited = append(visited, time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).Format("2006-01"))
		return 0, 0, nil
	}
	t.Cleanup(func() { fetchAndPublishONSMonthFn = origFetch })

	failedChunks, err := backfillONS(context.Background(), nil, from, to, nil, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if failedChunks != 0 {
		t.Fatalf("want 0 failed chunks, got %d", failedChunks)
	}

	want := []string{"2022-03", "2022-02", "2022-01"}
	if len(visited) != len(want) {
		t.Fatalf("visited %v, want %v", visited, want)
	}
	for i := range want {
		if visited[i] != want[i] {
			t.Fatalf("visited %v, want %v", visited, want)
		}
	}
}

// TestBackfillONS_SkipsFailedChunkAndContinues confirms a single chunk's
// fetch error doesn't abort the rest of a — potentially hours-long,
// hundreds-of-chunks-long — backfill run: it's counted and logged, and the
// loop moves on to the next (older) month rather than returning early.
func TestBackfillONS_SkipsFailedChunkAndContinues(t *testing.T) {
	var visited []string
	origFetch := fetchAndPublishONSMonthFn
	fetchAndPublishONSMonthFn = func(_ context.Context, _ *publish.Publisher, year int, month time.Month, _ time.Time) (int, int, error) {
		key := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).Format("2006-01")
		visited = append(visited, key)
		if key == "2022-02" {
			return 0, 0, errors.New("boom")
		}
		return 0, 0, nil
	}
	t.Cleanup(func() { fetchAndPublishONSMonthFn = origFetch })

	from := time.Date(2022, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2022, 3, 15, 0, 0, 0, 0, time.UTC)
	failedChunks, err := backfillONS(context.Background(), nil, from, to, nil, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if failedChunks != 1 {
		t.Fatalf("want 1 failed chunk, got %d", failedChunks)
	}

	want := []string{"2022-03", "2022-02", "2022-01"}
	if len(visited) != len(want) {
		t.Fatalf("visited %v, want %v (a failed chunk must not stop the walk)", visited, want)
	}
}

// TestBackfillONS_UsesYearlyFetchBelowCutoff confirms the walk fetches one
// whole year exactly once for every year below ons.YearlyFileCutoff,
// instead of re-requesting the same whole-year file up to twelve times over
// via the monthly path — the real bug found live against ONS's actual S3
// layout (docs/tasks/TASK-historical-backfill.md §2.4: 2000-2021 are
// published as one file per year, not per month).
func TestBackfillONS_UsesYearlyFetchBelowCutoff(t *testing.T) {
	var monthCalls []string
	var yearCalls []int

	origMonth := fetchAndPublishONSMonthFn
	fetchAndPublishONSMonthFn = func(_ context.Context, _ *publish.Publisher, year int, month time.Month, _ time.Time) (int, int, error) {
		monthCalls = append(monthCalls, time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).Format("2006-01"))
		return 0, 0, nil
	}
	t.Cleanup(func() { fetchAndPublishONSMonthFn = origMonth })

	origYear := fetchAndPublishONSYearFn
	fetchAndPublishONSYearFn = func(_ context.Context, _ *publish.Publisher, year int, _ time.Time) (int, int, error) {
		yearCalls = append(yearCalls, year)
		return 0, 0, nil
	}
	t.Cleanup(func() { fetchAndPublishONSYearFn = origYear })

	// Straddles the real 2022 cutoff: 2022's months walk monthly, then
	// crossing into 2021 (below the cutoff) switches to one yearly fetch —
	// which also covers everything requested down to `from`, so the walk
	// stops there rather than continuing to fetch 2020, 2019, etc.
	from := time.Date(2021, 6, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2022, 2, 15, 0, 0, 0, 0, time.UTC)
	failedChunks, err := backfillONS(context.Background(), nil, from, to, nil, time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if failedChunks != 0 {
		t.Fatalf("want 0 failed chunks, got %d", failedChunks)
	}

	wantMonths := []string{"2022-02", "2022-01"}
	if len(monthCalls) != len(wantMonths) {
		t.Fatalf("monthly calls = %v, want %v", monthCalls, wantMonths)
	}
	for i := range wantMonths {
		if monthCalls[i] != wantMonths[i] {
			t.Fatalf("monthly calls = %v, want %v", monthCalls, wantMonths)
		}
	}

	wantYears := []int{2021}
	if len(yearCalls) != len(wantYears) || yearCalls[0] != wantYears[0] {
		t.Fatalf("yearly calls = %v, want %v (exactly once for 2021, and the walk must stop there, not continue into 2020)", yearCalls, wantYears)
	}
}
