# AttuneGraph first principles

## Thesis

AttuneGraph exists to solve **long-lived agent discontinuity**.

An agent acts across turns, tools, files, and source systems. The important
state is not a bag of remembered sentences. It is the path from observation to
revision, decision, action, and outcome, including which source supported each
step and which later event changed its meaning.

The database therefore has one primary job:

> Preserve the relations that make an agent decision reconstructable, then
> compile only the relations that are admissible for the current decision.

AttuneGraph is not a smaller general-purpose graph database. It is an embedded,
deterministic context compiler for an agent. Its northbound result is a small
decision context with evidence and an exact receipt, not an arbitrary graph
neighbourhood.

## The problem being solved

Long-lived agents fail even when retrieval finds semantically similar text.
They can:

- use an old fact after it was revised;
- merge two people or objects without enough identity evidence;
- treat a nearby edge as truth, permission, feedback, or action authority;
- omit the failed attempt that explains why a workflow changed;
- combine notes, calendar state, and tool results from incompatible snapshots;
- present a confident answer after a budget cut hid material counterevidence;
- forget why an action was chosen or which outputs a revoked source affected.

These are relation and state-transition failures. Better chunk similarity alone
does not solve them.

AttuneGraph must answer a stricter question than `how is this connected?`:

> Which connections may this agent use as evidence now, for this decision, and
> why?

## Why a graph is necessary

A graph is justified only where the relation carries meaning that would be lost
in an isolated record.

1. **State is a path.** An outcome is interpretable through the observation,
   decision, action, and tool result that preceded it.
2. **Revision is non-destructive.** A new assertion can supersede an old one
   without erasing what the agent knew at the time of an earlier decision.
3. **Evidence is shared.** One source can support several claims, and revoking
   it must reveal every dependent belief, decision context, and receipt.
4. **Identity is uncertain.** `sameAs` is initially a supported candidate, not
   permission to destructively merge histories.
5. **A global history must become a local frontier.** Tens of millions of
   assertions are useful only if one decision sees a bounded, relevant,
   proof-closed subgraph.

The graph is not the product merely because nodes and edges exist. The value is
the engine's ability to preserve causal and evidential structure across time,
then exclude relations that are stale, unauthorized, unsupported, conflicting,
or outside the declared work budget.

## What belongs in AttuneGraph

Persist a relation when losing it would force the agent to reconstruct prior
work or would make a later decision materially harder to explain, invalidate,
or reproduce.

Examples include:

- source artifact -> observation -> assertion;
- assertion -> supports or contradicts -> claim;
- assertion version -> supersedes -> prior version;
- observation -> decision -> action -> tool result -> outcome;
- failed attempt -> explains -> workflow constraint or gotcha;
- policy evidence -> used, adjusted, ignored, or rejected outcome;
- exact source anchor -> page, cell range, heading, block, time range, or tool
  receipt.

Do not graph everything. Raw PDF, spreadsheet, image, audio, Markdown, and
Notion bytes remain in their authoritative systems. AttuneGraph stores typed
references, exact anchors, hashes, parser provenance, temporal state, and
rebuildable relations. Parsers, OCR, embeddings, and model calls belong behind
optional adapters rather than inside the database core.

## Fundamental values

### Evidence before proximity

Graph distance is a discovery signal. It is never, by itself, truth,
permission, feedback, or action authority. Every admitted relation must retain
its exact provenance, temporal state, epistemic class, and permitted use.

### History without stale leakage

The engine preserves both world time and knowledge time. It can reproduce what
was known for an earlier decision while preventing superseded information from
silently leaking into a current one.

### Honest incompleteness

Budgets are part of query semantics. If a token, node, edge, depth, source-open,
or wall-clock bound prevents conflict and authority checks from completing, the
result is `partial` or `abstained`, never silently `complete`.

### Non-destructive correction

Revision, revocation, and uncertain identity preserve their evidence and impact
chains. Logical revoke precedes dependency analysis; physical compaction occurs
only after active heads and retained receipts no longer require the data.

### Exact replay

The same admitted evidence, decision parameters, canonical order, and snapshot
must produce the same semantic result. A receipt identifies the inputs,
freshness, budget cuts, selected evidence, exclusions, and terminal state.

### Local adoption

One developer should be able to embed the engine without a graph server,
credentials, or a hidden model bill. External lexical or vector systems may
propose candidate entry points; AttuneGraph remains the final admissibility
gate.

## The agent-native contract

The target public boundary is a Decision Context Compiler:

```text
authoritative sources
  -> bounded source observations
  -> temporal and provenance graph
  -> candidate entry points
  -> admissibility, conflict, authority, and budget checks
  -> DecisionContext + ContextReceipt
  -> agent decision
  -> action and outcome receipt
  -> revision or policy evidence
```

`DecisionContext` should contain only the evidence the current decision may
use. `ContextReceipt` should make that selection replayable and explain why
material candidates were selected, rejected, truncated, or caused abstention.

The first shipped step is narrower: `decision-query@1` compiles one exact-head,
fresh, bounded evidence frontier through either a canonical object or a fixed
AttuneQL grammar. Its content-addressed receipt explicitly labels authority and
conflict evaluation as `not-performed`. It is therefore evidence for a host
decision, not a claim that the full Decision Context contract is complete.

