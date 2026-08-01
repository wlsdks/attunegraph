import { types as nodeTypes } from "node:util";

import {
  CANONICAL_IMMUTABLE_ENVELOPE_LIMITS,
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse,
  type CanonicalImmutableEnvelopeResult
} from "./canonical-immutable-envelope.js";
import {
  ACTIVATION_PREDICATES,
  GRAPH_ASSERTION_SOURCE_NAMESPACE,
  MAX_ACTIVATION_ESTIMATED_TOKENS
} from "./constants.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraph,
  AttuneGraphAuthorityQuery,
  AttuneGraphAuthorityQueryResult,
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryResult,
  AttuneGraphExecuteCommand,
  AttuneGraphOperatorResult,
  AttuneGraphProjectAgainstHeadCommand,
  AttuneGraphProjectCommand,
  AttuneGraphRevocationImpactCommand,
  AttuneGraphRevocationImpactResult,
  AttuneGraphRevocationTransitionCommand,
  AttuneGraphRevocationTransitionReceipt,
  AttuneGraphRevocationTransitionResult,
  AttuneGraphScope,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  AttuneGraphSourceObservationV2,
  OpenAttuneGraphOptions
} from "./attunegraph-contracts.js";
import {
  compileAuthorityQuery,
  normalizeAuthorityQuery
} from "./authority-query.js";
import {
  normalizeDecisionQuery,
  sealDecisionQueryReceipt
} from "./decision-query.js";
import {
  admitRevocationImpactReceiptCanonicalJson,
  compileRevocationImpact,
  matchesRevocationSelector,
  normalizeRevocationImpactCommand
} from "./revocation-impact.js";
import { registeredAttuneGraphStoreBackend } from "./attunegraph-store-internal.js";
import { graphRefKey, instantEpoch, normalizeGraphAssertionBatch } from "./validation.js";
import type { GraphAssertion, GraphRef } from "./types.js";

const MAX_WORKING_DEPTH = 2;
const MAX_WORKING_CONSIDERED = 128;
const MAX_WORKING_VISITED = 64;
const MAX_WORKING_ASSERTIONS = 64;
const MAX_STORED_PROJECTION_TEXT =
  CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringCodeUnits;
const MAX_STORED_PROJECTION_BYTES =
  CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxStringBytes;
const transitionReceiptSpec = Object.freeze({
  hashDomain: "attunegraph.revocation-transition.v1",
  idField: "receiptId",
  idPrefix: "attunegraph-revocation-transition:"
} as const);

type DataRecord = Record<string, unknown>;

interface NormalizedObservation {
  readonly hasDuplicateAssertionIds: boolean;
  readonly assertionFingerprint: string;
  readonly assertions: readonly GraphAssertion[];
  readonly canonicalProjection: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly threadRoot?: GraphRef;
}

interface NormalizedRevocationTransition {
  readonly impactReceipt: ReturnType<typeof admitRevocationImpactReceiptCanonicalJson>;
  readonly replacement: NormalizedObservation;
}

function attuneGraphError(code: AttuneGraphError["code"], message: string, options?: ErrorOptions): never {
  throw new AttuneGraphError(code, message, options);
}

function record(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  code: AttuneGraphError["code"] = "INVALID_INPUT"
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) attuneGraphError(code, `${label} must be a plain object`);
  if (nodeTypes.isProxy(value)) attuneGraphError(code, `${label} must not be a proxy`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) attuneGraphError(code, `${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) attuneGraphError(code, `${label} has unknown fields`);
  if (required.some((key) => !keys.includes(key))) attuneGraphError(code, `${label} has missing fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string" || !descriptors[key] || !("value" in descriptors[key]!))) attuneGraphError(code, `${label} must have data properties`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function text(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT", limit = 512): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > limit) attuneGraphError(code, `${label} must be bounded non-empty text`);
  return value;
}

function instant(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) attuneGraphError(code, `${label} must be a canonical ISO instant`);
  return value;
}

export function normalizeAttuneGraphScope(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphScope {
  const input = record(value, label, ["sourceId", "threadId"], ["sourceId", "threadId"], code);
  return Object.freeze({ sourceId: text(input.sourceId, `${label}.sourceId`, code), threadId: text(input.threadId, `${label}.threadId`, code) });
}

function sameScope(left: AttuneGraphScope, right: AttuneGraphScope): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function snapshot(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphSnapshot {
  const input = record(value, label, ["schemaVersion", "scope", "generation", "commitId"], ["schemaVersion", "scope", "generation", "commitId"], code);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.generation) || (input.generation as number) < 1) attuneGraphError(code, `${label} is invalid`);
  return Object.freeze({ schemaVersion: 1, scope: normalizeAttuneGraphScope(input.scope, `${label}.scope`, code), generation: input.generation as number, commitId: text(input.commitId, `${label}.commitId`, code) });
}

