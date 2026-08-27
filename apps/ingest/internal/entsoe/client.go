package entsoe

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// baseURL is ENTSO-E's Transparency Platform RESTful API
// (docs/architecture.md §3, confirmed via entsoe-py's real request-building
// code — the official user-guide pages returned 400/503 when checked live).
const baseURL = "https://web-api.tp.entsoe.eu/api"

// Zone is one ENTSO-E bidding zone this poller covers, pairing our
// canonical zone code with ENTSO-E's own EIC domain code.
type Zone struct {
	// Code is our canonical zone (e.g. "NO-NO1").
	Code string
	// EIC is ENTSO-E's in_Domain area code for this zone.
	EIC string
}

// Zones are the five Norwegian bidding zones plus the Netherlands' single
// bidding zone, all confirmed against entsoe-py's mappings.py
// (docs/tasks/TASK-entsoe-eia-pollers.md §1; NL added 2026-08-26, same
// source).
var Zones = []Zone{
	{Code: "NO-NO1", EIC: "10YNO-1--------2"},
	{Code: "NO-NO2", EIC: "10YNO-2--------T"},
	{Code: "NO-NO3", EIC: "10YNO-3--------J"},
	{Code: "NO-NO4", EIC: "10YNO-4--------9"},
	{Code: "NO-NO5", EIC: "10Y1001A1001A48H"},
	{Code: "NL", EIC: "10YNL----------L"},
}

const periodLayout = "200601021504"

// fetchRetryAttempts/fetchRetryDelay bound retrying a failed request. A live
// poll can just wait for next hour's tick on failure, but a backfill's
// hundreds of sequential per-zone requests can't
// (docs/tasks/TASK-historical-backfill.md §2.1).
const (
	fetchRetryAttempts = 3
	fetchRetryDelay    = 5 * time.Second
)

// FetchActualGeneration fetches document type A75 (Actual generation per
// type), process type A16 (Realised), for one EIC area code over
// [start, end).
func FetchActualGeneration(ctx context.Context, token, eicArea string, start, end time.Time) (*glMarketDocument, error) {
	q := url.Values{
		"securityToken": {token},
		"documentType":  {"A75"},
		"processType":   {"A16"},
		"in_Domain":     {eicArea},
		"periodStart":   {start.UTC().Format(periodLayout)},
		"periodEnd":     {end.UTC().Format(periodLayout)},
	}
	reqURL := baseURL + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("entsoe: building request: %w", err)
	}

	resp, err := doWithRetry(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("entsoe: fetching %s: %w", eicArea, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("entsoe: reading response body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("entsoe: fetching %s: unexpected status %s: %s", eicArea, resp.Status, body)
	}

	var ack acknowledgementMarketDocument
	if err := xml.Unmarshal(body, &ack); err == nil && ack.XMLName.Local == "Acknowledgement_MarketDocument" {
		return nil, fmt.Errorf("entsoe: %s rejected query: [%s] %s", eicArea, ack.Reason.Code, ack.Reason.Text)
	}

	var doc glMarketDocument
	if err := xml.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("entsoe: parsing response for %s: %w", eicArea, err)
	}
	return &doc, nil
}

// doWithRetry performs req, retrying up to fetchRetryAttempts times with
// exponential backoff on transport-level failure.
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
