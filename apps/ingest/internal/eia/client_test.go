package eia

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// TestFetchFuelTypeData_RequestsEveryRespondentInOneFacet confirms the
// request sends every configured respondent as a repeated
// facets[respondent][] value in a single call, rather than one call per
// respondent (verified live against the real API before writing this test —
// docs/tasks/TASK-live-dashboard.md §2.8).
func TestFetchFuelTypeData_RequestsEveryRespondentInOneFacet(t *testing.T) {
	var gotRespondents []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRespondents = r.URL.Query()["facets[respondent][]"]
		fmt.Fprint(w, `{"response":{"total":"0","data":[]}}`)
	}))
	defer server.Close()

	withTestBaseURL(t, server.URL+"/")

	if _, err := FetchFuelTypeData(t.Context(), "key", time.Now(), time.Now()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(gotRespondents) != len(Respondents) {
		t.Fatalf("want %d respondents in one request, got %d: %v", len(Respondents), len(gotRespondents), gotRespondents)
	}
	for _, want := range Respondents {
		found := false
		for _, got := range gotRespondents {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("respondent %q missing from request", want)
		}
	}
}

// TestFetchFuelTypeData_PaginatesUntilTotalIsReached confirms a response
// reporting more total rows than one page returns triggers a second,
// offset-advanced request — needed because a combined 8-respondent, 5-day
// window can exceed EIA's 5000-row page size (verified live: a single
// respondent's 5-day window alone returned 1089 rows).
func TestFetchFuelTypeData_PaginatesUntilTotalIsReached(t *testing.T) {
	var offsets []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset := r.URL.Query().Get("offset")
		offsets = append(offsets, offset)
		if offset == "0" {
			fmt.Fprint(w, `{"response":{"total":"2","data":[
				{"period":"2026-08-26T00","respondent":"CISO","fueltype":"WND","value":"1"}
			]}}`)
			return
		}
		fmt.Fprint(w, `{"response":{"total":"2","data":[
			{"period":"2026-08-26T01","respondent":"CISO","fueltype":"WND","value":"2"}
		]}}`)
	}))
	defer server.Close()

	withTestBaseURL(t, server.URL+"/")

	rows, err := FetchFuelTypeData(t.Context(), "key", time.Now(), time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows across both pages, got %d", len(rows))
	}
	if len(offsets) != 2 {
		t.Fatalf("want exactly 2 requests (one per page), got %d: %v", len(offsets), offsets)
	}
	if offsets[0] != "0" || offsets[1] != "1" {
		t.Errorf("want offsets [0, 1] (advanced by rows already received), got %v", offsets)
	}
}

// withTestBaseURL points baseURL at a local test server for the duration of
// the test, restoring the real EIA URL afterward — so these tests never hit
// the live API.
func withTestBaseURL(t *testing.T, u string) {
	t.Helper()
	if _, err := url.Parse(u); err != nil {
		t.Fatalf("invalid test base URL: %v", err)
	}
	original := baseURL
	baseURL = u
	t.Cleanup(func() { baseURL = original })
}
