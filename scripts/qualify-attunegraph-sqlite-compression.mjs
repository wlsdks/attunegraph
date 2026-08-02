import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync
} from "node:zlib";

import { openAttuneGraph } from "@attunegraph/core";
import { createAttuneGraphStore } from "@attunegraph/core/backend";
import { InMemoryAttuneGraphStoreBackend } from "@attunegraph/core/testing";
import { openSqliteAttuneGraphStore } from "../dist/attunegraph-sqlite-store.js";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "../dist/attunegraph-physical-schema-v1.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V2 } from "../dist/attunegraph-physical-schema-v2.mjs";
import {
  createBenchmarkCorpusPlan,
  createBenchmarkShard,
  runScaleBenchmark
} from "./benchmark-attunegraph-scale.mjs";
import { captureSourceCheckoutProvenance } from "./source-checkout-provenance.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const MAX_DURABLE_PROJECTION_BYTES = 1_048_576;
const SQLITE_REPRESENTATIVE_ROWS = 313;
const DURABLE_PROFILE_REPETITIONS = 101;
const MAX_RAW_SCALE_REPORT_BYTES = 16 * 1_024 * 1_024;
const MAX_PROVENANCE_TEXT_LENGTH = 512;
const MAX_COMMAND_ARGUMENTS = 32;
const QUALIFICATION_COMMAND = "corepack pnpm --silent benchmark:sqlite-compression-qualification";
const HEX_REVISION = /^[0-9a-f]{40}$/u;
const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/u;
const ISO_UTC_MILLISECONDS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function distribution(samples) {
  return Object.freeze({
    maxMicroseconds: Math.max(...samples),
    p50Microseconds: percentile(samples, 0.5),
    p95Microseconds: percentile(samples, 0.95),
    p99Microseconds: percentile(samples, 0.99),
    sampleCount: samples.length,
    samplesMicroseconds: Object.freeze(samples)
  });
}

function boundedIdentityText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROVENANCE_TEXT_LENGTH
    && value.trim() === value;
}

function exactOwnKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactIsoUtc(value) {
  if (!boundedIdentityText(value) || !ISO_UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function denseBoundedArguments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMAND_ARGUMENTS) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !boundedIdentityText(value[index])) return false;
  }
  return true;
}

export function evaluateSelectedIntegrationGate(ratios, ceiling = 1.2) {
  if (
    typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 1
    || ratios === null || typeof ratios !== "object"
  ) throw new TypeError("selected integration gate input is invalid");
  const cells = [ratios.projection, ratios.warmRead, ratios.coldReopenedRead];
  if (cells.some((cell) =>
    cell === null || typeof cell !== "object"
    || typeof cell.p50 !== "number" || !Number.isFinite(cell.p50) || cell.p50 < 0
    || typeof cell.p95 !== "number" || !Number.isFinite(cell.p95) || cell.p95 < 0
    || typeof cell.p99 !== "number" || !Number.isFinite(cell.p99) || cell.p99 < 0
  )) throw new TypeError("selected integration gate ratios are invalid");
  return Object.freeze({
    ceiling,
    gatePercentiles: Object.freeze(["p50", "p95"]),
    monitoringPercentiles: Object.freeze(["p99"]),
    p99Interpretation: "101-sample nearest-rank p99 is monitoring-only",
    passes: cells.every((cell) => cell.p50 <= ceiling && cell.p95 <= ceiling)
  });
}

