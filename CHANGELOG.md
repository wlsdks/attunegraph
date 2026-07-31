# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Added

- Add a deterministic connected-v2 10K/100K/1M scale benchmark with fixed
  shards, revision/toolchain/corpus binding, raw latency and RSS samples,
  in-memory and local SQLite profiles, safe non-overwriting JSON output, and an
  explicit measurement-only/no-readiness-claim boundary.
- Add `canonical-projection@2` with an explicit `threadRoot` inside the
  content-addressed observation.
- Reject disconnected graph debris before any Store read or compare-and-swap,
  while retaining byte-compatible v1 Store and `.atgx` re-admission.

### Fixed

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
