package ons

import (
	"encoding/csv"
	"fmt"
	"io"
)

// Row is one line of the geracao-usina-2 CSV, matching the confirmed column
// order (docs/architecture.md §3):
// din_instante;id_subsistema;nom_subsistema;id_estado;nom_estado;
// cod_modalidadeoperacao;nom_tipousina;nom_tipocombustivel;nom_usina;
// id_ons;ceg;val_geracao
type Row struct {
	DinInstante string
	IDSubsist   string
	NomTipoUsi  string
	NomUsina    string
	IDONS       string
	ValGeracao  string
}

var wantColumns = []string{
	"din_instante", "id_subsistema", "nom_subsistema", "id_estado", "nom_estado",
	"cod_modalidadeoperacao", "nom_tipousina", "nom_tipocombustivel", "nom_usina",
	"id_ons", "ceg", "val_geracao",
}

const (
	colDinInstante = 0
	colIDSubsist   = 1
	colNomTipoUsi  = 6
	colNomUsina    = 8
	colIDONS       = 9
	colValGeracao  = 11
)

// ParseRows streams r as the ONS CSV format (semicolon-delimited) and calls
// fn once per data row. The file can run tens of MB, so this never buffers
// the whole thing in memory.
func ParseRows(r io.Reader, fn func(Row) error) error {
	cr := csv.NewReader(r)
	cr.Comma = ';'
	cr.FieldsPerRecord = -1 // trailing val_geracao is sometimes empty (short row)

	header, err := cr.Read()
	if err != nil {
		return fmt.Errorf("ons: reading header: %w", err)
	}
	if len(header) < len(wantColumns) {
		return fmt.Errorf("ons: unexpected header %v, want at least %v", header, wantColumns)
	}
	for i, want := range wantColumns {
		if header[i] != want {
			return fmt.Errorf("ons: unexpected column %d: got %q, want %q", i, header[i], want)
		}
	}

	for {
		record, err := cr.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("ons: reading row: %w", err)
		}

		row := Row{
			DinInstante: record[colDinInstante],
			IDSubsist:   record[colIDSubsist],
			NomTipoUsi:  record[colNomTipoUsi],
			NomUsina:    record[colNomUsina],
			IDONS:       record[colIDONS],
		}
		if len(record) > colValGeracao {
			row.ValGeracao = record[colValGeracao]
		}

		if err := fn(row); err != nil {
			return err
		}
	}
}
