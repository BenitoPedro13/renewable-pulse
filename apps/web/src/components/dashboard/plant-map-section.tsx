"use client";

import type { PlantRegistrySource, Source, Zone } from "@renewable-pulse/contracts";
import { useState } from "react";
import { PLANT_MAP_SOURCES, PlantMap } from "@/components/dashboard/plant-map";
import { RegionalTotals } from "@/components/dashboard/regional-totals";
import { ONS_ZONES, USA_REGIONAL_ZONES } from "@/lib/zones";

/**
 * Maps a plant-registry toggle choice to the matching live-generation
 * source/zones for the totals panel beside the map — the two picks are
 * different vocabularies (a registry source like "ANEEL_SIGA"/"EIA_860" vs.
 * a generation source like "ONS"/"EIA") that happen to describe the same
 * country, so this is the one place that translates between them.
 */
const TOTALS_FOR: Record<PlantRegistrySource, { source: Source; zones: Zone[] }> = {
  ANEEL_SIGA: { source: "ONS", zones: ONS_ZONES },
  EIA_860: { source: "EIA", zones: USA_REGIONAL_ZONES },
};

/**
 * The plant map and its per-zone totals panel as one unit that toggles
 * together between Brazil and USA — previously the map owned its own
 * internal Brazil/USA toggle while the totals panel beside it was
 * ONS-only, so switching the map to "USA (EIA Form 860)" left Brazil's
 * BR-N/NE/S/SE totals showing next to it (docs/tasks/TASK-live-dashboard.md
 * §2.9). `source` is lifted here and passed down as a controlled prop to
 * both children instead.
 */
export function PlantMapSection() {
  const [source, setSource] = useState<PlantRegistrySource>("ANEEL_SIGA");
  const totals = TOTALS_FOR[source];

  return (
    <section aria-labelledby="plant-map-heading" className="flex flex-col gap-4">
      <h2 id="plant-map-heading" className="text-label-lg text-text-strong-950">
        Plant registry
      </h2>
      <div className="flex gap-1">
        {PLANT_MAP_SOURCES.map((s) => (
          <button
            key={s.source}
            type="button"
            onClick={() => setSource(s.source)}
            className={`rounded-full px-3 py-1 text-paragraph-xs ${
              s.source === source ? "bg-primary-base text-static-white" : "bg-bg-weak-50 text-text-sub-600"
            }`}
            aria-pressed={s.source === source}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PlantMap key={source} source={source} />
        <RegionalTotals source={totals.source} zones={totals.zones} />
      </div>
    </section>
  );
}
