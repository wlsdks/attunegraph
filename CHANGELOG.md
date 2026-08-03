# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Changed

- Bump Decision Query receipts to wire `contractRevision: 2` and the
  `attunegraph.decision-query-receipt.v2` hash domain. Each receipt now carries
  a separately domain-separated `selectedWorkingGraphId` that content-binds
  normalized selected assertion bytes in producer order plus the seed, so
  full-result admission rejects same-length content drift. Admission also
  closes producer diagnostics exactly: no token cut means considered equals
  selected, a token cut requires at least one rejected considered assertion,
  and refs beyond the visited cap require traversal truncation. Revision-1
  receipts are not converted; consumers must re-run the query and transport
  the complete revision-2 result.

### Added

- Add `graph.admitAgentDecisionBundleAtCurrentHead` as the live Store boundary
  for detached agent bundles. It fully re-admits untrusted bytes before Store
  I/O, then requires exact scope, snapshot, canonical projection, observed time,
  and source freshness to match a head-stable current projection read window.
  Success returns the unchanged frozen bundle and grants no lock, lease, source
  truth, or execution capability.
- Add `agent-decision-view@1` and
  `decision-context-proof-bundle@1`. `compileAgentDecisionBundle` separates one
  same-process Decision Context into a compact model-facing assertion union and
  one canonical-projection replay proof; `admitAgentDecisionBundle` rebuilds
  the full fixed-profile result and exact-compares the view. The executable
  four-scenario payload gate records 74.2–95.1% prompt-byte reduction and
  41.9–62.3% combined view-plus-proof reduction on Node 24.16 without claiming
  producer authenticity, live-head currency, source truth, model quality, or
  execution permission.
- Add `decision-query@1`, the first agent-native evidence compiler over the
  current exact head. Typed objects and bounded AttuneQL normalize to one
  canonical query, require fresh source state, reuse deterministic Working
  Graph semantics, expose honest complete/partial/abstained outcomes, and seal
  a content-addressed evidence-only receipt. The fixed grammar does not expose
  caller-selected relationship families, writes, or general traversal, and the
  receipt explicitly does not claim authority or conflict closure.
- Add the recommended host-neutral readiness `@2` profile: subject-bearing
  evidence names an exact `consumer` gitlink and uses generic consumer CLI,
  gate, and cwd contracts. The existing Muse-shaped `@1` profile remains a
  frozen compatibility profile rather than being silently reinterpreted; Muse
  is now only an optional dogfood consumer, not a standalone product contract.
- Add `revocation-transition@1`: a source-authoritative, exact-head V2
  replacement protocol that re-admits a complete canonical impact receipt,
  recomputes it at hard bounds, requires exact survivor subtraction and an
  unchanged thread root, then performs one CAS and seals a transition receipt.
  Only an identical concurrent CAS winner converges; late retry, persisted
  receipt pins, retention, pruning, compaction, and general-purpose AttuneQL
  traversal remain unshipped.
- Add the provider-neutral `revocation-impact@1` exact-head, read-only plan on
  the durable `AttuneGraph` handle. It normalizes bounded assertion, graph,
  and source selectors before Store I/O; expands immutable assertion-source
  dependencies with deterministic shortest witnesses; returns honest partial
  results under work/output caps; and seals an immutable snapshot-bound
  receipt. Applying a revocation, receipt retention, journal pruning, and
  physical compaction remain directional and unshipped. The legacy in-memory
  `forget()` physical-delete utility is unchanged.
- Add the first-principles architecture contract defining long-lived agent
  discontinuity, the evidence-admissibility purpose of the graph, the
  Decision Context direction, graph inclusion and exclusion rules, honest
  shipped-versus-directional boundaries, and the scale-gated TypeScript,
  SQLite, and optional Rust data-plane path.
