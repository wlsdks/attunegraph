# Contributing

Use Node 24.15 or newer and pnpm 10 or newer. Install dependencies, then run
the focused test for the area you change before opening a pull request.

```sh
pnpm install
pnpm typecheck
pnpm test:focused
pnpm test
pnpm build
```

`pnpm test` covers the cross-platform core, in-memory, and portable contracts.
On a reviewed Linux/macOS filesystem profile, also run
`pnpm test:local-profile` with Node 24.15 or newer. Local SQLite/Admin are not
silently skipped on Windows; those interfaces fail closed until a Windows
profile is explicitly designed and reviewed.

Keep the core dependency-free and agent-neutral. Source systems remain
authoritative; changes must not turn graph proximity into permission, feedback,
or action authority. Add deterministic tests for public behavior and preserve
canonical portable-format compatibility unless the format version changes.
