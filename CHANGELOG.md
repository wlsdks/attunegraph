# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Added

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
