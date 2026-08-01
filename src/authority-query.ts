import { types as nodeTypes } from "node:util";

import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraphAuthorityConflict,
  AttuneGraphAuthorityDiagnostics,
  AttuneGraphAuthorityExclusion,
  AttuneGraphAuthorityQuery,
  AttuneGraphAuthorityQueryReceipt,
  AttuneGraphAuthorityQueryResult,
  AttuneGraphAuthorityTerminalReason,
  AttuneGraphAuthorityTruncationReason,
  AttuneGraphScope,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness
} from "./attunegraph-contracts.js";
import {
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { MAX_ACTIVATION_ESTIMATED_TOKENS } from "./constants.js";
import type { GraphAssertion, GraphEvidenceRef, GraphRef } from "./types.js";

const AUTHORITY_RECEIPT_SPEC = Object.freeze({
  hashDomain: "attunegraph.authority-query-receipt.v1",
  idField: "receiptId",
  idPrefix: "attunegraph-authority-query:"
} as const);
const MIN_AUTHORITY_QUERY_RESULT_ESTIMATED_TOKENS = 1_024;
const MAX_AUTHORITY_CONSIDERED_ASSERTIONS = 32 as const;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

type DataRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new AttuneGraphError("INVALID_INPUT", message);
}

function record(
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
  ) invalid(`${label} must be a non-proxy plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) invalid(`${label} has invalid fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    if (typeof key !== "string") return true;
    const descriptor = descriptors[key];
    return descriptor === undefined || !("value" in descriptor);
  })) invalid(`${label} fields must be data properties`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > 512
    || CONTROL_CHARACTERS.test(value)
    || !isWellFormedUnicode(value)
  ) invalid(`${label} must be bounded non-empty text without control characters`);
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = boundedText(value, label);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return text;
}

function exactRef<K extends "action" | "thread">(
  value: unknown,
  kind: K,
  label: string
): GraphRef & Readonly<{ readonly kind: K }> {
  const input = record(value, label, ["id", "kind"], ["id", "kind"]);
  if (input.kind !== kind) invalid(`${label}.kind must be ${kind}`);
  return Object.freeze({ id: boundedText(input.id, `${label}.id`), kind });
}

function normalizeHead(value: unknown): AttuneGraphAuthorityQuery["head"] {
  const input = record(value, "authority query.head", ["mode", "generation", "commitId"], ["mode"]);
  if (input.mode === "current") {
    if (Reflect.ownKeys(input).length !== 1) invalid("current authority query head has extra fields");
    return Object.freeze({ mode: "current" as const });
  }
  if (
    input.mode !== "exact"
    || !Number.isSafeInteger(input.generation)
    || (input.generation as number) < 1
  ) invalid("authority query exact head is invalid");
  return Object.freeze({
    mode: "exact" as const,
    generation: input.generation as number,
    commitId: boundedText(input.commitId, "authority query.head.commitId")
  });
}

export function normalizeAuthorityQuery(value: AttuneGraphAuthorityQuery): AttuneGraphAuthorityQuery {
  const input = record(
    value,
    "authority query",
    ["operator", "scope", "action", "threadRoot", "asOf", "head", "freshness", "budget"],
    ["operator", "scope", "action", "threadRoot", "asOf", "head", "freshness", "budget"]
  );
  if (input.operator !== "authority-query@1") {
    throw new AttuneGraphError("UNSUPPORTED_OPERATOR", "queryAuthority supports only authority-query@1");
  }
  const scope = record(input.scope, "authority query.scope", ["sourceId", "threadId"], ["sourceId", "threadId"]);
  const freshness = record(input.freshness, "authority query.freshness", ["require"], ["require"]);
  if (freshness.require !== "fresh") invalid("authority query.freshness.require must be fresh");
  const budget = record(input.budget, "authority query.budget", ["maxEstimatedTokens"], ["maxEstimatedTokens"]);
  if (
    !Number.isSafeInteger(budget.maxEstimatedTokens)
    || (budget.maxEstimatedTokens as number) < MIN_AUTHORITY_QUERY_RESULT_ESTIMATED_TOKENS
    || (budget.maxEstimatedTokens as number) > MAX_ACTIVATION_ESTIMATED_TOKENS
  ) {
    invalid(`authority query.budget.maxEstimatedTokens must be an integer from ${MIN_AUTHORITY_QUERY_RESULT_ESTIMATED_TOKENS.toString()} to ${MAX_ACTIVATION_ESTIMATED_TOKENS.toString()}`);
  }
  const normalized = Object.freeze({
    operator: "authority-query@1" as const,
    scope: Object.freeze({
      sourceId: boundedText(scope.sourceId, "authority query.scope.sourceId"),
      threadId: boundedText(scope.threadId, "authority query.scope.threadId")
    }),
    action: exactRef(input.action, "action", "authority query.action"),
    threadRoot: exactRef(input.threadRoot, "thread", "authority query.threadRoot"),
    asOf: canonicalInstant(input.asOf, "authority query.asOf"),
    head: normalizeHead(input.head),
    freshness: Object.freeze({ require: "fresh" as const }),
    budget: Object.freeze({ maxEstimatedTokens: budget.maxEstimatedTokens as number })
  });
  const mandatoryTokens = convergeResult(
    normalized,
    terminal(undefined, "no-head")
  ).diagnostics.estimatedTokens;
  if (mandatoryTokens > normalized.budget.maxEstimatedTokens) {
    invalid("authority query budget cannot represent its mandatory result metadata");
  }
  return normalized;
}

