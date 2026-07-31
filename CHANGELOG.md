# Changelog

All notable changes to AttuneGraph are recorded here.

## [Unreleased]

### Fixed

- Invoke the pinned TypeScript compiler without platform command shims so builds work on Windows.
- Verify the full Node 24 floor and current-major suite on Linux, macOS, and Windows.

## [0.1.0] - 2026-07-31

### Added

- Dependency-free agent-native temporal and provenance graph engine.
- Bounded Working Graph compilation with explicit abstention and diagnostics.
- In-memory store and worker-isolated local SQLite adapter.
- Canonical portable `.atgx` format with golden fixtures.
- Offline read-only Admin Interface.
- Standalone Node 24 build, CI, package dry-run, and non-Muse example.

[0.1.0]: https://github.com/wlsdks/attunegraph/releases/tag/v0.1.0
