import { performance } from "node:perf_hooks";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildCompetitorParityCorpus } from "../../scripts/benchmark-attunegraph-competitor-parity.mjs";
import { isDirectEntrypoint } from "../../scripts/direct-entrypoint.mjs";

const MAX_OUTPUT_BYTES = 128 * 1_024;
const ENGINES = new Set(["attunegraph-v4", "ladybug", "cozo"]);

function fail(message) {
  throw new Error(`competitor parity child: ${message}`);
}

export function parseCompetitorParityChildArguments(argv) {
  if (argv.length !== 2 || !argv[0].startsWith("--engine=") || !argv[1].startsWith("--database-dir=")) {
    fail("expected exact --engine and --database-dir arguments");
  }
  const engine = argv[0].slice("--engine=".length);
  const databaseDir = resolve(argv[1].slice("--database-dir=".length));
  if (!ENGINES.has(engine)) {
    fail("arguments are outside the admitted benchmark domain");
  }
  let parent;
  try {
    parent = realpathSync(dirname(databaseDir));
  } catch {
    fail("database parent is not an admitted benchmark temporary root");
  }
  const canonicalTmp = realpathSync(tmpdir());
  const parentName = basename(parent);
  const trialName = basename(databaseDir);
  const trial = /^trial-([1-5])-([0-2])-(attunegraph-v4|ladybug|cozo)$/u.exec(trialName);
  const engines = ["attunegraph-v4", "ladybug", "cozo"];
  if (
    dirname(parent) !== canonicalTmp
    || !/^attunegraph-competitor-parity-[A-Za-z0-9]{6}$/u.test(parentName)
    || resolve(parent, trialName) !== databaseDir
    || trial === null
    || trial[3] !== engine
    || engines[(Number(trial[1]) - 1 + Number(trial[2])) % engines.length] !== engine
  ) {
    fail("arguments are outside the admitted benchmark domain");
  }
  return Object.freeze({ engine, databaseDir });
}

function directoryBytes(path) {
  const rootStats = statSync(path);
  if (!rootStats.isDirectory()) return rootStats.size;
  let total = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stats = statSync(child);
    total += stats.isDirectory() ? directoryBytes(child) : stats.size;
  }
  return total;
}

function summary(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    fail("latency samples are invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return Object.freeze({
    samples: sorted.length,
    rawMs: Object.freeze([...values]),
    minMs: sorted[0],
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((total, value) => total + value, 0) / sorted.length
  });
}

function exactRows(scope, neighbors, degree) {
  if (
    degree !== scope.degree
    || (neighbors !== undefined && JSON.stringify(neighbors) !== JSON.stringify(scope.orderedNeighbors))
  ) {
    fail(`oracle mismatch for ${scope.scopeId}`);
  }
}

async function queryWorkload(query, corpus, plan) {
  const firstStart = performance.now();
  const first = await query(corpus.scopes[0]);
  const firstAfterReopenMs = performance.now() - firstStart;
  exactRows(corpus.scopes[0], first.neighbors, first.degree);
  for (const scope of corpus.scopes) {
    const result = await query(scope);
    exactRows(scope, result.neighbors, result.degree);
  }
  for (let index = 0; index < plan.warmupQueries; index += 1) await query(corpus.scopes[index % corpus.scopeCount]);
  const adjacency = [];
  const degree = [];
  for (let index = 0; index < plan.sampleQueries; index += 1) {
    const scope = corpus.scopes[(index * 17) % corpus.scopeCount];
    const adjacencyStart = performance.now();
    const adjacencyResult = await query(scope, "adjacency");
    adjacency.push(performance.now() - adjacencyStart);
    const degreeStart = performance.now();
    const degreeResult = await query(scope, "degree");
    degree.push(performance.now() - degreeStart);
    exactRows(scope, adjacencyResult.neighbors, adjacencyResult.degree);
    exactRows(scope, degreeResult.neighbors, degreeResult.degree);
  }
  return Object.freeze({ firstAfterReopenMs, adjacency: summary(adjacency), degree: summary(degree) });
}

