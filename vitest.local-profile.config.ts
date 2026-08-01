import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "**/src/attunegraph-admin-readonly-inspector.test.ts",
      "**/src/attunegraph-admin-readonly-snapshot.test.ts",
      "**/src/attunegraph-admin-readonly-worker.test.ts",
      "**/src/attunegraph-admin-staging-lifecycle.test.ts",
      "**/src/local.test.ts",
      "**/scripts/benchmark-attunegraph-agent-decision-durable.test.mjs",
      "**/scripts/benchmark-attunegraph-agent-decision-mixed-durable.test.mjs",
      "**/scripts/benchmark-attunegraph-worker-resource-lifecycle.test.mjs"
    ],
    testTimeout: 15_000
  }
});
