# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Added

- Add `canonical-projection@2` with an explicit `threadRoot` inside the
  content-addressed observation.
- Reject disconnected graph debris before any Store read or compare-and-swap,
  while retaining byte-compatible v1 Store and `.atgx` re-admission.

### Fixed

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
