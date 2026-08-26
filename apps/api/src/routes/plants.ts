import { plantsQuerySchema, plantsResponseSchema, type Metric, type Plant, type PlantRegistrySource } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";

// ANEEL's SigTipoGeracao codes, confirmed against a live poll of the real
// resource — the same fuel categories ONS's own nom_tipousina values map to
// in packages/contracts/src/event.ts.
const METRIC_BY_ANEEL_TYPE: Record<string, Metric> = {
  UHE: "hydro",
  PCH: "hydro",
  CGH: "hydro",
  UTE: "thermal",
  EOL: "wind",
  UFV: "solar",
  UTN: "nuclear",
};

// All 28 real `technology` facet values from EIA's own facet-metadata
// endpoint (electricity/operating-generator-capacity/facet/technology),
// fetched live 2026-08-26 — not guessed. Mapped using the same reasoning
// already applied to EIA's 16 hourly-generation `fueltype` codes
// (TASK-entsoe-eia-pollers.md §5.1): combustion variants -> thermal,
// pumped storage -> hydro (matching the existing PS->hydro precedent),
// standalone storage/unclassified -> other.
const METRIC_BY_EIA_TECHNOLOGY: Record<string, Metric> = {
  "Conventional Hydroelectric": "hydro",
  "Hydroelectric Pumped Storage": "hydro",
  "Onshore Wind Turbine": "wind",
  "Offshore Wind Turbine": "wind",
  "Solar Photovoltaic": "solar",
  "Solar Thermal without Energy Storage": "solar",
  "Solar Thermal with Energy Storage": "solar",
  Nuclear: "nuclear",
  "Petroleum Liquids": "thermal",
  "Petroleum Coke": "thermal",
  "Natural Gas Fired Combustion Turbine": "thermal",
  "Natural Gas Steam Turbine": "thermal",
  "Natural Gas Fired Combined Cycle": "thermal",
  "Natural Gas Internal Combustion Engine": "thermal",
  "Natural Gas with Compressed Air Storage": "thermal",
  "Other Natural Gas": "thermal",
  "Conventional Steam Coal": "thermal",
  "Coal Integrated Gasification Combined Cycle": "thermal",
  "Municipal Solid Waste": "thermal",
  "Landfill Gas": "thermal",
  "Other Gases": "thermal",
  "Wood/Wood Waste Biomass": "thermal",
  "Other Waste Biomass": "thermal",
  Geothermal: "other",
  Batteries: "other",
  Flywheels: "other",
  "All Other": "other",
};

const ANEEL_URL = "https://dadosabertos.aneel.gov.br/api/3/action/datastore_search?resource_id=2f65a1b0-19b8-4360-8238-b34ab4693d55&limit=5000";
const ANEEL_ATTRIBUTION = "ANEEL SIGA daily CKAN resource 2f65a1b0-19b8-4360-8238-b34ab4693d55, ODbL";

// EIA's own v2 REST route for Form EIA-860/860M ("Inventory of Operable
// Generators"), confirmed live 2026-08-26 (docs/tasks/TASK-live-dashboard.md
// §2.7) — not the same route apps/ingest polls for hourly generation
// (electricity/rto/fuel-type-data). One row per *generator*, not per plant
// (a plant can have several), status=OP restricts to currently operating
// generators, sorted by period desc so the capped page favors the most
// recently reported ones. ~4.3M generator-months exist in total; this page
// is a real but partial sample, not full US coverage — the attribution
// below says so rather than implying completeness.
const EIA_URL =
  "https://api.eia.gov/v2/electricity/operating-generator-capacity/data/" +
  "?frequency=monthly&data[0]=nameplate-capacity-mw&data[1]=latitude&data[2]=longitude" +
  "&facets[status][]=OP&sort[0][column]=period&sort[0][direction]=desc&length=5000";
const EIA_ATTRIBUTION =
  "EIA Form 860/860M (electricity/operating-generator-capacity), first 5000 of ~4.3M operating generator-months — a real sample, not full US coverage";

const ONE_HOUR_MS = 60 * 60 * 1000;

const cache = new Map<PlantRegistrySource, { at: number; body: unknown }>();