function freshness(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphSourceFreshness {
  const input = record(value, label, ["state", "observedAt"], ["state", "observedAt"], code);
  if (input.state !== "fresh" && input.state !== "stale" && input.state !== "unknown") attuneGraphError(code, `${label}.state is invalid`);
  return Object.freeze({ state: input.state, observedAt: instant(input.observedAt, `${label}.observedAt`, code) });
}

function freezeSnapshot(input: AttuneGraphSnapshot): AttuneGraphSnapshot {
  return Object.freeze({ schemaVersion: 1, scope: Object.freeze({ ...input.scope }), generation: input.generation, commitId: input.commitId });
}

function canonicalEnvelope(
  value: unknown,
  profile: "external-mutable" | "attunegraph-frozen",
  label: string,
  code: AttuneGraphError["code"] = "INVALID_INPUT",
  version: 1 | 2 = 1
): { readonly envelope: Readonly<Record<string, unknown>>; readonly canonicalJson: string; readonly contentId: string } {
  try {
    return canonicalizeImmutableEnvelope(value, profile, {
      hashDomain: `attunegraph.canonical-projection.v${version}`,
      idField: "observationId",
      idPrefix: "attunegraph-observation:"
    });
  } catch (cause) {
    throw new AttuneGraphError(code, `${label} is not a safe canonical envelope`, { cause });
  }
}

function dedupeAssertions(
  assertions: readonly GraphAssertion[],
  code: AttuneGraphError["code"]
): readonly GraphAssertion[] {
  const byId = new Map<string, GraphAssertion>();
  for (const assertion of assertions) {
    const existing = byId.get(assertion.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(assertion)) {
      attuneGraphError(code, `assertion id ${assertion.id} has conflicting content`);
    }
    if (!existing) byId.set(assertion.id, assertion);
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function requireThreadRootedObservation(
  assertions: readonly GraphAssertion[],
  threadRoot: GraphRef,
  code: AttuneGraphError["code"]
): void {
  if (assertions.length === 0) return;

  const adjacency = new Map<
    string,
    { readonly assertionIndex: number; readonly next: string }[]
  >();
  const connect = (from: string, assertionIndex: number, next: string): void => {
    const entries = adjacency.get(from);
    const entry = { assertionIndex, next };
    if (entries) entries.push(entry);
    else adjacency.set(from, [entry]);
  };

  for (let index = 0; index < assertions.length; index += 1) {
    const assertion = assertions[index]!;
    const subject = graphRefKey(assertion.subject);
    const object = graphRefKey(assertion.object);
    connect(subject, index, object);
    connect(object, index, subject);
  }

  const root = graphRefKey(threadRoot);
  const queue = [root];
  const visitedRefs = new Set(queue);
  const reachedAssertions = new Set<number>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const entry of adjacency.get(queue[cursor]!) ?? []) {
      reachedAssertions.add(entry.assertionIndex);
      if (!visitedRefs.has(entry.next)) {
        visitedRefs.add(entry.next);
        queue.push(entry.next);
      }
    }
  }

  if (reachedAssertions.size !== assertions.length) {
    attuneGraphError(
      code,
      "source observation assertions must form one component rooted at its thread scope"
    );
  }
}

function normalizedObservationFromEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  canonicalProjection: string,
  observationId: string,
  expectedScope: AttuneGraphScope,
  code: AttuneGraphError["code"],
  version: 1 | 2
): NormalizedObservation {
  const fields = version === 1
    ? ["schemaVersion", "observationId", "observationKey", "scope", "observedAt", "sourceFreshness", "assertions"]
    : ["schemaVersion", "observationId", "observationKey", "scope", "threadRoot", "observedAt", "sourceFreshness", "assertions"];
  const input = record(envelope, "source observation", fields, fields, code);
  if (input.schemaVersion !== version) attuneGraphError(code, `source observation.schemaVersion must be ${version}`);
  text(input.observationKey, "source observation.observationKey", code);
  const observedScope = normalizeAttuneGraphScope(input.scope, "source observation.scope", code);
  if (!sameScope(observedScope, expectedScope)) attuneGraphError(code === "INVALID_INPUT" ? "INVALID_SCOPE" : code, "source observation must match the opened scope");
  if (!Array.isArray(input.assertions)) attuneGraphError(code, "source observation.assertions must be an array");
  let normalizedAssertions: readonly GraphAssertion[];
  try {
    normalizedAssertions = normalizeGraphAssertionBatch(input.assertions);
  } catch (cause) {
    if (cause instanceof AttuneGraphError) throw cause;
    throw new AttuneGraphError(code, "source observation assertions are invalid", { cause });
  }
  const hasDuplicateAssertionIds = new Set(normalizedAssertions.map((assertion) => assertion.id)).size !== normalizedAssertions.length;
  const assertions = dedupeAssertions(normalizedAssertions, code);
  let threadRoot: GraphRef | undefined;
  if (version === 2) {
    const rootInput = record(
      input.threadRoot,
      "source observation.threadRoot",
      ["id", "kind"],
      ["id", "kind"],
      code
    );
    if (rootInput.kind !== "thread") {
      attuneGraphError(code, "source observation.threadRoot.kind must be thread");
    }
    threadRoot = Object.freeze({
      id: text(rootInput.id, "source observation.threadRoot.id", code),
      kind: "thread" as const
    });
    requireThreadRootedObservation(
      assertions,
      threadRoot,
      code === "INVALID_INPUT" ? "DISCONNECTED_OBSERVATION" : code
    );
  }
  const derivedId = text(input.observationId, "source observation.observationId", code);
  if (derivedId !== observationId) attuneGraphError(code, "source observation content identifier mismatches its canonical envelope");
  return Object.freeze({
    hasDuplicateAssertionIds,
    assertionFingerprint: JSON.stringify(assertions),
    assertions,
    canonicalProjection,
    observationId,
    observedAt: instant(input.observedAt, "source observation.observedAt", code),
    sourceFreshness: freshness(input.sourceFreshness, "source observation.sourceFreshness", code),
    ...(threadRoot === undefined ? {} : { threadRoot })
  });
}

function normalizeObservation(
  value: unknown,
  expectedScope: AttuneGraphScope,
  version: 1 | 2
): NormalizedObservation {
  const canonical = canonicalEnvelope(
    value,
    "external-mutable",
    "source observation",
    "INVALID_INPUT",
    version
  );
  return normalizedObservationFromEnvelope(
    canonical.envelope,
    canonical.canonicalJson,
    canonical.contentId,
    expectedScope,
    "INVALID_INPUT",
    version
  );
}

function normalizeProject(command: AttuneGraphProjectCommand, expectedScope: AttuneGraphScope): { readonly expectedSnapshot: AttuneGraphSnapshot | undefined; readonly observation: NormalizedObservation } {
  const input = record(command, "project command", ["operator", "observation", "expectedSnapshot"], ["operator", "observation"]);
  if (input.operator !== "canonical-projection@1" && input.operator !== "canonical-projection@2") {
    attuneGraphError("UNSUPPORTED_OPERATOR", "project supports canonical-projection@1 and canonical-projection@2");
  }
  const expectedSnapshot = input.expectedSnapshot === undefined ? undefined : snapshot(input.expectedSnapshot, "project command.expectedSnapshot");
  if (expectedSnapshot && !sameScope(expectedSnapshot.scope, expectedScope)) attuneGraphError("SNAPSHOT_SCOPE_MISMATCH", "expected snapshot belongs to another scope");
  const observation = normalizeObservation(
    input.observation,
    expectedScope,
    input.operator === "canonical-projection@2" ? 2 : 1
  );
  if (
    observation.canonicalProjection.length > MAX_STORED_PROJECTION_TEXT
    || Buffer.byteLength(observation.canonicalProjection, "utf8")
      > MAX_STORED_PROJECTION_BYTES
  ) {
    attuneGraphError(
      "INVALID_INPUT",
      "source observation exceeds the stored projection text budget"
    );
  }
  return Object.freeze({ expectedSnapshot, observation });
}

function normalizeProjectAgainstHead(
  command: AttuneGraphProjectAgainstHeadCommand,
  expectedScope: AttuneGraphScope
): NormalizedObservation {
  const input = record(
    command,
    "projectAgainstHead command",
    ["operator", "observation"],
    ["operator", "observation"]
  );
  if (input.operator !== "canonical-projection@1" && input.operator !== "canonical-projection@2") {
    attuneGraphError("UNSUPPORTED_OPERATOR", "projectAgainstHead supports canonical-projection@1 and canonical-projection@2");
  }
  const observation = normalizeObservation(
    input.observation,
    expectedScope,
    input.operator === "canonical-projection@2" ? 2 : 1
  );
  if (
    observation.canonicalProjection.length > MAX_STORED_PROJECTION_TEXT
    || Buffer.byteLength(observation.canonicalProjection, "utf8")
      > MAX_STORED_PROJECTION_BYTES
  ) {
    attuneGraphError(
      "INVALID_INPUT",
      "source observation exceeds the stored projection text budget"
    );
  }
  return observation;
}

