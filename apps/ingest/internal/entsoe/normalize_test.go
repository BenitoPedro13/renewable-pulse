package entsoe

import (
	"testing"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

var ingestedAt = time.Date(2026, 8, 26, 6, 0, 0, 0, time.UTC)

func newTimeInterval(start, end string) struct {
	Start string `xml:"start"`
	End   string `xml:"end"`
} {
	return struct {
		Start string `xml:"start"`
		End   string `xml:"end"`
	}{Start: start, End: end}
}

func TestNormalize_MapsHydroGenerationPoints(t *testing.T) {
	doc := &glMarketDocument{
		TimeSeries: []timeSeries{
			{
				InBiddingZone: "10YNO-1--------2",
				Periods: []period{
					{
						TimeInterval: newTimeInterval("2026-08-26T00:00Z", "2026-08-26T02:00Z"),
						Resolution:   "PT60M",
						Points: []point{
							{Position: 1, Quantity: 4213},
							{Position: 2, Quantity: 4300.5},
						},
					},
				},
			},
		},
	}
	doc.TimeSeries[0].MktPSRType.PsrType = "B12"

	var readings []event.Reading
	Normalize(doc, "NO-NO1", ingestedAt, func(r event.Reading, err error) {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		readings = append(readings, r)
	})

	if len(readings) != 2 {
		t.Fatalf("want 2 readings, got %d", len(readings))
	}
	first := readings[0]
	if first.Source != event.SourceENTSOE {
		t.Errorf("want source=ENTSOE, got %q", first.Source)
	}
	if first.Zone != "NO-NO1" {
		t.Errorf("want zone=NO-NO1, got %q", first.Zone)
	}
	if first.Metric != event.MetricHydro {
		t.Errorf("want metric=hydro, got %q", first.Metric)
	}
	if first.Unit != event.UnitMAW {
		t.Errorf("want unit=MAW, got %q", first.Unit)
	}
	if first.AssetID != nil {
		t.Errorf("want nil asset_id, got %v", first.AssetID)
	}
	if first.RecordedAt != "2026-08-26T00:00:00Z" {
		t.Errorf("want recorded_at=2026-08-26T00:00:00Z, got %q", first.RecordedAt)
	}
	second := readings[1]
	if second.RecordedAt != "2026-08-26T01:00:00Z" {
		t.Errorf("want second recorded_at=2026-08-26T01:00:00Z, got %q", second.RecordedAt)
	}
}

func TestNormalize_SkipsConsumptionDirectionTimeSeries(t *testing.T) {
	doc := &glMarketDocument{
		TimeSeries: []timeSeries{
			{
				OutBiddingZone: "10YNO-1--------2",
				Periods: []period{
					{
						TimeInterval: newTimeInterval("2026-08-26T00:00Z", "2026-08-26T01:00Z"),
						Resolution:   "PT60M",
						Points:       []point{{Position: 1, Quantity: 500}},
					},
				},
			},
		},
	}
	doc.TimeSeries[0].MktPSRType.PsrType = "B10"

	var readings []event.Reading
	Normalize(doc, "NO-NO1", ingestedAt, func(r event.Reading, err error) {
		readings = append(readings, r)
	})

	if len(readings) != 0 {
		t.Fatalf("want 0 readings for a consumption-direction series, got %d", len(readings))
	}
}

func TestNormalize_UnmappedPsrTypeReturnsError(t *testing.T) {
	doc := &glMarketDocument{
		TimeSeries: []timeSeries{
			{
				InBiddingZone: "10YNO-1--------2",
				Periods: []period{
					{
						TimeInterval: newTimeInterval("2026-08-26T00:00Z", "2026-08-26T01:00Z"),
						Resolution:   "PT60M",
						Points:       []point{{Position: 1, Quantity: 12}},
					},
				},
			},
		},
	}
	doc.TimeSeries[0].MktPSRType.PsrType = "B09" // geothermal, deliberately unmapped

	var gotErr error
	Normalize(doc, "NO-NO1", ingestedAt, func(r event.Reading, err error) {
		gotErr = err
	})

	if gotErr == nil {
		t.Fatal("want an error for an unmapped psrType, got nil")
	}
}
