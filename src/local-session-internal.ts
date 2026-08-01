import { types as nodeTypes } from "node:util";

import { createAttuneGraphStore } from "./attunegraph-backend.js";
import type {
  AttuneGraph,
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryResult,
  AttuneGraphExecuteCommand,
  AttuneGraphOperatorResult,
  AttuneGraphProjectAgainstHeadCommand,
  AttuneGraphProjectCommand,
  AttuneGraphRevocationImpactCommand,
  AttuneGraphRevocationImpactResult,
  AttuneGraphRevocationTransitionCommand,
  AttuneGraphRevocationTransitionResult,
  AttuneGraphScope,
  AttuneGraphSnapshot
} from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import {
  openSqliteAttuneGraphStore,
  type OpenSqliteAttuneGraphStoreOptions,
  type SqliteWorkerHeapStatistics
} from "./attunegraph-sqlite-store.js";

export interface OpenLocalAttuneGraphSessionOptions {
  readonly databasePath: string;
}

export interface OpenLocalAttuneGraphHandleOptions {
  readonly scope: AttuneGraphScope;
}

export interface LocalAttuneGraphSession {
  open(options: OpenLocalAttuneGraphHandleOptions): Promise<AttuneGraph>;
  close(): Promise<void>;
}

const workerHeapMeasurementProbes = new WeakMap<
  LocalAttuneGraphSession,
  () => Promise<SqliteWorkerHeapStatistics>
>();

/** Package-owned measurement probe; absent from the public local contract and object shape. */
export function inspectLocalSessionWorkerHeapStatisticsForMeasurement(
  session: LocalAttuneGraphSession
): Promise<SqliteWorkerHeapStatistics> {
  const probe = workerHeapMeasurementProbes.get(session);
  if (probe === undefined) {
    return Promise.reject(
      new AttuneGraphError("INVALID_INPUT", "worker heap measurement requires a local session")
    );
  }
  return probe();
}

export interface OpenLocalAttuneGraphSessionForTestingOptions
  extends OpenLocalAttuneGraphSessionOptions {
  readonly testFault?: OpenSqliteAttuneGraphStoreOptions["testFault"];
  readonly testFixtureMode?: true;
  readonly testTimeoutMs?: number;
  readonly testResponseDelayMs?: number;
  readonly testHooks?: OpenSqliteAttuneGraphStoreOptions["testHooks"];
}

type DataRecord = Record<string, unknown>;

function dataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): DataRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new AttuneGraphError("INVALID_INPUT", `${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AttuneGraphError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    throw new AttuneGraphError("INVALID_INPUT", `${label} has invalid fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    throw new AttuneGraphError("INVALID_INPUT", `${label} fields must be data properties`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value])
  );
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 512
  ) {
    throw new AttuneGraphError("INVALID_INPUT", `${label} must be bounded non-empty text`);
  }
  return value;
}

function normalizeSessionOptions(value: unknown): OpenLocalAttuneGraphSessionOptions {
  const options = dataRecord(
    value,
    "open local AttuneGraph session options",
    ["databasePath"],
    ["databasePath"]
  );
  if (typeof options.databasePath !== "string") {
    throw new AttuneGraphError(
      "INVALID_INPUT",
      "open local AttuneGraph session options.databasePath must be a string"
    );
  }
  return Object.freeze({ databasePath: options.databasePath });
}

function normalizeHandleOptions(value: unknown): OpenLocalAttuneGraphHandleOptions {
  const options = dataRecord(
    value,
    "open local AttuneGraph session handle options",
    ["scope"],
    ["scope"]
  );
  const rawScope = dataRecord(
    options.scope,
    "open local AttuneGraph session handle options.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"]
  );
  return Object.freeze({
    scope: Object.freeze({
      sourceId: boundedText(rawScope.sourceId, "open local AttuneGraph session handle options.scope.sourceId"),
      threadId: boundedText(rawScope.threadId, "open local AttuneGraph session handle options.scope.threadId")
    })
  });
}