- Add `attunegraph-sqlite-generation-growth@1`, a compiler-free packed local
  diagnostic that isolates 32 fixed-width single-scope generations and records
  DB/WAL/SHM logical sizes at 15 exact public-API boundaries. It pins the final
  head, decision, commit, workload, reopen, and two close resolutions while
  keeping PASSIVE counters private and making no allocated-byte, checkpoint,
  compaction, retention, slope, SLA, or qualification claim.
- Add `worker-resource-lifecycle@1`, a packed measurement-only diagnostic that
  performs one excluded preparation write followed by four identical read-only
  public session/Worker reopen cycles. It separates whole-process RSS,
  main-thread memory, and active-Worker isolate heap, samples after handle
  close, waits for session-close Worker exit, binds harness/workload hashes,
  enforces fresh DB/WAL/SHM state and a 128 KiB emitted-report cap, runs from a
  compiler-free clean installation, and makes no leak, allocator, per-Worker
  RSS, performance, or qualification claim.
- Close the packed-tool boundary with source-versus-installed runtime preparation,
  complete script/Golden fixture inclusion, clean-room execution of installed
  Golden and durable tracers, explicit refusal of revision-bound evidence under
  `node_modules`, and package-manager-safe readiness capture arguments.
- Add the first public readiness evidence contract with a separate fail-closed, unscored measurement
  registry and bounded producer for the four-session durable tracer. The
  scorer validates the raw 80-read/20-write ledger, full 88-read/24-write run,
  golden reopen results, provenance, runtime, checked-out harness bytes,
  artifact uniqueness, and freshness while preserving all eight gates, 37
  checks, weights, and qualification closure.
- Add `four-session-mixed-80r20w@1`, a runnable measurement-only durable
  SQLite tracer using four independent public sessions and Workers over one
  shared file. Its deterministic 80-read/20-write timed window is derived from
  an operation ledger, exact public results are pinned through graceful reopen,
  and settled DB/WAL/SHM logical sizes are reported with explicit concurrency,
  timing, provenance, and qualification non-claims.
- Add `generation-churn-8x40@1`, a measurement-only durable SQLite agent
  decision tracer using only the public local API. It projects eight
  generation-specific 16-active/24-temporal-decoy heads, gracefully reopens a
  new Worker in the same process, and pins exact head, ordered provenance,
  diagnostics, and full-result equality without claiming cold cache, crash
  recovery, multi-client contention, tails, or qualification.
- Add `agent-decision-read-scale@1`, a strict measurement-only active-scale
  Working Graph harness with cold/warm rebuilt heads, raw timings, stored schema-revision-2
  byte and semantic anchors, bounded p50-only reporting, an explicit temporal
  authorization-abstention sentinel, process-observational memory checkpoints,
  explicit per-read versus aggregate batch work counts, and clean
  revision/host/argv-bound CLI evidence.
- Add the dependency-free `attunegraph-performance-regression@1` offline
  verifier and CLI. It strictly binds a five-pair AB/BA manifest to exact
  base/candidate evidence bytes, distinct immutable revision/package
  identities, correctness output, environment, harness, corpus, contract,
  chronology, paired ratio/delta recomputation, percentile eligibility, and
  absolute/half-host RSS policy checks. Unattested bundles remain
  measurement-only and claim-ineligible; only the explicitly named shared-
  runner advisory gate can succeed without asserting qualification.
- Add a strict measurement-only `agent-decision-read@1` benchmark for the
  public Working Graph path. Its isolated generation-8 in-memory workloads
  cover wide-hot and deep-cold/bitemporal complete, partial, and abstained
  decisions in independent single-seed batches of 1, 4, and 32, with exact
  counters, output bytes, semantic anchors, provenance, packed-entry smoke,
  separate Engine-sum versus harness-wall timing, unambiguous head/input
  assertion counts, fixed `@1` semantic expectations, independently supplied
  canonical-root clean-start/clean-end provenance authority verification, and
  honest tail ineligibility.
- Add revision-bound external-project performance measurement and qualification: bounded
  concurrent local-session ingestion with alternating same-run baselines, portable `.atgx`
  encode/materialize/decode metrics, cold/warm SQLite session open, process peak RSS, and a
  fail-closed six-report 10K/100K/1M threshold policy.
