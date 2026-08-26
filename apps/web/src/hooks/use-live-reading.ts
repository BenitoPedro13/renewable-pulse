import type { ReadingEvent, Source, Zone } from "@renewable-pulse/contracts";
import { useLiveStore } from "@/providers/live-store-provider";

/** Matches the buffer key readingBufferKey() in src/stores/live-store.ts derives from a ReadingEvent. */
function key(source: Source, zone: Zone, assetId: string | null, metric: string): string {
  return `${source}|${zone}|${assetId ?? ""}|${metric}`;
}

/** The latest live-socket reading for one (source, zone, asset_id, metric) series, or undefined if none has arrived yet this session. REST snapshots (useGenerationLatest) remain the source for anything not yet seen live. */
export function useLiveReading(source: Source, zone: Zone, assetId: string | null, metric: string): ReadingEvent | undefined {
  return useLiveStore((s) => s.readings.get(key(source, zone, assetId, metric)));
}