function normalizeRevocationTransition(
  value: unknown,
  expectedScope: AttuneGraphScope
): NormalizedRevocationTransition {
  const input = record(
    value,
    "revocation transition command",
    ["operator", "receiptCanonicalJson", "replacement"],
    ["operator", "receiptCanonicalJson", "replacement"]
  );
  if (input.operator !== "revocation-transition@1") {
    attuneGraphError("UNSUPPORTED_OPERATOR", "applyRevocationTransition supports revocation-transition@1");
  }
  const impactReceipt = admitRevocationImpactReceiptCanonicalJson(input.receiptCanonicalJson);
  if (impactReceipt.status !== "complete" || impactReceipt.snapshot === null) {
    attuneGraphError("INVALID_INPUT", "revocation transition requires a complete non-empty impact receipt");
  }
  if (!sameScope(impactReceipt.snapshot.scope, expectedScope)) {
    attuneGraphError("INVALID_SCOPE", "revocation impact receipt must match the opened scope");
  }
  const replacement = record(
    input.replacement,
    "revocation transition command.replacement",
    ["operator", "observation"],
    ["operator", "observation"]
  );
  if (replacement.operator !== "canonical-projection@2") {
    attuneGraphError("UNSUPPORTED_OPERATOR", "revocation transition replacement must use canonical-projection@2");
  }
  const normalizedReplacement = normalizeProjectAgainstHead(
    Object.freeze({ operator: "canonical-projection@2" as const, observation: replacement.observation as AttuneGraphSourceObservationV2 }),
    expectedScope
  );
  if (normalizedReplacement.hasDuplicateAssertionIds) {
    attuneGraphError("INVALID_INPUT", "revocation transition replacement must not contain duplicate assertion IDs");
  }
  if (
    normalizedReplacement.sourceFreshness.state !== "fresh"
    || normalizedReplacement.sourceFreshness.observedAt !== normalizedReplacement.observedAt
  ) {
    attuneGraphError("INVALID_INPUT", "revocation transition replacement must be fresh at its observation time");
  }
  return Object.freeze({ impactReceipt, replacement: normalizedReplacement });
}

function exactV2ThreadRoot(projection: AttuneGraphStoredProjection): GraphRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection.canonicalProjection);
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "stored canonical projection is invalid JSON", { cause });
  }
  const observation = record(
    parsed,
    "stored canonical projection",
    ["schemaVersion", "observationId", "observationKey", "scope", "threadRoot", "observedAt", "sourceFreshness", "assertions"],
    ["schemaVersion", "observationId", "observationKey", "scope", "observedAt", "sourceFreshness", "assertions"],
    "CORRUPT_STORE"
  );
  if (observation.schemaVersion !== 2) {
    attuneGraphError("SNAPSHOT_CONFLICT", "revocation transition requires a canonical-projection@2 predecessor");
  }
  const root = record(observation.threadRoot, "stored canonical projection.threadRoot", ["id", "kind"], ["id", "kind"], "CORRUPT_STORE");
  if (root.kind !== "thread") attuneGraphError("CORRUPT_STORE", "stored canonical projection.threadRoot is invalid");
  return Object.freeze({ id: text(root.id, "stored canonical projection.threadRoot.id", "CORRUPT_STORE"), kind: "thread" });
}

function sameGraphRef(left: GraphRef, right: GraphRef): boolean {
  return left.id === right.id && left.kind === right.kind;
}

function sameAssertions(left: readonly GraphAssertion[], right: readonly GraphAssertion[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.id !== right[index]?.id || JSON.stringify(left[index]) !== JSON.stringify(right[index])) return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function sealRevocationTransitionReceipt(
  scope: AttuneGraphScope,
  planReceiptId: string,
  priorSnapshot: AttuneGraphSnapshot,
  replacementObservationId: string,
  resultSnapshot: AttuneGraphSnapshot,
  plannedImpactIds: readonly string[],
  preservedSurvivorCount: number
): AttuneGraphRevocationTransitionReceipt {
  const unsigned = deepFreeze({
    contractRevision: 1 as const,
    scope: Object.freeze({ ...scope }),
    planReceiptId,
    priorSnapshot: freezeSnapshot(priorSnapshot),
    replacementObservationId,
    resultSnapshot: freezeSnapshot(resultSnapshot),
    plannedImpactIds: Object.freeze([...plannedImpactIds]),
    preservedSurvivorCount,
    zeroResidueProof: Object.freeze({ impactIds: 0 as const, selectorMatches: 0 as const, witnessAssertionRefs: 0 as const })
  });
  try {
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(unsigned, transitionReceiptSpec);
    return Object.freeze({ ...minted.envelope, canonicalJson: minted.canonicalJson }) as unknown as AttuneGraphRevocationTransitionReceipt;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "revocation transition receipt could not be sealed", { cause });
  }
}

function safeRef(value: unknown): GraphRef {
  const input = record(value, "working graph seed", ["id", "kind"], ["id", "kind"]);
  const validKinds = ["thread", "artifact", "evidence", "delivery", "outcome", "policy", "decision", "action"];
  if (!validKinds.includes(input.kind as string)) attuneGraphError("INVALID_INPUT", "working graph seed.kind is invalid");
  return Object.freeze({ id: text(input.id, "working graph seed.id"), kind: input.kind as GraphRef["kind"] });
}

function normalizeExecute(command: AttuneGraphExecuteCommand): { readonly seed: GraphRef; readonly nowEpoch: number; readonly maxEstimatedTokens: number } {
  const input = record(command, "execute command", ["operator", "seed", "now", "maxEstimatedTokens"], ["operator", "seed", "now", "maxEstimatedTokens"]);
  if (input.operator !== "working-graph@1") attuneGraphError("UNSUPPORTED_OPERATOR", "execute supports only working-graph@1");
  if (!Number.isSafeInteger(input.maxEstimatedTokens) || (input.maxEstimatedTokens as number) < 1 || (input.maxEstimatedTokens as number) > MAX_ACTIVATION_ESTIMATED_TOKENS) attuneGraphError("INVALID_INPUT", "execute command.maxEstimatedTokens is invalid");
  const now = instant(input.now, "execute command.now");
  return Object.freeze({ seed: safeRef(input.seed), nowEpoch: instantEpoch(now), maxEstimatedTokens: input.maxEstimatedTokens as number });
}

function storeEnvelope(value: unknown): CanonicalImmutableEnvelopeResult {
  const spec = { hashDomain: "attunegraph.store-projection.v1", idField: "storeEnvelopeId", idPrefix: "attunegraph-store:" };
  try {
    return canonicalizeImmutableEnvelope(value, "external-mutable", spec);
  } catch (cause) {
    if (!(cause instanceof CanonicalImmutableEnvelopeError) || cause.code !== "PROFILE_MISMATCH") {
      throw new AttuneGraphError("CORRUPT_STORE", "Store returned an unsafe projection", { cause });
    }
  }
  try {
    return canonicalizeImmutableEnvelope(value, "attunegraph-frozen", spec);
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "Store returned an unsafe projection", { cause });
  }
}

