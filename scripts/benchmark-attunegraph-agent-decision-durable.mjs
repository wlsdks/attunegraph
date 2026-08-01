import { Buffer } from "node:buffer";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { types as nodeTypes } from "node:util";

import { openLocalAttuneGraph } from "@attunegraph/core/local";

const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const RECORDED_AT = "2026-08-01T10:00:00.000Z";

function frozen(value) {
  return Object.freeze(value);
}

function graphRef(kind, id) {
  return frozen({ kind, id });
}

function assertion(id, subject, object, sourceId, temporal = {}) {
  return frozen({
    schemaVersion: 1,
    id,
    subject,
    predicate: "LINKED_TO",
    object,
    epistemicClass: "source-observed",
    sourceRefs: frozen([frozen({
      namespace: "b",
      id: sourceId
    })]),
    recordedAt: temporal.recordedAt ?? RECORDED_AT,
    ...(temporal.validFrom === undefined ? {} : { validFrom: temporal.validFrom }),
    ...(temporal.validTo === undefined ? {} : { validTo: temporal.validTo }),
    ...(temporal.supersededAt === undefined ? {} : { supersededAt: temporal.supersededAt }),
    derivation: frozen({ kind: "projection", version: "v" })
  });
}

export function createDurableAgentDecisionWorkload() {
  const scope = frozen({
    sourceId: "agent-decision-durable-benchmark",
    threadId: "scope:frontier-16"
  });
  const threadRoot = graphRef("thread", "root");
  const temporalProfiles = frozen([
    frozen({ id: "x", time: frozen({ validTo: "2026-08-01T11:00:00.000Z" }) }),
    frozen({ id: "f", time: frozen({ validFrom: "2026-08-01T13:00:00.000Z" }) }),
    frozen({ id: "r", time: frozen({ recordedAt: "2026-08-01T13:00:00.000Z" }) }),
    frozen({ id: "s", time: frozen({ supersededAt: "2026-08-01T11:00:00.000Z" }) })
  ]);
  const projectCommands = frozen(Array.from({ length: 8 }, (_, index) => {
    const generation = `g${(index + 1).toString().padStart(2, "0")}`;
    const active = Array.from({ length: 16 }, (_, assertionIndex) => {
      const suffix = assertionIndex.toString().padStart(2, "0");
      return assertion(
        `a:${generation}:${suffix}`,
        graphRef("artifact", `n:${generation}:${suffix}`),
        threadRoot,
        `s:${generation}:a:${suffix}`
      );
    });
    const inactive = temporalProfiles.flatMap((profile) => Array.from(
      { length: 6 },
      (_, assertionIndex) => {
        const suffix = assertionIndex.toString().padStart(2, "0");
        return assertion(
          `d:${generation}:${profile.id}:${suffix}`,
          graphRef("artifact", `d:${generation}:${profile.id}:${suffix}`),
          threadRoot,
          `s:${generation}:d:${profile.id}:${suffix}`,
          profile.time
        );
      }
    ));
    return frozen({
      operator: "canonical-projection@2",
      observation: frozen({
        schemaVersion: 2,
        observationKey: `generation-churn-8x40:${generation}`,
        scope,
        threadRoot,
        observedAt: OBSERVED_AT,
        sourceFreshness: frozen({ state: "fresh", observedAt: OBSERVED_AT }),
        assertions: frozen([...active, ...inactive])
      })
    });
  }));

  return frozen({
    scope,
    seed: graphRef("artifact", "n:g08:00"),
    projectCommands
  });
}

