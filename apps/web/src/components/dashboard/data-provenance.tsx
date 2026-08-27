import type { Source } from "@renewable-pulse/contracts";

/**
 * Real, already-verified facts about each source's actual dataset — not a
 * new API route, since this is fixed text rather than something that
 * changes per request (docs/tasks/TASK-pipeline-transparency-panel.md §2.3).
 * Every fact here cites the docs/architecture.md §3 passage it was verified
 * against; nothing is invented for this panel.
 */
const PROVENANCE: Record<Source, { dataset: string; url: string; cadence: string; note: string }> = {
  ONS: {
    dataset: "ONS Dados Abertos — \"Geração de Usinas em Base Horária\" (geracao-usina-2)",
    url: "https://dados.ons.org.br/dataset/geracao-usina-2",
    cadence: "Republished daily at 12:00 and 19:00 (Brazil grid operator's own dataset metadata)",
    note: "A monthly CKAN/S3 CSV file, not a queryable REST endpoint — apps/ingest downloads the current month's file each poll and filters to new rows.",
  },
  ENTSOE: {
    dataset: "ENTSO-E Transparency Platform — Actual Generation per Type (document type A75, process type A16)",
    url: "https://transparency.entsoe.eu",
    cadence: "15–60 minute resolution depending on bidding zone/series",
    note: "Norway's five bidding zones plus the Netherlands. Live verification is pending an issued API token — see docs/architecture.md §3.",
  },
  EIA: {
    dataset: "EIA Open Data API v2 — electricity/rto/fuel-type-data",
    url: "https://www.eia.gov/opendata",
    cadence: "Hourly (UTC)",
    note: "US48 national aggregate plus 7 individual RTO/ISO respondents (CAISO, ERCOT, ISO-NE, MISO, NYISO, PJM, SPP).",
  },
};

const SOURCE_ORDER: Source[] = ["ONS", "EIA", "ENTSOE"];

/** Where each source's real data actually comes from — the provenance half of the pipeline-transparency panel. */
export function DataProvenance() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {SOURCE_ORDER.map((source) => {
        const info = PROVENANCE[source];
        return (
          <div key={source} className="flex flex-col gap-1 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-3">
            <span className="text-subheading-xs text-text-soft-400 uppercase">{source}</span>
            <a href={info.url} target="_blank" rel="noreferrer" className="text-label-sm text-primary-base underline underline-offset-2">
              {info.dataset}
            </a>
            <span className="text-paragraph-xs text-text-sub-600">{info.cadence}</span>
            <span className="text-paragraph-xs text-text-soft-400">{info.note}</span>
          </div>
        );
      })}
    </div>
  );
}
