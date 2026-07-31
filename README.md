# AttuneGraph Core

`@attunegraph/core` is an agent-neutral temporal and provenance graph engine.
It turns bounded source observations into immutable projections and compiles a
small Working Graph for one agent decision.

The package does not treat graph proximity as truth, feedback, policy,
permission, or action authority. Authoritative data remains in its source
system; AttuneGraph stores rebuildable relations and exact source references.

The core, in-memory adapter, and portable wire contract require Node.js 22.12
or newer and are tested on Linux, macOS, and Windows. The worker-isolated local
SQLite adapter and offline Admin require Node.js 24.15 or newer and currently
have reviewed filesystem profiles for Linux and macOS only. Opening either
interface on an older runtime or Windows fails closed; it does not silently
fall back to a weaker store.

| Interface | Runtime | Reviewed operating systems |
| --- | --- | --- |
| Core, in-memory, portable wire/decoder | Node.js >=22.12 | Linux, macOS, Windows |
| Local SQLite (`./local`) | Node.js >=24.15 | Linux, macOS |
| Offline Admin (`./admin`) | Node.js >=24.15 | Linux, macOS |

## Package boundary

This is a standalone, publishable package boundary. It has:

- no package dependencies;
- no TypeScript project references;
- no host-product imports;
- a provider-neutral engine and store capability;
- an in-memory semantic oracle and a worker-isolated SQLite adapter;
- a canonical NDJSON portable format with checked-in golden fixtures;
- a revision-bound, measurement-only 10K/100K/1M scale harness.

The package is not yet published to a registry and does not provide a hosted
service. Its API is usable locally from this repository now.

## Public exports

- `@attunegraph/core` — engine lifecycle, graph contracts, and bounded
  Activation Subgraph compilation.
- `@attunegraph/core/backend` — the expert store-adapter seam.
- `@attunegraph/core/local` — the durable local SQLite adapter.
- `@attunegraph/core/admin` — the offline, read-only Admin Interface for
  explicitly closed and quiescent local stores.
- `@attunegraph/core/testing` — in-memory adapters and executable conformance
  contracts.
- `@attunegraph/core/extension-kit` — a narrow set of canonicalization,
  validation, settlement, and witness-path primitives for integration
  packages.

Source filenames and all other package subpaths are private.

## Quick start

```ts
import {
  openAttuneGraph,
  type AttuneGraphScope,
  type GraphAssertion
} from "@attunegraph/core";
import {
  createInMemoryAttuneGraphStore
} from "@attunegraph/core/testing";

const scope: AttuneGraphScope = {
  sourceId: "notes",
  threadId: "trip-planning"
};
const threadRoot = { kind: "thread" as const, id: "thread:trip-planning" };

const assertion: GraphAssertion = {
  schemaVersion: 1,
  id: "trip-linked-to-hotel-comparison",
  subject: { kind: "artifact", id: "hotel-comparison" },
  predicate: "LINKED_TO",
  object: { ...threadRoot },
  epistemicClass: "source-observed",
  sourceRefs: [{
    namespace: "example.notes",
    id: "travel.md#hotel-comparison"
  }],
  recordedAt: "2026-07-30T09:00:00.000Z",
  derivation: { kind: "projection", version: "example@1" }
};

const attuneGraph = await openAttuneGraph({
  scope,
  store: createInMemoryAttuneGraphStore()
});

const snapshot = await attuneGraph.project({
  operator: "canonical-projection@2",
  observation: {
    schemaVersion: 2,
    observationKey: "notes-sync-42",
    scope,
    threadRoot,
    observedAt: "2026-07-30T09:00:00.000Z",
    sourceFreshness: {
      state: "fresh",
      observedAt: "2026-07-30T09:00:00.000Z"
    },
    assertions: [assertion]
  }
});

const result = await attuneGraph.execute({
  operator: "working-graph@1",
  seed: threadRoot,
  now: "2026-07-30T09:00:00.000Z",
  maxEstimatedTokens: 2_000
});

console.log(snapshot.commitId, result.status, result.workingGraph);
await attuneGraph.close();
```

`canonical-projection@2` adds **Thread-rooted Admission**. The exact
`threadRoot` is part of the content-addressed observation; the engine requires
every normalized assertion to belong to its undirected connected component
before it performs a Store read or compare-and-swap. Empty observations remain
valid. A mixed projection containing useful thread context plus disconnected
graph debris fails closed with `DISCONNECTED_OBSERVATION`, so there is no
partial generation or hidden orphan component.

