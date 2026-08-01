# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Added

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
  Working Graph harness with cold/warm rebuilt heads, raw timings, stored-v2
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
  capabilities, host extraction results, exact evidence references, and v2
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
- Add readiness evidence v2 with immutable hashed artifacts, strict unavailable
  check handling, substitute-command rejection, provenance boundaries, v1
  rejection, Ubuntu/Windows Node 24.15 tests, and a GitHub producer-contract
  attestation skeleton.
- Add a deterministic connected-v2 10K/100K/1M scale benchmark with fixed
  shards, revision/toolchain/corpus binding, raw latency and RSS samples,
  in-memory and local SQLite profiles, safe non-overwriting JSON output, and an
  explicit measurement-only/no-readiness-claim boundary.
- Add `canonical-projection@2` with an explicit `threadRoot` inside the
  content-addressed observation.
- Reject disconnected graph debris before any Store read or compare-and-swap,
  while retaining byte-compatible v1 Store and `.atgx` re-admission.

### Changed

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
  binding as a harness-v2 requirement.
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
