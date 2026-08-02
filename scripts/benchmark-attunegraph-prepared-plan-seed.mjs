import { openAttuneGraph } from "@attunegraph/core";
import { createAttuneGraphStore } from "@attunegraph/core/backend";
import { InMemoryAttuneGraphStoreBackend } from "@attunegraph/core/testing";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const NOW = "2026-08-02T00:00:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "prepared-plan-seed-part-count",
  threadId: "thread:prepared-plan-seed"
});
const ROOT = Object.freeze({ kind: "thread", id: SCOPE.threadId });

function observation() {
  return Object.freeze({
    operator: "canonical-projection@2",
    observation: Object.freeze({
      schemaVersion: 2,
      observationKey: "prepared-plan-seed",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: Object.freeze({ state: "fresh", observedAt: NOW }),
      assertions: Object.freeze([Object.freeze({
        schemaVersion: 1,
        id: "prepared-plan-seed-assertion",
        subject: Object.freeze({ kind: "artifact", id: "prepared-plan-seed-artifact" }),
        predicate: "CONTEXT_FOR",
        object: ROOT,
        epistemicClass: "source-observed",
        sourceRefs: Object.freeze([Object.freeze({
          namespace: "attunegraph.benchmark.prepared-plan-seed",
          id: "prepared-plan-seed-source"
        })]),
        recordedAt: NOW,
        derivation: Object.freeze({ kind: "projection", version: "prepared-plan-seed@1" })
      })])
    })
  });
}

function query(snapshot) {
  return Object.freeze({
    operator: "decision-query@1",
    scope: SCOPE,
    seed: ROOT,
    asOf: NOW,
    head: Object.freeze({
      mode: "exact",
      generation: snapshot.generation,
      commitId: snapshot.commitId
    }),
    freshness: Object.freeze({ require: "fresh" }),
    budget: Object.freeze({ maxEstimatedTokens: 4_000 })
  });
}

function counts() {
  return { compareAndSwaps: 0, fullProjectionReads: 0, headReads: 0 };
}

function snapshotCounts(value) {
  return Object.freeze({
    compareAndSwaps: value.compareAndSwaps,
    fullProjectionReads: value.fullProjectionReads,
    headReads: value.headReads
  });
}

function countDelta(after, before) {
  return Object.freeze({
    compareAndSwaps: after.compareAndSwaps - before.compareAndSwaps,
    fullProjectionReads: after.fullProjectionReads - before.fullProjectionReads,
    headReads: after.headReads - before.headReads
  });
}

function countedStore(backing, partCounts) {
  return createAttuneGraphStore({
    async read(scope) {
      partCounts.fullProjectionReads += 1;
      return backing.read(scope);
    },
    async readHead(scope) {
      partCounts.headReads += 1;
      return backing.readHead(scope);
    },
    async compareAndSwap(scope, expected, proposed) {
      partCounts.compareAndSwaps += 1;
      return backing.compareAndSwap(scope, expected, proposed);
    }
  });
}

function exactCounts(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} part counts diverged: ${JSON.stringify({ actual, expected })}`);
  }
}

export async function runPreparedPlanSeedPartCountBenchmark() {
  const backing = new InMemoryAttuneGraphStoreBackend();
  const seededCounts = counts();
  const seeded = await openAttuneGraph({
    scope: SCOPE,
    store: countedStore(backing, seededCounts)
  });
  try {
    const beforeProject = snapshotCounts(seededCounts);
    const committed = await seeded.projectAgainstHead(
      JSON.parse(JSON.stringify(observation()))
    );
    const projectAgainstHead = countDelta(seededCounts, beforeProject);

    const beforeFirst = snapshotCounts(seededCounts);
    const first = await seeded.query(query(committed));
    const seededFirstQuery = countDelta(seededCounts, beforeFirst);

    const beforeRepeated = snapshotCounts(seededCounts);
    const repeated = await seeded.query(query(committed));
    const seededRepeatedQuery = countDelta(seededCounts, beforeRepeated);

    const coldCounts = counts();
    const cold = await openAttuneGraph({
      scope: SCOPE,
      store: countedStore(backing, coldCounts)
    });
    let coldFirst;
    let coldFirstQuery;
    try {
      const beforeCold = snapshotCounts(coldCounts);
      coldFirst = await cold.query(query(committed));
      coldFirstQuery = countDelta(coldCounts, beforeCold);
    } finally {
      await cold.close();
    }

    const firstEqualsCold = JSON.stringify(first) === JSON.stringify(coldFirst);
    const repeatedEqualsFirst = JSON.stringify(repeated) === JSON.stringify(first);
    if (!firstEqualsCold || !repeatedEqualsFirst) {
      throw new Error("prepared-plan seed changed decision result or receipt bytes");
    }
    exactCounts(projectAgainstHead, {
      compareAndSwaps: 1,
      fullProjectionReads: 1,
      headReads: 0
    }, "projectAgainstHead");
    exactCounts(seededFirstQuery, {
      compareAndSwaps: 0,
      fullProjectionReads: 0,
      headReads: 1
    }, "seeded first query");
    exactCounts(seededRepeatedQuery, seededFirstQuery, "seeded repeated query");
    exactCounts(coldFirstQuery, {
      compareAndSwaps: 0,
      fullProjectionReads: 1,
      headReads: 1
    }, "cold first query");

    return Object.freeze({
      claimEligible: false,
      equivalence: Object.freeze({ firstEqualsCold, repeatedEqualsFirst }),
      measurementOnly: true,
      parts: Object.freeze({
        coldFirstQuery,
        projectAgainstHead,
        seededFirstQuery,
        seededRepeatedQuery
      }),
      schema: "attunegraph-prepared-plan-seed-part-count@1",
      workload: "projectAgainstHead -> first exact-head decision-query@1 -> repeated query"
    });
  } finally {
    await seeded.close();
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  runPreparedPlanSeedPartCountBenchmark().then(
    (report) => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); },
    (cause) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  );
}