function semantic(result) {
  return frozen({
    assertionIds: frozen(result.workingGraph.assertions.map((entry) => entry.id)),
    assertionProvenance: frozen(result.workingGraph.assertions.map((entry) => frozen({
      assertionId: entry.id,
      derivation: frozen({ ...entry.derivation }),
      sourceRefs: frozen(entry.sourceRefs.map((sourceRef) => frozen({ ...sourceRef })))
    }))),
    consideredAssertions: result.workingGraph.diagnostics.consideredAssertions,
    emittedAssertions: result.workingGraph.assertions.length,
    generation: result.snapshot.generation,
    headCommitId: result.snapshot.commitId,
    maxDepthReached: result.workingGraph.diagnostics.maxDepthReached,
    refIds: frozen(result.workingGraph.refs.map((entry) => `${entry.kind}:${entry.id}`)),
    sourceFreshness: frozen({ ...result.sourceFreshness }),
    sourceRefIds: frozen(result.workingGraph.assertions.flatMap(
      (entry) => entry.sourceRefs.map((sourceRef) => `${sourceRef.namespace}:${sourceRef.id}`)
    )),
    status: result.status,
    truncationReasons: frozen([...result.workingGraph.diagnostics.truncationReasons]),
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
}

function exactMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function databasePathFrom(options) {
  const keys = options !== null && typeof options === "object" && !nodeTypes.isProxy(options)
    ? Reflect.ownKeys(options)
    : [];
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || nodeTypes.isProxy(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || keys.length !== 1
    || keys[0] !== "databasePath"
  ) {
    throw new Error("durable agent-decision tracer requires one absolute databasePath");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "databasePath");
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
    || !isAbsolute(descriptor.value)
  ) {
    throw new Error("durable agent-decision tracer requires one absolute databasePath");
  }
  const databasePath = descriptor.value;
  if (existsSync(databasePath)) {
    throw new Error("durable agent-decision tracer requires a new databasePath");
  }
  return databasePath;
}

async function closeGraph(graph) {
  if (graph !== undefined) await graph.close();
}

export function composeDurableTracerCleanupFailure(primaryFailure, cleanupFailures, message) {
  return new AggregateError(
    [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
    message
  );
}

export async function runDurableAgentDecisionTracer(options) {
  const databasePath = databasePathFrom(options);
  const cell = createDurableAgentDecisionWorkload();
  const projectionInputBytes = Math.max(...cell.projectCommands.map(
    (command) => Buffer.byteLength(JSON.stringify(command.observation), "utf8")
  ));
  const execute = frozen({
    operator: "working-graph@1",
    seed: cell.seed,
    now: NOW,
    maxEstimatedTokens: 32_768
  });

  let first;
  let reopened;
  let primaryFailure;
  try {
    first = await openLocalAttuneGraph({ databasePath, scope: cell.scope });
    let snapshotBeforeClose;
    for (const command of cell.projectCommands) {
      snapshotBeforeClose = await first.projectAgainstHead(JSON.parse(JSON.stringify(command)));
    }
    const resultBeforeClose = await first.execute(JSON.parse(JSON.stringify(execute)));
    await closeGraph(first);
    first = undefined;

    const reopenStartedAt = performance.now();
    reopened = await openLocalAttuneGraph({ databasePath, scope: cell.scope });
    const reopenAfterGracefulCloseMilliseconds = performance.now() - reopenStartedAt;
    const snapshotAfterReopen = await reopened.head();
    const executeStartedAt = performance.now();
    const resultAfterReopen = await reopened.execute(JSON.parse(JSON.stringify(execute)));
    const executeAfterReopenMilliseconds = performance.now() - executeStartedAt;

    const beforeClose = semantic(resultBeforeClose);
    const afterReopen = semantic(resultAfterReopen);
    const snapshotStable = exactMatch(snapshotBeforeClose, snapshotAfterReopen);
    const semanticStable = exactMatch(beforeClose, afterReopen);
    const fullResultExact = exactMatch(resultBeforeClose, resultAfterReopen);
    if (!snapshotStable || !semanticStable || !fullResultExact) {
      throw new Error("durable agent-decision tracer observed close/reopen divergence");
    }

    await closeGraph(reopened);
    reopened = undefined;

    return frozen({
      schema: "attunegraph-agent-decision-durable-tracer@1",
      measurementOnly: true,
      claimEligible: false,
      measurementBoundary: frozen({
        clientCount: 1,
        closeMode: "graceful",
        osCache: "uncontrolled",
        process: "same-process-new-worker"
      }),
      workload: frozen({
        id: "generation-churn-8x40@1",
        activeAssertionCount: 16,
        inactiveAssertionCount: 24,
        projectedAssertionInputs: 320,
        projectionEnvelopeLimitBytes: 15_500,
        projectionInputBytes,
        totalAssertionCountAtHead: 40,
        generation: 8,
        profile: "single-client-worker-isolated-sqlite-graceful-close-reopen",
        temporalDecoys: frozen({
          expired: 6,
          futureValid: 6,
          postRecordedCutoff: 6,
          superseded: 6
        })
      }),
      correctness: frozen({
        exactMatch: semanticStable,
        fullResultExact,
        snapshotStable,
        beforeClose,
        afterReopen
      }),
      limits: frozen({
        crashRecovery: "not-measured",
        multiClientConcurrency: "not-measured",
        osPageCache: "uncontrolled"
      }),
      timing: frozen({
        reopenAfterGracefulCloseMilliseconds,
        executeAfterReopenMilliseconds
      })
    });
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    const cleanupFailures = [];
    for (const graph of [reopened, first]) {
      try {
        await closeGraph(graph);
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    if (cleanupFailures.length > 0) {
      throw composeDurableTracerCleanupFailure(
        primaryFailure,
        cleanupFailures,
        "durable tracer Worker cleanup failed"
      );
    }
  }
}

export async function runDurableAgentDecisionTracerCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("durable agent-decision tracer does not accept command-line arguments");
  }
  let createdDirectory;
  let primaryFailure;
  try {
    createdDirectory = mkdtempSync(join(tmpdir(), "attunegraph-durable-decision-"));
    chmodSync(createdDirectory, 0o700);
    const directory = realpathSync(createdDirectory);
    const report = await runDurableAgentDecisionTracer({
      databasePath: join(directory, "attunegraph.sqlite")
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    if (createdDirectory !== undefined) {
      try {
        rmSync(createdDirectory, { force: true, recursive: true });
      } catch (cause) {
        throw composeDurableTracerCleanupFailure(
          primaryFailure,
          [cause],
          "durable tracer database cleanup failed"
        );
      }
    }
  }
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string"
  && import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await runDurableAgentDecisionTracerCommand().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
