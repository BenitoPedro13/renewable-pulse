// Package ons fetches and normalizes ONS's "Geração de Usinas em Base
// Horária" dataset (docs/architecture.md §3).
//
// The dataset is not a queryable REST API — it's a monthly CSV file dump on
// S3, refreshed twice daily. There is no incremental-query endpoint; a poll
// cycle re-fetches the current month's whole file and the caller filters to
// new rows.
package ons

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// baseURL is the confirmed live URL pattern for the geracao-usina-2 dataset
// (docs/architecture.md §3, verified 2026-08-26):
// https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho/GERACAO_USINA-2_{YYYY}_{MM}.csv
const baseURL = "https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/geracao_usina_2_ho"

// YearlyFileCutoff is the first year ONS publishes as one file per
// month/year; every earlier year is published as a single whole-year file
// instead (confirmed live by probing S3 directly, 2026-08-28 —
// docs/tasks/TASK-historical-backfill.md §2.4: GERACAO_USINA-2_2000.csv
// through _2021.csv return 200, GERACAO_USINA-2_2021_12.csv returns 404,
// GERACAO_USINA-2_2022_01.csv returns 200). FetchMonth only ever fits the
// >=YearlyFileCutoff shape; a caller walking further back must use
// FetchYear instead.
const YearlyFileCutoff = 2022

// fetchRetryAttempts/fetchRetryDelay bound retrying a failed request. A live
// poll can just wait for next hour's tick on failure, but a backfill's
// hundreds of sequential monthly requests can't
// (docs/tasks/TASK-historical-backfill.md §2.1).
const (
	fetchRetryAttempts = 3
	fetchRetryDelay    = 2 * time.Second
)

// FetchMonth streams the CSV file for the given year/month. The caller must
// close the returned ReadCloser.
func FetchMonth(ctx context.Context, year int, month time.Month) (io.ReadCloser, error) {
	url := fmt.Sprintf("%s/GERACAO_USINA-2_%04d_%02d.csv", baseURL, year, int(month))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("ons: building request for %s: %w", url, err)
	}

	resp, err := doWithRetry(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("ons: fetching %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("ons: fetching %s: unexpected status %s", url, resp.Status)
	}

	return resp.Body, nil
}

// FetchYear streams the single whole-year CSV file ONS publishes for years
// before YearlyFileCutoff. The caller must close the returned ReadCloser.
func FetchYear(ctx context.Context, year int) (io.ReadCloser, error) {
	url := fmt.Sprintf("%s/GERACAO_USINA-2_%04d.csv", baseURL, year)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("ons: building request for %s: %w", url, err)
	}

	resp, err := doWithRetry(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("ons: fetching %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("ons: fetching %s: unexpected status %s", url, resp.Status)
	}

	return resp.Body, nil
}

// doWithRetry performs req, retrying up to fetchRetryAttempts times with
// exponential backoff on transport-level failure (a closed connection, a
// timeout) — the kind of transient error a sequential backfill run is far
// more likely to hit than one hourly live poll.
func doWithRetry(ctx context.Context, req *http.Request) (*http.Response, error) {
	delay := fetchRetryDelay
	var err error
	for attempt := 1; attempt <= fetchRetryAttempts; attempt++ {
		var resp *http.Response
		resp, err = http.DefaultClient.Do(req)
		if err == nil {
			return resp, nil
		}
		if attempt == fetchRetryAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
	return nil, err
}

// FetchCurrentMonth streams the CSV file for the current month, evaluated in
// the given location (docs/architecture.md §3 leaves ONS's own timestamp
// timezone as an open [VERIFY] — the poller's "current month" boundary uses
// whatever location the caller passes, typically saoPauloLocation from
// normalize.go, so the month rollover matches how recorded_at is
// interpreted).
func FetchCurrentMonth(ctx context.Context, loc *time.Location) (io.ReadCloser, error) {
	now := time.Now().In(loc)
	return FetchMonth(ctx, now.Year(), now.Month())
}