The typed `authority-query@1` operator is a second narrow step. It answers only
whether one exact action is currently authorized for one exact V2 thread root.
It requires the fixed outgoing chains `action GOVERNED_BY policy`,
`policy SCOPED_TO thread`, `action AUTHORIZED_BY evidence`, and
`evidence OBSERVED_DURING thread`; every granting edge must be temporally
eligible and non-hypothesis. A `GOVERNED_BY` conflict abstains, and any result
or work cut remains `partial/undetermined`. This is not general policy
evaluation, historical-head retention, or authority to execute the action.

This is the wedge over a general graph query. A general database can implement
the same behaviour with sufficient application code. AttuneGraph makes the
behaviour the database contract and fail-closed default.

## Scale follows the decision boundary

The aggregate database may contain 10 million to 50 million assertions, but a
single agent decision remains intentionally small. Scale work therefore
optimizes `global history -> local decision frontier`, not unbounded graph
analytics.

The planned data plane is:

1. TypeScript owns the public API, canonical semantics, validation, ordering,
   budgets, receipts, and the reference implementation.
2. SQLite owns durable commits, exact heads, optimistic concurrency, the
   canonical journal, and initially the normalized decision index.
3. Internal integer dictionaries and ordered adjacency postings avoid loading
   or scanning unrelated scopes and payloads.
4. Current-time bitemporal eligibility can be compiled to the exact interval
   `max(recordedAt, validFrom) <= now < min(supersededAt, validTo)` while the
   stored model retains both time axes. Historical operators with an independent
   recorded-time cutoff retain the full two-axis evaluation.
5. Immutable segmented adjacency, late payload materialization, retention pins,
   and manifest-bound snapshots are introduced only behind identical public
   semantics.
6. A Rust kernel is admitted only when reproducible 10M/50M profiles show that
   traversal, interval filtering, sorting, compaction, or file validation is
   the measured bottleneck. It may replace the data-plane implementation, not
   reinterpret ordering or weaken TypeScript semantics.

Proposed latency and throughput thresholds are qualification gates, not current
performance claims. A benchmark must bind results to one clean revision, host,
dataset, semantic hash, and cold/warm profile.

## Product falsification

The direction is wrong if any of these remain true after the planned contracts
ship:

- an equivalent vector-only baseline has no material disadvantage in stale
  leakage, wrong-memory suppression, reconstruction time, or action reversals;
- a new agent requires custom Cypher, a bespoke ontology, or more than about an
  hour to complete the first useful integration;
- the same evidence and budget produce nondeterministic decision contexts;
- AttuneGraph adds latency without reducing context tokens, errors, rework, or
  reconstruction cost;
- receipts cannot reproduce which source versions and exclusions affected an
  action.

The engine should be judged on better agent decisions and safer continuity, not
node count or graph visualisation alone.

## Current boundary

Shipped in the current core:

- immutable source-linked projections and exact heads;
- validity, recording, supersession, freshness, provenance, and abstention
  semantics;
- deterministic bounded Working Graph compilation;
- fixed-profile `decision-query@1` through canonical objects or bounded
  AttuneQL, with exact-head and freshness fail-close behavior, honest terminal
  states, and a content-addressed evidence-only receipt;
- typed `authority-query@1` with exact V2 embedded-root verification,
  bitemporal/freshness posture, a fixed four-edge non-hypothesis authority
  proof, query-local governance conflict closure, explicit
  `authorized | undetermined`, and a content-addressed result-bounded receipt;
- in-memory and worker-isolated local SQLite profiles;
- canonical portable artifacts and a read-only offline Admin;
- head-pinned prepared plans with fail-closed snapshot mismatch handling;
- exact-head `revocation-impact@1` planning with normalized bounded selectors,
  deterministic dependency witnesses, partiality, and content-addressed
  receipts; and `revocation-transition@1`, a one-CAS source-authoritative V2
  replacement that proves exact survivor subtraction, never graph-owned delete.

Directional, not yet shipped as a complete public contract:

- `DecisionContext` and `ContextReceipt` named public interfaces;
- general proof-closed conflict and authority selection beyond the fixed
  `authority-query@1` profile;
- non-destructive temporal identity resolution;
- receipt-pin persistence, historical receipt lookup, retention, journal
  pruning, physical compaction, and any retry ergonomics that would require a
  persisted predecessor proof;
- arbitrary general-purpose AttuneQL traversal, caller-selected relationship
  families, joins, analytics, and writes;
- multi-source snapshot vectors;
- Agent Experience Graph and outcome-linked evaluation;
- normalized 10M/50M decision indexes and any Rust acceleration.

Documentation and benchmarks must keep this distinction explicit.

## Research anchors

- Kùzu's columnar, double-indexed CSR design is a useful embedded-graph storage
  reference, not an implementation to copy: [Kùzu CIDR paper](https://www.cidrdb.org/cidr2023/papers/p48-jin.pdf).
- Graphiti demonstrates temporal knowledge-graph memory and public demand for
  deterministic, observable bulk ingestion: [Graphiti](https://github.com/getzep/graphiti),
  [large-scale ingestion discussion](https://github.com/getzep/graphiti/issues/1193).
- LongMemEval-V2 evaluates dynamic state, workflows, failed trajectories, and
  premise awareness rather than only static fact retrieval:
  [LongMemEval-V2](https://arxiv.org/abs/2605.12493).
- GEM frames agent memory as state-trajectory maintenance with ingestion,
  revision, forgetting, and retrieval operations: [GEM](https://arxiv.org/abs/2605.26252).
- SQLite's WAL and storage guidance informs the local control-plane boundary:
  [WAL](https://www.sqlite.org/wal.html),
  [WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html).

These references motivate design questions. They do not prove that current
AttuneGraph builds, scale targets, or comparative performance are achieved.
