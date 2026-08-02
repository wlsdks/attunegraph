import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import {
  createSimulatedWitnessPhaseSamples,
  installSimulatedV4Witness,
  resealSimulatedAssertionSet,
  SIMULATED_WITNESS_METADATA_SCAN_LIMIT,
  SIMULATED_WITNESS_SOURCE_REF_SCAN_LIMIT,
  simulatedV4WitnessEndpoint,
  sqliteAllocation
} from "./attunegraph-simulated-v4-witness.mjs";

const NOW = "2026-08-02T00:00:00.000Z";
const DEFAULT_ASSERTIONS = 32;
const DEFAULT_SAMPLES = 200;
const DEFAULT_WARMUP = 20;
const ADAPTIVE_SPARSE_CANDIDATE_LIMIT = 8;
const ENDPOINT_DEGREES = Object.freeze([1, 2, 4, 8, 12, 16, 24, 32]);
const SOURCE_REF_COUNTS = Object.freeze([1, 4, 8, 16, 32]);

function assertion(id, subject, predicate, object, sourceRefCount = 1) {
  return Object.freeze({
    schemaVersion: 1,
    id,
    subject: Object.freeze(subject),
    predicate,
    object: Object.freeze(object),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze(Array.from({ length: sourceRefCount }, (_, index) => Object.freeze({
      namespace: "benchmark.endpoint",
      id: `source:${id}:${index.toString().padStart(2, "0")}`
    }))),
    recordedAt: NOW,
    derivation: Object.freeze({ kind: "projection", version: "normalized-endpoint@1" })
  });
}