async function openLocalAttuneGraphSessionWithStoreOptions(
  options: OpenLocalAttuneGraphSessionOptions,
  storeOptions: Omit<OpenSqliteAttuneGraphStoreOptions, "databasePath"> = {}
): Promise<LocalAttuneGraphSession> {
  const normalized = normalizeSessionOptions(options);
  const resource = await openSqliteAttuneGraphStore({
    databasePath: normalized.databasePath,
    ...storeOptions
  });
  const store = createAttuneGraphStore(resource.backend);
  let lifecycle: "open" | "closing" | "closed" = "open";
  let opening = 0;
  let inFlight = 0;
  let drainResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const rejectClosed = <T>(): Promise<T> => Promise.reject(
    new AttuneGraphError("CLOSED", "local AttuneGraph session is closing or closed")
  );
  const release = (): void => {
    if (opening + inFlight === 0) drainResolve?.();
  };
  const releaseOpening = (): void => {
    opening -= 1;
    release();
  };
  const begin = <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "open") return rejectClosed<T>();
    inFlight += 1;
    let accepted: Promise<T>;
    try {
      accepted = Promise.resolve(operation());
    } catch (cause) {
      accepted = Promise.reject(cause);
    }
    return accepted.finally(() => {
      inFlight -= 1;
      release();
    });
  };
  const sessionHandle = (engine: AttuneGraph): AttuneGraph => Object.freeze({
    head(): Promise<AttuneGraphSnapshot | undefined> {
      return begin(() => engine.head());
    },
    project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot> {
      return begin(() => engine.project(command));
    },
    projectAgainstHead(
      command: AttuneGraphProjectAgainstHeadCommand
    ): Promise<AttuneGraphSnapshot> {
      return begin(() => engine.projectAgainstHead(command));
    },
    execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult> {
      return begin(() => engine.execute(command));
    },
    query(command: AttuneGraphDecisionQuery): Promise<AttuneGraphDecisionQueryResult> {
      return begin(() => engine.query(command));
    },
    planRevocationImpact(
      command: AttuneGraphRevocationImpactCommand
    ): Promise<AttuneGraphRevocationImpactResult> {
      return begin(() => engine.planRevocationImpact(command));
    },
    applyRevocationTransition(
      command: AttuneGraphRevocationTransitionCommand
    ): Promise<AttuneGraphRevocationTransitionResult> {
      return begin(() => engine.applyRevocationTransition(command));
    },
    close(): Promise<void> {
      return engine.close();
    }
  });

  const session = {
    open(handleOptions: OpenLocalAttuneGraphHandleOptions): Promise<AttuneGraph> {
      if (lifecycle !== "open") return rejectClosed<AttuneGraph>();
      let normalizedHandle: OpenLocalAttuneGraphHandleOptions;
      try {
        normalizedHandle = normalizeHandleOptions(handleOptions);
      } catch (cause) {
        return Promise.reject(cause);
      }
      opening += 1;
      return openAttuneGraph({ scope: normalizedHandle.scope, store })
        .then(async (engine) => {
          if (lifecycle === "open") return sessionHandle(engine);
          await engine.close();
          throw new AttuneGraphError("CLOSED", "local AttuneGraph session is closing or closed");
        })
        .finally(releaseOpening);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      closePromise = (async () => {
        if (opening + inFlight > 0) {
          await new Promise<void>((resolve) => {
            drainResolve = resolve;
          });
        }
        await resource.close();
      })().finally(() => {
        lifecycle = "closed";
      });
      return closePromise;
    }
  } satisfies LocalAttuneGraphSession;
  workerHeapMeasurementProbes.set(
    session,
    () => resource.inspectWorkerHeapStatisticsForMeasurement()
  );
  return Object.freeze(session);
}

export function openLocalAttuneGraphSession(
  options: OpenLocalAttuneGraphSessionOptions
): Promise<LocalAttuneGraphSession> {
  return openLocalAttuneGraphSessionWithStoreOptions(options);
}

/** Internal test fixture; it is not exported by the package map. */
export function openLocalAttuneGraphSessionForTesting(
  options: OpenLocalAttuneGraphSessionForTestingOptions
): Promise<LocalAttuneGraphSession> {
  const input = dataRecord(
    options,
    "open local AttuneGraph session test options",
    ["databasePath", "testFault", "testFixtureMode", "testTimeoutMs", "testResponseDelayMs", "testHooks"],
    ["databasePath"]
  );
  return openLocalAttuneGraphSessionWithStoreOptions(
    { databasePath: input.databasePath as string },
    {
      testFault: input.testFault as OpenSqliteAttuneGraphStoreOptions["testFault"],
      testFixtureMode: input.testFixtureMode as true | undefined,
      testTimeoutMs: input.testTimeoutMs as number | undefined,
      testResponseDelayMs: input.testResponseDelayMs as number | undefined,
      testHooks: input.testHooks as OpenSqliteAttuneGraphStoreOptions["testHooks"]
    }
  );
}
