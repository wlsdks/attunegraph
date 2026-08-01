import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const forbiddenPackedBytes = [
  "@muse/",
  "workspace:",
  "packages/muse-attunegraph",
  "/Users/"
];

function fail(message, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`${message}${output ? `\n${output}` : ""}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`, result);
  return result.stdout;
}

function runExpectedFailure(command, args, expected, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} must fail closed`);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  assert.match(output, expected, `${command} ${args.join(" ")} must explain its refusal`);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|ENOENT.*pnpm-lock/u);
}

function runJsonCommand(command, args, expectedSchema, options = {}, maxOutputBytes) {
  const stdout = run(command, args, options);
  assert.notEqual(stdout.trim(), "", `${command} ${args.join(" ")} must emit JSON`);
  if (maxOutputBytes !== undefined) {
    assert.ok(
      Buffer.byteLength(stdout, "utf8") <= maxOutputBytes,
      `${command} ${args.join(" ")} must emit at most ${maxOutputBytes} bytes`
    );
  }
  const report = JSON.parse(stdout);
  assert.equal(report.schema, expectedSchema);
  return report;
}

function verifyPrivateTemporaryDirectory(directory) {
  const metadata = statSync(directory);
  assert.equal(metadata.isDirectory(), true, "clean-room root must be a directory");
  assert.equal(metadata.mode & 0o077, 0, "clean-room root must not be group/world accessible");
  if (typeof process.getuid === "function") {
    assert.equal(metadata.uid, process.getuid(), "clean-room root must be owned by this user");
  }
}

function scanInstalledBytes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      scanInstalledBytes(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(path);
    for (const forbidden of forbiddenPackedBytes) {
      assert.equal(
        bytes.includes(Buffer.from(forbidden)),
        false,
        `packed installed byte leak (${forbidden}) in ${relative(directory, path)}`
      );
    }
  }
}

const consumerProof = String.raw`import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "@attunegraph/core";
const installedRoot = resolve("node_modules", "@attunegraph", "core");
const resolvedRoot = fileURLToPath(import.meta.resolve(packageName));
const resolvedRelative = relative(installedRoot, resolvedRoot);
assert.equal(isAbsolute(resolvedRelative), false, "root export must resolve from consumer node_modules");
assert.equal(
  resolvedRelative === ".." || resolvedRelative.startsWith(".." + sep),
  false,
  "root export must resolve from consumer node_modules"
);