/** @param {any} report @param {any} physical @param {readonly string[]} commandArgs @param {string} zlib @param {string} executable */
export function summarizeSettledScaleEvidence(
  report,
  physical,
  commandArgs,
  zlib,
  executable = QUALIFICATION_COMMAND
) {
  if (
    report?.schema !== "attunegraph-scale-benchmark@1"
    || report.claimEligible !== false
    || report.measurementOnly !== true
    || report.configuration?.profile !== "local-session"
    || report.configuration?.warmups !== 0
    || report.configuration?.repetitions !== 1
    || ![10_000, 100_000, 1_000_000].includes(report.configuration?.scale)
    || report.corpus?.schema !== "attunegraph-benchmark-corpus-manifest@1"
    || !boundedIdentityText(report.corpus.seed)
    || !SHA256_IDENTITY.test(report.corpus.sha256)
    || !positiveSafeInteger(report.corpus.assertionCount)
    || report.corpus?.assertionCount !== report.configuration.scale
    || !positiveSafeInteger(report.corpus.shardCount)
    || !positiveSafeInteger(report.corpus.maxAssertionsPerShard)
    || report.corpus.shardCount
      !== Math.ceil(report.corpus.assertionCount / report.corpus.maxAssertionsPerShard)
    || !positiveSafeInteger(report.operations?.projectedAssertions)
    || report.operations?.projectedAssertions !== report.configuration.scale
    || !positiveSafeInteger(report.operations?.projections)
    || report.operations?.projections !== report.corpus?.shardCount
    || !Array.isArray(report.metrics?.databaseBytes)
    || report.metrics.databaseBytes.length !== 1
    || !exactIsoUtc(report.observedAt)
    || !exactOwnKeys(report.repository, ["clean", "commit", "lockfileSha256", "tree"])
    || typeof report.repository?.clean !== "boolean"
    || !HEX_REVISION.test(report.repository.commit)
    || !HEX_REVISION.test(report.repository.tree)
    || !SHA256_IDENTITY.test(report.repository.lockfileSha256)
    || !exactOwnKeys(report.host, [
      "arch",
      "cpuCount",
      "cpuModel",
      "node",
      "os",
      "pnpm",
      "sqlite",
      "totalMemoryBytes"
    ])
    || !boundedIdentityText(report.host.arch)
    || !positiveSafeInteger(report.host.cpuCount)
    || !boundedIdentityText(report.host.cpuModel)
    || !boundedIdentityText(report.host.node)
    || !boundedIdentityText(report.host.os)
    || !boundedIdentityText(report.host.pnpm)
    || !boundedIdentityText(report.host.sqlite)
    || !positiveSafeInteger(report.host.totalMemoryBytes)
    || !boundedIdentityText(zlib)
    || !boundedIdentityText(executable)
    || !denseBoundedArguments(commandArgs)
  ) throw new Error("scale evidence report provenance is malformed or missing");
  const files = report.metrics.databaseBytes[0];
  if (
    !Number.isSafeInteger(files.database) || files.database <= 0
    || !Number.isSafeInteger(files.writeAheadLog) || files.writeAheadLog < 0
    || !Number.isSafeInteger(files.sharedMemory) || files.sharedMemory < 0
    || !Number.isSafeInteger(physical?.pageSizeBytes) || physical.pageSizeBytes <= 0
    || !Number.isSafeInteger(physical?.pageCount) || physical.pageCount <= 0
    || !Number.isSafeInteger(physical?.journalRows)
    || physical.journalRows !== report.corpus.shardCount
    || physical.userVersion !== 2
    || physical.pageSizeBytes * physical.pageCount !== files.database
  ) throw new Error("scale evidence physical observation is malformed or incoherent");
  const raw = JSON.stringify(report);
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes < 1 || rawBytes > MAX_RAW_SCALE_REPORT_BYTES) {
    throw new Error("scale evidence raw report exceeds its bounded provenance limit");
  }
  return Object.freeze({
    schema: "attunegraph-sqlite-compression-settled-scale@1",
    scale: report.configuration.scale,
    observedAt: report.observedAt,
    corpus: Object.freeze({
      schema: report.corpus.schema,
      seed: report.corpus.seed,
      sha256: report.corpus.sha256,
      assertionCount: report.corpus.assertionCount,
      shardCount: report.corpus.shardCount,
      maxAssertionsPerShard: report.corpus.maxAssertionsPerShard
    }),
    command: Object.freeze({
      executable,
      args: Object.freeze([...commandArgs]),
      benchmark: Object.freeze({
        profile: "local-session",
        repetitions: 1,
        scale: report.configuration.scale,
        warmups: 0
      })
    }),
    repository: Object.freeze({ ...report.repository }),
    host: Object.freeze({ ...report.host, zlib }),
    storage: Object.freeze({
      journalRows: physical.journalRows,
      pageSizeBytes: physical.pageSizeBytes,
      pages: physical.pageCount,
      databaseBytes: files.database,
      writeAheadLogBytes: files.writeAheadLog,
      sharedMemoryBytes: files.sharedMemory,
      userVersion: physical.userVersion
    }),
    rawProvenance: Object.freeze({
      schema: report.schema,
      byteLength: rawBytes,
      sha256: sha256(raw),
      maximumBytes: MAX_RAW_SCALE_REPORT_BYTES
    }),
    claimEligible: false,
    measurementOnly: true
  });
}