function refKey(ref: GraphRef): string {
  return `${ref.kind}\u0000${ref.id}`;
}

function sameRef(left: GraphRef, right: GraphRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function eligible(assertion: GraphAssertion, asOf: number): boolean {
  return Date.parse(assertion.recordedAt) <= asOf
    && (assertion.validFrom === undefined || Date.parse(assertion.validFrom) <= asOf)
    && (assertion.validTo === undefined || asOf < Date.parse(assertion.validTo))
    && (assertion.supersededAt === undefined || asOf < Date.parse(assertion.supersededAt));
}

function evidenceRefKey(ref: GraphEvidenceRef): string {
  return `${ref.namespace}\u0000${ref.id}\u0000${ref.version ?? ""}`;
}

function frozenEvidenceRefs(assertions: readonly GraphAssertion[]): readonly GraphEvidenceRef[] {
  const refs = [...new Map(assertions.flatMap((assertion) => assertion.sourceRefs)
    .map((ref) => [evidenceRefKey(ref), ref])).values()]
    .sort((left, right) => compareText(evidenceRefKey(left), evidenceRefKey(right)))
    .map((ref) => Object.freeze({ ...ref }));
  return Object.freeze(refs);
}

function projectionRoot(projection: AttuneGraphStoredProjection): GraphRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection.canonicalProjection);
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "authority query projection is invalid JSON", { cause });
  }
  const envelope = parsed as { readonly schemaVersion?: unknown; readonly threadRoot?: unknown };
  if (envelope.schemaVersion !== 2) return null;
  const root = record(envelope.threadRoot, "stored projection.threadRoot", ["id", "kind"], ["id", "kind"]);
  if (root.kind !== "thread") throw new AttuneGraphError("CORRUPT_STORE", "stored projection thread root is invalid");
  return Object.freeze({ kind: "thread" as const, id: boundedText(root.id, "stored projection.threadRoot.id") });
}

interface AuthorityCompilation {
  readonly projection: AttuneGraphStoredProjection | undefined;
  readonly status: "complete" | "partial" | "abstained";
  readonly authority: "authorized" | "undetermined";
  readonly witnessAssertions: readonly GraphAssertion[];
  readonly conflicts: readonly AttuneGraphAuthorityConflict[];
  readonly exclusions: readonly AttuneGraphAuthorityExclusion[];
  readonly consideredAssertions: number;
  readonly eligibleFrontierAssertions: number;
  readonly rejectedFrontierAssertions: number;
  readonly truncationReasons: readonly AttuneGraphAuthorityTruncationReason[];
  readonly terminalReasons: readonly AttuneGraphAuthorityTerminalReason[];
  readonly authorityClosure: "complete" | "incomplete";
  readonly conflictClosure: "complete" | "conflict" | "incomplete";
  readonly root: GraphRef | null;
}

function terminal(
  projection: AttuneGraphStoredProjection | undefined,
  reason: AttuneGraphAuthorityTerminalReason,
  root: GraphRef | null = null
): AuthorityCompilation {
  return Object.freeze({
    projection,
    status: "abstained" as const,
    authority: "undetermined" as const,
    witnessAssertions: Object.freeze([]),
    conflicts: Object.freeze([]),
    exclusions: Object.freeze([]),
    consideredAssertions: 0,
    eligibleFrontierAssertions: 0,
    rejectedFrontierAssertions: 0,
    truncationReasons: Object.freeze([]),
    terminalReasons: Object.freeze([reason]),
    authorityClosure: "incomplete" as const,
    conflictClosure: "incomplete" as const,
    root
  });
}