const manifest = JSON.parse(readFileSync(resolve(installedRoot, "package.json"), "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  assert.equal(manifest[field], undefined, "packed manifest must not declare " + field);
}

for (const exportKey of Object.keys(manifest.exports)) {
  const specifier = exportKey === "." ? packageName : packageName + exportKey.slice(1);
  await import(specifier);
}

for (const entry of manifest.files.filter((value) => value.endsWith(".mjs"))) {
  await import(pathToFileURL(realpathSync(resolve(installedRoot, entry))).href);
}

const { prepareAttuneGraphRuntime } = await import(
  pathToFileURL(resolve(installedRoot, "scripts/prepare-attunegraph-runtime.mjs")).href
);
assert.equal(
  prepareAttuneGraphRuntime({ packageRoot: installedRoot }).mode,
  "installed-artifact",
  "packed runtime preparation must validate bytes without a source compiler"
);

const { captureSourceCheckoutProvenance } = await import(
  pathToFileURL(resolve(installedRoot, "scripts/source-checkout-provenance.mjs")).href
);
assert.throws(
  () => captureSourceCheckoutProvenance({ packageRoot: installedRoot }),
  /revision-bound AttuneGraph evidence requires a source checkout/u,
  "installed tools must not borrow the consumer repository identity"
);

const { parseReadinessCaptureArguments } = await import(
  pathToFileURL(resolve(installedRoot, "scripts/capture-attunegraph-readiness.mjs")).href
);
assert.equal(parseReadinessCaptureArguments([
  "--",
  "--name=inspect",
  "--output-directory=/tmp/evidence",
  "--attunegraph-repository=/tmp/attunegraph",
  "--muse-repository=/tmp/muse",
  "--cwd=/tmp/attunegraph",
  "--"
]).name, "inspect");

const { parseReadinessMeasurementCaptureArguments } = await import(
  pathToFileURL(resolve(installedRoot, "scripts/capture-attunegraph-measurement.mjs")).href
);
assert.equal(parseReadinessMeasurementCaptureArguments([
  "--",
  "--name=mixed-durable-agent-decision-observation",
  "--producer-mode=local-unattested",
  "--output-directory=/tmp/measurements",
  "--attunegraph-repository=/tmp/attunegraph",
  "--muse-repository=/tmp/muse",
  "--cwd=/tmp/attunegraph",
  "--",
  "node",
  "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"
]).name, "mixed-durable-agent-decision-observation");

await assert.rejects(
  import("@attunegraph/core/attunegraph-engine"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "private source subpaths must reject"
);

const { openAttuneGraph } = await import(packageName);
const {
  defineAttuneGraphSourceAdapter,
  projectAttuneGraphSource
} = await import("@attunegraph/core/source-adapter");
const { createInMemoryAttuneGraphStore } = await import("@attunegraph/core/testing");
const scope = { sourceId: "clean-room-consumer", threadId: "release-proof" };
const threadRoot = { id: "thread:release-proof", kind: "thread" };
const now = "2026-07-31T09:00:00.000Z";
const later = "2026-07-31T09:00:01.000Z";
const graph = await openAttuneGraph({ scope, store: createInMemoryAttuneGraphStore() });

try {
  const observation = {
    schemaVersion: 2,
    observationKey: "clean-room-release-proof",
    scope,
    threadRoot,
    observedAt: now,
    sourceFreshness: { state: "fresh", observedAt: now },
    assertions: [{
      schemaVersion: 1,
      id: "clean-room-artifact-linked-to-thread",
      subject: { id: "artifact:clean-room", kind: "artifact" },
      predicate: "LINKED_TO",
      object: { ...threadRoot },
      epistemicClass: "source-observed",
      sourceRefs: [{ namespace: "clean-room.example", id: "release-proof" }],
      recordedAt: now,
      derivation: { kind: "projection", version: "clean-room@1" }
    }]
  };
  const adapter = defineAttuneGraphSourceAdapter({
    capabilities: {
      maxAssertionsPerExtraction: 4,
      sourceKinds: ["markdown"],
      supportsIncremental: false
    },
    extract: (hostInput) => ({ assertions: hostInput.assertions }),
    metadata: {
      id: "clean.room.markdown",
      label: "Clean-room Markdown",
      version: "1"
    }
  });
  const firstProjection = await projectAttuneGraphSource({
    adapter,
    attuneGraph: graph,
    correlationKey: "clean-room-release-proof",
    input: { assertions: observation.assertions },
    observedAt: now,
    scope,
    sourceFreshness: { state: "fresh", observedAt: now },
    sourceKind: "markdown",
    threadRoot
  });
  const snapshot = await graph.projectAgainstHead({
    operator: "canonical-projection@2",
    observation: {
      ...observation,
      observationKey: "clean-room-release-proof-update",
      observedAt: later,
      sourceFreshness: { state: "fresh", observedAt: later }
    }
  });
  const result = await graph.execute({
    operator: "working-graph@1",
    seed: threadRoot,
    now: later,
    maxEstimatedTokens: 500
  });
  assert.equal(snapshot.scope.threadId, scope.threadId);
  assert.equal(firstProjection.snapshot.generation, 1);
  assert.equal(firstProjection.observation.schemaVersion, 2);
  assert.match(firstProjection.observation.observationKey, /clean\.room\.markdown/);
  assert.equal(snapshot.generation, 2);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.workingGraph.seed, threadRoot);
  assert.equal(result.workingGraph.assertions.length, 1);
} finally {
  await graph.close();
}
`;

const cleanRoom = mkdtempSync(join(tmpdir(), "attunegraph-clean-room-"));
chmodSync(cleanRoom, 0o700);

try {
  verifyPrivateTemporaryDirectory(cleanRoom);
  const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", cleanRoom]));
  assert.equal(packed.length, 1, "npm pack must produce exactly one artifact");
  const tarball = join(cleanRoom, packed[0].filename);
  const consumer = join(cleanRoom, "consumer");
  mkdirSync(consumer, { mode: 0o700 });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "attunegraph-clean-room-consumer", private: true }),
    { mode: 0o600 }
  );
  run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer
  });
  const installedRoot = realpathSync(join(consumer, "node_modules", "@attunegraph", "core"));
  scanInstalledBytes(installedRoot);
  writeFileSync(join(consumer, "consumer-proof.mjs"), consumerProof, { mode: 0o600 });
  run(process.execPath, ["consumer-proof.mjs"], { cwd: consumer });
  run(npm, ["run", "build", "--silent"], { cwd: installedRoot });
  runJsonCommand(
    npm,
    ["run", "verify:working-graph-golden", "--silent"],
    "attunegraph-working-graph-golden-report@1",
    { cwd: installedRoot }
  );
  runJsonCommand(
    npm,
    ["run", "benchmark:agent-decision-read-durable", "--silent"],
    "attunegraph-agent-decision-durable-tracer@1",
    { cwd: installedRoot }
  );
  runJsonCommand(
    npm,
    ["run", "benchmark:agent-decision-mixed-durable", "--silent"],
    "attunegraph-agent-decision-mixed-durable-tracer@1",
    { cwd: installedRoot }
  );
  const workerLifecycle = runJsonCommand(
    npm,
    ["run", "benchmark:worker-resource-lifecycle", "--silent"],
    "attunegraph-worker-resource-lifecycle@1",
    { cwd: installedRoot },
    128 * 1_024
  );
  assert.equal(workerLifecycle.measurementOnly, true);
  assert.equal(workerLifecycle.claimEligible, false);
  assert.equal(workerLifecycle.correctness.cyclesCompleted, 4);
  assert.equal(workerLifecycle.correctness.workerHeapSamples, 12);
  const installedAlias = join(cleanRoom, "installed-alias");
  symlinkSync(installedRoot, installedAlias, process.platform === "win32" ? "junction" : "dir");
  runJsonCommand(
    process.execPath,
    [join(installedAlias, "scripts", "benchmark-attunegraph-agent-decision-mixed-durable.mjs")],
    "attunegraph-agent-decision-mixed-durable-tracer@1",
    { cwd: consumer }
  );
  runExpectedFailure(
    npm,
    [
      "run",
      "benchmark:scale",
      "--silent",
      "--",
      "--scale=10000",
      "--profile=core",
      "--warmups=0",
      "--repetitions=1"
    ],
    /revision-bound AttuneGraph evidence requires a source checkout at the repository root/u,
    { cwd: installedRoot }
  );
} finally {
  rmSync(cleanRoom, { force: true, recursive: true });
}
