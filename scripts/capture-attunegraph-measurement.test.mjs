import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  executeBoundedMeasurement,
  parseReadinessMeasurementCaptureArguments
} from "./capture-attunegraph-measurement.mjs";
import {
  READINESS_MEASUREMENT_CAPTURE_SCHEMA_V2,
  READINESS_MEASUREMENT_PROVENANCE_SCHEMA_V2,
  READINESS_MEASUREMENT_RESULT_SCHEMA_V2
} from "./readiness-measurement-contracts.mjs";
import { READINESS_EVIDENCE_SCHEMA_V2 } from "./score-attunegraph-readiness.mjs";

const FIXED_ARGV = ["node", "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"];
const CAPTURE_ENTRYPOINT = fileURLToPath(new URL("./capture-attunegraph-measurement.mjs", import.meta.url));
let repositoryFixture;

function git(repository, arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" }).trim();
}

async function initializeRepository(path, filename) {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "measurement@example.test"]);
  git(path, ["config", "user.name", "Measurement Test"]);
  await writeFile(join(path, filename), `${filename}\n`);
  git(path, ["add", filename]);
  git(path, ["commit", "-qm", `add ${filename}`]);
}

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-measurement-protocol-"));
  const attunegraph = join(directory, "attunegraph");
  const consumer = join(directory, "consumer");
  await Promise.all([mkdir(attunegraph), mkdir(consumer)]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await initializeRepository(consumer, "consumer.txt");
  git(consumer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "vendor/attunegraph"]);
  git(consumer, ["add", ".gitmodules", "vendor/attunegraph"]);
  git(consumer, ["commit", "-qm", "bind AttuneGraph consumer gitlink"]);
  repositoryFixture = { attunegraph, consumer, directory };
});

afterAll(async () => {
  if (repositoryFixture) await rm(repositoryFixture.directory, { force: true, recursive: true });
});

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
  const expectedV1 = {
    argv: FIXED_ARGV,
    attunegraphRepository: "/tmp/attunegraph",
    cwd: "/tmp/attunegraph",
    museGitlinkPath: "packages/attunegraph",
    museRepository: "/tmp/muse",
    name: "mixed-durable-agent-decision-observation",
    outputDirectory: "/tmp/attunegraph-measurements",
    producerMode: "local-unattested"
  };
  expect(JSON.stringify(parseReadinessMeasurementCaptureArguments(argumentsFor())))
    .toBe(JSON.stringify(expectedV1));
  expect(JSON.stringify(parseReadinessMeasurementCaptureArguments([
    "--evidence-schema=attunegraph-readiness-evidence@1",
    ...argumentsFor()
  ]))).toBe(JSON.stringify(expectedV1));
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

it("captures a V2 measurement envelope for a generic consumer subject", async () => {
  const output = join(repositoryFixture.directory, "evidence-v2");
  const args = [
    `--evidence-schema=${READINESS_EVIDENCE_SCHEMA_V2}`,
    "--name=mixed-durable-agent-decision-observation",
    `--output-directory=${output}`,
    `--attunegraph-repository=${repositoryFixture.attunegraph}`,
    `--consumer-repository=${repositoryFixture.consumer}`,
    "--consumer-gitlink=vendor/attunegraph",
    `--cwd=${repositoryFixture.attunegraph}`,
    "--",
    ...FIXED_ARGV
  ];
  expect(parseReadinessMeasurementCaptureArguments(args)).toMatchObject({
    consumerGitlinkPath: "vendor/attunegraph",
    consumerRepository: repositoryFixture.consumer,
    evidenceSchema: READINESS_EVIDENCE_SCHEMA_V2
  });
  const result = spawnSync(process.execPath, [CAPTURE_ENTRYPOINT, ...args], {
    encoding: "utf8",
    timeout: 20_000
  });
  expect(result.status).toBe(0);
  const descriptor = JSON.parse(result.stdout);
  expect(descriptor).toMatchObject({
    schema: READINESS_MEASUREMENT_CAPTURE_SCHEMA_V2,
    subject: { consumer: { attunegraphGitlink: { path: "vendor/attunegraph" } } }
  });
  expect(descriptor.subject).not.toHaveProperty("muse");
  const captured = JSON.parse(await readFile(join(output, descriptor.measurement.result.path), "utf8"));
  expect(captured).toMatchObject({
    cwd: realpathSync(repositoryFixture.attunegraph),
    provenance: {
      producer: "capture-attunegraph-measurement@2",
      schema: READINESS_MEASUREMENT_PROVENANCE_SCHEMA_V2
    },
    schema: READINESS_MEASUREMENT_RESULT_SCHEMA_V2
  });
  expect(captured.subject).not.toHaveProperty("muse");
});

it("rejects mixed and future measurement profiles before repository access", () => {
  expect(() => parseReadinessMeasurementCaptureArguments([
    `--evidence-schema=${READINESS_EVIDENCE_SCHEMA_V2}`,
    ...argumentsFor().slice(0, -FIXED_ARGV.length - 1),
    "--consumer-repository=/tmp/consumer",
    "--consumer-gitlink=vendor/attunegraph",
    "--",
    ...FIXED_ARGV
  ])).toThrow(/must not mix V1 Muse and V2 consumer arguments/u);
  expect(() => parseReadinessMeasurementCaptureArguments([
    "--evidence-schema=attunegraph-readiness-evidence@1",
    ...argumentsFor().slice(0, -FIXED_ARGV.length - 1).filter((argument) => (
      !argument.startsWith("--muse-repository=")
    )),
    "--consumer-repository=/tmp/consumer",
    "--consumer-gitlink=vendor/attunegraph",
    "--",
    ...FIXED_ARGV
  ])).toThrow(/must not mix V1 Muse and V2 consumer arguments/u);
  expect(() => parseReadinessMeasurementCaptureArguments([
    "--evidence-schema=attunegraph-readiness-evidence@3",
    ...argumentsFor()
  ])).toThrow(/unsupported readiness evidence schema/u);
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
