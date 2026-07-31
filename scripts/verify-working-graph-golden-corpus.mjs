import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { openAttuneGraph } from "../dist/index.js";
import { createInMemoryAttuneGraphStore } from "../dist/testing.js";

const FIXTURE_URL = new URL(
  "../fixtures/working-graph-v1/corpus.json",
  import.meta.url
);
const MANIFEST_URL = new URL(
  "../fixtures/working-graph-v1/manifest.json",
  import.meta.url
);
const SCHEMA = "attunegraph-working-graph-golden@1";
const MANIFEST_SCHEMA = "attunegraph-working-graph-golden-manifest@1";
const REPORT_SCHEMA = "attunegraph-working-graph-golden-report@1";

function fail(message) {
  throw new Error(`invalid Working Graph golden corpus: ${message}`);
}

function record(value, name, keys) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${name} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length
    || actual.some((key) =>
      typeof key !== "string"
      || !keys.includes(key)
      || !("value" in descriptors[key])
    )
    || keys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    fail(`${name} has an invalid field set`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value])
  );
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} must be non-empty text`);
  }
  return value;
}

function exactStringArray(value, name) {
  const values = array(value, name).map((entry, index) =>
    text(entry, `${name}[${index}]`)
  );
  if (new Set(values).size !== values.length) fail(`${name} must be unique`);
  return values;
}

function normalizedExpected(value, name) {
  const expected = record(value, name, [
    "status",
    "assertionIds",
    "truncationReasons",
    "sourceFreshnessState"
  ]);
  if (!["complete", "partial", "abstained"].includes(expected.status)) {
    fail(`${name}.status is invalid`);
  }
  if (!["fresh", "stale", "unknown"].includes(expected.sourceFreshnessState)) {
    fail(`${name}.sourceFreshnessState is invalid`);
  }
  const truncationReasons = exactStringArray(
    expected.truncationReasons,
    `${name}.truncationReasons`
  );
  if (truncationReasons.some((reason) =>
    reason !== "token-budget" && reason !== "traversal-budget"
  )) {
    fail(`${name}.truncationReasons is invalid`);
  }
  return Object.freeze({
    assertionIds: Object.freeze(
      exactStringArray(expected.assertionIds, `${name}.assertionIds`)
    ),
    sourceFreshnessState: expected.sourceFreshnessState,
    status: expected.status,
    truncationReasons: Object.freeze(truncationReasons)
  });
}

function equalArray(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedManifest(value) {
  const manifest = record(value, "manifest", [
    "schema",
    "corpusFile",
    "corpusSha256"
  ]);
  if (manifest.schema !== MANIFEST_SCHEMA) {
    fail(`manifest.schema must be ${MANIFEST_SCHEMA}`);
  }
  if (manifest.corpusFile !== "corpus.json") {
    fail("manifest.corpusFile must be corpus.json");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifest.corpusSha256)) {
    fail("manifest.corpusSha256 must be a lowercase SHA-256 digest");
  }
  return manifest;
}

export async function verifyWorkingGraphGoldenDocument(document, options = {}) {
  const root = record(document, "corpus", ["schema", "cases"]);
  if (root.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  const cases = array(root.cases, "corpus.cases");
  if (cases.length === 0) fail("corpus.cases must not be empty");

  const caseNames = new Set();
  const queryNames = new Set();
  const results = [];
  let returnedAssertions = 0;
  let expectedAssertions = 0;
  let truePositives = 0;
  let abstentionCases = 0;
  let partialCases = 0;

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const caseName = `corpus.cases[${caseIndex}]`;
    const goldenCase = record(cases[caseIndex], caseName, [
      "name",
      "scope",
      "threadRoot",
      "observedAt",
      "sourceFreshness",
      "assertions",
      "queries"
    ]);
    const name = text(goldenCase.name, `${caseName}.name`);
    if (caseNames.has(name)) fail(`duplicate case name: ${name}`);
    caseNames.add(name);
    const queries = array(goldenCase.queries, `${caseName}.queries`);
    if (queries.length === 0) fail(`${caseName}.queries must not be empty`);

    const graph = await openAttuneGraph({
      scope: goldenCase.scope,
      store: createInMemoryAttuneGraphStore()
    });
    try {
      await graph.project({
        operator: "canonical-projection@2",
        observation: {
          schemaVersion: 2,
          observationKey: `golden:${name}`,
          scope: goldenCase.scope,
          threadRoot: goldenCase.threadRoot,
          observedAt: goldenCase.observedAt,
          sourceFreshness: goldenCase.sourceFreshness,
          assertions: goldenCase.assertions
        }
      });

      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const queryPath = `${caseName}.queries[${queryIndex}]`;
        const query = record(queries[queryIndex], queryPath, [
          "name",
          "seed",
          "now",
          "maxEstimatedTokens",
          "expected"
        ]);
        const queryName = text(query.name, `${queryPath}.name`);
        const qualifiedName = `${name}/${queryName}`;
        if (queryNames.has(qualifiedName)) {
          fail(`duplicate query name: ${qualifiedName}`);
        }
        queryNames.add(qualifiedName);
        const expected = normalizedExpected(
          query.expected,
          `${queryPath}.expected`
        );
        const actual = await graph.execute({
          operator: "working-graph@1",
          seed: query.seed,
          now: query.now,
          maxEstimatedTokens: query.maxEstimatedTokens
        });
        const actualIds = actual.workingGraph.assertions.map(
          (assertion) => assertion.id
        );
        const actualReasons = actual.workingGraph.diagnostics.truncationReasons;
        const exact = actual.status === expected.status
          && actual.sourceFreshness.state === expected.sourceFreshnessState
          && equalArray(actualIds, expected.assertionIds)
          && equalArray(actualReasons, expected.truncationReasons);
        if (!exact) {
          throw new Error(
            `Working Graph golden mismatch: ${qualifiedName}\n`
            + `expected ${JSON.stringify(expected)}\n`
            + `actual ${JSON.stringify({
              assertionIds: actualIds,
              sourceFreshnessState: actual.sourceFreshness.state,
              status: actual.status,
              truncationReasons: actualReasons
            })}`
          );
        }
        const expectedSet = new Set(expected.assertionIds);
        truePositives += actualIds.filter((id) => expectedSet.has(id)).length;
        returnedAssertions += actualIds.length;
        expectedAssertions += expected.assertionIds.length;
        if (expected.status === "abstained") abstentionCases += 1;
        if (expected.status === "partial") partialCases += 1;
        results.push(Object.freeze({
          assertionCount: actualIds.length,
          name: qualifiedName,
          status: actual.status
        }));
      }
    } finally {
      await graph.close();
    }
  }

  if (abstentionCases === 0 || partialCases === 0) {
    fail("corpus must contain both abstained and partial expectations");
  }
  return Object.freeze({
    abstentionCases,
    caseCount: cases.length,
    corpusSha256: options.corpusSha256 ?? sha256(JSON.stringify(document)),
    exactMatches: results.length,
    partialCases,
    passed: true,
    precision: ratio(truePositives, returnedAssertions),
    queryCount: results.length,
    recall: ratio(truePositives, expectedAssertions),
    results: Object.freeze(results),
    schema: REPORT_SCHEMA
  });
}

export async function verifyWorkingGraphGoldenCorpus() {
  const [bytes, manifestBytes] = await Promise.all([
    readFile(FIXTURE_URL),
    readFile(MANIFEST_URL)
  ]);
  return verifyWorkingGraphGoldenBytes(
    bytes,
    JSON.parse(manifestBytes.toString("utf8"))
  );
}

export async function verifyWorkingGraphGoldenBytes(bytes, manifestDocument) {
  if (!(bytes instanceof Uint8Array)) fail("corpus bytes must be a Uint8Array");
  const manifest = normalizedManifest(manifestDocument);
  const corpusSha256 = sha256(bytes);
  if (corpusSha256 !== manifest.corpusSha256) {
    fail(
      `corpus byte digest mismatch: expected ${manifest.corpusSha256}, got ${corpusSha256}`
    );
  }
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (cause) {
    throw new Error("invalid Working Graph golden corpus: corpus.json is not valid JSON", {
      cause
    });
  }
  return verifyWorkingGraphGoldenDocument(document, {
    corpusSha256
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write("verify-working-graph-golden-corpus accepts no arguments\n");
    process.exitCode = 1;
  } else {
    try {
      const report = await verifyWorkingGraphGoldenCorpus();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
