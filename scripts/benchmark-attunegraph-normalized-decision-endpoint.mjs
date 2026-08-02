import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { createAttuneGraphStore } from "../dist/attunegraph-backend.js";
import {
  readAttuneGraphCurrentDecisionEndpointForMeasurement
} from "../dist/attunegraph-current-head-index.mjs";
import { openAttuneGraph } from "../dist/attunegraph-engine.js";
import { parseProjection } from "../dist/attunegraph-local-projection.mjs";
import { decodeAttuneGraphProjectionJson } from "../dist/attunegraph-projection-codec.mjs";
import { openSqliteAttuneGraphStore } from "../dist/attunegraph-sqlite-store.js";
import { ACTIVATION_PREDICATES } from "../dist/constants.js";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { captureContentAddressedSourceCheckoutProvenance } from "./source-checkout-provenance.mjs";

const NOW = "2026-08-02T00:00:00.000Z";
const DEFAULT_ASSERTIONS = 32;
const DEFAULT_SAMPLES = 200;
const DEFAULT_WARMUP = 20;
const ADAPTIVE_SPARSE_CANDIDATE_LIMIT = 8;
const ENDPOINT_DEGREES = Object.freeze([1, 2, 4, 8, 12, 16, 24, 32]);

function assertion(id, subject, predicate, object) {
  return Object.freeze({
    schemaVersion: 1,
    id,
    subject: Object.freeze(subject),
    predicate,
    object: Object.freeze(object),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({ namespace: "benchmark.endpoint", id: `source:${id}` })]),
    recordedAt: NOW,
    derivation: Object.freeze({ kind: "projection", version: "normalized-endpoint@1" })
  });
}

function workload(name, assertionCount, hubCount) {
  const scope = Object.freeze({ sourceId: "normalized-endpoint", threadId: `thread:${name}` });
  const root = Object.freeze({ kind: "thread", id: scope.threadId });
  const assertions = [];
  for (let index = 0; index < hubCount; index += 1) {
    const artifact = { kind: "artifact", id: `artifact:${name}:hub:${index.toString().padStart(4, "0")}` };
    assertions.push(assertion(`assertion:${name}:hub:${index.toString().padStart(4, "0")}`, artifact, "LINKED_TO", root));
  }
  let previous = { kind: "artifact", id: `artifact:${name}:hub:0000` };
  for (let index = hubCount; index < assertionCount; index += 1) {
    const next = { kind: "artifact", id: `artifact:${name}:chain:${index.toString().padStart(4, "0")}` };
    assertions.push(assertion(`assertion:${name}:chain:${index.toString().padStart(4, "0")}`, next, "REVISION_OF", previous));
    previous = next;
  }
  return Object.freeze({
    scope,
    root,
    command: Object.freeze({
      operator: "canonical-projection@2",
      observation: Object.freeze({
        schemaVersion: 2,
        observationKey: `normalized-endpoint:${name}:${assertionCount}:${hubCount}`,
        scope,
        threadRoot: root,
        observedAt: NOW,
        sourceFreshness: Object.freeze({ state: "fresh", observedAt: NOW }),
        assertions: Object.freeze(assertions)
      })
    })
  });
}

function eligible(assertion, seed) {
  return ACTIVATION_PREDICATES.includes(assertion.predicate)
    && ((assertion.subject.kind === seed.kind && assertion.subject.id === seed.id)
      || (assertion.object.kind === seed.kind && assertion.object.id === seed.id))
    && assertion.recordedAt <= NOW
    && (assertion.supersededAt === undefined || assertion.supersededAt > NOW)
    && (assertion.validFrom === undefined || assertion.validFrom <= NOW)
    && (assertion.validTo === undefined || assertion.validTo > NOW);
}

