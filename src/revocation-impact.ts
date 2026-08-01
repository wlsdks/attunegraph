import { types as nodeTypes } from "node:util";

import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { GRAPH_ASSERTION_SOURCE_NAMESPACE } from "./constants.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraphRevocationImpact,
  AttuneGraphRevocationImpactCommand,
  AttuneGraphRevocationImpactDiagnostics,
  AttuneGraphRevocationImpactReceipt,
  AttuneGraphRevocationImpactResult,
  AttuneGraphRevocationSelector,
  AttuneGraphSnapshot
} from "./attunegraph-contracts.js";
import { GRAPH_NODE_KINDS, type GraphAssertion, type GraphEvidenceRef, type GraphRef } from "./types.js";

/**
 * Core-safe text excludes control characters, so worst-case canonical JSON is
 * four UTF-8 bytes per scalar. With 24 of each selector form and 16 triangular
 * witnesses, the sealed receipt remains below the shared 1 MiB immutable-
 * envelope limit without a late failure.
 */
const MAX_SELECTOR_ITEMS = 24;
const MAX_REVOCATION_ASSERTIONS = 16;
const MAX_REVOCATION_CONSIDERED_ASSERTIONS = 4096;
const receiptSpec = Object.freeze({
  hashDomain: "attunegraph.revocation-impact.v1",
  idField: "receiptId",
  idPrefix: "attunegraph-revocation-impact:"
} as const);