function compileAuthority(
  projection: AttuneGraphStoredProjection | undefined,
  query: AttuneGraphAuthorityQuery
): AuthorityCompilation {
  if (projection === undefined) return terminal(undefined, "no-head");
  const root = projectionRoot(projection);
  if (root === null) return terminal(projection, "root-unverified");
  if (!sameRef(root, query.threadRoot)) return terminal(projection, "root-mismatch", root);
  const asOf = Date.parse(query.asOf);
  if (Date.parse(projection.observedAt) > asOf) return terminal(projection, "projection-from-future", root);
  if (Date.parse(projection.sourceFreshness.observedAt) > asOf) return terminal(projection, "freshness-from-future", root);
  if (projection.sourceFreshness.state !== "fresh") return terminal(projection, "source-not-fresh", root);

  const workTruncated = projection.assertions.length > MAX_AUTHORITY_CONSIDERED_ASSERTIONS;
  const inspected = projection.assertions
    .slice(0, MAX_AUTHORITY_CONSIDERED_ASSERTIONS)
    .sort((left, right) => compareText(left.id, right.id));
  const actionCandidates = inspected.filter((assertion) =>
    sameRef(assertion.subject, query.action)
    && (assertion.predicate === "GOVERNED_BY" || assertion.predicate === "AUTHORIZED_BY")
  );
  const actionExclusionReason = (assertion: GraphAssertion): AttuneGraphAuthorityExclusion["reason"] | undefined => {
    if (!eligible(assertion, asOf)) return "temporally-ineligible";
    if (assertion.epistemicClass === "model-hypothesis") return "model-hypothesis";
    if (
      (assertion.predicate === "GOVERNED_BY" && assertion.object.kind !== "policy")
      || (assertion.predicate === "AUTHORIZED_BY" && assertion.object.kind !== "evidence")
    ) return "invalid-endpoint-kind";
    return undefined;
  };
  const eligibleAction = actionCandidates.filter((assertion) => actionExclusionReason(assertion) === undefined);
  const policyKeys = new Set(eligibleAction.filter((entry) => entry.predicate === "GOVERNED_BY").map((entry) => refKey(entry.object)));
  const evidenceKeys = new Set(eligibleAction.filter((entry) => entry.predicate === "AUTHORIZED_BY").map((entry) => refKey(entry.object)));
  const linkedCandidates = inspected.filter((assertion) =>
    (assertion.predicate === "SCOPED_TO" && policyKeys.has(refKey(assertion.subject)))
    || (assertion.predicate === "OBSERVED_DURING" && evidenceKeys.has(refKey(assertion.subject)))
  );
  const linkedExclusionReason = (assertion: GraphAssertion): AttuneGraphAuthorityExclusion["reason"] | undefined => {
    if (!eligible(assertion, asOf)) return "temporally-ineligible";
    if (assertion.epistemicClass === "model-hypothesis") return "model-hypothesis";
    if (assertion.object.kind !== "thread") return "invalid-endpoint-kind";
    if (!sameRef(assertion.object, query.threadRoot)) return "thread-root-mismatch";
    return undefined;
  };
  const eligibleLinked = linkedCandidates.filter((assertion) => linkedExclusionReason(assertion) === undefined);
  const exclusions = Object.freeze([
    ...actionCandidates.flatMap((assertion) => {
      const reason = actionExclusionReason(assertion);
      return reason === undefined ? [] : [Object.freeze({ assertionId: assertion.id, reason })];
    }),
    ...linkedCandidates.flatMap((assertion) => {
      const reason = linkedExclusionReason(assertion);
      return reason === undefined ? [] : [Object.freeze({ assertionId: assertion.id, reason })];
    })
  ].sort((left, right) => compareText(left.assertionId, right.assertionId)));
  const eligibleFrontier = [...eligibleAction, ...eligibleLinked];
  const rejectedFrontierAssertions = exclusions.length;
  const governed = eligibleAction.filter((entry) => entry.predicate === "GOVERNED_BY");
  const governedObjects = [...new Map(governed.map((entry) => [refKey(entry.object), entry.object])).values()];
  let conflicts: readonly AttuneGraphAuthorityConflict[] = Object.freeze([]);
  if (governedObjects.length > 1) {
    conflicts = Object.freeze([Object.freeze({
      predicate: "GOVERNED_BY" as const,
      subject: Object.freeze({ ...query.action }),
      assertionIds: Object.freeze(governed.map((entry) => entry.id).sort(compareText)),
      objectRefs: Object.freeze(governedObjects.sort((left, right) => compareText(refKey(left), refKey(right))).map((ref) => Object.freeze({ ...ref }) as GraphRef & { readonly kind: "policy" })),
      sourceRefs: frozenEvidenceRefs(governed)
    })]);
  }
  if (conflicts.length > 0) {
    return Object.freeze({
      projection,
      status: "abstained" as const,
      authority: "undetermined" as const,
      witnessAssertions: Object.freeze([]),
      conflicts,
      exclusions,
      consideredAssertions: inspected.length,
      eligibleFrontierAssertions: eligibleFrontier.length,
      rejectedFrontierAssertions,
      truncationReasons: Object.freeze(workTruncated ? ["work-budget" as const] : []),
      terminalReasons: Object.freeze(["authority-conflict" as const]),
      authorityClosure: "incomplete" as const,
      conflictClosure: "conflict" as const,
      root
    });
  }
  if (workTruncated) {
    return Object.freeze({
      projection,
      status: "partial" as const,
      authority: "undetermined" as const,
      witnessAssertions: Object.freeze([]),
      conflicts,
      exclusions,
      consideredAssertions: inspected.length,
      eligibleFrontierAssertions: eligibleFrontier.length,
      rejectedFrontierAssertions,
      truncationReasons: Object.freeze(["work-budget" as const]),
      terminalReasons: Object.freeze([]),
      authorityClosure: "incomplete" as const,
      conflictClosure: "incomplete" as const,
      root
    });
  }

  const governanceChains = governed.flatMap((governance) => eligibleLinked
    .filter((scope) => scope.predicate === "SCOPED_TO" && sameRef(scope.subject, governance.object) && sameRef(scope.object, query.threadRoot))
    .map((scope) => [governance, scope] as const));
  const authorityChains = eligibleAction.filter((entry) => entry.predicate === "AUTHORIZED_BY")
    .flatMap((authority) => eligibleLinked
      .filter((scope) => scope.predicate === "OBSERVED_DURING" && sameRef(scope.subject, authority.object) && sameRef(scope.object, query.threadRoot))
      .map((scope) => [authority, scope] as const));
  if (governanceChains.length === 0 || authorityChains.length === 0) {
    return Object.freeze({
      projection,
      status: "abstained" as const,
      authority: "undetermined" as const,
      witnessAssertions: Object.freeze([]),
      conflicts,
      exclusions,
      consideredAssertions: inspected.length,
      eligibleFrontierAssertions: eligibleFrontier.length,
      rejectedFrontierAssertions,
      truncationReasons: Object.freeze([]),
      terminalReasons: Object.freeze([
        ...(governanceChains.length === 0 ? ["missing-governance-chain" as const] : []),
        ...(authorityChains.length === 0 ? ["missing-evidence-chain" as const] : [])
      ]),
      authorityClosure: "complete" as const,
      conflictClosure: "complete" as const,
      root
    });
  }
  const governance = governanceChains.sort((left, right) => compareText(left.map((entry) => entry.id).join("\u0000"), right.map((entry) => entry.id).join("\u0000")))[0]!;
  const authority = authorityChains.sort((left, right) => compareText(left.map((entry) => entry.id).join("\u0000"), right.map((entry) => entry.id).join("\u0000")))[0]!;
  return Object.freeze({
    projection,
    status: "complete" as const,
    authority: "authorized" as const,
    witnessAssertions: Object.freeze([...governance, ...authority].sort((left, right) => compareText(left.id, right.id))),
    conflicts,
    exclusions,
    consideredAssertions: inspected.length,
    eligibleFrontierAssertions: eligibleFrontier.length,
    rejectedFrontierAssertions,
    truncationReasons: Object.freeze([]),
    terminalReasons: Object.freeze([]),
    authorityClosure: "complete" as const,
    conflictClosure: "complete" as const,
    root
  });
}

