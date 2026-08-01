import type { GraphAssertion, GraphEvidenceRef, GraphRef } from "./types.js";

declare const attuneGraphStoreBrand: unique symbol;
declare const attuneGraphSourceAdapterBrand: unique symbol;

/** Opaque capability. Store adapters are constructed only from the ./backend seam. */
export interface AttuneGraphStore {
  readonly [attuneGraphStoreBrand]: "AttuneGraphStore";
}

/** Reserved opaque capability for bounded source adapters. */
export interface AttuneGraphSourceAdapter {
  readonly [attuneGraphSourceAdapterBrand]: "AttuneGraphSourceAdapter";
}

export interface AttuneGraphScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface AttuneGraphSnapshot {
  readonly schemaVersion: 1;
  readonly scope: AttuneGraphScope;
  readonly generation: number;
  readonly commitId: string;
}

export interface AttuneGraphSourceFreshness {
  readonly state: "fresh" | "stale" | "unknown";
  readonly observedAt: string;
}

/**
 * Caller-declared source truth. It is self-consistent evidence, not a claim that
 * a source was independently observed or that the source remains fresh.
 */
export interface AttuneGraphSourceObservationV1 {
  readonly schemaVersion: 1;
  /** Caller-declared bounded correlation key. The engine mints observationId. */
  readonly observationKey: string;
  readonly scope: AttuneGraphScope;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

export interface AttuneGraphSourceObservationV2 {
  readonly schemaVersion: 2;
  /** Exact graph root declared by the source; it is not derived from scope text. */
  readonly threadRoot: GraphRef;
  /** Caller-declared bounded correlation key. The engine mints observationId. */
  readonly observationKey: string;
  readonly scope: AttuneGraphScope;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertions: readonly GraphAssertion[];
}

export type AttuneGraphSourceObservation =
  | AttuneGraphSourceObservationV1
  | AttuneGraphSourceObservationV2;

interface AttuneGraphProjectCommandBase {
  readonly expectedSnapshot?: AttuneGraphSnapshot;
}

export type AttuneGraphProjectCommand =
  | (AttuneGraphProjectCommandBase & {
    readonly operator: "canonical-projection@1";
    readonly observation: AttuneGraphSourceObservationV1;
  })
  | (AttuneGraphProjectCommandBase & {
    readonly operator: "canonical-projection@2";
    readonly observation: AttuneGraphSourceObservationV2;
  });

export type AttuneGraphProjectAgainstHeadCommand =
  | {
    readonly operator: "canonical-projection@1";
    readonly observation: AttuneGraphSourceObservationV1;
  }
  | {
    readonly operator: "canonical-projection@2";
    readonly observation: AttuneGraphSourceObservationV2;
  };

export interface AttuneGraphExecuteCommand {
  readonly operator: "working-graph@1";
  readonly seed: GraphRef;
  readonly now: string;
  readonly maxEstimatedTokens: number;
}

export interface AttuneGraphWorkingGraph {
  readonly assertions: readonly GraphAssertion[];
  readonly refs: readonly GraphRef[];
  readonly seed: GraphRef;
  readonly diagnostics: Readonly<{
    readonly consideredAssertions: number;
    readonly estimatedTokens: number;
    readonly maxDepthReached: number;
    readonly visitedRefs: number;
    readonly truncationReasons: readonly ("token-budget" | "traversal-budget")[];
  }>;
}

export interface AttuneGraphOperatorResult {
  readonly operator: "working-graph@1";
  readonly status: "complete" | "partial" | "abstained";
  readonly snapshot: AttuneGraphSnapshot;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly workingGraph: AttuneGraphWorkingGraph;
}

export type AttuneGraphDecisionHead =
  | Readonly<{ readonly mode: "current" }>
  | Readonly<{
    readonly mode: "exact";
    readonly generation: number;
    readonly commitId: string;
  }>;

/**
 * Canonical agent-decision input. The traversal profile is intentionally fixed:
 * callers choose the decision anchor, time, exact head posture, and context
 * budget, but cannot omit evidence classes or relationship families while
 * claiming that the resulting evidence frontier is complete.
 */
export interface AttuneGraphDecisionQuery {
  readonly operator: "decision-query@1";
  readonly scope: AttuneGraphScope;
  readonly seed: GraphRef;
  readonly asOf: string;
  readonly head: AttuneGraphDecisionHead;
  readonly freshness: Readonly<{ readonly require: "fresh" }>;
  readonly budget: Readonly<{ readonly maxEstimatedTokens: number }>;
}

export interface AttuneGraphDecisionQueryReceipt {
  readonly contractRevision: 1;
  readonly receiptId: string;
  /** Exact canonical JSON whose content address is receiptId. */
  readonly canonicalJson: string;
  readonly use: "evidence-only";
  readonly query: AttuneGraphDecisionQuery;
  readonly snapshot: AttuneGraphSnapshot | null;
  readonly sourceFreshness: AttuneGraphSourceFreshness | null;
  readonly status: "complete" | "partial" | "abstained";
  readonly witness: Readonly<{
    readonly assertionIds: readonly string[];
    readonly sourceRefs: readonly GraphEvidenceRef[];
  }>;
  readonly diagnostics: Readonly<{
    readonly consideredAssertions: number;
    readonly estimatedTokens: number;
    readonly maxDepthReached: number;
    readonly visitedRefs: number;
    readonly truncationReasons: readonly ("token-budget" | "traversal-budget")[];
    readonly abstentionReasons: readonly (
      | "no-head"
      | "source-not-fresh"
      | "no-eligible-evidence"
    )[];
    readonly authorityEvaluation: "not-performed";
    readonly conflictClosure: "not-performed";
  }>;
}

export interface AttuneGraphDecisionQueryResult {
  readonly operator: "decision-query@1";
  readonly use: "evidence-only";
  readonly status: "complete" | "partial" | "abstained";
  /** Absent only when the opened scope has no admitted projection head. */
  readonly snapshot?: AttuneGraphSnapshot;
  readonly sourceFreshness?: AttuneGraphSourceFreshness;
  readonly workingGraph: AttuneGraphWorkingGraph;
  readonly receipt: AttuneGraphDecisionQueryReceipt;
}

export type AttuneGraphAuthorityTerminalReason =
  | "no-head"
  | "root-unverified"
  | "root-mismatch"
  | "projection-from-future"
  | "freshness-from-future"
  | "source-not-fresh"
  | "authority-conflict"
  | "missing-governance-chain"
  | "missing-evidence-chain";

export type AttuneGraphAuthorityTruncationReason =
  | "work-budget"
  | "token-budget";

export interface AttuneGraphAuthorityQuery {
  readonly operator: "authority-query@1";
  readonly scope: AttuneGraphScope;
  readonly action: GraphRef & Readonly<{ readonly kind: "action" }>;
  readonly threadRoot: GraphRef & Readonly<{ readonly kind: "thread" }>;
  readonly asOf: string;
  readonly head: AttuneGraphDecisionHead;
  readonly freshness: Readonly<{ readonly require: "fresh" }>;
  readonly budget: Readonly<{ readonly maxEstimatedTokens: number }>;
}

export interface AttuneGraphAuthorityConflict {
  readonly predicate: "GOVERNED_BY";
  readonly subject: GraphRef & Readonly<{ readonly kind: "action" }>;
  readonly assertionIds: readonly string[];
  readonly objectRefs: readonly (GraphRef & Readonly<{ readonly kind: "policy" }>)[];
  readonly sourceRefs: readonly GraphEvidenceRef[];
}

export interface AttuneGraphAuthorityWitness {
  readonly assertionIds: readonly string[];
  readonly sourceRefs: readonly GraphEvidenceRef[];
}

export interface AttuneGraphAuthorityExclusion {
  readonly assertionId: string;
  readonly reason:
    | "temporally-ineligible"
    | "model-hypothesis"
    | "invalid-endpoint-kind"
    | "thread-root-mismatch";
}

export interface AttuneGraphAuthorityDiagnostics {
  readonly consideredAssertions: number;
  readonly eligibleFrontierAssertions: number;
  readonly rejectedFrontierAssertions: number;
  readonly estimatedTokens: number;
  readonly maxConsideredAssertions: 32;
  readonly truncationReasons: readonly AttuneGraphAuthorityTruncationReason[];
  readonly terminalReasons: readonly AttuneGraphAuthorityTerminalReason[];
  readonly authorityClosure: "complete" | "incomplete";
  readonly conflictClosure: "complete" | "conflict" | "incomplete";
}

export interface AttuneGraphAuthorityQueryReceipt {
  readonly contractRevision: 1;
  readonly receiptId: string;
  readonly canonicalJson: string;
  readonly use: "current-world-action-authority";
  readonly query: AttuneGraphAuthorityQuery;
  readonly snapshot: AttuneGraphSnapshot | null;
  readonly projection: Readonly<{
    readonly observationId: string;
    readonly observedAt: string;
    readonly threadRoot: GraphRef | null;
  }> | null;
  readonly sourceFreshness: AttuneGraphSourceFreshness | null;
  readonly status: "complete" | "partial" | "abstained";
  readonly authority: "authorized" | "undetermined";
  readonly witness: AttuneGraphAuthorityWitness;
  readonly conflicts: readonly AttuneGraphAuthorityConflict[];
  readonly exclusions: readonly AttuneGraphAuthorityExclusion[];
  readonly diagnostics: AttuneGraphAuthorityDiagnostics;
}

export interface AttuneGraphAuthorityQueryResult {
  readonly operator: "authority-query@1";
  readonly use: "current-world-action-authority";
  readonly status: "complete" | "partial" | "abstained";
  readonly authority: "authorized" | "undetermined";
  readonly snapshot?: AttuneGraphSnapshot;
  readonly projection?: Readonly<{
    readonly observationId: string;
    readonly observedAt: string;
    readonly threadRoot: GraphRef | null;
  }>;
  readonly sourceFreshness?: AttuneGraphSourceFreshness;
  readonly witness: AttuneGraphAuthorityWitness;
  readonly conflicts: readonly AttuneGraphAuthorityConflict[];
  readonly exclusions: readonly AttuneGraphAuthorityExclusion[];
  readonly diagnostics: AttuneGraphAuthorityDiagnostics;
  readonly receipt: AttuneGraphAuthorityQueryReceipt;
}

export interface AttuneGraphRevocationSelector {
  readonly assertionIds?: readonly string[];
  readonly graphRefs?: readonly GraphRef[];
  readonly sourceRefs?: readonly GraphEvidenceRef[];
}

export interface AttuneGraphRevocationImpactCommand {
  readonly operator: "revocation-impact@1";
  readonly selector: AttuneGraphRevocationSelector;
  /** Hard cap on returned impacted assertions. */
  readonly maxAssertions: number;
  /** Hard cap on admitted projection assertions inspected while planning. */
  readonly maxConsideredAssertions: number;
}

export interface AttuneGraphRevocationImpact {
  readonly assertionId: string;
  readonly reason: "direct" | "dependency";
  /** Direct selector match through this impacted assertion, inclusive. */
  readonly witnessAssertionIds: readonly string[];
}

export interface AttuneGraphRevocationImpactDiagnostics {
  readonly consideredAssertions: number;
  readonly directMatches: number;
  readonly truncationReasons: readonly ("assertion-budget" | "considered-budget")[];
}

/** Immutable, content-addressed plan receipt. It is an informational pin, not retention. */
export interface AttuneGraphRevocationImpactReceipt {
  readonly contractRevision: 1;
  readonly receiptId: string;
  /** Exact canonical JSON whose content address is receiptId. */
  readonly canonicalJson: string;
  readonly snapshot: AttuneGraphSnapshot | null;
  readonly selector: AttuneGraphRevocationSelector;
  readonly impacts: readonly AttuneGraphRevocationImpact[];
  readonly diagnostics: AttuneGraphRevocationImpactDiagnostics;
  readonly status: "complete" | "partial" | "abstained";
}

export interface AttuneGraphRevocationImpactResult {
  readonly operator: "revocation-impact@1";
  readonly status: "complete" | "partial" | "abstained";
  /** Undefined only when the opened scope has no admitted projection head. */
  readonly snapshot?: AttuneGraphSnapshot;
  readonly selector: AttuneGraphRevocationSelector;
  readonly impacts: readonly AttuneGraphRevocationImpact[];
  readonly diagnostics: AttuneGraphRevocationImpactDiagnostics;
  readonly receipt: AttuneGraphRevocationImpactReceipt;
}

/** A source-authoritative replacement applied against one complete impact plan. */
export interface AttuneGraphRevocationTransitionCommand {
  readonly operator: "revocation-transition@1";
  /** Exact canonical JSON of a complete revocation-impact@1 receipt. */
  readonly receiptCanonicalJson: string;
  readonly replacement: {
    readonly operator: "canonical-projection@2";
    readonly observation: AttuneGraphSourceObservationV2;
  };
}

export interface AttuneGraphRevocationTransitionReceipt {
  readonly contractRevision: 1;
  readonly receiptId: string;
  /** Exact canonical JSON whose content address is receiptId. */
  readonly canonicalJson: string;
  readonly scope: AttuneGraphScope;
  readonly planReceiptId: string;
  readonly priorSnapshot: AttuneGraphSnapshot;
  readonly replacementObservationId: string;
  readonly resultSnapshot: AttuneGraphSnapshot;
  readonly plannedImpactIds: readonly string[];
  /** Assertions preserved exactly from the predecessor. */
  readonly preservedSurvivorCount: number;
  readonly zeroResidueProof: Readonly<{
    readonly impactIds: 0;
    readonly selectorMatches: 0;
    readonly witnessAssertionRefs: 0;
  }>;
}

export type AttuneGraphRevocationTransitionResult =
  | Readonly<{
    readonly operator: "revocation-transition@1";
    /** The caller committed, or lost one CAS to an identical validated replacement. */
    readonly disposition: "committed" | "converged";
    readonly receipt: AttuneGraphRevocationTransitionReceipt;
  }>;

export interface AttuneGraph {
  /**
   * Reads the exact current projection head for this opened scope.
   * The returned snapshot is an optimistic-concurrency token only; it carries
   * no assertions, source authority, or permission.
   */
  head(): Promise<AttuneGraphSnapshot | undefined>;
  project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot>;
  /**
   * Validates the complete committed projection, then uses that internally read
   * snapshot as one exact CAS expectation. A concurrent different winner still
   * conflicts; this is not last-write-wins or an automatic retry policy.
   */
  projectAgainstHead(
    command: AttuneGraphProjectAgainstHeadCommand
  ): Promise<AttuneGraphSnapshot>;
  execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult>;
  /** Compiles one fixed-profile, evidence-only context against the current exact head. */
  query(command: AttuneGraphDecisionQuery): Promise<AttuneGraphDecisionQueryResult>;
  /** Proves current action authority from one fixed, exact, fail-closed frontier. */
  queryAuthority(command: AttuneGraphAuthorityQuery): Promise<AttuneGraphAuthorityQueryResult>;
  /** Read-only revocation planning. Apply, retention, and compaction remain separate operations. */
  planRevocationImpact(
    command: AttuneGraphRevocationImpactCommand
  ): Promise<AttuneGraphRevocationImpactResult>;
  applyRevocationTransition(
    command: AttuneGraphRevocationTransitionCommand
  ): Promise<AttuneGraphRevocationTransitionResult>;
  close(): Promise<void>;
}

export interface OpenAttuneGraphOptions {
  readonly scope: AttuneGraphScope;
  readonly store: AttuneGraphStore;
}
