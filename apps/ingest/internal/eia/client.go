// Package eia fetches and normalizes EIA's "electricity/rto/fuel-type-data"
// dataset (EIA-930 hourly balancing-authority generation by fuel type),
// scoped to the "US48" national aggregate respondent
// (docs/architecture.md §3).
package eia

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// baseURL is EIA's v2 Open Data API (docs/tasks/TASK-entsoe-eia-pollers.md
// §1, confirmed via RamiKrispin/EIAapi's real request examples — EIA's own
// documentation.php returned 503 when checked live).
const baseURL = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/"

// Respondent is the EIA balancing-authority code this poller covers for v1
// (docs/tasks/TASK-entsoe-eia-pollers.md §1: the US48 national aggregate,
// not a specific ISO — deviates from docs/architecture.md's illustrative
// "US-CAISO" example, which used EIA's actual respondent code incorrectly).
const Respondent = "US48"

const periodLayout = "2006-01-02T15"

type apiResponse struct {
	Response struct {
		Data []dataRow `json:"data"`
	} `json:"response"`
}

type dataRow struct {
	Period     string `json:"period"`
	Respondent string `json:"respondent"`
	FuelType   string `json:"fueltype"`
	Value      string `json:"value"`
}

// FetchFuelTypeData fetches hourly generation-by-fuel-type rows for
// Respondent over [start, end).
func FetchFuelTypeData(ctx context.Context, apiKey string, start, end time.Time) ([]dataRow, error) {
	q := url.Values{
		"api_key":              {apiKey},
		"frequency":            {"hourly"},
		"data[0]":              {"value"},
		"facets[respondent][]": {Respondent},
		"start":                {start.UTC().Format(periodLayout)},
		"end":                  {end.UTC().Format(periodLayout)},
		"sort[0][column]":      {"period"},
		"sort[0][direction]":   {"desc"},
		"offset":               {"0"},
		"length":               {"5000"},
	}
	reqURL := baseURL + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("eia: building request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("eia: fetching fuel-type-data: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("eia: reading response body: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("eia: fetching fuel-type-data: unexpected status %s: %s", resp.Status, body)
	}

	var parsed apiResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("eia: parsing response: %w", err)
	}
	return parsed.Response.Data, nil
}
