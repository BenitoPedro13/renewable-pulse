package ons

import (
	"fmt"
	"strconv"
	"time"
	_ "time/tzdata" // embed the IANA DB so America/Sao_Paulo loads even without OS tzdata

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

// Location is the timezone ONS's din_instante field is assumed to be in.
//
// [VERIFY: docs/architecture.md §3 — ONS's own data dictionary does not
// state a timezone for din_instante. Brazil has used a single fixed UTC-3
// offset nationwide (no DST) since 2019, so America/Sao_Paulo is the most
// likely candidate, but this is an assumption, not a confirmed fact. Resolve
// by comparing a live poll against ONS's own real-time dashboard before
// this assumption is relied on for anything time-sensitive.]
var Location = mustLoadLocation("America/Sao_Paulo")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("ons: loading location %q: %v", name, err))
	}
	return loc
}

var metricByTipoUsina = map[string]string{
	"HIDROELÉTRICA": event.MetricHydro,
	"TÉRMICA":       event.MetricThermal,
	"EOLIELÉTRICA":  event.MetricWind,
	"FOTOVOLTAICA":  event.MetricSolar,
	"NUCLEAR":       event.MetricNuclear,
}

const dinInstanteLayout = "2006-01-02 15:04:05"

// Normalize maps one ONS CSV row to the canonical reading event. It returns
// an error for rows this poller doesn't yet know how to handle (unmapped
// generation type, unparseable value) rather than guessing — callers should
// log and skip, the same posture the DLQ formalizes in Phase 2
// (docs/architecture.md §5).
func Normalize(row Row, ingestedAt time.Time) (event.Reading, error) {
	metric, ok := metricByTipoUsina[row.NomTipoUsi]
	if !ok {
		return event.Reading{}, fmt.Errorf("ons: unmapped nom_tipousina %q", row.NomTipoUsi)
	}

	if row.ValGeracao == "" {
		return event.Reading{}, fmt.Errorf("ons: empty val_geracao for row %+v", row)
	}
	value, err := strconv.ParseFloat(row.ValGeracao, 64)
	if err != nil {
		return event.Reading{}, fmt.Errorf("ons: parsing val_geracao %q: %w", row.ValGeracao, err)
	}

	recordedAt, err := time.ParseInLocation(dinInstanteLayout, row.DinInstante, Location)
	if err != nil {
		return event.Reading{}, fmt.Errorf("ons: parsing din_instante %q: %w", row.DinInstante, err)
	}

	// id_ons is empty for ONS's per-state/per-interconnection "Pequenas
	// Usinas" small-plant aggregate rows (e.g. "PQU DFGO HID") — several of
	// these share the same zone+metric+hour (one per state pair), so a null
	// asset_id would collide them under the idempotency key and silently
	// drop all but the last. nom_usina is ONS's own name for the aggregate
	// group and is unique within that group (verified against a live poll,
	// 2026-08-26) — use it as the identifier instead of null.
	var assetID *string
	switch {
	case row.IDONS != "":
		id := row.IDONS
		assetID = &id
	case row.NomUsina != "":
		id := row.NomUsina
		assetID = &id
	}

	return event.Reading{
		Source:        event.SourceONS,
		Zone:          "BR-" + row.IDSubsist,
		AssetID:       assetID,
		Metric:        metric,
		Value:         value,
		Unit:          event.UnitMWmed,
		RecordedAt:    recordedAt.Format(time.RFC3339),
		IngestedAt:    ingestedAt.Format(time.RFC3339),
		SchemaVersion: 1,
	}, nil
}