function workload(name, assertionCount, hubCount, endpointSourceRefCount) {
  const scope = Object.freeze({ sourceId: "normalized-endpoint", threadId: `thread:${name}` });
  const root = Object.freeze({ kind: "thread", id: scope.threadId });
  const assertions = [];
  for (let index = 0; index < hubCount; index += 1) {
    const artifact = { kind: "artifact", id: `artifact:${name}:hub:${index.toString().padStart(4, "0")}` };
    assertions.push(assertion(
      `assertion:${name}:hub:${index.toString().padStart(4, "0")}`,
      artifact,
      "LINKED_TO",
      root,
      index === 0 ? endpointSourceRefCount : 1
    ));
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
        observationKey: `normalized-endpoint:${name}:${assertionCount}:${hubCount}:${endpointSourceRefCount}`,
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
  return normalized.scanStatus === "complete"
    ? Object.freeze({ path: "normalized-candidate", assertions: normalized.assertions })
    : Object.freeze({ path: "canonical-fallback", assertions: fullProjectionEndpoint(database, scope, seed) });
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function durationProfile(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("benchmark phase profile is empty");
  return Object.freeze({
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99)
  });
}

function sampleOperations(operations, warmup, samples) {
  const durations = new Map(operations.map(({ name }) => [name, []]));
  const runRound = (round, measured) => {
    for (let offset = 0; offset < operations.length; offset += 1) {
      const operation = operations[(round + offset) % operations.length];
      if (operation === undefined) throw new Error("benchmark operation is missing");
      const started = performance.now();
      operation.run(measured);
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

async function scenario(
  directory,
  name,
  assertionCount,
  hubCount,
  endpointSourceRefCount,
  warmup,
  samples,
  allowProjectionBudgetBlock = false
) {
  const databasePath = join(directory, `${name}.sqlite`);
  const fixture = workload(name, assertionCount, hubCount, endpointSourceRefCount);
  const resource = await openSqliteAttuneGraphStore({ databasePath });
  const graph = await openAttuneGraph({ scope: fixture.scope, store: createAttuneGraphStore(resource.backend) });
  let projectionFailure;
  try {
    await graph.project(JSON.parse(JSON.stringify(fixture.command)));
  } catch (cause) {
    projectionFailure = cause;
  } finally {
    await graph.close();
    await resource.close();
  }
  if (projectionFailure !== undefined) {
    if (
      allowProjectionBudgetBlock
      && projectionFailure !== null
      && typeof projectionFailure === "object"
      && projectionFailure.code === "INVALID_INPUT"
      && projectionFailure.message === "source observation exceeds the stored projection text budget"
    ) {
      return Object.freeze({
        name,
        assertionCount,
        requestedSourceRefs: endpointSourceRefCount,
        observationBytes: Buffer.byteLength(JSON.stringify(fixture.command.observation), "utf8"),
        status: "blocked-by-production-projection-budget"
      });
    }
    throw projectionFailure;
  }
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  try {
    const baselineAllocation = sqliteAllocation(database);
    installSimulatedV4Witness(database, fixture.scope);
    const simulatedWitnessAllocation = sqliteAllocation(database);
    const allocation = Object.freeze({
      baseline: baselineAllocation,
      simulatedWitness: simulatedWitnessAllocation,
      delta: Object.freeze({
        pages: simulatedWitnessAllocation.pageCount - baselineAllocation.pageCount,
        bytes: simulatedWitnessAllocation.bytes - baselineAllocation.bytes
      })
    });
    const full = fullProjectionEndpoint(database, fixture.scope, fixture.root);
    const normalized = readAttuneGraphCurrentDecisionEndpointForMeasurement(database, {
      scope: fixture.scope,
      seed: fixture.root,
      asOf: NOW
    });
    if (
      normalized.scanStatus !== "complete"
      || JSON.stringify(full) !== JSON.stringify(normalized.assertions)
    ) {
      throw new Error(`${name} endpoint semantic identity diverged`);
    }
    const adaptive = adaptiveEndpoint(database, fixture.scope, fixture.root);
    if (JSON.stringify(full) !== JSON.stringify(adaptive.assertions)) {
      throw new Error(`${name} adaptive endpoint semantic identity diverged`);
    }
    const witnessed = simulatedV4WitnessEndpoint(database, fixture.scope, fixture.root, { asOf: NOW });
    if (JSON.stringify(full) !== JSON.stringify(witnessed)) {
      throw new Error(`${name} simulated witness endpoint semantic identity diverged`);
    }
    const witnessPhaseSamples = createSimulatedWitnessPhaseSamples();
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
      }),
      Object.freeze({
        name: "witnessedEndpoint",
        run: (measured) => simulatedV4WitnessEndpoint(database, fixture.scope, fixture.root, {
          asOf: NOW,
          phaseSamples: measured ? witnessPhaseSamples : undefined
        })
      })
    ], warmup, samples);
    const fullProfile = profiles.fullProjectionEndpoint;
    const normalizedProfile = profiles.normalizedEndpoint;
    const adaptiveProfile = profiles.adaptiveEndpoint;
    const witnessedProfile = profiles.witnessedEndpoint;
    if (
      fullProfile === undefined
      || normalizedProfile === undefined
      || adaptiveProfile === undefined
      || witnessedProfile === undefined
    ) {
      throw new Error("benchmark profile is missing");
    }
    const witnessedPhases = Object.freeze(Object.fromEntries(
      Object.entries(witnessPhaseSamples).map(([phaseName, values]) => [
        phaseName,
        durationProfile(values)
      ])
    ));
    return Object.freeze({
      name,
      assertionCount,
      requestedSourceRefs: endpointSourceRefCount,
      status: "measured",
      endpointAssertions: full.length,
      selectedSourceRefs: full.reduce((total, assertion) => total + assertion.sourceRefs.length, 0),
      sqliteAllocation: allocation,
      semanticByteIdentity: true,
      normalizedCompleteness: normalized.scanStatus,
      witnessedCompleteness: "simulated-v4-two-level-witness",
      adaptivePath: adaptive.path,
      fullProjectionEndpoint: fullProfile,
      normalizedEndpoint: normalizedProfile,
      adaptiveEndpoint: adaptiveProfile,
      witnessedEndpoint: witnessedProfile,
      witnessedPhases,
      p50SpeedupFullOverNormalized: fullProfile.p50Ms / normalizedProfile.p50Ms,
      p50SpeedupFullOverAdaptive: fullProfile.p50Ms / adaptiveProfile.p50Ms,
      p50SpeedupFullOverWitnessed: fullProfile.p50Ms / witnessedProfile.p50Ms
    });
  } finally {
    database.close();
  }
}

async function projectedWitnessFixture(directory, name, temporalDecoys = false) {
  const base = workload(name, 12, 5, 1);
  const command = JSON.parse(JSON.stringify(base.command));
  if (temporalDecoys) {
    command.observation.assertions[1].recordedAt = "2026-08-03T00:00:00.000Z";
    command.observation.assertions[2].validFrom = "2026-08-03T00:00:00.000Z";
    command.observation.assertions[3].validTo = "2026-08-01T00:00:00.000Z";
    command.observation.assertions[4].supersededAt = NOW;
  }
  const databasePath = join(directory, `${name}.sqlite`);
  const resource = await openSqliteAttuneGraphStore({ databasePath });
  const graph = await openAttuneGraph({ scope: base.scope, store: createAttuneGraphStore(resource.backend) });
  try {
    await graph.project(command);
  } finally {
    await graph.close();
    await resource.close();
  }
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  installSimulatedV4Witness(database, base.scope);
  return Object.freeze({ database, fixture: base });
}