interface NormalizedStoredProjectionAdmission {
  readonly projection: AttuneGraphStoredProjection;
  readonly projectionId: `attunegraph-store:${string}`;
}

function normalizeStoredProjectionShared(
  envelope: CanonicalImmutableEnvelopeResult,
  expectedScope: AttuneGraphScope | undefined
): NormalizedStoredProjectionAdmission {
  const input = record(envelope.envelope, "stored projection", ["schemaVersion", "storeEnvelopeId", "snapshot", "observationId", "canonicalProjection", "projectionFingerprint", "observedAt", "sourceFreshness", "assertions"], ["schemaVersion", "storeEnvelopeId", "snapshot", "observationId", "canonicalProjection", "projectionFingerprint", "observedAt", "sourceFreshness", "assertions"], "CORRUPT_STORE");
  if (input.schemaVersion !== 1) {
    if (typeof input.schemaVersion === "number" && input.schemaVersion > 1) attuneGraphError("FUTURE_STORE_STATE", "Store projection schema is newer than this engine");
    attuneGraphError("CORRUPT_STORE", "Store projection schema is invalid");
  }
  const storedSnapshot = snapshot(input.snapshot, "stored projection.snapshot", "CORRUPT_STORE");
  if (expectedScope !== undefined && !sameScope(storedSnapshot.scope, expectedScope)) attuneGraphError("CORRUPT_STORE", "Store projection belongs to another scope");
  const observationId = text(input.observationId, "stored projection.observationId", "CORRUPT_STORE");
  const canonicalProjection = text(input.canonicalProjection, "stored projection.canonicalProjection", "CORRUPT_STORE", MAX_STORED_PROJECTION_TEXT);
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalProjection); } catch (cause) { throw new AttuneGraphError("CORRUPT_STORE", "stored canonical projection is invalid JSON", { cause }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    attuneGraphError("CORRUPT_STORE", "stored canonical projection is not an observation");
  }
  const parsedVersion = Object.getOwnPropertyDescriptor(
    parsed,
    "schemaVersion"
  )?.value;
  if (parsedVersion !== 1 && parsedVersion !== 2) {
    attuneGraphError(
      typeof parsedVersion === "number" && parsedVersion > 2
        ? "FUTURE_STORE_STATE"
        : "CORRUPT_STORE",
      "stored canonical projection has an unsupported observation schema"
    );
  }
  const canonical = canonicalEnvelope(
    parsed,
    "external-mutable",
    "stored canonical projection",
    "CORRUPT_STORE",
    parsedVersion
  );
  if (canonical.canonicalJson !== canonicalProjection || canonical.contentId !== observationId) attuneGraphError("CORRUPT_STORE", "stored canonical projection fingerprint is invalid");
  const observation = normalizedObservationFromEnvelope(
    canonical.envelope,
    canonical.canonicalJson,
    canonical.contentId,
    storedSnapshot.scope,
    "CORRUPT_STORE",
    parsedVersion
  );
  if (input.projectionFingerprint !== observation.observationId) attuneGraphError("CORRUPT_STORE", "stored projection fingerprint does not match its observation");
  if (storedSnapshot.commitId !== `attunegraph-commit:${observation.observationId}`) attuneGraphError("CORRUPT_STORE", "stored snapshot commit does not match its observation");
  const rawObservedAt = instant(input.observedAt, "stored projection.observedAt", "CORRUPT_STORE");
  const rawFreshness = freshness(input.sourceFreshness, "stored projection.sourceFreshness", "CORRUPT_STORE");
  if (rawObservedAt !== observation.observedAt || JSON.stringify(rawFreshness) !== JSON.stringify(observation.sourceFreshness)) attuneGraphError("CORRUPT_STORE", "stored projection metadata does not match its canonical observation");
  if (!Array.isArray(input.assertions)) attuneGraphError("CORRUPT_STORE", "stored projection.assertions must be an array");
  let rawAssertions: readonly GraphAssertion[];
  try { rawAssertions = dedupeAssertions(normalizeGraphAssertionBatch(input.assertions), "CORRUPT_STORE"); } catch (cause) { if (cause instanceof AttuneGraphError) throw cause; throw new AttuneGraphError("CORRUPT_STORE", "stored projection assertions are invalid", { cause }); }
  if (JSON.stringify(rawAssertions) !== observation.assertionFingerprint) attuneGraphError("CORRUPT_STORE", "stored projection assertions do not match its canonical observation");
  const projection = Object.freeze({
    schemaVersion: 1,
    snapshot: freezeSnapshot(storedSnapshot),
    observationId: observation.observationId,
    canonicalProjection: observation.canonicalProjection,
    projectionFingerprint: observation.observationId,
    observedAt: observation.observedAt,
    sourceFreshness: Object.freeze({ ...observation.sourceFreshness }),
    assertions: Object.freeze([...observation.assertions])
  });
  return Object.freeze({
    projection,
    projectionId: envelope.contentId as `attunegraph-store:${string}`
  });
}

export function normalizeStoredProjection(
  value: unknown,
  expectedScope: AttuneGraphScope
): AttuneGraphStoredProjection {
  return normalizeStoredProjectionShared(
    storeEnvelope(value),
    expectedScope
  ).projection;
}

export function normalizeStoredProjectionForPortableDecoder(
  envelope: CanonicalImmutableEnvelopeResult
): NormalizedStoredProjectionAdmission {
  return normalizeStoredProjectionShared(envelope, undefined);
}

interface PreparedDecisionEligibility {
  /** Fast same-now interval: max(recordedAt, validFrom) <= now < min(supersededAt, validTo). */
  readonly eligibleFrom: number;
  readonly eligibleTo: number;
}

function prepareDecisionEligibility(assertion: GraphAssertion): PreparedDecisionEligibility {
  const recordedAt = instantEpoch(assertion.recordedAt);
  const supersededAt = assertion.supersededAt ? instantEpoch(assertion.supersededAt) : Infinity;
  const validFrom = assertion.validFrom ? instantEpoch(assertion.validFrom) : -Infinity;
  const validTo = assertion.validTo ? instantEpoch(assertion.validTo) : Infinity;
  return Object.freeze({
    eligibleFrom: Math.max(recordedAt, validFrom),
    eligibleTo: Math.min(supersededAt, validTo)
  });
}

function assertionEligible(
  eligibility: PreparedDecisionEligibility,
  validAt: number
): boolean {
  return eligibility.eligibleFrom <= validAt && validAt < eligibility.eligibleTo;
}

