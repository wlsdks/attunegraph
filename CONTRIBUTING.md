# Contributing

Use Node 24.12 or newer and pnpm 10 or newer. Install dependencies, then run
the focused test for the area you change before opening a pull request.

```sh
pnpm install
pnpm typecheck
pnpm test:focused
pnpm build
```

Keep the core dependency-free and agent-neutral. Source systems remain
authoritative; changes must not turn graph proximity into permission, feedback,
or action authority. Add deterministic tests for public behavior and preserve
canonical portable-format compatibility unless the format version changes.