- Add a zero-dependency `@attunegraph/core/source-adapter` SDK for typed,
  factory-defined external adapters. It validates bounded metadata,
  capabilities, host extraction results, exact evidence references, and `schemaVersion: 2`
  projection inputs before Store I/O, then uses `projectAgainstHead` without
  parsing or retaining authoritative source bytes.
- Add a fixed Working Graph golden corpus and strict verifier for ordered
  retrieval, bitemporal filtering, explicit thread roots, freshness, budget
  partials, and abstention.
- Add explicit `projectAgainstHead` optimistic concurrency for agents that
  intend the latest committed head at operation start, using one initial
  validated Store read and one exact CAS without weakening `project` semantics;
  a CAS miss rereads the winner once to distinguish convergence from conflict.
- Add a paired measurement-only local-session update profile comparing caller
  `head()` plus exact `project` against `projectAgainstHead`.
- Add an Ubuntu Node 24.15 clean-room consumer CI proof that packs the built
  package, installs it offline outside the checkout, and exercises its public
  export boundary through a canonical-projection@2 Working Graph.
- Add explicit database-scoped `openLocalAttuneGraphSession` handles that share
  one caller-owned SQLite Worker across scopes while retaining cold
  `openLocalAttuneGraph` semantics and no global pool.
- Add a separate measurement-only `local-session` scale benchmark profile for
  the fixed 313-shard 10K workload.
- Add a revision-bound readiness-integrity scorer with eight gates, 37
  registry-bound checks, exact Muse gitlink verification, fixed performance
  parameters, and local-unattested eligibility closure.
- Add readiness evidence with immutable hashed artifacts, strict unavailable
  check handling, substitute-command rejection, provenance boundaries,
  Ubuntu/Windows Node 24.15 tests, and a GitHub producer-contract
  attestation skeleton.
- Add a deterministic thread-rooted schema-revision-2 10K/100K/1M scale benchmark with fixed
  shards, revision/toolchain/corpus binding, raw latency and RSS samples,
  in-memory and local SQLite profiles, safe non-overwriting JSON output, and an
  explicit measurement-only/no-readiness-claim boundary.
- Add `canonical-projection@2` with an explicit `threadRoot` inside the
  content-addressed observation.
- Reject disconnected graph debris before any Store read or compare-and-swap,
  while retaining byte-compatible v1 Store and `.atgx` re-admission.

### Changed

- Precompute exact current-decision eligibility intervals while preparing a
  Working Graph, remove the retained flat assertion list, and evaluate time
  only for adjacency postings reached by bounded traversal. Repeated decisions
  no longer parse or scan the whole scope's temporal metadata; public ordering,
  budgets, diagnostics, temporal boundaries, and persisted formats are
  unchanged.
- Reuse one bounded prepared Working Graph plan per open Engine handle when an
  optional Store Adapter exact-head read matches the same scope, generation,
  and commit ID. The SQLite and in-memory adapters implement the capability;
  custom adapters without it retain full-read behavior. Time validity, seed
  traversal, token budgets, diagnostics, and final results are recomputed on
  every execute, while successful local CAS and observed external writes
  invalidate the plan. Persistent head/projection mismatch retries once and
  fails closed rather than mixing generations.
- Reuse the decoder's already verified canonical store-envelope result during
  semantic normalization instead of independently re-admitting the same
  projection twice more. Wire bytes, content identities, validation outcomes,
  corruption handling, budgets, sink abort semantics, and terminal convergence
  remain unchanged. Five clean rebuilt AB/BA 10K portable pairs record a 29.89%
  paired-median decode-latency reduction and a 42.64% throughput increase.
  RSS remains too noisy to classify and is an explicit measurement gap. This is
  bounded one-host evidence, not a tail, SLA, leak, or general database claim.
