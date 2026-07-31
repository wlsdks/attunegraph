# AttuneGraph agent guide

AttuneGraph is an agent-native temporal and provenance graph engine. Keep the
runtime dependency-free, bounded, deterministic, and independent of any host
agent or product.

- Source systems remain authoritative.
- Graph proximity is not truth, permission, feedback, or action authority.
- Unknown, stale, corrupt, and over-budget states fail closed or abstain.
- Portable-format and persisted-store changes require explicit version and
  compatibility decisions.
- Use `pnpm test:focused` while editing. Run slow or broad verification
  separately so it does not block unrelated implementation.
- Before merge, use Node 24.12 or newer and run `pnpm typecheck`, `pnpm test`,
  `pnpm example`, and `pnpm pack:dry-run`.
