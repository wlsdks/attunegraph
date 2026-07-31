import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.qualification.test.mjs"
    ],
    testTimeout: 15_000
  }
});
