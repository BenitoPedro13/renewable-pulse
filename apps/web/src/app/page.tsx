import { LiveIndicator } from "@/components/dashboard/live-indicator";
import { PipelineHealthSection } from "@/components/dashboard/pipeline-health-section";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-title-h4 text-text-strong-950">Renewable Pulse</h1>
          <LiveIndicator />
        </div>
        <p className="text-paragraph-sm text-text-sub-600">
          A live instrument panel for how much of the world&apos;s electricity already comes from renewables.
        </p>
      </header>
      <PipelineHealthSection />
    </main>
  );
}