async function runSettledScaleEvidence(scales, commandArgs) {
  const provenance = captureSourceCheckoutProvenance();
  const cells = [];
  for (const scale of scales) {
    let physical;
    const instrumentedOpen = async ({ databasePath }) => {
      const { openLocalAttuneGraphSession } = await import("@attunegraph/core/local");
      const session = await openLocalAttuneGraphSession({ databasePath });
      let observed = false;
      return Object.freeze({
        open: (options) => session.open(options),
        async close() {
          if (observed) return session.close();
          observed = true;
          const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
          try {
            const pageSize = database.prepare("PRAGMA page_size").get();
            const pageCount = database.prepare("PRAGMA page_count").get();
            const userVersion = database.prepare("PRAGMA user_version").get();
            const journal = database.prepare(
              "SELECT COUNT(*) AS journalRows FROM attunegraph_projection_journal"
            ).get();
            physical = Object.freeze({
              pageSizeBytes: Number(pageSize.page_size),
              pageCount: Number(pageCount.page_count),
              userVersion: Number(userVersion.user_version),
              journalRows: Number(journal.journalRows)
            });
          } finally {
            database.close();
            await session.close();
          }
        }
      });
    };
    const benchmarkArgs = Object.freeze([
      "--",
      `--scale=${scale.toString()}`,
      "--profile=local-session",
      "--warmups=0",
      "--repetitions=1"
    ]);
    const report = await runScaleBenchmark({
      scale,
      profile: "local-session",
      warmups: 0,
      repetitions: 1
    }, {
      argv: benchmarkArgs,
      repository: provenance.repository,
      openLocalAttuneGraphSession: instrumentedOpen
    });
    cells.push(summarizeSettledScaleEvidence(
      report,
      physical,
      commandArgs,
      process.versions.zlib
    ));
  }
  return Object.freeze({
    schema: "attunegraph-sqlite-compression-scale-evidence@1",
    cells: Object.freeze(cells),
    includesMillionScale: scales.includes(1_000_000),
    claimEligible: false,
    measurementOnly: true
  });
}

function timing(operation, repetitions) {
  for (let index = 0; index < 5; index += 1) operation();
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    operation();
    samples.push((performance.now() - started) * 1_000);
  }
  return Object.freeze({
    p50Microseconds: percentile(samples, 0.5),
    repetitions,
    samplesMicroseconds: Object.freeze(samples)
  });
}

const CODECS = Object.freeze([
  Object.freeze({
    name: "raw",
    compress: (input) => Buffer.from(input),
    decompress: (input) => Buffer.from(input)
  }),
  ...[1, 6, 9].flatMap((level) => [
    Object.freeze({
      name: `deflateRaw-level-${level.toString()}`,
      compress: (input) => deflateRawSync(input, { level }),
      decompress: (input) => inflateRawSync(input, { maxOutputLength: MAX_DURABLE_PROJECTION_BYTES })
    }),
    Object.freeze({
      name: `gzip-level-${level.toString()}`,
      compress: (input) => gzipSync(input, { level }),
      decompress: (input) => gunzipSync(input, { maxOutputLength: MAX_DURABLE_PROJECTION_BYTES })
    })
  ]),
  ...[4, 6, 9, 11].map((quality) => Object.freeze({
    name: `brotli-quality-${quality.toString()}`,
    compress: (input) => brotliCompressSync(input, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.byteLength
      }
    }),
    decompress: (input) => brotliDecompressSync(input, {
      maxOutputLength: MAX_DURABLE_PROJECTION_BYTES
    })
  }))
]);

