package ons

import (
	"testing"
	"time"
)

var ingestedAt = time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)

func TestNormalize_PlantLevelUsesIDONS(t *testing.T) {
	row := Row{
		DinInstante: "2026-08-01 00:00:00",
		IDSubsist:   "N",
		NomTipoUsi:  "HIDROELÉTRICA",
		NomUsina:    "BALBINA",
		IDONS:       "AMBA",
		ValGeracao:  "78.13492496172586",
	}
	reading, err := Normalize(row, ingestedAt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reading.AssetID == nil || *reading.AssetID != "AMBA" {
		t.Fatalf("want asset_id=AMBA, got %v", reading.AssetID)
	}
	if reading.Zone != "BR-N" {
		t.Fatalf("want zone=BR-N, got %q", reading.Zone)
	}
	if reading.Unit != "MWmed" {
		t.Fatalf("want unit=MWmed, got %q", reading.Unit)
	}
}

// A real-data regression: several "Pequenas Usinas" aggregate rows share the
// same zone+metric+hour with an empty id_ons — found by a live poll showing
// ~16% of rows colliding under the idempotency key before this fix
// (docs/architecture.md §3).
func TestNormalize_AggregateRowFallsBackToNomUsina(t *testing.T) {
	rowA := Row{
		DinInstante: "2026-08-01 00:00:00",
		IDSubsist:   "SE",
		NomTipoUsi:  "HIDROELÉTRICA",
		NomUsina:    "PQU DFGO HID",
		IDONS:       "",
		ValGeracao:  "47.0",
	}
	rowB := Row{
		DinInstante: "2026-08-01 00:00:00",
		IDSubsist:   "SE",
		NomTipoUsi:  "HIDROELÉTRICA",
		NomUsina:    "PQU MGGO HID",
		IDONS:       "",
		ValGeracao:  "10.0",
	}

	a, err := Normalize(rowA, ingestedAt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := Normalize(rowB, ingestedAt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if a.AssetID == nil || *a.AssetID != "PQU DFGO HID" {
		t.Fatalf("want asset_id=PQU DFGO HID, got %v", a.AssetID)
	}
	if b.AssetID == nil || *b.AssetID != "PQU MGGO HID" {
		t.Fatalf("want asset_id=PQU MGGO HID, got %v", b.AssetID)
	}
	if *a.AssetID == *b.AssetID {
		t.Fatalf("two distinct aggregate rows must not share an asset_id")
	}
}

func TestNormalize_UnmappedGenerationTypeErrors(t *testing.T) {
	row := Row{
		DinInstante: "2026-08-01 00:00:00",
		IDSubsist:   "N",
		NomTipoUsi:  "GEOTÉRMICA",
		IDONS:       "X",
		ValGeracao:  "1.0",
	}
	if _, err := Normalize(row, ingestedAt); err == nil {
		t.Fatal("want error for unmapped generation type, got nil")
	}
}

func TestNormalize_EmptyValGeracaoErrors(t *testing.T) {
	row := Row{
		DinInstante: "2026-08-01 00:00:00",
		IDSubsist:   "N",
		NomTipoUsi:  "HIDROELÉTRICA",
		IDONS:       "X",
		ValGeracao:  "",
	}
	if _, err := Normalize(row, ingestedAt); err == nil {
		t.Fatal("want error for empty val_geracao, got nil")
	}
}
