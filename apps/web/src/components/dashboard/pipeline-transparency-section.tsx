import { DataProvenance } from "@/components/dashboard/data-provenance";
import { DlqPreview } from "@/components/dashboard/dlq-preview";
import { IngestionThroughputChart } from "@/components/dashboard/ingestion-throughput-chart";

/**
 * The deeper half of "pipeline health" deferred in docs/tasks/
 * TASK-live-dashboard.md §2.7 and built per
 * docs/tasks/TASK-pipeline-transparency-panel.md: real ingestion throughput,
 * a real DLQ preview, and real data-provenance facts — not just the three
 * headline numbers PipelineHealthSection already shows. Kept as its own
 * section (not folded into PipelineHealthSection) so the two stay legible:
 * one is "is it healthy right now", this one is "here's what's actually
 * happening and where the data comes from".
 */
export function PipelineTransparencySection() {
  return (
    <section aria-labelledby="pipeline-transparency-heading" className="flex flex-col gap-4">
      <h2 id="pipeline-transparency-heading" className="text-label-lg text-text-strong-950">
        Pipeline transparency
      </h2>
      <IngestionThroughputChart />
      <div className="flex flex-col gap-2">
        <h3 className="text-subheading-sm text-text-sub-600 uppercase">Dead-letter queue</h3>
        <DlqPreview />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-subheading-sm text-text-sub-600 uppercase">Data provenance</h3>
        <DataProvenance />
      </div>
    </section>
  );
}