async function storedProjection(command, scope) {
  const backend = new InMemoryAttuneGraphStoreBackend();
  const graph = await openAttuneGraph({ scope, store: createAttuneGraphStore(backend) });
  try {
    await graph.project(command);
    const stored = await backend.read(scope);
    if (stored === undefined) throw new Error("qualification projection was not stored");
    return stored;
  } finally {
    await graph.close();
  }
}

function expandedNearCapCommand(representative, sourceVersionBytes) {
  const assertions = representative.command.observation.assertions.map((assertion) => ({
    ...JSON.parse(JSON.stringify(assertion)),
    sourceRefs: assertion.sourceRefs.map((sourceRef) => ({
      ...JSON.parse(JSON.stringify(sourceRef)),
      version: "v".repeat(sourceVersionBytes)
    }))
  }));
  const scope = {
    ...representative.scope,
    threadId: `near-cap-${sourceVersionBytes.toString()}`
  };
  return {
    command: {
      operator: "canonical-projection@2",
      observation: {
        ...representative.command.observation,
        assertions,
        observationKey: `compression-near-cap-${sourceVersionBytes.toString()}`,
        scope,
        threadRoot: { ...representative.threadRoot }
      }
    },
    scope
  };
}

async function findNearCapProjection(representative) {
  let low = 0;
  let high = 128;
  let best;
  let lastRejection;
  while (low <= high) {
    const sourceVersionBytes = Math.floor((low + high) / 2);
    const fixture = expandedNearCapCommand(representative, sourceVersionBytes);
    try {
      const projection = await storedProjection(fixture.command, fixture.scope);
      const bytes = Buffer.from(JSON.stringify(projection), "utf8");
      if (bytes.byteLength <= MAX_DURABLE_PROJECTION_BYTES) {
        best = {
          assertionCount: 32,
          bytes,
          canonicalProjectionBytes: Buffer.byteLength(projection.canonicalProjection, "utf8"),
          sourceVersionBytes
        };
        low = sourceVersionBytes + 1;
      } else {
        high = sourceVersionBytes - 1;
      }
    } catch (cause) {
      if (cause?.code !== "INVALID_INPUT") throw cause;
      lastRejection = JSON.stringify({
        code: cause.code,
        message: cause.message,
        details: cause.details,
        causeName: cause.cause?.name,
        causeMessage: cause.cause?.message,
        causeDetails: cause.cause?.details
      });
      high = sourceVersionBytes - 1;
    }
  }
  if (best === undefined || best.canonicalProjectionBytes < 16_384 * 0.95) {
    throw new Error(
      `could not construct a real near-cap durable projection: ${JSON.stringify({
        assertionCount: best?.assertionCount,
        bytes: best?.bytes.byteLength,
        canonicalProjectionBytes: best?.canonicalProjectionBytes,
        sourceVersionBytes: best?.sourceVersionBytes,
        lastRejection
      })}`
    );
  }
  return best;
}

function qualifyPayload(label, input, repetitions) {
  return Object.freeze({
    label,
    rawBytes: input.byteLength,
    sha256: sha256(input),
    codecs: Object.freeze(CODECS.map((codec) => {
      const compressed = codec.compress(input);
      const roundtrip = codec.decompress(compressed);
      if (!roundtrip.equals(input)) throw new Error(`${codec.name} did not roundtrip ${label}`);
      return Object.freeze({
        codec: codec.name,
        compressedBytes: compressed.byteLength,
        compression: timing(() => codec.compress(input), repetitions),
        decompression: timing(() => codec.decompress(compressed), repetitions),
        densityImprovement: input.byteLength / compressed.byteLength,
        sha256: sha256(compressed)
      });
    }))
  });
}