function fullProjectionEndpoint(database, scope, seed) {
  const rows = database.prepare(`
    SELECT j.projection_encoding AS projectionEncoding,
           j.projection_payload AS projectionPayload,
           j.projection_uncompressed_bytes AS projectionUncompressedBytes,
           j.projection_payload_sha256 AS projectionPayloadSha256
    FROM attunegraph_projection_head AS h
    JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    WHERE h.source_id = ? AND h.thread_id = ? LIMIT 2
  `).all(scope.sourceId, scope.threadId);
  if (rows.length !== 1) throw new Error("full projection endpoint head is invalid");
  const row = rows[0];
  const json = decodeAttuneGraphProjectionJson({
    encoding: row.projectionEncoding,
    payload: row.projectionPayload,
    payloadFingerprint: row.projectionPayloadSha256,
    uncompressedBytes: Number(row.projectionUncompressedBytes)
  });
  const projection = parseProjection(JSON.parse(json), scope);
  return Object.freeze(projection.assertions.filter((entry) => eligible(entry, seed)).sort((left, right) =>
    (left.predicate < right.predicate ? -1 : left.predicate > right.predicate ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));
}

function adaptiveEndpoint(database, scope, seed) {
  const normalized = readAttuneGraphCurrentDecisionEndpointForMeasurement(database, {
    scope,
    seed,
    asOf: NOW,
    maxCandidateAssertions: ADAPTIVE_SPARSE_CANDIDATE_LIMIT
  });
  return normalized.scanStatus === "built-unverified"
    ? Object.freeze({ path: "normalized-candidate", assertions: normalized.assertions })
    : Object.freeze({ path: "canonical-fallback", assertions: fullProjectionEndpoint(database, scope, seed) });
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function sampleOperations(operations, warmup, samples) {
  const durations = new Map(operations.map(({ name }) => [name, []]));
  const runRound = (round, measured) => {
    for (let offset = 0; offset < operations.length; offset += 1) {
      const operation = operations[(round + offset) % operations.length];
      if (operation === undefined) throw new Error("benchmark operation is missing");
      const started = performance.now();
      operation.run();
      if (measured) durations.get(operation.name)?.push(performance.now() - started);
    }
  };
  for (let index = 0; index < warmup; index += 1) runRound(index, false);
  for (let index = 0; index < samples; index += 1) runRound(index, true);
  return Object.freeze(Object.fromEntries([...durations].map(([name, values]) => {
    values.sort((left, right) => left - right);
    return [name, Object.freeze({
      samples,
      p50Ms: percentile(values, 0.50),
      p95Ms: percentile(values, 0.95),
      p99Ms: percentile(values, 0.99)
    })];
  })));
}

async function scenario(directory, name, assertionCount, hubCount, warmup, samples) {
  const databasePath = join(directory, `${name}.sqlite`);
  const fixture = workload(name, assertionCount, hubCount);
  const resource = await openSqliteAttuneGraphStore({ databasePath });
  const graph = await openAttuneGraph({ scope: fixture.scope, store: createAttuneGraphStore(resource.backend) });
  await graph.project(JSON.parse(JSON.stringify(fixture.command)));
  await graph.close();
  await resource.close();
  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  try {
    const full = fullProjectionEndpoint(database, fixture.scope, fixture.root);
    const normalized = readAttuneGraphCurrentDecisionEndpointForMeasurement(database, {
      scope: fixture.scope,
      seed: fixture.root,
      asOf: NOW
    });
    if (
      normalized.scanStatus !== "built-unverified"
      || JSON.stringify(full) !== JSON.stringify(normalized.assertions)
    ) {
      throw new Error(`${name} endpoint semantic identity diverged`);
    }
    const adaptive = adaptiveEndpoint(database, fixture.scope, fixture.root);
    if (JSON.stringify(full) !== JSON.stringify(adaptive.assertions)) {
      throw new Error(`${name} adaptive endpoint semantic identity diverged`);
    }
    const profiles = sampleOperations([
      Object.freeze({
        name: "fullProjectionEndpoint",
        run: () => fullProjectionEndpoint(database, fixture.scope, fixture.root)
      }),
      Object.freeze({
        name: "normalizedEndpoint",
        run: () => readAttuneGraphCurrentDecisionEndpointForMeasurement(database, {
          scope: fixture.scope,
          seed: fixture.root,
          asOf: NOW
        })
      }),
      Object.freeze({
        name: "adaptiveEndpoint",
        run: () => adaptiveEndpoint(database, fixture.scope, fixture.root)
      })
    ], warmup, samples);
    const fullProfile = profiles.fullProjectionEndpoint;
    const normalizedProfile = profiles.normalizedEndpoint;
    const adaptiveProfile = profiles.adaptiveEndpoint;
    if (fullProfile === undefined || normalizedProfile === undefined || adaptiveProfile === undefined) {
      throw new Error("benchmark profile is missing");
    }
    return Object.freeze({
      name,
      assertionCount,
      endpointAssertions: full.length,
      databaseBytes: statSync(databasePath).size,
      semanticByteIdentity: true,
      normalizedCompleteness: normalized.scanStatus,
      adaptivePath: adaptive.path,
      fullProjectionEndpoint: fullProfile,
      normalizedEndpoint: normalizedProfile,
      adaptiveEndpoint: adaptiveProfile,
      p50SpeedupFullOverNormalized: fullProfile.p50Ms / normalizedProfile.p50Ms,
      p50SpeedupFullOverAdaptive: fullProfile.p50Ms / adaptiveProfile.p50Ms
    });
  } finally {
    database.close();
  }
}

export async function runNormalizedDecisionEndpointBenchmark({
  assertionCount = DEFAULT_ASSERTIONS,
  samples = DEFAULT_SAMPLES,
  warmup = DEFAULT_WARMUP
} = {}) {
  if (assertionCount !== DEFAULT_ASSERTIONS) {
    throw new Error("normalized endpoint assertion count is invalid");
  }
  if (!Number.isSafeInteger(samples) || samples < 3 || samples > 10_000) {
    throw new Error("normalized endpoint sample count is invalid");
  }
  if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 1_000) {
    throw new Error("normalized endpoint warmup is invalid");
  }
  const startProvenance = captureContentAddressedSourceCheckoutProvenance();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "attunegraph-normalized-endpoint-")));
  try {
    const degreeCells = [];
    for (const degree of ENDPOINT_DEGREES) {
      degreeCells.push(await scenario(
        directory,
        `degree-${degree.toString().padStart(2, "0")}`,
        assertionCount,
        degree,
        warmup,
        samples
      ));
    }
    const degreeSweep = Object.freeze(degreeCells);
    const sparse = degreeSweep[0];
    const hub = degreeSweep[degreeSweep.length - 1];
    if (sparse === undefined || hub === undefined) {
      throw new Error("normalized endpoint degree sweep is invalid");
    }
    const endProvenance = captureContentAddressedSourceCheckoutProvenance();
    if (JSON.stringify(startProvenance) !== JSON.stringify(endProvenance)) {
      throw new Error("normalized endpoint benchmark source changed during measurement");
    }
    const body = Object.freeze({
      schema: "attunegraph-normalized-decision-endpoint-benchmark@1",
      measurementOnly: true,
      claimEligible: false,
      provenance: startProvenance,
      runtime: Object.freeze({ node: process.version, sqlite: process.versions.sqlite ?? "unknown" }),
      workload: Object.freeze({
        assertionCount,
        samples,
        warmup,
        asOf: NOW,
        adaptiveSparseCandidateLimit: ADAPTIVE_SPARSE_CANDIDATE_LIMIT,
        measurementOrder: "rotating-three-cell-round-robin"
      }),
      scenarios: Object.freeze({ sparse, hub, degreeSweep }),
      exclusions: Object.freeze([
        "no-worker-or-engine-transport",
        "no-full-working-graph-bfs",
        "no-public-fast-path",
        "single-host-no-sla"
      ])
    });
    return Object.freeze({
      ...body,
      artifactIdentity: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  runNormalizedDecisionEndpointBenchmark().then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    (cause) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  );
}
