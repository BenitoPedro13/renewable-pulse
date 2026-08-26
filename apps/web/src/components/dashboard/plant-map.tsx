"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import Map, { Marker } from "react-map-gl/mapbox";
import { usePlants } from "@/hooks/use-plants";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/**
 * ANEEL SIGA plant registry markers (docs/tasks/TASK-live-dashboard.md
 * §2.5.1) — registry locations/attributes, not live ONS generation. Renders
 * a real map only when a Mapbox token is configured; otherwise shows the
 * real plant count/attribution without a fabricated map, since
 * react-map-gl needs a real per-account credential this repo can't invent
 * (docs/brand.md: "Mapbox access is read from a documented public client
 * env var and never hard-coded").
 */
export function PlantMap() {
  const { data, isPending, isError, error } = usePlants();

  if (isPending) {
    return <p className="text-paragraph-sm text-text-sub-600">Loading plant registry…</p>;
  }

  if (isError) {
    return (
      <p className="text-paragraph-sm text-error-base">Plant registry unavailable: {error instanceof Error ? error.message : "unknown error"}</p>
    );
  }

  if (data.unavailable) {
    return <p className="text-paragraph-sm text-error-base">ANEEL SIGA is currently unreachable — no cached plant registry available.</p>;
  }

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex flex-col gap-1 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 p-4">
        <p className="text-paragraph-sm text-text-sub-600">
          {data.plants.length.toLocaleString()} real plants loaded from {data.attribution}, but no map is rendered:
          NEXT_PUBLIC_MAPBOX_TOKEN is not configured.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="h-96 w-full overflow-hidden rounded-2xl border border-stroke-soft-200">
        <Map
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={{ longitude: -51.9, latitude: -14.2, zoom: 3.2 }}
          mapStyle="mapbox://styles/mapbox/light-v11"
        >
          {data.plants.map((plant) => (
            <Marker key={plant.ceg} longitude={plant.longitude} latitude={plant.latitude}>
              <span
                aria-label={`${plant.name}, ${plant.generationType}, ${plant.state}`}
                title={`${plant.name} (${plant.generationType})`}
                className="block h-2 w-2 rounded-full bg-primary-base"
              />
            </Marker>
          ))}
        </Map>
      </div>
      <p className="text-paragraph-xs text-text-soft-400">{data.attribution}</p>
    </div>
  );
}