function sqliteBytesFor(codec, input) {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-compression-db-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "density.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      CREATE TABLE density (key TEXT PRIMARY KEY, payload BLOB NOT NULL) STRICT, WITHOUT ROWID;
      BEGIN IMMEDIATE;
    `);
    const insert = database.prepare("INSERT INTO density (key, payload) VALUES (?, ?)");
    const payload = codec.compress(input);
    for (let index = 0; index < SQLITE_REPRESENTATIVE_ROWS; index += 1) {
      insert.run(`scale-10000-shard-${index.toString().padStart(3, "0")}`, payload);
    }
    database.exec("COMMIT; VACUUM");
    database.close();
    return statSync(path).size;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function durableProfile(representative, schema) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), `attunegraph-compression-v${schema.userVersion.toString()}-`))
  );
  chmodSync(directory, 0o700);
  const databasePath = join(directory, "baseline.sqlite");
  try {
    const fixture = new DatabaseSync(databasePath);
    fixture.exec(`
      ${schema.createJournal};
      ${schema.createGenerationIndex};
      ${schema.createHead};
      PRAGMA application_id = ${schema.applicationId};
      PRAGMA user_version = ${schema.userVersion};
    `);
    fixture.close();
    chmodSync(databasePath, 0o600);

    const writer = await openSqliteAttuneGraphStore({ databasePath });
    const store = createAttuneGraphStore(writer.backend);
    const projectionSamples = [];
    for (let index = 0; index < DURABLE_PROFILE_REPETITIONS; index += 1) {
      const scope = index === 0 ? representative.scope : {
        ...representative.scope,
        threadId: `${representative.scope.threadId}-baseline-${index.toString()}`
      };
      const threadRoot = index === 0 ? representative.threadRoot : {
        ...representative.threadRoot,
        id: `${representative.threadRoot.id}-baseline-${index.toString()}`
      };
      const command = index === 0 ? representative.command : {
        ...representative.command,
        observation: {
          ...representative.command.observation,
          observationKey: `${representative.command.observation.observationKey}-baseline-${index.toString()}`,
          scope,
          threadRoot,
          assertions: representative.command.observation.assertions.map((assertion) => ({
            ...assertion,
            object: assertion.object.kind === "thread" ? { ...threadRoot } : { ...assertion.object },
            sourceRefs: assertion.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
            subject: { ...assertion.subject },
            derivation: { ...assertion.derivation }
          }))
        }
      };
      const graph = await openAttuneGraph({ scope, store });
      const projectionStarted = performance.now();
      await graph.project(command);
      projectionSamples.push((performance.now() - projectionStarted) * 1_000);
      await graph.close();
    }
    await writer.close();

    const coldReadSamples = [];
    const warmReadSamples = [];
    for (let index = 0; index < DURABLE_PROFILE_REPETITIONS; index += 1) {
      const coldStarted = performance.now();
      const reader = await openSqliteAttuneGraphStore({ databasePath });
      const projection = await reader.backend.read(representative.scope);
      coldReadSamples.push((performance.now() - coldStarted) * 1_000);
      if (projection === undefined) {
        throw new Error(`physical v${schema.userVersion.toString()} durable profile lost its projection`);
      }
      const warmStarted = performance.now();
      await reader.backend.read(representative.scope);
      warmReadSamples.push((performance.now() - warmStarted) * 1_000);
      await reader.close();
    }
    return Object.freeze({
      userVersion: schema.userVersion,
      projection: distribution(projectionSamples),
      coldReopenedRead: distribution(coldReadSamples),
      warmRead: distribution(warmReadSamples)
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function runSqliteCompressionQualification() {
  const plan = createBenchmarkCorpusPlan(10_000);
  const representative = createBenchmarkShard(plan, 0);
  const representativeStored = await storedProjection(
    representative.command,
    representative.scope
  );
  const representativeBytes = Buffer.from(JSON.stringify(representativeStored), "utf8");
  const nearCap = await findNearCapProjection(representative);
  const payloads = Object.freeze([
    qualifyPayload("real-scale-corpus-32-assertion", representativeBytes, 101),
    qualifyPayload("real-engine-admitted-near-cap", nearCap.bytes, 21)
  ]);
  const representativeCodecs = new Map(
    payloads[0].codecs.map((entry) => [entry.codec, entry])
  );
  const databaseBytes = Object.freeze(CODECS.map((codec) => Object.freeze({
    codec: codec.name,
    databaseBytes: sqliteBytesFor(codec, representativeBytes)
  })));
  const rawDatabaseBytes = databaseBytes.find((entry) => entry.codec === "raw").databaseBytes;
  const databaseDensity = Object.freeze(databaseBytes.map((entry) => Object.freeze({
    ...entry,
    densityImprovement: rawDatabaseBytes / entry.databaseBytes
  })));
  const baseline = await durableProfile(representative, ATTUNEGRAPH_PHYSICAL_SCHEMA_V1);
  const candidateProfile = await durableProfile(
    representative,
    ATTUNEGRAPH_PHYSICAL_SCHEMA_V2
  );
  const projectionP50Microseconds = baseline.projection.p50Microseconds;
  const readP50Microseconds = baseline.warmRead.p50Microseconds;
  const candidates = Object.freeze(databaseDensity
    .filter((entry) => entry.codec !== "raw")
    .map((entry) => {
      const codec = representativeCodecs.get(entry.codec);
      return Object.freeze({
        codec: entry.codec,
        databaseDensityImprovement: entry.densityImprovement,
        payloadDensityImprovement: codec.densityImprovement,
        compressionShareOfCurrentProjectionP50: codec.compression.p50Microseconds
          / projectionP50Microseconds,
        decompressionShareOfCurrentReadP50: codec.decompression.p50Microseconds
          / readP50Microseconds,
        proceeds: entry.densityImprovement >= 3
          && codec.densityImprovement >= 3
          && codec.compression.p50Microseconds <= projectionP50Microseconds * 0.1
          && codec.decompression.p50Microseconds <= readP50Microseconds * 0.1
      });
    }));
  const ratio = (candidate, legacy) => Object.freeze({
    p50: candidate.p50Microseconds / legacy.p50Microseconds,
    p95: candidate.p95Microseconds / legacy.p95Microseconds,
    p99: candidate.p99Microseconds / legacy.p99Microseconds
  });
  const endToEndRatios = Object.freeze({
    projection: ratio(candidateProfile.projection, baseline.projection),
    warmRead: ratio(candidateProfile.warmRead, baseline.warmRead),
    coldReopenedRead: ratio(candidateProfile.coldReopenedRead, baseline.coldReopenedRead)
  });
  const selectedIntegrationGate = evaluateSelectedIntegrationGate(endToEndRatios);
  const selectedMicroGate = candidates.find(
    (entry) => entry.codec === "deflateRaw-level-1"
  );
  if (selectedMicroGate === undefined) throw new Error("selected codec gate is missing");
  return Object.freeze({
    schema: "attunegraph-sqlite-compression-qualification@1",
    measuredAt: new Date().toISOString(),
    provenance: {
      repository: captureSourceCheckoutProvenance().repository,
      host: {
        arch: process.arch,
        node: process.versions.node,
        platform: process.platform,
        sqlite: process.versions.sqlite,
        zlib: process.versions.zlib
      }
    },
    corpus: {
      nearCapAssertionCount: nearCap.assertionCount,
      nearCapCanonicalProjectionBytes: nearCap.canonicalProjectionBytes,
      nearCapSourceVersionBytes: nearCap.sourceVersionBytes,
      representativeAssertionCount: representative.assertionCount,
      representativeRows: SQLITE_REPRESENTATIVE_ROWS,
      scale: 10_000
    },
    payloads,
    databaseDensity,
    currentLegacyV1DurableBaseline: baseline,
    candidateV2DurableProfile: candidateProfile,
    endToEndRatios,
    selectedIntegrationGate,
    candidates,
    proceed: selectedMicroGate.proceeds && selectedIntegrationGate.passes,
    claims: {
      ladybugParity: false,
      reason: "AttuneGraph journal semantics and this codec microqualification differ from LadybugDB"
    }
  });
}

async function runCommand() {
const args = process.argv.slice(2).filter((value) => value !== "--");
const scaleEvidence = args.find((value) => value.startsWith("--scale-evidence="));
if (
  args.some((value) => value !== "--json" && !value.startsWith("--scale-evidence="))
  || new Set(args).size !== args.length
  || (scaleEvidence !== undefined
    && scaleEvidence !== "--scale-evidence=standard"
    && scaleEvidence !== "--scale-evidence=all")
  || args.filter((value) => value.startsWith("--scale-evidence=")).length > 1
) {
  throw new Error(
    "SQLite compression qualification accepts --json and one --scale-evidence=standard|all"
  );
}
if (scaleEvidence !== undefined) {
  const scales = scaleEvidence === "--scale-evidence=all"
    ? [10_000, 100_000, 1_000_000]
    : [10_000, 100_000];
  const evidence = await runSettledScaleEvidence(scales, Object.freeze([...args]));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return;
}
const report = await runSqliteCompressionQualification();
const selected = report.candidates.find((entry) => entry.codec === "deflateRaw-level-1");
const selectedPayload = report.payloads[0].codecs.find(
  (entry) => entry.codec === "deflateRaw-level-1"
);
const selectedDatabase = report.databaseDensity.find(
  (entry) => entry.codec === "deflateRaw-level-1"
);
if (selected === undefined || selectedPayload === undefined || selectedDatabase === undefined) {
  throw new Error("selected deflateRaw qualification cell is missing");
}
const summary = Object.freeze({
  schema: "attunegraph-sqlite-compression-qualification-summary@1",
  measuredAt: report.measuredAt,
  provenance: report.provenance,
  corpus: report.corpus,
  selected: {
    codec: "deflateRaw-level-1",
    rawBytes: report.payloads[0].rawBytes,
    compressedBytes: selectedPayload.compressedBytes,
    payloadDensityImprovement: selectedPayload.densityImprovement,
    databaseBytes: selectedDatabase.databaseBytes,
    databaseDensityImprovement: selectedDatabase.densityImprovement,
    compressionP50Microseconds: selectedPayload.compression.p50Microseconds,
    decompressionP50Microseconds: selectedPayload.decompression.p50Microseconds,
    gate: selected
  },
  currentLegacyV1DurableBaseline: {
    projectionP50Microseconds: report.currentLegacyV1DurableBaseline.projection.p50Microseconds,
    projectionP95Microseconds: report.currentLegacyV1DurableBaseline.projection.p95Microseconds,
    warmReadP50Microseconds: report.currentLegacyV1DurableBaseline.warmRead.p50Microseconds,
    warmReadP95Microseconds: report.currentLegacyV1DurableBaseline.warmRead.p95Microseconds,
    coldReopenedReadP50Microseconds:
      report.currentLegacyV1DurableBaseline.coldReopenedRead.p50Microseconds,
    coldReopenedReadP95Microseconds:
      report.currentLegacyV1DurableBaseline.coldReopenedRead.p95Microseconds
  },
  candidateV2DurableProfile: {
    projectionP50Microseconds: report.candidateV2DurableProfile.projection.p50Microseconds,
    projectionP95Microseconds: report.candidateV2DurableProfile.projection.p95Microseconds,
    warmReadP50Microseconds: report.candidateV2DurableProfile.warmRead.p50Microseconds,
    warmReadP95Microseconds: report.candidateV2DurableProfile.warmRead.p95Microseconds,
    coldReopenedReadP50Microseconds:
      report.candidateV2DurableProfile.coldReopenedRead.p50Microseconds,
    coldReopenedReadP95Microseconds:
      report.candidateV2DurableProfile.coldReopenedRead.p95Microseconds
  },
  endToEndRatios: report.endToEndRatios,
  selectedIntegrationGate: report.selectedIntegrationGate,
  proceed: report.proceed,
  claims: report.claims,
  rawEvidence: "rerun with --json"
});
process.stdout.write(`${JSON.stringify(args.includes("--json") ? report : summary, null, 2)}\n`);
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) await runCommand();
