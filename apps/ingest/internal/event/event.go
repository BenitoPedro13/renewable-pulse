// Package event defines the canonical reading event.
//
// This is a hand-maintained mirror of packages/contracts/src/event.ts's
// readingEventSchema — a deliberate cross-language seam documented in
// docs/architecture.md §6, not an oversight. Whoever changes the event
// schema must update both sides in the same task.
package event

// Reading is the canonical event published to the Redpanda "readings" topic.
type Reading struct {
	Source        string  `json:"source"`
	Zone          string  `json:"zone"`
	AssetID       *string `json:"asset_id"`
	Metric        string  `json:"metric"`
	Value         float64 `json:"value"`
	Unit          string  `json:"unit"`
	RecordedAt    string  `json:"recorded_at"`
	IngestedAt    string  `json:"ingested_at"`
	SchemaVersion int     `json:"schema_version"`
}

const (
	SourceONS = "ONS"
	UnitMWmed = "MWmed"

	MetricHydro   = "hydro"
	MetricThermal = "thermal"
	MetricWind    = "wind"
	MetricSolar   = "solar"
	MetricNuclear = "nuclear"
)
