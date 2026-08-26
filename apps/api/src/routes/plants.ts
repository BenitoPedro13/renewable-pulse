import { plantsResponseSchema, type Plant } from "@renewable-pulse/contracts";
import type { FastifyInstance } from "fastify";

const ANEEL_URL = "https://dadosabertos.aneel.gov.br/api/3/action/datastore_search?resource_id=2f65a1b0-19b8-4360-8238-b34ab4693d55&limit=5000";
const ONE_HOUR_MS = 60 * 60 * 1000;
const attribution = "ANEEL SIGA daily CKAN resource 2f65a1b0-19b8-4360-8238-b34ab4693d55, ODbL";

let cached: { at: number; body: unknown } | undefined;

function num(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

export async function plantsRoute(app: FastifyInstance): Promise<void> {
  app.get("/plants", async () => {
    if (cached && Date.now() - cached.at < ONE_HOUR_MS) return cached.body;
    try {
      const response = await fetch(ANEEL_URL);
      if (!response.ok) throw new Error(`ANEEL ${response.status}`);
      const json = (await response.json()) as { result?: { records?: Record<string, unknown>[] } };
      // ANEEL's own CKAN resource repeats the same CEG across rows (observed
      // live, e.g. "PCH.PH.TO.000031-0.1" more than once) — a "daily"
      // resource without a date filter on this query, so a plant reported on
      // multiple days comes back as multiple rows. CEG is the real-world
      // unique plant identifier, so dedupe on it here rather than showing
      // duplicate markers or an inflated plant count.
      const byCeg = new Map<string, Plant>();
      for (const r of json.result?.records ?? []) {
        const latitude = num(r.NumCoordNEmpreendimento);
        const longitude = num(r.NumCoordEEmpreendimento);
        if (latitude === undefined || longitude === undefined) continue;
        const ceg = String(r.CodCEG ?? "");
        byCeg.set(ceg, {
          ceg,
          name: String(r.NomEmpreendimento ?? ""),
          state: String(r.SigUFPrincipal ?? ""),
          generationType: String(r.SigTipoGeracao ?? ""),
          phase: r.DscFaseUsina == null ? null : String(r.DscFaseUsina),
          fuelOrigin: r.DscOrigemCombustivel == null ? null : String(r.DscOrigemCombustivel),
          latitude,
          longitude,
        });
      }
      const plants = Array.from(byCeg.values());
      cached = { at: Date.now(), body: plantsResponseSchema.parse({ source: "ANEEL_SIGA", attribution, unavailable: false, plants, cachedAt: new Date().toISOString() }) };
      return cached.body;
    } catch {
      return plantsResponseSchema.parse({ source: "ANEEL_SIGA", attribution, unavailable: true, plants: [], cachedAt: null });
    }
  });
}
