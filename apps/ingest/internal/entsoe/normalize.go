package entsoe

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

// metricByPsrType maps ENTSO-E's psrType code (docs/tasks/TASK-entsoe-eia-pollers.md
// §1) to our canonical metric. Combustion categories (B01-B08) fold into
// "thermal", matching ONS's existing single "TÉRMICA" bucket. Left
// unmapped on purpose (Normalize returns an error, caller logs+skips —
// same posture as ONS's unmapped nom_tipousina): B09 geothermal, B13
// marine, B15 other-renewable, B17 waste, B21-B25 (network infrastructure,
// not generation) — none are material to Norway's actual hydro/wind-
// dominated mix.
var metricByPsrType = map[string]string{
	"B01": event.MetricThermal, // Biomass
	"B02": event.MetricThermal, // Fossil Brown coal/Lignite
	"B03": event.MetricThermal, // Fossil Coal-derived gas
	"B04": event.MetricThermal, // Fossil Gas
	"B05": event.MetricThermal, // Fossil Hard coal
	"B06": event.MetricThermal, // Fossil Oil
	"B07": event.MetricThermal, // Fossil Oil shale
	"B08": event.MetricThermal, // Fossil Peat
	"B10": event.MetricHydro,   // Hydro Pumped Storage
	"B11": event.MetricHydro,   // Hydro Run-of-river and poundage
	"B12": event.MetricHydro,   // Hydro Water Reservoir
	"B14": event.MetricNuclear,
	"B16": event.MetricSolar,
	"B18": event.MetricWind, // Wind Offshore
	"B19": event.MetricWind, // Wind Onshore
	"B20": event.MetricOther,
}

const timeInstantLayout = "2006-01-02T15:04Z"

// parseResolution supports the ISO-8601 durations ENTSO-E actually uses for
// this document type ("PT60M", occasionally "PT15M") — not a general ISO
// 8601 duration parser, which this project doesn't need.
func parseResolution(res string) (time.Duration, error) {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(res, "PT"), "M")
	if trimmed == res {
		return 0, fmt.Errorf("entsoe: unsupported resolution %q", res)
	}
	minutes, err := strconv.Atoi(trimmed)
	if err != nil {
		return 0, fmt.Errorf("entsoe: parsing resolution %q: %w", res, err)
	}
	return time.Duration(minutes) * time.Minute, nil
}

// normalizePoint maps one TimeSeries/Period/Point triple to the canonical
// reading event. Callers must first skip TimeSeries whose direction is
// consumption (outBiddingZone_Domain.mRID set, e.g. pumped-storage
// charging) rather than generation — see Normalize.
func normalizePoint(zone, psrType string, p period, pt point, ingestedAt time.Time) (event.Reading, error) {
	metric, ok := metricByPsrType[psrType]
	if !ok {
		return event.Reading{}, fmt.Errorf("entsoe: unmapped psrType %q", psrType)
	}

	periodStart, err := time.Parse(timeInstantLayout, p.TimeInterval.Start)
	if err != nil {
		return event.Reading{}, fmt.Errorf("entsoe: parsing timeInterval.start %q: %w", p.TimeInterval.Start, err)
	}
	resolution, err := parseResolution(p.Resolution)
	if err != nil {
		return event.Reading{}, err
	}
	if pt.Position < 1 {
		return event.Reading{}, fmt.Errorf("entsoe: invalid position %d", pt.Position)
	}
	recordedAt := periodStart.Add(time.Duration(pt.Position-1) * resolution)

	return event.Reading{
		Source:        event.SourceENTSOE,
		Zone:          zone,
		AssetID:       nil,
		Metric:        metric,
		Value:         pt.Quantity,
		Unit:          event.UnitMAW,
		RecordedAt:    recordedAt.Format(time.RFC3339),
		IngestedAt:    ingestedAt.Format(time.RFC3339),
		SchemaVersion: 1,
	}, nil
}

// Normalize maps every generation-direction Point in doc to canonical
// reading events, calling fn once per successfully-normalized reading.
// TimeSeries in the consumption direction (outBiddingZone_Domain.mRID set —
// e.g. pumped-storage charging) are skipped entirely, not just their
// unmapped metric: they aren't generation.
func Normalize(doc *glMarketDocument, zone string, ingestedAt time.Time, fn func(event.Reading, error)) {
	for _, ts := range doc.TimeSeries {
		if ts.OutBiddingZone != "" && ts.InBiddingZone == "" {
			continue
		}
		for _, p := range ts.Periods {
			for _, pt := range p.Points {
				reading, err := normalizePoint(zone, ts.MktPSRType.PsrType, p, pt, ingestedAt)
				fn(reading, err)
			}
		}
	}
}
