import { configDefaults, defineConfig } from "vitest/config";

const localProfileTests = [
  "**/src/attunegraph-admin-readonly-inspector.test.ts",
  "**/src/attunegraph-admin-readonly-snapshot.test.ts",
  "**/src/attunegraph-admin-readonly-worker.test.ts",
  "**/src/attunegraph-admin-staging-lifecycle.test.ts",
  "**/src/local.test.ts"
];

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...localProfileTests,
      "**/*.qualification.test.mjs"
    ],
    testTimeout: 15_000
  }
});