- Build one execute-local adjacency index for each Working Graph compilation
  instead of rescanning every usable assertion for every visited ref. Exact
  ordering, temporal filtering, budgets, diagnostics, authority, provenance,
  abstention, and storage validation remain unchanged. Five clean rebuilt
  AB/BA pairs record paired-median reductions of 9.5% cold and 9.8% warm for
  `thread-frontier-48`, and 8.0% cold and 9.1% warm for its batch-32 cell;
  focused-read medians remain near noise and carry no speed claim.
- Remove the redundant post-freeze unsigned canonical re-encode and SHA-256
  pass while retaining deep frozen-output verification, exact content-ID
  verification, and byte-for-byte full-envelope re-encoding. Five clean
  rebuilt AB/BA pairs preserve every workload and semantic anchor and record
  paired-median reductions of 8.5% to 13.9% cold and 7.8% to 14.7% warm across
  the nine bounded `agent-decision-read-scale@1` cells. This remains
  measurement-only evidence from one host, not an SLA or general database
  performance claim.
- Replace repeated full-prefix JSON serialization in Working Graph token-budget
  checks with exact incremental UTF-8 byte accounting. Exact one-through-48
  multibyte boundary tests preserve selection and diagnostics, while five
  rebuilt AB/BA pairs show no focused-read speed claim and a 7.3% to 14.5%
  cold paired-median reduction for the declared frontier-32/48 and frontier-48
  batch cells. Evidence remains measurement-only and records built-artifact
  binding as a second harness-revision requirement.
- Measure bounded error paths, ASCII contract fields, and canonical JSON
  fragment/body-envelope limits through a captured Node `Buffer.byteLength`
  primordial instead of allocating a `TextEncoder` result at those call sites.
  Input-string UTF-16 validation and aggregate UTF-8 charging remain unchanged,
  while exact canonical bytes, content IDs, portable hashes, budgets, validation
  precedence, and post-import primordial-poison resistance stay pinned. A
  fixed exact-base checkpoint records five fresh AB/BA 10K portable pairs,
  their exact report hashes, identical artifacts, and excluded moving-base
  samples. It remains measurement-only and makes no p95, p99, SLA, or general
  hardware claim; traversal, key sorting, and bounded path construction are
  now the profiled canonicalization bottlenecks.
- Replace portable decoder per-byte array framing with a bounded chunk-aware LF
  scanner and reusable byte buffer while retaining caller-chunk detachment,
  wire bytes, budgets, failure precedence, sink reentry, and abort semantics.
  CPU evidence classifies this as allocation/streaming hygiene with no material
  speed claim; canonicalization remains the measured bottleneck.

### Fixed

- Close performance-evidence forgery paths with exact nested schemas, corpus-bound correctness
  counts, deterministic AB/BA ordering, raw-sample recomputation, and an explicit distinction
  between evidence integrity and absolute performance qualification.
- Read pnpm provenance portably on Windows and POSIX benchmark runners.
- Isolate the real 10K lifecycle qualification from the normal cross-platform
  suite so slower runners do not turn measurement into a flaky correctness
  gate.
- Reject a source observation before any Store read or compare-and-swap when
  its canonical projection cannot fit the Store envelope's single-string
  budget; previously such a write could commit and then fail its own next read
  as corrupt.
- Invoke the pinned TypeScript compiler without platform command shims so builds work on Windows.
- Verify cross-platform contracts on Linux, macOS, and Windows while keeping
  local SQLite and Admin verification on their reviewed Linux/macOS profiles.
- Pin canonical portable fixtures to LF checkouts on every operating system.
- Remove the timer race from the SQLite busy-exhaustion qualification.

## [0.1.0] - 2026-07-31

### Added

- Dependency-free agent-native temporal and provenance graph engine.
- Bounded Working Graph compilation with explicit abstention and diagnostics.
- In-memory store and worker-isolated local SQLite adapter.
- Canonical portable `.atgx` format with golden fixtures.
- Offline read-only Admin Interface.
- Standalone Node 24 build, CI, package dry-run, and non-Muse example.

[0.1.0]: https://github.com/wlsdks/attunegraph/releases/tag/v0.1.0