function num(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim();
  // ANEEL renders a genuinely missing decimal field as just ",00" (no
  // integer part) rather than omitting the key — observed live on
  // MdaGarantiaFisicaKw. Number(".00") would otherwise silently become 0,
  // a false "zero capacity" instead of "not reported".
  if (raw === "" || raw.startsWith(",")) return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

async function fetchAneelPlants(): Promise<Plant[]> {
  const response = await fetch(ANEEL_URL);
  if (!response.ok) throw new Error(`ANEEL ${response.status}`);
  const json = (await response.json()) as { result?: { records?: Record<string, unknown>[] } };
  // ANEEL's own CKAN resource repeats the same CEG across rows (observed
  // live, e.g. "PCH.PH.TO.000031-0.1" more than once) — a "daily" resource
  // without a date filter on this query, so a plant reported on multiple
  // days comes back as multiple rows. CEG is the real-world unique plant
  // identifier, so dedupe on it here rather than showing duplicate markers
  // or an inflated plant count.
  const byCeg = new Map<string, Plant>();
  for (const r of json.result?.records ?? []) {
    const latitude = num(r.NumCoordNEmpreendimento);
    const longitude = num(r.NumCoordEEmpreendimento);
    if (latitude === undefined || longitude === undefined) continue;
    const ceg = String(r.CodCEG ?? "");
    // Prefer the inspected/verified capacity (MdaPotenciaFiscalizadaKw) over
    // the originally granted one (MdaPotenciaOutorgadaKw) — a plant not yet
    // inspected only has the latter.
    const installedCapacityKw = num(r.MdaPotenciaFiscalizadaKw) ?? num(r.MdaPotenciaOutorgadaKw) ?? null;
    const generationType = String(r.SigTipoGeracao ?? "");
    byCeg.set(ceg, {
      ceg,
      name: String(r.NomEmpreendimento ?? ""),
      state: String(r.SigUFPrincipal ?? ""),
      generationType,
      metric: METRIC_BY_ANEEL_TYPE[generationType] ?? "other",
      phase: r.DscFaseUsina == null ? null : String(r.DscFaseUsina),
      fuelOrigin: r.DscOrigemCombustivel == null ? null : String(r.DscOrigemCombustivel),
      latitude,
      longitude,
      installedCapacityKw,
    });
  }
  return Array.from(byCeg.values());
}

type EiaGeneratorRow = {
  plantid?: string;
  plantName?: string;
  stateid?: string;
  technology?: string | null;
  statusDescription?: string;
  latitude?: string;
  longitude?: string;
  "nameplate-capacity-mw"?: string;
};

async function fetchEiaPlants(apiKey: string): Promise<Plant[]> {
  const response = await fetch(`${EIA_URL}&api_key=${encodeURIComponent(apiKey)}`);
  if (!response.ok) throw new Error(`EIA ${response.status}`);
  const json = (await response.json()) as { response?: { data?: EiaGeneratorRow[] } };

  // EIA-860 is one row per generator, several generators per plant — group
  // to plant level the same way ANEEL's CEG-duplicate rows are deduped
  // above, summing capacity across a plant's generators and keeping the
  // technology with the most capacity as that plant's representative fuel
  // type (this schema models one generationType per plant, matching
  // ANEEL's shape).
  const byPlantId = new Map<
    string,
    { name: string; state: string; latitude: number; longitude: number; phase: string | null; capacityByTechnology: Map<string, number> }
  >();
  for (const r of json.response?.data ?? []) {
    const latitude = num(r.latitude);
    const longitude = num(r.longitude);
    const plantid = r.plantid;
    if (latitude === undefined || longitude === undefined || !plantid) continue;
    const capacityMw = num(r["nameplate-capacity-mw"]) ?? 0;
    const technology = r.technology ?? "All Other";

    const existing = byPlantId.get(plantid) ?? {
      name: r.plantName ?? "",
      state: r.stateid ?? "",
      latitude,
      longitude,
      phase: r.statusDescription ?? null,
      capacityByTechnology: new Map<string, number>(),
    };
    existing.capacityByTechnology.set(technology, (existing.capacityByTechnology.get(technology) ?? 0) + capacityMw);
    byPlantId.set(plantid, existing);
  }

  return Array.from(byPlantId.entries()).map(([plantid, plant]) => {
    let dominantTechnology = "All Other";
    let dominantCapacity = -1;
    let totalCapacityMw = 0;
    for (const [technology, capacity] of plant.capacityByTechnology) {
      totalCapacityMw += capacity;
      if (capacity > dominantCapacity) {
        dominantCapacity = capacity;
        dominantTechnology = technology;
      }
    }
    return {
      ceg: plantid,
      name: plant.name,
      state: plant.state,
      generationType: dominantTechnology,
      metric: METRIC_BY_EIA_TECHNOLOGY[dominantTechnology] ?? "other",
      phase: plant.phase,
      fuelOrigin: dominantTechnology,
      latitude: plant.latitude,
      longitude: plant.longitude,
      installedCapacityKw: totalCapacityMw > 0 ? totalCapacityMw * 1000 : null,
    };
  });
}

export async function plantsRoute(app: FastifyInstance): Promise<void> {
  app.get("/plants", async (request, reply) => {
    const query = plantsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.message });
    const source = query.data.source;

    const cached = cache.get(source);
    if (cached && Date.now() - cached.at < ONE_HOUR_MS) return cached.body;

    try {
      const plants =
        source === "ANEEL_SIGA"
          ? await fetchAneelPlants()
          : await fetchEiaPlants(requireEiaApiKey());
      const attribution = source === "ANEEL_SIGA" ? ANEEL_ATTRIBUTION : EIA_ATTRIBUTION;
      const body = plantsResponseSchema.parse({ source, attribution, unavailable: false, plants, cachedAt: new Date().toISOString() });
      cache.set(source, { at: Date.now(), body });
      return body;
    } catch {
      const attribution = source === "ANEEL_SIGA" ? ANEEL_ATTRIBUTION : EIA_ATTRIBUTION;
      return plantsResponseSchema.parse({ source, attribution, unavailable: true, plants: [], cachedAt: null });
    }
  });
}

function requireEiaApiKey(): string {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error("EIA_API_KEY is required for source=EIA_860");
  return apiKey;
}