function frozenSnapshot(snapshot: AttuneGraphSnapshot | undefined): AttuneGraphSnapshot | null {
  return snapshot === undefined ? null : Object.freeze({
    schemaVersion: 1 as const,
    scope: Object.freeze({ ...snapshot.scope }),
    generation: snapshot.generation,
    commitId: snapshot.commitId
  });
}

function frozenFreshness(value: AttuneGraphSourceFreshness | undefined): AttuneGraphSourceFreshness | null {
  return value === undefined ? null : Object.freeze({ ...value });
}

function sealReceipt(input: Readonly<{
  readonly query: AttuneGraphAuthorityQuery;
  readonly compilation: AuthorityCompilation;
  readonly diagnostics: AttuneGraphAuthorityDiagnostics;
}>): AttuneGraphAuthorityQueryReceipt {
  const projection = input.compilation.projection;
  const unsigned = Object.freeze({
    contractRevision: 1 as const,
    use: "current-world-action-authority" as const,
    query: input.query,
    snapshot: frozenSnapshot(projection?.snapshot),
    projection: projection === undefined ? null : Object.freeze({
      observationId: projection.observationId,
      observedAt: projection.observedAt,
      threadRoot: input.compilation.root === null ? null : Object.freeze({ ...input.compilation.root })
    }),
    sourceFreshness: frozenFreshness(projection?.sourceFreshness),
    status: input.compilation.status,
    authority: input.compilation.authority,
    witness: Object.freeze({
      assertionIds: Object.freeze(input.compilation.witnessAssertions.map((entry) => entry.id)),
      sourceRefs: frozenEvidenceRefs(input.compilation.witnessAssertions)
    }),
    conflicts: input.compilation.conflicts,
    exclusions: input.compilation.exclusions,
    diagnostics: input.diagnostics
  });
  try {
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(unsigned, AUTHORITY_RECEIPT_SPEC);
    return Object.freeze({ ...minted.envelope, canonicalJson: minted.canonicalJson }) as unknown as AttuneGraphAuthorityQueryReceipt;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "authority query receipt could not be sealed", { cause });
  }
}

