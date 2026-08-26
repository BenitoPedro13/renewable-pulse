import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Six of this package's spec files each spin up their own real
    // TimescaleDB and/or Redpanda testcontainer (CLAUDE.md: integration
    // tests must hit real infra, never mocks). Running them as separate
    // Vitest workers in parallel starts that many containers at once and
    // reliably starves each other past the 60s beforeAll hook timeout on a
    // single dev machine — every file passes on its own. Serializing files
    // trades wall-clock time for a suite that actually completes.
    fileParallelism: false,
  },
});
