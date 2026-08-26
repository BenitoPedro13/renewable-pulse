"use client";

import type { Metric, Plant, PlantRegistrySource } from "@renewable-pulse/contracts";
import "mapbox-gl/dist/mapbox-gl.css";
import { useState } from "react";
import Map, { Marker, Popup } from "react-map-gl/mapbox";
import { usePlants } from "@/hooks/use-plants";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const MARKER_COLOR: Record<Metric, string> = {
  hydro: "var(--chart-1)",
  solar: "var(--chart-2)",
  wind: "var(--chart-3)",
  thermal: "var(--chart-4)",
  nuclear: "var(--chart-5)",
  other: "var(--chart-5)",
};

const MIN_MARKER_PX = 6;
const MAX_MARKER_PX = 22;

/** Square-root scale (area, not radius, proportional to capacity) so a handful of huge plants don't visually swamp the map; falls back to the minimum size when the registry hasn't reported a capacity for that plant. */
function markerSizePx(installedCapacityKw: number | null, maxCapacityKw: number): number {
  if (!installedCapacityKw || maxCapacityKw <= 0) return MIN_MARKER_PX;
  const ratio = Math.sqrt(installedCapacityKw / maxCapacityKw);
  return MIN_MARKER_PX + ratio * (MAX_MARKER_PX - MIN_MARKER_PX);
}

const SOURCES: { source: PlantRegistrySource; label: string; view: { longitude: number; latitude: number; zoom: number } }[] = [
  { source: "ANEEL_SIGA", label: "Brazil (ANEEL)", view: { longitude: -51.9, latitude: -14.2, zoom: 3.2 } },
  { source: "EIA_860", label: "USA (EIA Form 860)", view: { longitude: -98.5, latitude: 39.8, zoom: 3.2 } },
];

function PlantPopup({ plant, onClose }: { plant: Plant; onClose: () => void }) {
  return (
    <Popup longitude={plant.longitude} latitude={plant.latitude} onClose={onClose} closeButton anchor="bottom" offset={12}>
      <div className="flex flex-col gap-1 p-1 text-paragraph-xs text-text-strong-950">
        <span className="text-label-sm">{plant.name || plant.ceg}</span>
        <span className="text-text-sub-600">
          {plant.metric} ({plant.fuelOrigin ?? plant.generationType}) · {plant.state}
        </span>
        {plant.installedCapacityKw ? (
          <span className="text-text-sub-600 tabular-nums">
            {(plant.installedCapacityKw / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MW installed
          </span>
        ) : null}
        <span className="text-text-soft-400">{plant.phase ?? "phase unknown"} · id {plant.ceg}</span>
      </div>
    </Popup>
  );
}

/**
 * Real plant registry markers — ANEEL SIGA for Brazil, EIA Form 860/860M
 * for the USA (docs/tasks/TASK-live-dashboard.md §2.5.1, §2.7) — registry
 * locations/attributes, not live generation. Renders a real map only when a
 * Mapbox token is configured; otherwise shows the real plant count instead
 * of a fabricated map, since react-map-gl needs a real per-account
 * credential this repo can't invent.
 */
export function PlantMap() {
  const [source, setSource] = useState<PlantRegistrySource>("ANEEL_SIGA");
  const { data, isPending, isError, error } = usePlants(source);
  const [selected, setSelected] = useState<Plant | null>(null);
  const activeSource = SOURCES.find((s) => s.source === source) ?? SOURCES[0];

  const sourceTabs = (
    <div className="flex gap-1">
      {SOURCES.map((s) => (
        <button
          key={s.source}
          type="button"
          onClick={() => {
            setSource(s.source);
            setSelected(null);
          }}
          className={`rounded-full px-3 py-1 text-paragraph-xs ${
            s.source === source ? "bg-primary-base text-static-white" : "bg-bg-weak-50 text-text-sub-600"
          }`}
          aria-pressed={s.source === source}
        >
          {s.label}
        </button>
      ))}
    </div>
  );

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        {sourceTabs}
        <p className="text-paragraph-sm text-text-sub-600">Loading plant registry…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-2">
        {sourceTabs}
        <p className="text-paragraph-sm text-error-base">Plant registry unavailable: {error instanceof Error ? error.message : "unknown error"}</p>
      </div>
    );
  }

  if (data.unavailable) {
    return (
      <div className="flex flex-col gap-2">
        {sourceTabs}
        <p className="text-paragraph-sm text-error-base">{activeSource.label} registry is currently unreachable — no cached data available.</p>
      </div>
    );
  }

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex flex-col gap-2">
        {sourceTabs}
        <div className="flex flex-col gap-1 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 p-4">
          <p className="text-paragraph-sm text-text-sub-600">
            {data.plants.length.toLocaleString()} real plants loaded from {data.attribution}, but no map is rendered:
            NEXT_PUBLIC_MAPBOX_TOKEN is not configured.
          </p>
        </div>
      </div>
    );
  }

  const maxCapacityKw = data.plants.reduce((max, p) => Math.max(max, p.installedCapacityKw ?? 0), 0);

  return (
    <div className="flex flex-col gap-2">
      {sourceTabs}
      <div className="h-96 w-full overflow-hidden rounded-2xl border border-stroke-soft-200">
        <Map key={source} mapboxAccessToken={MAPBOX_TOKEN} initialViewState={activeSource.view} mapStyle="mapbox://styles/mapbox/light-v11">
          {data.plants.map((plant) => {
            const size = markerSizePx(plant.installedCapacityKw, maxCapacityKw);
            return (
              <Marker key={plant.ceg} longitude={plant.longitude} latitude={plant.latitude} onClick={() => setSelected(plant)}>
                <button
                  type="button"
                  aria-label={`${plant.name}, ${plant.metric}, ${plant.state}`}
                  title={`${plant.name} (${plant.metric})`}
                  className="block cursor-pointer rounded-full border border-bg-white-0"
                  style={{ width: size, height: size, backgroundColor: MARKER_COLOR[plant.metric] }}
                />
              </Marker>
            );
          })}
          {selected ? <PlantPopup plant={selected} onClose={() => setSelected(null)} /> : null}
        </Map>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-paragraph-xs text-text-sub-600">
        {(["hydro", "wind", "solar", "thermal", "nuclear", "other"] as Metric[]).map((metric) => (
          <span key={metric} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: MARKER_COLOR[metric] }} />
            {metric}
          </span>
        ))}
      </div>
      <p className="text-paragraph-xs text-text-soft-400">{data.attribution}</p>
    </div>
  );
}
