import { types as nodeTypes } from "node:util";

import type {
  AttuneGraph,
  AttuneGraphAuthorityQuery,
  AttuneGraphAuthorityQueryResult,
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryResult,
  AttuneGraphDecisionContextQuery,
  AttuneGraphDecisionContextResult,
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
import { AttuneGraphError } from "./attunegraph-error.js";
import {
  openLocalAttuneGraphSession as openLocalAttuneGraphSessionInternal
} from "./local-session-internal.js";

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

export interface OpenLocalAttuneGraphOptions {
  readonly databasePath: string;
  readonly scope: AttuneGraphScope;
}

/**
 * Opens one durable SQLite worker for a caller-owned database session. Each
 * opened Engine handle remains bound to its declared scope; closing a handle
 * never closes the session or its other handles.
 */
export function openLocalAttuneGraphSession(
  options: OpenLocalAttuneGraphSessionOptions
): Promise<LocalAttuneGraphSession> {
  return openLocalAttuneGraphSessionInternal(options);
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

function normalizeOptions(value: unknown): OpenLocalAttuneGraphOptions {
  const options = dataRecord(
    value,
    "open local AttuneGraph options",
    ["databasePath", "scope"],
    ["databasePath", "scope"]
  );
  const rawScope = dataRecord(
    options.scope,
    "open local AttuneGraph options.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"]
  );
  if (typeof options.databasePath !== "string") {
    throw new AttuneGraphError(
      "INVALID_INPUT",
      "open local AttuneGraph options.databasePath must be a string"
    );
  }
  return Object.freeze({
    databasePath: options.databasePath,
    scope: Object.freeze({
      sourceId: boundedText(
        rawScope.sourceId,
        "open local AttuneGraph options.scope.sourceId"
      ),
      threadId: boundedText(
        rawScope.threadId,
        "open local AttuneGraph options.scope.threadId"
      )
    })
  });
}

/**
 * Opens the durable local AttuneGraph Module.
 *
 * SQLite, SQL, Worker lifecycle, migrations, and physical profile details stay
 * behind this Interface. The existing AttuneGraph Engine remains the sole owner of
 * projection, replay, snapshot, and operator semantics.
 */
export async function openLocalAttuneGraph(options: OpenLocalAttuneGraphOptions): Promise<AttuneGraph> {
  const normalized = normalizeOptions(options);
  const session = await openLocalAttuneGraphSession({ databasePath: normalized.databasePath });
  let engine: AttuneGraph;
  try {
    engine = await session.open({ scope: normalized.scope });
  } catch (cause) {
    await session.close().catch(() => undefined);
    throw cause;
  }

  let lifecycle: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;

  const rejectClosed = <T>(): Promise<T> =>
    Promise.reject(new AttuneGraphError("CLOSED", "local AttuneGraph instance is closing or closed"));

  return Object.freeze({
    head() {
      return lifecycle === "open"
        ? engine.head()
        : rejectClosed<AttuneGraphSnapshot | undefined>();
    },
    project(command: AttuneGraphProjectCommand) {
      return lifecycle === "open"
        ? engine.project(command)
        : rejectClosed<AttuneGraphSnapshot>();
    },
    projectAgainstHead(command: AttuneGraphProjectAgainstHeadCommand) {
      return lifecycle === "open"
        ? engine.projectAgainstHead(command)
        : rejectClosed<AttuneGraphSnapshot>();
    },
    execute(command: AttuneGraphExecuteCommand) {
      return lifecycle === "open"
        ? engine.execute(command)
        : rejectClosed<AttuneGraphOperatorResult>();
    },
    query(command: AttuneGraphDecisionQuery) {
      return lifecycle === "open"
        ? engine.query(command)
        : rejectClosed<AttuneGraphDecisionQueryResult>();
    },
    queryAuthority(command: AttuneGraphAuthorityQuery) {
      return lifecycle === "open"
        ? engine.queryAuthority(command)
        : rejectClosed<AttuneGraphAuthorityQueryResult>();
    },
    queryDecisionContext(command: AttuneGraphDecisionContextQuery) {
      return lifecycle === "open"
        ? engine.queryDecisionContext(command)
        : rejectClosed<AttuneGraphDecisionContextResult>();
    },
    planRevocationImpact(command: AttuneGraphRevocationImpactCommand) {
      return lifecycle === "open"
        ? engine.planRevocationImpact(command)
        : rejectClosed<AttuneGraphRevocationImpactResult>();
    },
    applyRevocationTransition(command: AttuneGraphRevocationTransitionCommand) {
      return lifecycle === "open"
        ? engine.applyRevocationTransition(command)
        : rejectClosed<AttuneGraphRevocationTransitionResult>();
    },
    close() {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      const engineClose = engine.close();
      closePromise = engineClose
        .then(() => session.close())
        .finally(() => {
          lifecycle = "closed";
        });
      return closePromise;
    }
  });
}