function makeDiagnostics(compilation: AuthorityCompilation, estimatedTokens: number): AttuneGraphAuthorityDiagnostics {
  return Object.freeze({
    consideredAssertions: compilation.consideredAssertions,
    eligibleFrontierAssertions: compilation.eligibleFrontierAssertions,
    rejectedFrontierAssertions: compilation.rejectedFrontierAssertions,
    estimatedTokens,
    maxConsideredAssertions: MAX_AUTHORITY_CONSIDERED_ASSERTIONS,
    truncationReasons: Object.freeze([...compilation.truncationReasons]),
    terminalReasons: Object.freeze([...compilation.terminalReasons]),
    authorityClosure: compilation.authorityClosure,
    conflictClosure: compilation.conflictClosure
  });
}

function buildResult(
  query: AttuneGraphAuthorityQuery,
  compilation: AuthorityCompilation,
  estimatedTokens: number
): AttuneGraphAuthorityQueryResult {
  const diagnostics = makeDiagnostics(compilation, estimatedTokens);
  const receipt = sealReceipt({ query, compilation, diagnostics });
  const projection = compilation.projection;
  return Object.freeze({
    operator: "authority-query@1" as const,
    use: "current-world-action-authority" as const,
    status: compilation.status,
    authority: compilation.authority,
    ...(projection === undefined ? {} : {
      snapshot: frozenSnapshot(projection.snapshot)!,
      projection: Object.freeze({
        observationId: projection.observationId,
        observedAt: projection.observedAt,
        threadRoot: compilation.root === null ? null : Object.freeze({ ...compilation.root })
      }),
      sourceFreshness: frozenFreshness(projection.sourceFreshness)!
    }),
    witness: Object.freeze({
      assertionIds: Object.freeze(compilation.witnessAssertions.map((entry) => entry.id)),
      sourceRefs: frozenEvidenceRefs(compilation.witnessAssertions)
    }),
    conflicts: compilation.conflicts,
    exclusions: compilation.exclusions,
    diagnostics,
    receipt
  });
}

export function compileAuthorityQuery(
  projection: AttuneGraphStoredProjection | undefined,
  query: AttuneGraphAuthorityQuery
): AttuneGraphAuthorityQueryResult {
  let compilation = compileAuthority(projection, query);
  let result = convergeResult(query, compilation);
  if (
    result.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens
  ) {
    compilation = Object.freeze({
      ...compilation,
      status: "partial" as const,
      authority: "undetermined" as const,
      witnessAssertions: Object.freeze([]),
      conflicts: Object.freeze([]),
      exclusions: Object.freeze([]),
      truncationReasons: Object.freeze(["token-budget" as const]),
      terminalReasons: Object.freeze([]),
      authorityClosure: "incomplete" as const,
      conflictClosure: "incomplete" as const
    });
    result = convergeResult(query, compilation);
  }
  if (result.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens) {
    invalid("authority query budget cannot represent the current projection result metadata");
  }
  return result;
}

function convergeResult(
  query: AttuneGraphAuthorityQuery,
  compilation: AuthorityCompilation
): AttuneGraphAuthorityQueryResult {
  let estimatedTokens = 0;
  let result = buildResult(query, compilation, estimatedTokens);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4);
    if (next === estimatedTokens) break;
    estimatedTokens = next;
    result = buildResult(query, compilation, estimatedTokens);
  }
  return result;
}
