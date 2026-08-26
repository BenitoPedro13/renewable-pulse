package eia

import (
	"testing"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

var ingestedAt = time.Date(2026, 8, 26, 6, 0, 0, 0, time.UTC)

func TestNormalize_MapsWindRow(t *testing.T) {
	row := dataRow{
		Period:     "2026-08-26T05",
		Respondent: "US48",
		FuelType:   "WND",
		Value:      "98234",
	}
	reading, err := Normalize(row, ingestedAt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reading.Source != event.SourceEIA {
		t.Errorf("want source=EIA, got %q", reading.Source)
	}
	if reading.Zone != "US-US48" {
		t.Errorf("want zone=US-US48, got %q", reading.Zone)
	}
	if reading.Metric != event.MetricWind {
		t.Errorf("want metric=wind, got %q", reading.Metric)
	}
	if reading.Unit != event.UnitMWh {
		t.Errorf("want unit=MWh, got %q", reading.Unit)
	}
	if reading.Value != 98234 {
		t.Errorf("want value=98234, got %v", reading.Value)
	}
	if reading.RecordedAt != "2026-08-26T05:00:00Z" {
		t.Errorf("want recorded_at=2026-08-26T05:00:00Z, got %q", reading.RecordedAt)
	}
	if reading.AssetID != nil {
		t.Errorf("want nil asset_id, got %v", reading.AssetID)
	}
}

func TestNormalize_AllEightFuelTypeCodesAreMapped(t *testing.T) {
	for code := range metricByFuelType {
		row := dataRow{Period: "2026-08-26T05", Respondent: "US48", FuelType: code, Value: "1"}
		if _, err := Normalize(row, ingestedAt); err != nil {
			t.Errorf("fueltype %q: unexpected error: %v", code, err)
		}
	}
	if len(metricByFuelType) != 8 {
		t.Errorf("want 8 mapped fuel types, got %d", len(metricByFuelType))
	}
}

func TestNormalize_UnmappedFuelTypeReturnsError(t *testing.T) {
	row := dataRow{Period: "2026-08-26T05", Respondent: "US48", FuelType: "ZZZ", Value: "1"}
	if _, err := Normalize(row, ingestedAt); err == nil {
		t.Fatal("want an error for an unmapped fueltype, got nil")
	}
}

func TestNormalize_EmptyValueReturnsError(t *testing.T) {
	row := dataRow{Period: "2026-08-26T05", Respondent: "US48", FuelType: "WND", Value: ""}
	if _, err := Normalize(row, ingestedAt); err == nil {
		t.Fatal("want an error for an empty value, got nil")
	}
}
