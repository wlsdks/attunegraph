# AttuneGraph readiness integrity

AttuneGraph reports fail-closed readiness integrity for one clean AttuneGraph revision and its
exact Muse consumer pin. Local artifacts are explicitly unattested: they do not prove who executed
a command and can never make a revision qualification-eligible. This report does not score product
usefulness, personal attunement, or user delight.

## Gates

| Gate | Weight | Required checks |
| --- | ---: | --- |
| Independent clean room | 15 | install, build, test, example, pack, consumer install |
| Muse integration | 20 | exact submodule pin, narrow public port, no copied Engine, durable `canonical-projection@2` path |
| Semantic safety | 20 | conformance, adversarial, property, fault, authority fail-closed |
| Persistence and portability | 10 | SQLite crash/CAS, `.atgx` streaming round trip |
| Retrieval quality | 10 | Working Graph golden corpus, abstention |
| Performance and resources | 15 | 10K/100K/1M corpora, latency, throughput, RSS, SQLite open, concurrency, portable encode/decode |
| Operability | 5 | inspect, verify, diagnose, zero hidden mutation |
| Public adoption | 5 | API reference, migration notes, independent example |

All 37 names are fixed in `scripts/readiness-check-contracts.mjs`. A gate contributes its full
weight only when every check passes. The integrity threshold is 90 plus passing Muse integration,
semantic safety, and persistence/portability. It is reported separately from eligibility.
`local-unattested` evidence always returns `eligible: false`.

`pnpm verify:working-graph-golden` is the checked-in corpus verifier substrate for
`working-graph-golden-corpus` and `abstention`. Its one stdout report is not two readiness
artifacts and cannot be reused or relabeled. The fixed `run-working-graph-readiness.mjs` adapter
emits one strict, distinct output envelope per check, making these the first two available registry
commands. The corpus result is never organic usefulness evidence.

## Evidence contract

`attunegraph-readiness-evidence@1` is the first public evidence contract. It contains the clean
exact AttuneGraph and Muse commit/tree subject, 37 `{ name, gate, result }` descriptors, and exactly
one descriptor from the separate unscored measurement registry:
`mixed-durable-agent-decision-observation`. Each check result binds the name to one fixed
registry contract, canonical repository cwd role, fixed argv template, output semantics, and fixed
parameters. It also carries timestamps, process outcome, capture toolchain, subject identities,
provenance, and unique hashed stdout/stderr artifacts.

A registry-unavailable check requires `state: "not-run"`, `executable: null`, and empty streams.
It cannot accept `/usr/bin/true`, `node --version`, a PATH substitute, or any other caller-selected
command. Performance contracts pin scale, profile, repetitions, warmups, and metric identity.
When a real verifier becomes available, its result must additionally bind the resolved child
executable's canonical path, byte hash, and version and validate a strict output envelope.

Traversal, symlink escape, artifact reuse, hash mismatch, malformed process state, future or stale
timestamps, contract drift, dirty subjects, wrong cwd role, repository mismatch, and gitlink
mismatch fail closed. The caller supplies `--as-of`; freshness ends exactly 168 hours after
completion.

Measurements are evidence inventory, never checks. They cannot contribute weight, satisfy
`performance-resources` or `concurrency`, change the integrity threshold, or become qualification
evidence. The score reports the measurement only as `observed`, `failed`, or freshness-derived
`stale`, always with `claimEligible: false`.

The scorer validates the mixed tracer's raw report rather than trusting a caller-authored pass
wrapper. It fixes the four-session topology, 80-read/20-write timed ledger, 88-read/24-write full
run, 25-wave schedule, generation-six golden heads, exact provenance, graceful reopen result,
storage phases, and non-claims. Runtime identity and the checked-out tracer hash must match the
outer capture. Missing, duplicate, extra, relabeled, stale, reused, or tampered artifacts fail
closed or remain visibly non-scoring as appropriate.

## Capture and score

Keep evidence outside both repositories. The registry exposes two exact Working Graph commands and
marks the other 35 semantic verifiers unavailable. Unavailable capture writes honest local
`not-run` descriptors and refuses substitute argv before resolution or spawn:

```sh
pnpm readiness:capture -- \
  --name=inspect \
  --output-directory=/absolute/path/readiness-evidence \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse \
  --cwd=/absolute/path/attunegraph --
```

Capture never replaces an existing check directory. Assemble exactly one descriptor per fixed
check with a shared subject, then score without mutation:

Capture the one measurement separately under the same private evidence root. Its fixed child
gets a 30-second watchdog, 2 MiB stdout and 64 KiB stderr ceilings, and a minimal environment; the
repositories must remain clean and byte-identical throughout:

```sh
pnpm readiness:capture-measurement -- \
  --name=mixed-durable-agent-decision-observation \
  --output-directory=/absolute/path/readiness-evidence \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse \
  --cwd=/absolute/path/attunegraph -- \
  node scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs
```

Use the returned descriptor as the sole `measurements` entry of the evidence manifest. Evidence may expose
runtime and platform identity; keep local bundles private unless that host metadata is intended for
publication.

```sh
pnpm readiness:score -- \
  --as-of=2026-07-31T00:00:00.000Z \
  --evidence=/absolute/path/readiness-evidence/readiness-evidence.json \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse
```

The score output says `authenticity: "unattested"` and `eligible: false`. A successful measurement
does not turn any unavailable performance check into a pass. A nonzero exit means even structural
integrity could not be established.

## Attested producer boundary

CI runs the contract tests on Node 24.15 for Ubuntu and Windows and issues GitHub build provenance
for the producer-contract bundle. The bundle includes the fixed check and measurement registries,
both bounded capture entrypoints, and the scorer. That attestation proves only which producer bytes
CI bundled. It does not attest 37 executions and does not change local authenticity.

The intended qualification producer is a public GitHub Actions run that checks out exact clean
AttuneGraph and Muse subjects, verifies the gitlink, executes only available fixed commands,
bundles immutable artifacts, and issues a GitHub artifact attestation. The scorer currently has no
live cryptographic verifier and rejects self-declared attested provenance. Eligibility must remain
closed until a verifier validates the public attestation, bundle digest, workflow identity,
repository, ref, and exact subject SHAs. Issuance and verification are separate trust boundaries.

## Pre-release artifact reset

Development-only artifacts produced before the canonical `@1` contract are not upgradeable.
Re-capture against clean exact subjects; never relabel a schema string, copy a pass, reuse an
artifact path, or synthesize measurement output. Until fixed semantic verifiers and cryptographic
verification exist, no eligible readiness claim is available.