function compareAssertions(left: GraphAssertion, right: GraphAssertion): number {
  return left.predicate.localeCompare(right.predicate) || left.id.localeCompare(right.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDecisionAssertions(left: GraphAssertion, right: GraphAssertion): number {
  return compareCodeUnits(left.predicate, right.predicate)
    || compareCodeUnits(left.id, right.id);
}

const WORKING_GRAPH_ASSERTIONS_PREFIX_BYTES = Buffer.byteLength("{\"assertions\":[", "utf8");
const WORKING_GRAPH_SEED_PREFIX_BYTES = Buffer.byteLength("],\"seed\":", "utf8");

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function estimateWorkingGraphTokens(
  assertionBytes: number,
  assertionCount: number,
  seedBytes: number
): number {
  const commaBytes = Math.max(0, assertionCount - 1);
  const bytes = WORKING_GRAPH_ASSERTIONS_PREFIX_BYTES
    + assertionBytes
    + commaBytes
    + WORKING_GRAPH_SEED_PREFIX_BYTES
    + seedBytes
    + 1;
  return Math.ceil(bytes / 4);
}

interface PreparedWorkingGraph {
  /** Only execution metadata is retained; canonical/source projection text stays in the Store. */
  readonly snapshot: AttuneGraphSnapshot;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertionBytes: ReadonlyMap<string, number>;
  readonly eligibility: ReadonlyMap<string, PreparedDecisionEligibility>;
  readonly adjacency: ReadonlyMap<string, readonly GraphAssertion[]>;
}

function prepareWorkingGraph(projection: AttuneGraphStoredProjection): PreparedWorkingGraph {
  const usable = dedupeAssertions(projection.assertions, "CORRUPT_STORE")
    .filter((assertion) => ACTIVATION_PREDICATES.includes(assertion.predicate))
    .sort(compareAssertions);
  const assertionBytes = new Map(usable.map((assertion) => [assertion.id, jsonBytes(assertion)]));
  const eligibility = new Map(usable.map((assertion) => [
    assertion.id,
    prepareDecisionEligibility(assertion)
  ]));
  const adjacency = new Map<string, GraphAssertion[]>();
  for (const assertion of usable) {
    const subjectKey = graphRefKey(assertion.subject);
    const objectKey = graphRefKey(assertion.object);
    const subjectAssertions = adjacency.get(subjectKey);
    if (subjectAssertions) subjectAssertions.push(assertion);
    else adjacency.set(subjectKey, [assertion]);
    if (objectKey !== subjectKey) {
      const objectAssertions = adjacency.get(objectKey);
      if (objectAssertions) objectAssertions.push(assertion);
      else adjacency.set(objectKey, [assertion]);
    }
  }
  return {
    snapshot: freezeSnapshot(projection.snapshot),
    sourceFreshness: Object.freeze({ ...projection.sourceFreshness }),
    assertionBytes,
    eligibility,
    adjacency
  };
}

function compileWorkingGraph(
  prepared: PreparedWorkingGraph,
  command: ReturnType<typeof normalizeExecute>,
  ordering: "legacy-locale" | "decision-code-unit" = "legacy-locale"
): AttuneGraphOperatorResult["workingGraph"] & { readonly status: AttuneGraphOperatorResult["status"] } {
  const eligible = (assertion: GraphAssertion): boolean => {
    const eligibility = prepared.eligibility.get(assertion.id);
    if (eligibility === undefined) attuneGraphError("CORRUPT_STORE", "Working Graph assertion eligibility is unavailable");
    return assertionEligible(eligibility, command.nowEpoch);
  };
  const seedBytes = jsonBytes(command.seed);
  const queue: Array<{ ref: GraphRef; depth: number }> = [{ ref: command.seed, depth: 0 }];
  const visited = new Set<string>([graphRefKey(command.seed)]);
  const selected: GraphAssertion[] = [];
  const selectedIds = new Set<string>();
  let considered = 0;
  let maxDepthReached = 0;
  let traversalTruncated = false;
  let tokenTruncated = false;
  let selectedAssertionBytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    maxDepthReached = Math.max(maxDepthReached, current.depth);
    const currentKey = graphRefKey(current.ref);
    const storedReachable = prepared.adjacency.get(currentKey) ?? [];
    const reachable = ordering === "decision-code-unit"
      ? [...storedReachable].sort(compareDecisionAssertions)
      : storedReachable;
    if (current.depth >= MAX_WORKING_DEPTH) {
      if (reachable.some((assertion) => eligible(assertion) && !selectedIds.has(assertion.id))) traversalTruncated = true;
      continue;
    }
    for (const assertion of reachable) {
      if (selectedIds.has(assertion.id)) continue;
      if (!eligible(assertion)) continue;
      if (considered >= MAX_WORKING_CONSIDERED || selected.length >= MAX_WORKING_ASSERTIONS) { traversalTruncated = true; break; }
      considered += 1;
      const candidateBytes = prepared.assertionBytes.get(assertion.id);
      if (candidateBytes === undefined) attuneGraphError("CORRUPT_STORE", "Working Graph assertion bytes are unavailable");
      if (estimateWorkingGraphTokens(selectedAssertionBytes + candidateBytes, selected.length + 1, seedBytes) > command.maxEstimatedTokens) { tokenTruncated = true; continue; }
      selected.push(assertion);
      selectedIds.add(assertion.id);
      selectedAssertionBytes += candidateBytes;
      for (const ref of [assertion.subject, assertion.object]) {
        const key = graphRefKey(ref);
        if (!visited.has(key)) {
          if (visited.size >= MAX_WORKING_VISITED) { traversalTruncated = true; continue; }
          visited.add(key);
          queue.push({ ref, depth: current.depth + 1 });
        }
      }
    }
  }
  const refs = [...new Map([command.seed, ...selected.flatMap((assertion) => [assertion.subject, assertion.object])].map((ref) => [graphRefKey(ref), Object.freeze({ ...ref })])).values()].sort((left, right) => ordering === "decision-code-unit"
    ? compareCodeUnits(graphRefKey(left), graphRefKey(right))
    : graphRefKey(left).localeCompare(graphRefKey(right)));
  const truncationReasons = Object.freeze([...(tokenTruncated ? ["token-budget" as const] : []), ...(traversalTruncated ? ["traversal-budget" as const] : [])]);
  const graph = Object.freeze({ assertions: Object.freeze([...selected]), refs: Object.freeze(refs), seed: Object.freeze({ ...command.seed }), diagnostics: Object.freeze({ consideredAssertions: considered, estimatedTokens: estimateWorkingGraphTokens(selectedAssertionBytes, selected.length, seedBytes), maxDepthReached, visitedRefs: visited.size, truncationReasons }) });
  return Object.freeze({ ...graph, status: truncationReasons.length > 0 ? "partial" as const : selected.length === 0 ? "abstained" as const : "complete" as const });
}

function emptyWorkingGraph(seed: GraphRef): AttuneGraphOperatorResult["workingGraph"] {
  const frozenSeed = Object.freeze({ ...seed });
  const estimatedTokens = estimateWorkingGraphTokens(0, 0, jsonBytes(frozenSeed));
  return Object.freeze({
    assertions: Object.freeze([]),
    refs: Object.freeze([frozenSeed]),
    seed: frozenSeed,
    diagnostics: Object.freeze({
      consideredAssertions: 0,
      estimatedTokens,
      maxDepthReached: 0,
      visitedRefs: 1,
      truncationReasons: Object.freeze([])
    })
  });
}

function decisionQueryResult(input: Readonly<{
  readonly query: AttuneGraphDecisionQuery;
  readonly status: AttuneGraphDecisionQueryResult["status"];
  readonly snapshot?: AttuneGraphSnapshot;
  readonly sourceFreshness?: AttuneGraphSourceFreshness;
  readonly workingGraph: AttuneGraphOperatorResult["workingGraph"];
  readonly abstentionReasons: readonly (
    | "no-head"
    | "source-not-fresh"
    | "no-eligible-evidence"
  )[];
}>): AttuneGraphDecisionQueryResult {
  const receipt = sealDecisionQueryReceipt({
    query: input.query,
    snapshot: input.snapshot ?? null,
    sourceFreshness: input.sourceFreshness ?? null,
    status: input.status,
    workingGraph: input.workingGraph,
    abstentionReasons: input.abstentionReasons
  });
  return Object.freeze({
    operator: "decision-query@1" as const,
    use: "evidence-only" as const,
    status: input.status,
    ...(input.snapshot ? { snapshot: freezeSnapshot(input.snapshot) } : {}),
    ...(input.sourceFreshness
      ? { sourceFreshness: Object.freeze({ ...input.sourceFreshness }) }
      : {}),
    workingGraph: input.workingGraph,
    receipt
  });
}

function sameSnapshot(left: AttuneGraphSnapshot | undefined, right: AttuneGraphSnapshot | undefined): boolean {
  return left?.generation === right?.generation && left?.commitId === right?.commitId && left !== undefined && right !== undefined && sameScope(left.scope, right.scope);
}

export async function openAttuneGraph(options: OpenAttuneGraphOptions): Promise<AttuneGraph> {
  const input = record(options, "open AttuneGraph options", ["scope", "store"], ["scope", "store"]);
  const openedScope = normalizeAttuneGraphScope(input.scope, "open AttuneGraph options.scope");
  const backend = registeredAttuneGraphStoreBackend(input.store as OpenAttuneGraphOptions["store"]);
  if (!backend) attuneGraphError("INVALID_INPUT", "store must be created by the backend Adapter seam");
  let lifecycle: "open" | "closing" | "closed" = "open";
  let inFlight = 0;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let preparedWorkingGraph: PreparedWorkingGraph | undefined;
  let preparingWorkingGraph: Promise<PreparedWorkingGraph | undefined> | undefined;
  let workingGraphPlanEpoch = 0;
  const invalidateWorkingGraphPlan = (): void => {
    preparedWorkingGraph = undefined;
    workingGraphPlanEpoch += 1;
  };
  const finishClose = (): void => {
    invalidateWorkingGraphPlan();
    preparingWorkingGraph = undefined;
    lifecycle = "closed";
    resolveClose?.();
  };
  const release = (): void => {
    inFlight -= 1;
    if (inFlight === 0 && lifecycle === "closing") finishClose();
  };
  const begin = <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "open") return Promise.reject(new AttuneGraphError("CLOSED", "AttuneGraph instance is closing or closed"));
    inFlight += 1;
    return Promise.resolve().then(operation).finally(release);
  };
  const read = async (): Promise<AttuneGraphStoredProjection | undefined> => {
    try {
      const raw = await backend.read(openedScope);
      return raw === undefined ? undefined : normalizeStoredProjection(raw, openedScope);
    } catch (cause) {
      if (cause instanceof AttuneGraphError) throw cause;
      throw new AttuneGraphError("STORE_FAILURE", "store read failed", { cause });
    }
  };
  const readHead = backend.readHead === undefined
    ? undefined
    : async (): Promise<AttuneGraphSnapshot | undefined> => {
      try {
        const raw = await backend.readHead?.(openedScope);
        if (raw === undefined) return undefined;
        const admitted = snapshot(raw, "store head", "CORRUPT_STORE");
        if (!sameScope(admitted.scope, openedScope)) {
          attuneGraphError("CORRUPT_STORE", "Store head belongs to another scope");
        }
        return freezeSnapshot(admitted);
      } catch (cause) {
        if (cause instanceof AttuneGraphError) throw cause;
        throw new AttuneGraphError("STORE_FAILURE", "store head read failed", { cause });
      }
    };
  const readHeadPinnedProjection = async (): Promise<AttuneGraphStoredProjection | undefined> => {
    if (readHead === undefined) return read();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await readHead();
      const current = await read();
      if (head === undefined && current === undefined) return undefined;
      if (head !== undefined && current !== undefined && sameSnapshot(head, current.snapshot)) return current;
    }
    attuneGraphError("SNAPSHOT_CONFLICT", "Store head changed while preparing the revocation impact plan");
  };
  const prepareHeadPinnedWorkingGraph = async (): Promise<PreparedWorkingGraph | undefined> => {
    if (readHead === undefined) {
      const current = await read();
      return current === undefined ? undefined : prepareWorkingGraph(current);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await readHead();
      if (head !== undefined && sameSnapshot(preparedWorkingGraph?.snapshot, head)) {
        return preparedWorkingGraph;
      }
      preparedWorkingGraph = undefined;
      const admissionEpoch = workingGraphPlanEpoch;
      const current = await read();
      if (admissionEpoch !== workingGraphPlanEpoch) continue;
      if (head === undefined && current === undefined) return undefined;
      if (head !== undefined && current !== undefined && sameSnapshot(head, current.snapshot)) {
        preparedWorkingGraph = prepareWorkingGraph(current);
        return preparedWorkingGraph;
      }
    }
    attuneGraphError("SNAPSHOT_CONFLICT", "Store head changed while preparing the Working Graph");
  };
  const workingGraphPlan = (): Promise<PreparedWorkingGraph | undefined> => {
    if (readHead === undefined) return prepareHeadPinnedWorkingGraph();
    if (preparingWorkingGraph) return preparingWorkingGraph;
    const pending = prepareHeadPinnedWorkingGraph();
    preparingWorkingGraph = pending;
    void pending.then(
      () => {
        if (preparingWorkingGraph === pending) preparingWorkingGraph = undefined;
      },
      () => {
        if (preparingWorkingGraph === pending) preparingWorkingGraph = undefined;
      }
    );
    return pending;
  };
  const projectObservation = async (
    observation: NormalizedObservation,
    expectation:
      | { readonly mode: "against-head" }
      | { readonly mode: "exact"; readonly snapshot: AttuneGraphSnapshot | undefined }
  ): Promise<AttuneGraphSnapshot> => {
    const current = await read();
    if (current?.observationId === observation.observationId) {
      if (
        current.canonicalProjection !== observation.canonicalProjection
        || current.projectionFingerprint !== observation.observationId
      ) {
        attuneGraphError(
          "CORRUPT_STORE",
          "stored replay does not match the requested canonical projection"
        );
      }
      return freezeSnapshot(current.snapshot);
    }
    if (
      current
      && Date.parse(observation.observedAt) < Date.parse(current.observedAt)
    ) {
      attuneGraphError(
        "SNAPSHOT_CONFLICT",
        "source observation must not precede the current projection"
      );
    }
    if (
      expectation.mode === "exact"
      && expectation.snapshot
      && !sameSnapshot(current?.snapshot, expectation.snapshot)
    ) {
      attuneGraphError("SNAPSHOT_CONFLICT", "expected snapshot is stale");
    }
    if (
      expectation.mode === "exact"
      && !expectation.snapshot
      && current
    ) {
      attuneGraphError(
        "SNAPSHOT_CONFLICT",
        "expectedSnapshot is required after the first projection"
      );
    }
    const expectedSnapshot = expectation.mode === "against-head"
      ? current?.snapshot
      : expectation.snapshot;
    const nextSnapshot = Object.freeze({
      schemaVersion: 1 as const,
      scope: Object.freeze({ ...openedScope }),
      generation: (current?.snapshot.generation ?? 0) + 1,
      commitId: `attunegraph-commit:${observation.observationId}`
    });
    const proposed: AttuneGraphStoredProjection = Object.freeze({
      schemaVersion: 1,
      snapshot: nextSnapshot,
      observationId: observation.observationId,
      canonicalProjection: observation.canonicalProjection,
      projectionFingerprint: observation.observationId,
      observedAt: observation.observedAt,
      sourceFreshness: Object.freeze({ ...observation.sourceFreshness }),
      assertions: Object.freeze([...observation.assertions])
    });
    let committed: unknown;
    try {
      committed = await backend.compareAndSwap(
        openedScope,
        expectedSnapshot,
        proposed
      );
    } catch (cause) {
      throw new AttuneGraphError(
        "STORE_FAILURE",
        "store compare-and-swap failed",
        { cause }
      );
    }
    if (committed !== true && committed !== false) {
      attuneGraphError(
        "CORRUPT_STORE",
        "store compare-and-swap returned a non-boolean result"
      );
    }
    if (!committed) {
      const winner = await read();
      if (
        winner?.observationId === observation.observationId
        && winner.canonicalProjection === observation.canonicalProjection
        && winner.projectionFingerprint === observation.observationId
      ) {
        return freezeSnapshot(winner.snapshot);
      }
      attuneGraphError("SNAPSHOT_CONFLICT", "projection compare-and-swap failed");
    }
    invalidateWorkingGraphPlan();
    return freezeSnapshot(nextSnapshot);
  };
  return Object.freeze({
    head(): Promise<AttuneGraphSnapshot | undefined> {
      return begin(async () => {
        const current = await read();
        return current === undefined
          ? undefined
          : freezeSnapshot(current.snapshot);
      });
    },
    project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot> {
      return begin(async () => {
        const normalized = normalizeProject(command, openedScope);
        return projectObservation(normalized.observation, {
          mode: "exact",
          snapshot: normalized.expectedSnapshot
        });
      });
    },
    projectAgainstHead(
      command: AttuneGraphProjectAgainstHeadCommand
    ): Promise<AttuneGraphSnapshot> {
      return begin(async () => {
        const observation = normalizeProjectAgainstHead(command, openedScope);
        return projectObservation(observation, { mode: "against-head" });
      });
    },
    execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult> {
      return begin(async () => {
        const normalized = normalizeExecute(command);
        const prepared = await workingGraphPlan();
        if (!prepared) attuneGraphError("SNAPSHOT_CONFLICT", "scope has no committed projection");
        const compiled = compileWorkingGraph(prepared, normalized);
        return Object.freeze({ operator: "working-graph@1" as const, status: compiled.status, snapshot: freezeSnapshot(prepared.snapshot), sourceFreshness: Object.freeze({ ...prepared.sourceFreshness }), workingGraph: Object.freeze({ assertions: compiled.assertions, refs: compiled.refs, seed: compiled.seed, diagnostics: compiled.diagnostics }) });
      });
    },
    query(command: AttuneGraphDecisionQuery): Promise<AttuneGraphDecisionQueryResult> {
      return begin(async () => {
        const normalized = normalizeDecisionQuery(command);
        if (!sameScope(normalized.scope, openedScope)) {
          attuneGraphError("INVALID_SCOPE", "decision query scope does not match the opened scope");
        }
        const prepared = await workingGraphPlan();
        if (!prepared) {
          if (normalized.head.mode === "exact") {
            attuneGraphError("SNAPSHOT_CONFLICT", "decision query exact head does not exist");
          }
          return decisionQueryResult({
            query: normalized,
            status: "abstained",
            workingGraph: emptyWorkingGraph(normalized.seed),
            abstentionReasons: Object.freeze(["no-head"])
          });
        }
        if (
          normalized.head.mode === "exact"
          && (
            normalized.head.generation !== prepared.snapshot.generation
            || normalized.head.commitId !== prepared.snapshot.commitId
          )
        ) {
          attuneGraphError("SNAPSHOT_CONFLICT", "decision query exact head does not match the current head");
        }
        if (prepared.sourceFreshness.state !== "fresh") {
          return decisionQueryResult({
            query: normalized,
            status: "abstained",
            snapshot: prepared.snapshot,
            sourceFreshness: prepared.sourceFreshness,
            workingGraph: emptyWorkingGraph(normalized.seed),
            abstentionReasons: Object.freeze(["source-not-fresh"])
          });
        }
        const compiled = compileWorkingGraph(prepared, {
          seed: normalized.seed,
          nowEpoch: instantEpoch(normalized.asOf),
          maxEstimatedTokens: normalized.budget.maxEstimatedTokens
        }, "decision-code-unit");
        return decisionQueryResult({
          query: normalized,
          status: compiled.status,
          snapshot: prepared.snapshot,
          sourceFreshness: prepared.sourceFreshness,
          workingGraph: Object.freeze({
            assertions: compiled.assertions,
            refs: compiled.refs,
            seed: compiled.seed,
            diagnostics: compiled.diagnostics
          }),
          abstentionReasons: compiled.status === "abstained"
            ? Object.freeze(["no-eligible-evidence"])
            : Object.freeze([])
        });
      });
    },
    queryAuthority(command: AttuneGraphAuthorityQuery): Promise<AttuneGraphAuthorityQueryResult> {
      return begin(async () => {
        const normalized = normalizeAuthorityQuery(command);
        if (!sameScope(normalized.scope, openedScope)) {
          attuneGraphError("INVALID_SCOPE", "authority query scope does not match the opened scope");
        }
        const projection = await readHeadPinnedProjection();
        if (projection === undefined && normalized.head.mode === "exact") {
          attuneGraphError("SNAPSHOT_CONFLICT", "authority query exact head does not exist");
        }
        if (
          projection !== undefined
          && normalized.head.mode === "exact"
          && (
            normalized.head.generation !== projection.snapshot.generation
            || normalized.head.commitId !== projection.snapshot.commitId
          )
        ) {
          attuneGraphError("SNAPSHOT_CONFLICT", "authority query exact head does not match the current head");
        }
        return compileAuthorityQuery(projection, normalized);
      });
    },
    planRevocationImpact(
      command: AttuneGraphRevocationImpactCommand
    ): Promise<AttuneGraphRevocationImpactResult> {
      return begin(async () => {
        const normalized = normalizeRevocationImpactCommand(command);
        return compileRevocationImpact(await readHeadPinnedProjection(), normalized);
      });
    },
    applyRevocationTransition(
      command: AttuneGraphRevocationTransitionCommand
    ): Promise<AttuneGraphRevocationTransitionResult> {
      return begin(async () => {
        // Both untrusted public inputs are fully admitted before any Store I/O.
        const normalized = normalizeRevocationTransition(command, openedScope);
        const receiptSnapshot = normalized.impactReceipt.snapshot;
        const predecessor = await readHeadPinnedProjection();
        if (
          predecessor === undefined
          || receiptSnapshot === null
          || !sameSnapshot(predecessor.snapshot, receiptSnapshot)
        ) {
          attuneGraphError("SNAPSHOT_CONFLICT", "revocation impact receipt does not name the exact current head");
        }
        const predecessorRoot = exactV2ThreadRoot(predecessor);
        if (
          normalized.replacement.threadRoot === undefined
          || !sameGraphRef(predecessorRoot, normalized.replacement.threadRoot)
        ) {
          attuneGraphError("INVALID_INPUT", "revocation transition replacement must preserve the predecessor thread root");
        }
        if (Date.parse(normalized.replacement.observedAt) <= Date.parse(predecessor.observedAt)) {
          attuneGraphError("SNAPSHOT_CONFLICT", "revocation transition replacement must be newer than its predecessor");
        }
        const recomputed = compileRevocationImpact(
          predecessor,
          normalizeRevocationImpactCommand({
            operator: "revocation-impact@1",
            selector: normalized.impactReceipt.selector,
            maxAssertions: 16,
            maxConsideredAssertions: 4096
          })
        );
        if (
          recomputed.status !== "complete"
          || recomputed.receipt.canonicalJson !== normalized.impactReceipt.canonicalJson
        ) {
          attuneGraphError("SNAPSHOT_CONFLICT", "revocation impact receipt is not the complete exact-head plan");
        }
        const plannedImpactIds = Object.freeze(recomputed.impacts.map((impact) => impact.assertionId));
        const impactIds = new Set(plannedImpactIds);
        const expectedSurvivors = predecessor.assertions.filter((assertion) => !impactIds.has(assertion.id));
        if (!sameAssertions(expectedSurvivors, normalized.replacement.assertions)) {
          attuneGraphError("INVALID_INPUT", "revocation transition replacement must equal the exact predecessor survivor set");
        }
        const witnessAssertionIds = new Set(
          recomputed.impacts.flatMap((impact) => impact.witnessAssertionIds)
        );
        const residueCounts = normalized.replacement.assertions.reduce<{
          impactIds: number;
          selectorMatches: number;
          witnessAssertionRefs: number;
        }>(
          (counts, assertion) => Object.freeze({
            impactIds: counts.impactIds + (impactIds.has(assertion.id) ? 1 : 0),
            selectorMatches: counts.selectorMatches + (matchesRevocationSelector(recomputed.selector, assertion) ? 1 : 0),
            witnessAssertionRefs: counts.witnessAssertionRefs + assertion.sourceRefs.filter(
              (source) => source.namespace === GRAPH_ASSERTION_SOURCE_NAMESPACE && witnessAssertionIds.has(source.id)
            ).length
          }),
          { impactIds: 0, selectorMatches: 0, witnessAssertionRefs: 0 }
        );
        if (
          residueCounts.impactIds !== 0
          || residueCounts.selectorMatches !== 0
          || residueCounts.witnessAssertionRefs !== 0
        ) {
          attuneGraphError("INVALID_INPUT", "revocation transition replacement leaves planned revocation residue");
        }
        const nextSnapshot = Object.freeze({
          schemaVersion: 1 as const,
          scope: Object.freeze({ ...openedScope }),
          generation: predecessor.snapshot.generation + 1,
          commitId: `attunegraph-commit:${normalized.replacement.observationId}`
        });
        const proposed: AttuneGraphStoredProjection = Object.freeze({
          schemaVersion: 1,
          snapshot: nextSnapshot,
          observationId: normalized.replacement.observationId,
          canonicalProjection: normalized.replacement.canonicalProjection,
          projectionFingerprint: normalized.replacement.observationId,
          observedAt: normalized.replacement.observedAt,
          sourceFreshness: Object.freeze({ ...normalized.replacement.sourceFreshness }),
          assertions: Object.freeze([...normalized.replacement.assertions])
        });
        let committed: unknown;
        try {
          committed = await backend.compareAndSwap(openedScope, predecessor.snapshot, proposed);
        } catch (cause) {
          throw new AttuneGraphError("STORE_FAILURE", "store compare-and-swap failed", { cause });
        }
        if (committed !== true && committed !== false) {
          attuneGraphError("CORRUPT_STORE", "store compare-and-swap returned a non-boolean result");
        }
        if (committed) {
          invalidateWorkingGraphPlan();
          return Object.freeze({
            operator: "revocation-transition@1" as const,
            disposition: "committed" as const,
            receipt: sealRevocationTransitionReceipt(openedScope, normalized.impactReceipt.receiptId, predecessor.snapshot, normalized.replacement.observationId, nextSnapshot, plannedImpactIds, expectedSurvivors.length)
          });
        }
        const winner = await read();
        if (
          winner?.observationId === normalized.replacement.observationId
          && winner.canonicalProjection === normalized.replacement.canonicalProjection
          && winner.projectionFingerprint === normalized.replacement.observationId
          && sameSnapshot(winner.snapshot, nextSnapshot)
        ) {
          invalidateWorkingGraphPlan();
          return Object.freeze({
            operator: "revocation-transition@1" as const,
            disposition: "converged" as const,
            receipt: sealRevocationTransitionReceipt(openedScope, normalized.impactReceipt.receiptId, predecessor.snapshot, normalized.replacement.observationId, nextSnapshot, plannedImpactIds, expectedSurvivors.length)
          });
        }
        attuneGraphError("SNAPSHOT_CONFLICT", "revocation transition compare-and-swap failed");
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      if (inFlight === 0) finishClose();
      return closePromise;
    }
  });
}

/** Compatibility-friendly factory spelling for the lifecycle entry point. */
export const createAttuneGraphEngine = openAttuneGraph;