async function attuneGraphLane(databaseDir, corpus, plan) {
  const moduleStart = performance.now();
  const [
    { openAttuneGraph },
    { createAttuneGraphStore },
    { openSqliteAttuneGraphStore },
    { readAttuneGraphCurrentDecisionEndpointForMeasurement }
  ] = await Promise.all([
    import("../../dist/attunegraph-engine.js"),
    import("../../dist/attunegraph-backend.js"),
    import("../../dist/attunegraph-sqlite-store.js"),
    import("../../dist/attunegraph-current-head-index.mjs")
  ]);
  const moduleLoadMs = performance.now() - moduleStart;
  const databasePath = join(databaseDir, "attunegraph.sqlite");
  const openStart = performance.now();
  const resource = await openSqliteAttuneGraphStore({ databasePath });
  const openMs = performance.now() - openStart;
  const ingestStart = performance.now();
  for (const scope of corpus.scopes) {
    const graphScope = { sourceId: "competitor-parity", threadId: scope.scopeId };
    const graph = await openAttuneGraph({ scope: graphScope, store: createAttuneGraphStore(resource.backend) });
    await graph.project({
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        observationKey: `competitor-parity:${scope.scopeId}`,
        scope: graphScope,
        threadRoot: { kind: "thread", id: scope.rootId },
        observedAt: "2026-08-02T00:00:00.000Z",
        sourceFreshness: { state: "fresh", observedAt: "2026-08-02T00:00:00.000Z" },
        assertions: scope.assertions.map((assertion, index) => ({
          schemaVersion: 1,
          id: assertion.assertionId,
          subject: { kind: "artifact", id: assertion.neighborId },
          predicate: "LINKED_TO",
          object: { kind: "thread", id: scope.rootId },
          epistemicClass: "source-observed",
          sourceRefs: [
            { namespace: "competitor-parity", id: assertion.sourceRef },
            ...(index === 0 ? [{ namespace: "competitor-parity", id: scope.scopeSourceRef }] : [])
          ],
          recordedAt: "2026-08-02T00:00:00.000Z",
          derivation: { kind: "projection", version: "competitor-parity@1" }
        }))
      }
    });
    await graph.close();
  }
  const ingestMs = performance.now() - ingestStart;
  await resource.close();
  const settledBytes = directoryBytes(databaseDir);
  const reopenStart = performance.now();
  const database = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
  const reopenMs = performance.now() - reopenStart;
  if (Number(database.prepare("PRAGMA user_version").get().user_version) !== 4) fail("AttuneGraph store is not physical v4");
  const adjacencyStatement = database.prepare(`
    SELECT a.subject_id AS id
    FROM attunegraph_current_manifest AS m
    JOIN attunegraph_current_assertion AS a ON a.index_id = m.index_id
    WHERE m.source_id = ? AND m.thread_id = ?
      AND a.object_kind = 'thread' AND a.object_id = ?
    ORDER BY a.subject_id
  `);
  const degreeStatement = database.prepare(`
    SELECT d.incident_assertion_count AS degree
    FROM attunegraph_current_manifest AS m
    JOIN attunegraph_current_endpoint_degree AS d ON d.index_id = m.index_id
    WHERE m.source_id = ? AND m.thread_id = ?
      AND d.ref_kind = 'thread' AND d.ref_id = ?
  `);
  const query = (scope, kind = "both") => {
    const args = ["competitor-parity", scope.scopeId, scope.rootId];
    if (kind === "adjacency") {
      const neighbors = adjacencyStatement.all(...args).map((row) => row.id);
      return { neighbors, degree: neighbors.length };
    }
    if (kind === "degree") {
      const row = degreeStatement.get(...args);
      return { neighbors: undefined, degree: Number(row?.degree) };
    }
    const neighbors = adjacencyStatement.all(...args).map((row) => row.id);
    const row = degreeStatement.get(...args);
    return { neighbors, degree: Number(row?.degree) };
  };
  const queries = await queryWorkload(query, corpus, plan);
  const witnessedQuery = (scope) => {
    const result = readAttuneGraphCurrentDecisionEndpointForMeasurement(database, {
      scope: { sourceId: "competitor-parity", threadId: scope.scopeId },
      seed: { kind: "thread", id: scope.rootId },
      asOf: "2026-08-02T00:00:00.000Z",
      maxCandidateAssertions: 64
    });
    if (result.scanStatus !== "complete") fail(`witnessed endpoint abstained for ${scope.scopeId}`);
    const neighbors = result.assertions.map((assertion) => assertion.subject.id).sort();
    exactRows(scope, neighbors, neighbors.length);
    return result;
  };
  for (const scope of corpus.scopes) witnessedQuery(scope);
  for (let index = 0; index < plan.warmupQueries; index += 1) witnessedQuery(corpus.scopes[index]);
  const witnessedSamples = [];
  for (let index = 0; index < plan.sampleQueries; index += 1) {
    const started = performance.now();
    witnessedQuery(corpus.scopes[(index * 17) % corpus.scopeCount]);
    witnessedSamples.push(performance.now() - started);
  }
  database.close();
  return {
    version: "0.1.0",
    moduleLoadMs, openMs, ingestMs, settledBytes, reopenMs, ...queries,
    witnessedDecisionEndpoint: {
      lane: "attunegraph-v4-proof-assembly-only",
      productRatioEligible: false,
      scanStatus: "complete",
      oracleScopesVerified: corpus.scopeCount,
      latency: summary(witnessedSamples)
    }
  };
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function ladybugLane(databaseDir, corpus, plan) {
  const moduleStart = performance.now();
  const { Database, Connection, VERSION } = await import("@ladybugdb/core");
  const moduleLoadMs = performance.now() - moduleStart;
  const nodesPath = join(databaseDir, "nodes.csv");
  const edgesPath = join(databaseDir, "edges.csv");
  const nodes = ["id,source_ref"];
  const edges = ["root,neighbor,scope,source_ref"];
  for (const scope of corpus.scopes) {
    nodes.push(`${csv(scope.rootId)},${csv(scope.scopeSourceRef)}`);
    for (const assertion of scope.assertions) {
      nodes.push(`${csv(assertion.neighborId)},${csv("")}`);
      edges.push([scope.rootId, assertion.neighborId, scope.scopeId, assertion.sourceRef].map(csv).join(","));
    }
  }
  writeFileSync(nodesPath, `${nodes.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(edgesPath, `${edges.join("\n")}\n`, { mode: 0o600 });
  const databasePath = join(databaseDir, "ladybug");
  const openStart = performance.now();
  let database = new Database(databasePath);
  let connection = new Connection(database);
  await connection.init();
  const openMs = performance.now() - openStart;
  const ingestStart = performance.now();
  await connection.query("CREATE NODE TABLE Node(id STRING PRIMARY KEY, source_ref STRING)");
  await connection.query("CREATE REL TABLE Edge(FROM Node TO Node, scope STRING, source_ref STRING)");
  await connection.query(`COPY Node FROM '${nodesPath}' (HEADER=true)`);
  await connection.query(`COPY Edge FROM '${edgesPath}' (HEADER=true)`);
  const ingestMs = performance.now() - ingestStart;
  await connection.close();
  await database.close();
  const settledBytes = directoryBytes(databasePath);
  const reopenStart = performance.now();
  database = new Database(databasePath, 0, true, true);
  connection = new Connection(database);
  await connection.init();
  const reopenMs = performance.now() - reopenStart;
  const query = (scope, kind = "both") => {
    const escaped = scope.rootId.replaceAll("'", "\\'");
    if (kind === "degree") {
      const degreeResult = connection.querySync(
        `MATCH (r:Node)-[e:Edge]->(n:Node) WHERE r.id = '${escaped}' RETURN count(e) AS degree`
      );
      const degreeRows = degreeResult.getAllSync();
      degreeResult.close();
      return { neighbors: undefined, degree: Number(degreeRows[0].degree) };
    }
    const adjacencyResult = connection.querySync(
      `MATCH (r:Node)-[:Edge]->(n:Node) WHERE r.id = '${escaped}' RETURN n.id AS id ORDER BY id`
    );
    const rows = adjacencyResult.getAllSync();
    adjacencyResult.close();
    const neighbors = rows.map((row) => row.id);
    if (kind === "adjacency") return { neighbors, degree: neighbors.length };
    const degreeResult = connection.querySync(
      `MATCH (r:Node)-[e:Edge]->(n:Node) WHERE r.id = '${escaped}' RETURN count(e) AS degree`
    );
    const degreeRows = degreeResult.getAllSync();
    degreeResult.close();
    return { neighbors, degree: Number(degreeRows[0].degree) };
  };
  const queries = await queryWorkload(query, corpus, plan);
  await connection.close();
  await database.close();
  return { version: VERSION, moduleLoadMs, openMs, ingestMs, settledBytes, reopenMs, ...queries };
}

async function cozoLane(databaseDir, corpus, plan) {
  const moduleStart = performance.now();
  const { CozoDb } = await import("cozo-node");
  const cozoPackage = JSON.parse(readFileSync(
    new URL("./node_modules/cozo-node/package.json", import.meta.url),
    "utf8"
  ));
  if (cozoPackage.name !== "cozo-node" || cozoPackage.version !== "0.7.6") {
    fail("installed Cozo package identity is invalid");
  }
  const moduleLoadMs = performance.now() - moduleStart;
  const databasePath = join(databaseDir, "cozo.sqlite");
  const openStart = performance.now();
  let database = new CozoDb("sqlite", databasePath, {});
  const openMs = performance.now() - openStart;
  const ingestStart = performance.now();
  await database.run(":create edge {scope: String, neighbor: String => root: String, source_ref: String}", {});
  await database.run(":create scope_source {scope: String => source_ref: String}", {});
  const rows = corpus.scopes.flatMap((scope) => scope.assertions.map((assertion) => [
    scope.scopeId, assertion.neighborId, scope.rootId, assertion.sourceRef
  ]));
  await database.run("?[scope, neighbor, root, source_ref] <- $rows\n:put edge {scope, neighbor => root, source_ref}", { rows });
  await database.run("?[scope, source_ref] <- $rows\n:put scope_source {scope => source_ref}", {
    rows: corpus.scopes.map((scope) => [scope.scopeId, scope.scopeSourceRef])
  });
  const ingestMs = performance.now() - ingestStart;
  database.close();
  const settledBytes = directoryBytes(databaseDir);
  const reopenStart = performance.now();
  database = new CozoDb("sqlite", databasePath, {});
  const reopenMs = performance.now() - reopenStart;
  const query = async (scope, kind = "both") => {
    if (kind === "degree") {
      const degree = await database.run(
        "?[count(neighbor)] := *edge{scope: $scope, neighbor}",
        { scope: scope.scopeId }, true
      );
      return { neighbors: undefined, degree: Number(degree.rows[0][0]) };
    }
    const adjacency = await database.run(
      "?[neighbor] := *edge{scope: $scope, neighbor}\n:sort neighbor",
      { scope: scope.scopeId }, true
    );
    const neighbors = adjacency.rows.map((row) => row[0]);
    if (kind === "adjacency") return { neighbors, degree: neighbors.length };
    const degree = await database.run(
      "?[count(neighbor)] := *edge{scope: $scope, neighbor}",
      { scope: scope.scopeId }, true
    );
    return { neighbors, degree: Number(degree.rows[0][0]) };
  };
  const queries = await queryWorkload(query, corpus, plan);
  database.close();
  return { version: cozoPackage.version, moduleLoadMs, openMs, ingestMs, settledBytes, reopenMs, ...queries };
}

async function runChild(argv) {
  const options = parseCompetitorParityChildArguments(argv);
  mkdirSync(options.databaseDir, { recursive: false, mode: 0o700 });
  const corpus = buildCompetitorParityCorpus();
  const plan = { warmupQueries: 20, sampleQueries: 200 };
  const lane = options.engine === "attunegraph-v4"
    ? await attuneGraphLane(options.databaseDir, corpus, plan)
    : options.engine === "ladybug"
      ? await ladybugLane(options.databaseDir, corpus, plan)
      : await cozoLane(options.databaseDir, corpus, plan);
  const report = Object.freeze({
    schema: "attunegraph-competitor-parity-child@1",
    engine: options.engine,
    ...lane,
    peakRssBytes: process.resourceUsage().maxRSS * 1_024,
    oracleScopesVerified: corpus.scopeCount
  });
  const encoded = JSON.stringify(report);
  if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) fail("output exceeded its byte bound");
  process.stdout.write(`${encoded}\n`);
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try {
    await runChild(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
