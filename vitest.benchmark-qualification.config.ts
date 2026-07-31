import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "**/scripts/benchmark-attunegraph-scale.qualification.test.mjs",
      "**/scripts/benchmark-attunegraph-agent-decision-read-scale.qualification.test.mjs"
    ],
    testTimeout: 120_000
  }
});
