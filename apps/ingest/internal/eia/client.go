// Package eia fetches and normalizes EIA's "electricity/rto/fuel-type-data"
// dataset (EIA-930 hourly balancing-authority generation by fuel type),
// covering the "US48" national aggregate plus seven RTO/ISO respondents for
// regional depth (docs/architecture.md §3, docs/tasks/TASK-live-dashboard.md
// §2.8).
package eia

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// baseURL is EIA's v2 Open Data API (docs/tasks/TASK-entsoe-eia-pollers.md
// §1, confirmed via RamiKrispin/EIAapi's real request examples — EIA's own
// documentation.php returned 503 when checked live). A var, not a const, so
// tests can point it at a local httptest server instead of the live API.
var baseURL = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/"

// Respondents are the EIA balancing-authority codes this poller covers:
// the US48 national aggregate (docs/tasks/TASK-entsoe-eia-pollers.md §1)
// plus seven RTO/ISO respondents added for USA regional depth mirroring
// ONS's five subsystems (docs/tasks/TASK-live-dashboard.md §2.8). All eight
// codes were confirmed live against EIA's own `facet/respondent/` metadata
// endpoint and a live data pull, not guessed. The other 76 respondent codes
// EIA exposes are either individual utilities or ambiguous geographic
// aggregates (e.g. "TEX", "SE") whose relationship to these named RTOs was
// not verified, so they are excluded.
var Respondents = []string{"US48", "CISO", "ERCO", "ISNE", "MISO", "NYIS", "PJM", "SWPP"}

// maxPageLength is EIA v2's per-request row cap.
const maxPageLength = 5000

const periodLayout = "2006-01-02T15"

// fetchRetryAttempts/fetchRetryDelay bound retrying a failed request. A live
// poll can just wait for next hour's tick on failure, but a backfill's many
// sequential paginated requests can't
// (docs/tasks/TASK-historical-backfill.md §2.1).
const (
	fetchRetryAttempts = 3
	fetchRetryDelay    = 3 * time.Second
)

type apiResponse struct {
	Response struct {
		Total string    `json:"total"`
		Data  []dataRow `json:"data"`
	} `json:"response"`
}

type dataRow struct {
	Period     string `json:"period"`
	Respondent string `json:"respondent"`
	FuelType   string `json:"fueltype"`
	Value      string `json:"value"`
}

// FetchFuelTypeData fetches hourly generation-by-fuel-type rows for every
// code in Respondents over [start, end), paginating with EIA's offset/length
// parameters since a multi-respondent, multi-day window can exceed one
// page (verified live: a single respondent's 5-day window alone returned
// 1089 rows, and EIA's facets[respondent][] accepts multiple values in one
// request).
func FetchFuelTypeData(ctx context.Context, apiKey string, start, end time.Time) ([]dataRow, error) {
	var all []dataRow
	offset := 0
	for {
		page, total, err := fetchPage(ctx, apiKey, start, end, offset)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		offset += len(page)
		if len(page) == 0 || offset >= total {
			break
		}
	}
	return all, nil
}

func fetchPage(ctx context.Context, apiKey string, start, end time.Time, offset int) ([]dataRow, int, error) {
	q := url.Values{
		"api_key":            {apiKey},
		"frequency":          {"hourly"},
		"data[0]":            {"value"},
		"start":              {start.UTC().Format(periodLayout)},
		"end":                {end.UTC().Format(periodLayout)},
		"sort[0][column]":    {"period"},
		"sort[0][direction]": {"desc"},
		"offset":             {strconv.Itoa(offset)},
		"length":             {strconv.Itoa(maxPageLength)},
	}
	for _, respondent := range Respondents {
		q.Add("facets[respondent][]", respondent)
	}
	reqURL := baseURL + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("eia: building request: %w", err)
	}

	resp, err := doWithRetry(ctx, req)
	if err != nil {
		return nil, 0, fmt.Errorf("eia: fetching fuel-type-data: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, fmt.Errorf("eia: reading response body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("eia: fetching fuel-type-data: unexpected status %s: %s", resp.Status, body)
	}

	var parsed apiResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, 0, fmt.Errorf("eia: parsing response: %w", err)
	}
	total, err := strconv.Atoi(parsed.Response.Total)
	if err != nil {
		return nil, 0, fmt.Errorf("eia: parsing response.total %q: %w", parsed.Response.Total, err)
	}
	return parsed.Response.Data, total, nil
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