async function simulatedWitnessFault(directory, name, mutate, options = {}) {
  const { database, fixture } = await projectedWitnessFixture(directory, name);
  try {
    mutate(database, fixture.scope);
    try {
      simulatedV4WitnessEndpoint(database, fixture.scope, fixture.root, { asOf: NOW, ...options });
      return Object.freeze({ detected: false, message: null });
    } catch (cause) {
      return Object.freeze({
        detected: true,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  } finally {
    database.close();
  }
}

export async function runSimulatedV4WitnessFalsification() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "attunegraph-witness-falsification-")));
  try {
    const temporal = await projectedWitnessFixture(directory, "temporal", true);
    let temporalSelectedAssertionIds;
    try {
      temporalSelectedAssertionIds = simulatedV4WitnessEndpoint(
        temporal.database,
        temporal.fixture.scope,
        temporal.fixture.root,
        { asOf: NOW }
      ).map((assertion) => assertion.id);
    } finally {
      temporal.database.close();
    }
    const corruptDigest = `sha256:${"0".repeat(64)}`;
    const faults = Object.freeze({
      manifestDigest: await simulatedWitnessFault(directory, "fault-manifest", (database) => {
        database.prepare("UPDATE attunegraph_current_manifest SET simulated_index_digest = ?")
          .run(corruptDigest);
      }),
      assertionMetadata: await simulatedWitnessFault(directory, "fault-assertion", (database) => {
        database.prepare("UPDATE attunegraph_current_assertion SET predicate = 'NEXT_STEP_FOR' WHERE assertion_ordinal = 0")
          .run();
      }),
      selectedSourceRefCount: await simulatedWitnessFault(directory, "fault-source-count", (database, scope) => {
        database.prepare(`
          UPDATE attunegraph_current_assertion
          SET simulated_source_ref_count = simulated_source_ref_count + 1
          WHERE assertion_id LIKE '%:hub:0000'
        `).run();
        database.prepare(`
          UPDATE attunegraph_current_manifest SET source_ref_count = source_ref_count + 1
        `).run();
        resealSimulatedAssertionSet(database, scope);
      }),
      selectedSourceRefDigest: await simulatedWitnessFault(directory, "fault-source-digest", (database, scope) => {
        database.prepare(`
          UPDATE attunegraph_current_assertion SET simulated_source_ref_digest = ?
          WHERE assertion_id LIKE '%:hub:0000'
        `).run(corruptDigest);
        resealSimulatedAssertionSet(database, scope);
      }),
      selectedSourceRefOrdinal: await simulatedWitnessFault(directory, "fault-source-ordinal", (database) => {
        database.prepare(`
          UPDATE attunegraph_current_source_ref SET source_ref_ordinal = 1
          WHERE assertion_ordinal = (
            SELECT assertion_ordinal FROM attunegraph_current_assertion
            WHERE assertion_id LIKE '%:hub:0000'
          ) AND source_ref_ordinal = 0
        `).run();
      }),
      metadataScanBound: await simulatedWitnessFault(
        directory,
        "fault-metadata-bound",
        () => {},
        { metadataScanLimit: 1 }
      ),
      selectedSourceRefScanBound: await simulatedWitnessFault(
        directory,
        "fault-source-bound",
        () => {},
        { sourceRefScanLimit: 1 }
      )
    });
    return Object.freeze({
      schema: "attunegraph-simulated-v4-witness-falsification@1",
      temporalSelectedAssertionIds: Object.freeze(temporalSelectedAssertionIds),
      faults
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
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
        1,
        warmup,
        samples
      ));
    }
    const degreeSweep = Object.freeze(degreeCells);
    const sourceRefCells = [];
    for (const sourceRefCount of SOURCE_REF_COUNTS) {
      sourceRefCells.push(await scenario(
        directory,
        `source-refs-${sourceRefCount.toString().padStart(2, "0")}`,
        assertionCount,
        1,
        sourceRefCount,
        warmup,
        samples,
        true
      ));
    }
    const sourceRefSweep = Object.freeze(sourceRefCells);
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
      schema: "attunegraph-normalized-decision-endpoint-benchmark@3",
      measurementOnly: true,
      claimEligible: false,
      provenance: startProvenance,
      runtime: Object.freeze({ node: process.version, sqlite: process.versions.sqlite ?? "unknown" }),
      workload: Object.freeze({
        assertionCount,
        samples,
        warmup,
        asOf: NOW,
        adaptiveRouting: "v4-endpoint-degree-hint-then-exact-set-proof",
        adaptiveSparseCandidateLimit: ADAPTIVE_SPARSE_CANDIDATE_LIMIT,
        sourceRefCounts: SOURCE_REF_COUNTS,
        simulatedWitnessMetadataScanLimit: SIMULATED_WITNESS_METADATA_SCAN_LIMIT,
        simulatedWitnessSourceRefScanLimit: SIMULATED_WITNESS_SOURCE_REF_SCAN_LIMIT,
        measurementOrder: "rotating-four-cell-round-robin"
      }),
      scenarios: Object.freeze({ sparse, hub, degreeSweep, sourceRefSweep }),
      exclusions: Object.freeze([
        "no-worker-or-engine-transport",
        "no-full-working-graph-bfs",
        "no-public-fast-path",
        "fresh-v4-production-store-plus-simulated-prototype-overhead-no-v3-to-v4-migration-or-durable-file-size-measurement",
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