`scope.threadId` is an isolation key, not an inferred graph node ID. Agents may
use opaque or content-addressed thread roots and must declare the exact
`GraphRef`. The legacy `canonical-projection@1` profile remains readable and
writable for compatibility, but is root-unverified; new agent integrations
should write v2. Stored and portable v1 projections remain readable without
being retroactively certified as thread-rooted.

V2 observation IDs use the `attunegraph.canonical-projection.v2` hash domain;
v1 IDs retain their original domain and bytes. The Store envelope and `.atgx`
transport versions do not change because both re-admit the embedded observation
according to its declared schema version.

After an exact replay check, both canonical projection profiles refuse a source
observation whose `observedAt` precedes the active head. This prevents a delayed
older source read from replacing newer truth; equal-instant distinct writes
retain the existing expected-snapshot CAS semantics.

The process-local in-memory adapter is intended for tests and experiments. It
does not provide durable storage.

## Durable local store

```ts
import { openLocalAttuneGraph } from "@attunegraph/core/local";

const attuneGraph = await openLocalAttuneGraph({
  databasePath: "/absolute/local/path/attunegraph.sqlite",
  scope: {
    sourceId: "notes",
    threadId: "trip-planning"
  }
});

// Recover the exact optimistic token after a process restart.
const current = await attuneGraph.head();
// A distinct projection supplies `current` as expectedSnapshot; an identical
// observation is replay-safe and returns the same generation.
await attuneGraph.close();
```

The local adapter keeps SQLite, SQL, worker lifecycle, and physical schema
private. It validates the runtime, filesystem, ownership, file mode, exact
physical identity, schema, and safety pragmas before serving data. Unsupported,
future, corrupt, and incompatible stores fail closed.

## Read-only Admin

```ts
import {
  openAttuneGraphAdminReadonlyApplication
} from "@attunegraph/core/admin";

const admin = await openAttuneGraphAdminReadonlyApplication({
  databasePath: "/absolute/local/path/attunegraph.sqlite",
  sourceState: "closed-quiescent"
});

const summary = await admin.inspectSummary();
const integrity = await admin.verifyIntegrity();
const head = await admin.inspectHead({
  sourceId: "notes",
  threadId: "trip-planning"
});

console.log(summary, integrity, head);
await admin.close();
```

This Interface is deliberately offline and read-only. The caller must stop the
writer and explicitly attest `closed-quiescent`; snapshot acquisition can
detect source changes while copying, but cannot prove the lifecycle. The
Interface exposes no SQLite handle, filesystem authority, Worker transport,
repair, export, or mutation primitive.

## Portable format

Portable artifacts use the `.atgx` extension and the
`attunegraph-portable` manifest identity. The format is canonical NDJSON, not a
binary container. Exact framing, hashes, ordering, limits, and validation-sink
requirements are specified in [PORTABLE-FORMAT.md](PORTABLE-FORMAT.md).

Artifacts and databases created with the superseded identities are
intentionally incompatible. The package rejects them before mutation; it does
not carry a compatibility alias or migration path.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test:focused
pnpm test                 # cross-platform core/in-memory/portable contracts
pnpm test:local-profile   # reviewed Linux/macOS local SQLite and Admin
pnpm test:supported       # both profiles on a reviewed local-profile host
pnpm test:benchmark-qualification # separate real 10K lifecycle proof
pnpm build
pnpm example
pnpm pack:dry-run
pnpm fixtures:portable
pnpm verify:portable-fixtures
pnpm verify:local
pnpm benchmark:scale -- --scale=10000 --profile=core --warmups=0 --repetitions=1
```

The benchmark's fixed connected v2 corpus, evidence schema, output safety, and
claim boundary are documented in [BENCHMARKS.md](BENCHMARKS.md). The real 10K
lifecycle proof and the 100K/1M runs are separate evidence activities, not
normal test gates.

Fixture generation is deterministic. Regeneration must reproduce the checked-in
inputs, `.atgx` artifacts, manifest hashes, byte counts, record identities, and
state identities exactly.

`pnpm test:local-profile` intentionally fails closed on unsupported hosts; CI
runs it only on reviewed Linux and macOS profiles. No platform test is silently
skipped.

Passing these checks proves the package contracts. It does not prove that an
agent has learned a person, improved its timing, or produced a real-world
outcome. Agent bridges, MCP transport, hosted operation, and product-specific
policy are roadmap work outside this neutral core.
