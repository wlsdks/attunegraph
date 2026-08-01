import { expect, it } from "vitest";

import {
  executeBoundedMeasurement,
  parseReadinessMeasurementCaptureArguments
} from "./capture-attunegraph-measurement.mjs";

const FIXED_ARGV = ["node", "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"];

function argumentsFor(argv = FIXED_ARGV) {
  return [
    "--name=mixed-durable-agent-decision-observation",
    "--output-directory=/tmp/attunegraph-measurements",
    "--attunegraph-repository=/tmp/attunegraph",
    "--muse-repository=/tmp/muse",
    "--cwd=/tmp/attunegraph",
    "--",
    ...argv
  ];
}

it("accepts only the fixed unscored measurement command", () => {
  expect(parseReadinessMeasurementCaptureArguments(argumentsFor())).toMatchObject({
    argv: FIXED_ARGV,
    name: "mixed-durable-agent-decision-observation",
    producerMode: "local-unattested"
  });
  expect(parseReadinessMeasurementCaptureArguments(["--", ...argumentsFor()])).toMatchObject({
    argv: FIXED_ARGV,
    name: "mixed-durable-agent-decision-observation",
    producerMode: "local-unattested"
  });
  expect(() => parseReadinessMeasurementCaptureArguments(argumentsFor([
    "node",
    "--version"
  ]))).toThrow(/fixed contract/u);
  expect(() => parseReadinessMeasurementCaptureArguments([
    ...argumentsFor(),
    "--producer-mode=github-actions-attested"
  ])).toThrow();
});

it("bounds child output and execution time under a sanitized environment", async () => {
  const success = await executeBoundedMeasurement(
    process.execPath,
    ["-e", "process.stdout.write(process.env.NODE_ENV ?? 'missing')"],
    process.cwd(),
    { maxStderrBytes: 64, maxStdoutBytes: 64, timeoutMilliseconds: 2_000 }
  );
  expect(success).toMatchObject({ exitCode: 0, signal: null, spawnError: null });
  expect(success.stdout.toString("utf8")).toBe("production");

  const overflow = await executeBoundedMeasurement(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(128))"],
    process.cwd(),
    { maxStderrBytes: 64, maxStdoutBytes: 32, timeoutMilliseconds: 2_000 }
  );
  expect(overflow.spawnError).toMatch(/OUTPUT_LIMIT/u);
  expect(overflow.stdout.length).toBeLessThanOrEqual(32);

  const timeout = await executeBoundedMeasurement(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    process.cwd(),
    { maxStderrBytes: 64, maxStdoutBytes: 64, timeoutMilliseconds: 50 }
  );
  expect(timeout.spawnError).toMatch(/TIMEOUT/u);
});