function fail(message: string): never {
  throw new AttuneGraphError("INVALID_INPUT", message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown, label: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) fail(`${label} must be a non-proxy plain object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(`${label} has invalid fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string" || !descriptors[key] || !("value" in descriptors[key]!))) fail(`${label} must have data properties`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a non-proxy array`);
  if (value.length > maximum) fail(`${label} exceeds its item cap`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) fail(`${label} has invalid keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail(`${label} must not be sparse or contain accessors`);
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 512 || value !== value.trim() || /[\u0000-\u001F\u007F]/u.test(value) || hasUnpairedSurrogate(value)) fail(`${label} must be bounded non-empty well-formed text without control characters`);
  return value;
}

function graphRef(value: unknown, label: string): GraphRef {
  const input = record(value, label, ["id", "kind"], ["id", "kind"]);
  const id = text(input.id, `${label}.id`);
  if (typeof input.kind !== "string" || !GRAPH_NODE_KINDS.includes(input.kind as GraphRef["kind"])) fail(`${label}.kind is invalid`);
  return Object.freeze({ id, kind: input.kind as GraphRef["kind"] });
}

function sourceRef(value: unknown, label: string): GraphEvidenceRef {
  const input = record(value, label, ["id", "namespace", "version"], ["id", "namespace"]);
  const id = text(input.id, `${label}.id`);
  const namespace = text(input.namespace, `${label}.namespace`);
  const version = input.version === undefined ? undefined : text(input.version, `${label}.version`);
  return Object.freeze({ id, namespace, ...(version === undefined ? {} : { version }) });
}

function graphKey(ref: GraphRef): string {
  return `${ref.kind}\u0000${ref.id}`;
}

function sourceKey(ref: GraphEvidenceRef): string {
  return `${ref.namespace}\u0000${ref.id}\u0000${ref.version ?? ""}`;
}

function sourceBaseKey(ref: GraphEvidenceRef): string {
  return `${ref.namespace}\u0000${ref.id}`;
}

function normalizeSelector(value: unknown): AttuneGraphRevocationSelector {
  const input = record(value, "revocation selector", ["assertionIds", "graphRefs", "sourceRefs"], []);
  const assertionIds = input.assertionIds === undefined ? undefined : array(input.assertionIds, "revocation selector.assertionIds", MAX_SELECTOR_ITEMS).map((item, index) => text(item, `revocation selector.assertionIds[${index.toString()}]`)).sort(compareText);
  const graphRefs = input.graphRefs === undefined ? undefined : array(input.graphRefs, "revocation selector.graphRefs", MAX_SELECTOR_ITEMS).map((item, index) => graphRef(item, `revocation selector.graphRefs[${index.toString()}]`)).sort((left, right) => compareText(graphKey(left), graphKey(right)));
  const sourceRefs = input.sourceRefs === undefined ? undefined : array(input.sourceRefs, "revocation selector.sourceRefs", MAX_SELECTOR_ITEMS).map((item, index) => sourceRef(item, `revocation selector.sourceRefs[${index.toString()}]`)).sort((left, right) => compareText(sourceKey(left), sourceKey(right)));
  if ((assertionIds?.length ?? 0) + (graphRefs?.length ?? 0) + (sourceRefs?.length ?? 0) === 0) fail("revocation selector must name at least one assertion, graph ref, or source ref");
  if (assertionIds && new Set(assertionIds).size !== assertionIds.length) fail("revocation selector.assertionIds must not contain duplicates");
  if (graphRefs && new Set(graphRefs.map(graphKey)).size !== graphRefs.length) fail("revocation selector.graphRefs must not contain duplicates");
  if (sourceRefs && new Set(sourceRefs.map(sourceKey)).size !== sourceRefs.length) fail("revocation selector.sourceRefs must not contain duplicates");
  return Object.freeze({ ...(assertionIds ? { assertionIds: Object.freeze(assertionIds) } : {}), ...(graphRefs ? { graphRefs: Object.freeze(graphRefs) } : {}), ...(sourceRefs ? { sourceRefs: Object.freeze(sourceRefs) } : {}) });
}

export function normalizeRevocationImpactCommand(value: unknown): AttuneGraphRevocationImpactCommand {
  const input = record(value, "revocation impact command", ["operator", "selector", "maxAssertions", "maxConsideredAssertions"], ["operator", "selector", "maxAssertions", "maxConsideredAssertions"]);
  if (input.operator !== "revocation-impact@1") throw new AttuneGraphError("UNSUPPORTED_OPERATOR", "planRevocationImpact supports revocation-impact@1");
  if (!Number.isSafeInteger(input.maxAssertions) || (input.maxAssertions as number) < 1 || (input.maxAssertions as number) > MAX_REVOCATION_ASSERTIONS) fail("revocation impact command.maxAssertions is invalid");
  if (!Number.isSafeInteger(input.maxConsideredAssertions) || (input.maxConsideredAssertions as number) < (input.maxAssertions as number) || (input.maxConsideredAssertions as number) > MAX_REVOCATION_CONSIDERED_ASSERTIONS) fail("revocation impact command.maxConsideredAssertions is invalid");
  return Object.freeze({ operator: "revocation-impact@1", selector: normalizeSelector(input.selector), maxAssertions: input.maxAssertions as number, maxConsideredAssertions: input.maxConsideredAssertions as number });
}

function freezeSnapshot(snapshot: AttuneGraphSnapshot): AttuneGraphSnapshot {
  return Object.freeze({ schemaVersion: 1, scope: Object.freeze({ ...snapshot.scope }), generation: snapshot.generation, commitId: snapshot.commitId });
}

export function matchesRevocationSelector(selector: AttuneGraphRevocationSelector, assertion: GraphAssertion): boolean {
  if (selector.assertionIds?.includes(assertion.id)) return true;
  if (selector.graphRefs?.some((ref) => graphKey(ref) === graphKey(assertion.subject) || graphKey(ref) === graphKey(assertion.object))) return true;
  return selector.sourceRefs?.some((wanted) => assertion.sourceRefs.some((actual) => sourceBaseKey(actual) === sourceBaseKey(wanted) && (wanted.version === undefined || actual.version === wanted.version))) ?? false;
}

function receiptSnapshot(value: unknown): AttuneGraphSnapshot | null {
  if (value === null) return null;
  const input = record(value, "revocation impact receipt.snapshot", ["schemaVersion", "scope", "generation", "commitId"], ["schemaVersion", "scope", "generation", "commitId"]);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.generation) || (input.generation as number) < 1) fail("revocation impact receipt.snapshot is invalid");
  const scope = record(input.scope, "revocation impact receipt.snapshot.scope", ["sourceId", "threadId"], ["sourceId", "threadId"]);
  return Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({ sourceId: text(scope.sourceId, "revocation impact receipt.snapshot.scope.sourceId"), threadId: text(scope.threadId, "revocation impact receipt.snapshot.scope.threadId") }),
    generation: input.generation as number,
    commitId: text(input.commitId, "revocation impact receipt.snapshot.commitId")
  });
}

/**
 * Re-admits an untrusted public receipt. Its canonical JSON is an integrity
 * witness, not an authority token: callers must still re-plan against a head.
 */
export function admitRevocationImpactReceipt(value: unknown): AttuneGraphRevocationImpactReceipt {
  const fields = ["contractRevision", "receiptId", "canonicalJson", "snapshot", "selector", "impacts", "diagnostics", "status"] as const;
  const supplied = record(value, "revocation impact receipt", fields, fields);
  if (typeof supplied.canonicalJson !== "string" || supplied.canonicalJson.length === 0 || supplied.canonicalJson.length > 1_048_576) fail("revocation impact receipt.canonicalJson is invalid");
  const unsigned = Object.fromEntries(fields.filter((field) => field !== "canonicalJson").map((field) => [field, supplied[field]]));
  let canonicalFromFields: ReturnType<typeof canonicalizeImmutableEnvelope>;
  let canonicalFromJson: ReturnType<typeof canonicalizeImmutableEnvelope>;
  try {
    canonicalFromFields = canonicalizeImmutableEnvelope(unsigned, "external-mutable", receiptSpec);
    canonicalFromJson = canonicalizeImmutableEnvelope(JSON.parse(supplied.canonicalJson), "external-mutable", receiptSpec);
  } catch (cause) {
    throw new AttuneGraphError("INVALID_INPUT", "revocation impact receipt is not a safe canonical envelope", { cause });
  }
  if (
    canonicalFromFields.canonicalJson !== supplied.canonicalJson
    || canonicalFromJson.canonicalJson !== supplied.canonicalJson
    || canonicalFromFields.contentId !== canonicalFromJson.contentId
  ) {
    fail("revocation impact receipt canonicalJson does not exactly admit its public fields");
  }
  const input = record(canonicalFromJson.envelope, "revocation impact receipt", fields.filter((field) => field !== "canonicalJson"), fields.filter((field) => field !== "canonicalJson"));
  if (input.contractRevision !== 1 || input.receiptId !== canonicalFromJson.contentId) fail("revocation impact receipt is invalid");
  const selector = normalizeSelector(input.selector);
  const impacts = array(input.impacts, "revocation impact receipt.impacts", MAX_REVOCATION_ASSERTIONS).map((value, index) => {
    const impact = record(value, `revocation impact receipt.impacts[${index.toString()}]`, ["assertionId", "reason", "witnessAssertionIds"], ["assertionId", "reason", "witnessAssertionIds"]);
    if (impact.reason !== "direct" && impact.reason !== "dependency") fail(`revocation impact receipt.impacts[${index.toString()}].reason is invalid`);
    const witnesses = array(impact.witnessAssertionIds, `revocation impact receipt.impacts[${index.toString()}].witnessAssertionIds`, MAX_REVOCATION_ASSERTIONS + 1)
      .map((witness, witnessIndex) => text(witness, `revocation impact receipt.impacts[${index.toString()}].witnessAssertionIds[${witnessIndex.toString()}]`));
    if (witnesses.length === 0 || new Set(witnesses).size !== witnesses.length) fail(`revocation impact receipt.impacts[${index.toString()}].witnessAssertionIds is invalid`);
    return Object.freeze({ assertionId: text(impact.assertionId, `revocation impact receipt.impacts[${index.toString()}].assertionId`), reason: impact.reason, witnessAssertionIds: Object.freeze(witnesses) });
  });
  if (new Set(impacts.map((impact) => impact.assertionId)).size !== impacts.length) fail("revocation impact receipt.impacts must not contain duplicates");
  const diagnosticsInput = record(input.diagnostics, "revocation impact receipt.diagnostics", ["consideredAssertions", "directMatches", "truncationReasons"], ["consideredAssertions", "directMatches", "truncationReasons"]);
  if (!Number.isSafeInteger(diagnosticsInput.consideredAssertions) || (diagnosticsInput.consideredAssertions as number) < 0 || (diagnosticsInput.consideredAssertions as number) > MAX_REVOCATION_CONSIDERED_ASSERTIONS || !Number.isSafeInteger(diagnosticsInput.directMatches) || (diagnosticsInput.directMatches as number) < 0 || (diagnosticsInput.directMatches as number) > MAX_REVOCATION_ASSERTIONS) fail("revocation impact receipt.diagnostics is invalid");
  const truncationReasons = array(diagnosticsInput.truncationReasons, "revocation impact receipt.diagnostics.truncationReasons", 2).map((reason) => {
    if (reason !== "assertion-budget" && reason !== "considered-budget") fail("revocation impact receipt.diagnostics.truncationReasons is invalid");
    return reason;
  });
  if (new Set(truncationReasons).size !== truncationReasons.length) fail("revocation impact receipt.diagnostics.truncationReasons must not contain duplicates");
  if (input.status !== "complete" && input.status !== "partial" && input.status !== "abstained") fail("revocation impact receipt.status is invalid");
  if (
    (input.status === "complete" && (impacts.length === 0 || truncationReasons.length !== 0))
    || (input.status === "partial" && truncationReasons.length === 0)
    || (input.status === "abstained" && (impacts.length !== 0 || truncationReasons.length !== 0))
  ) {
    fail("revocation impact receipt status is inconsistent with impacts or truncation");
  }
  // Structural admission above is deliberately independent of Store state.
  void selector;
  void impacts;
  void receiptSnapshot(input.snapshot);
  return deepFreeze({ ...canonicalFromJson.envelope, canonicalJson: supplied.canonicalJson }) as AttuneGraphRevocationImpactReceipt;
}

/** Admits a receipt transported solely as exact canonical JSON. */
export function admitRevocationImpactReceiptCanonicalJson(value: unknown): AttuneGraphRevocationImpactReceipt {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_048_576) {
    fail("revocation impact receipt canonical JSON is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new AttuneGraphError("INVALID_INPUT", "revocation impact receipt canonical JSON is invalid", { cause });
  }
  let canonical: ReturnType<typeof canonicalizeImmutableEnvelope>;
  try {
    canonical = canonicalizeImmutableEnvelope(parsed, "external-mutable", receiptSpec);
  } catch (cause) {
    throw new AttuneGraphError("INVALID_INPUT", "revocation impact receipt canonical JSON is unsafe", { cause });
  }
  if (canonical.canonicalJson !== value) fail("revocation impact receipt canonical JSON is not canonical");
  // Re-admit the mutable JSON parse so the public-field validator exercises
  // the external-input profile instead of treating its own frozen detachment
  // as caller input.
  return admitRevocationImpactReceipt({ ...(parsed as Record<string, unknown>), canonicalJson: value });
}

function pathCompare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareText(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function receipt(
  snapshot: AttuneGraphSnapshot | undefined,
  selector: AttuneGraphRevocationSelector,
  impacts: readonly AttuneGraphRevocationImpact[],
  diagnostics: AttuneGraphRevocationImpactDiagnostics,
  status: AttuneGraphRevocationImpactResult["status"]
): AttuneGraphRevocationImpactReceipt {
  const unsigned = deepFreeze({ contractRevision: 1 as const, snapshot: snapshot === undefined ? null : freezeSnapshot(snapshot), selector, impacts, diagnostics, status });
  try {
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(unsigned, receiptSpec);
    return Object.freeze({ ...minted.envelope, canonicalJson: minted.canonicalJson }) as unknown as AttuneGraphRevocationImpactReceipt;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "revocation impact receipt could not be sealed", { cause });
  }
}

export function compileRevocationImpact(
  projection: AttuneGraphStoredProjection | undefined,
  command: AttuneGraphRevocationImpactCommand
): AttuneGraphRevocationImpactResult {
  if (projection === undefined) {
    const diagnostics = Object.freeze({ consideredAssertions: 0, directMatches: 0, truncationReasons: Object.freeze([]) });
    const selector = command.selector;
    const sealed = receipt(undefined, selector, Object.freeze([]), diagnostics, "abstained");
    return Object.freeze({ operator: "revocation-impact@1", status: "abstained", selector, impacts: Object.freeze([]), diagnostics, receipt: sealed });
  }
  const assertions = [...projection.assertions].sort((left, right) => compareText(left.id, right.id));
  const inspected = assertions.slice(0, command.maxConsideredAssertions);
  const consideredTruncated = inspected.length !== assertions.length;
  const direct = inspected.filter((assertion) => matchesRevocationSelector(command.selector, assertion)).map((assertion) => assertion.id);
  const dependents = new Map<string, string[]>();
  for (const assertion of inspected) {
    for (const source of assertion.sourceRefs) {
      if (source.namespace !== GRAPH_ASSERTION_SOURCE_NAMESPACE) continue;
      const entries = dependents.get(source.id);
      if (entries) entries.push(assertion.id);
      else dependents.set(source.id, [assertion.id]);
    }
  }
  for (const entries of dependents.values()) entries.sort(compareText);
  const currentIds = new Set(inspected.map((assertion) => assertion.id));
  const paths = new Map<string, readonly string[]>();
  const queue: Array<readonly string[]> = [];
  let assertionTruncated = false;
  let impactedCount = 0;
  for (const id of direct) {
    if (impactedCount >= command.maxAssertions) {
      assertionTruncated = true;
      break;
    }
    const path = Object.freeze([id]);
    paths.set(id, path);
    queue.push(path);
    impactedCount += 1;
  }
  if (!assertionTruncated) {
    for (const id of command.selector.assertionIds ?? []) {
      if (currentIds.has(id) || paths.has(id)) continue;
      const path = Object.freeze([id]);
      paths.set(id, path);
      queue.push(path);
    }
  }
  while (queue.length > 0 && !assertionTruncated) {
    queue.sort((left, right) => left.length - right.length || pathCompare(left, right));
    const current = queue.shift();
    if (!current) break;
    const currentId = current[current.length - 1];
    if (!currentId || paths.get(currentId) !== current) continue;
    for (const dependent of dependents.get(currentId) ?? []) {
      const candidate = Object.freeze([...current, dependent]);
      const previous = paths.get(dependent);
      if (previous && (previous.length < candidate.length || (previous.length === candidate.length && pathCompare(previous, candidate) <= 0))) continue;
      if (!previous && impactedCount >= command.maxAssertions) { assertionTruncated = true; break; }
      if (!previous) impactedCount += 1;
      paths.set(dependent, candidate);
      queue.push(candidate);
    }
  }
  const impacts = Object.freeze([...paths.entries()].filter(([assertionId]) => currentIds.has(assertionId)).map(([assertionId, witnessAssertionIds]) => Object.freeze({ assertionId, reason: direct.includes(assertionId) ? "direct" as const : "dependency" as const, witnessAssertionIds: Object.freeze([...witnessAssertionIds]) })).sort((left, right) => compareText(left.assertionId, right.assertionId)));
  const truncationReasons = Object.freeze([...(consideredTruncated ? ["considered-budget" as const] : []), ...(assertionTruncated ? ["assertion-budget" as const] : [])]);
  const status = truncationReasons.length > 0 ? "partial" as const : impacts.length === 0 ? "abstained" as const : "complete" as const;
  const diagnostics = Object.freeze({ consideredAssertions: inspected.length, directMatches: direct.length, truncationReasons });
  const snapshot = freezeSnapshot(projection.snapshot);
  const sealed = receipt(snapshot, command.selector, impacts, diagnostics, status);
  return Object.freeze({ operator: "revocation-impact@1", status, snapshot, selector: command.selector, impacts, diagnostics, receipt: sealed });
}
