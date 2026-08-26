package eia

import (
	"fmt"
	"strconv"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

// metricByFuelType maps EIA-930's fuel-type facet to our canonical metric.
// The facet has 16 codes, not the 8 originally assumed — confirmed via a
// live poll and EIA's own facet-metadata endpoint
// (docs/tasks/TASK-entsoe-eia-pollers.md §5.1). All 16 are mapped; none are
// left for the DLQ.
var metricByFuelType = map[string]string{
	"COL": event.MetricThermal,
	"NG":  event.MetricThermal,
	"OIL": event.MetricThermal,
	"NUC": event.MetricNuclear,
	"WAT": event.MetricHydro,
	"PS":  event.MetricHydro, // Pumped Storage — turbine-driven hydro generation
	"SUN": event.MetricSolar,
	"SNB": event.MetricSolar, // Solar with integrated battery storage
	"WND": event.MetricWind,
	"WNB": event.MetricWind, // Wind with integrated battery storage
	"OTH": event.MetricOther,
	"BAT": event.MetricOther, // Battery / Battery storage (standalone)
	"OES": event.MetricOther, // Other energy storage
	"UES": event.MetricOther, // Unknown/unknown energy storage
	"UNK": event.MetricOther, // Unknown
	"GEO": event.MetricOther, // Geothermal — doesn't fit the five named categories
}

// Normalize maps one EIA fuel-type-data row to the canonical reading event.
// It returns an error for a row this poller doesn't yet know how to handle
// (unmapped fuel type, unparseable value) rather than guessing — callers
// should log and skip, the same posture ONS's poller uses.
func Normalize(row dataRow, ingestedAt time.Time) (event.Reading, error) {
	metric, ok := metricByFuelType[row.FuelType]
	if !ok {
		return event.Reading{}, fmt.Errorf("eia: unmapped fueltype %q", row.FuelType)
	}

	if row.Value == "" {
		return event.Reading{}, fmt.Errorf("eia: empty value for row %+v", row)
	}
	value, err := strconv.ParseFloat(row.Value, 64)
	if err != nil {
		return event.Reading{}, fmt.Errorf("eia: parsing value %q: %w", row.Value, err)
	}

	recordedAt, err := time.ParseInLocation(periodLayout, row.Period, time.UTC)
	if err != nil {
		return event.Reading{}, fmt.Errorf("eia: parsing period %q: %w", row.Period, err)
	}

	return event.Reading{
		Source:        event.SourceEIA,
		Zone:          "US-" + row.Respondent,
		AssetID:       nil,
		Metric:        metric,
		Value:         value,
		Unit:          event.UnitMWh,
		RecordedAt:    recordedAt.Format(time.RFC3339),
		IngestedAt:    ingestedAt.Format(time.RFC3339),
		SchemaVersion: 1,
	}, nil
}
