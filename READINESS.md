# AttuneGraph readiness integrity

AttuneGraph reports fail-closed readiness integrity for one clean AttuneGraph revision and its
exact Muse consumer pin. Local artifacts are explicitly unattested: they do not prove who executed
a command and can never make a revision qualification-eligible. This report does not score product
usefulness, personal attunement, or user delight.

## Gates

| Gate | Weight | Required checks |
| --- | ---: | --- |
| Independent clean room | 15 | install, build, test, example, pack, consumer install |
| Muse integration | 20 | exact submodule pin, narrow public port, no copied Engine, durable v2 path |
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
artifacts and cannot be reused or relabeled. Those registry entries remain unavailable until a
fixed adapter emits one strict, distinct output envelope per check. The corpus result is never
organic usefulness evidence.

## Evidence v2

`attunegraph-readiness-evidence@2` contains the clean exact AttuneGraph and Muse commit/tree
subject plus 37 `{ name, gate, result }` descriptors. Each result binds the name to one versioned
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

## Capture and score

Keep evidence outside both repositories. The current registry deliberately marks all 37 semantic
verifiers unavailable, so capture writes honest local `not-run` descriptors and refuses substitute
argv before resolution or spawn:

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

```sh
pnpm readiness:score -- \
  --as-of=2026-07-31T00:00:00.000Z \
  --evidence=/absolute/path/readiness-evidence/readiness-evidence.json \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse
```

The score output says `authenticity: "unattested"` and `eligible: false`. A nonzero exit means
even structural integrity could not be established.

## Attested producer boundary

CI runs the contract tests on Node 24.15 for Ubuntu and Windows and issues GitHub build provenance
for the versioned producer-contract bundle. That attestation proves only which producer bytes CI
bundled. It does not attest 37 executions and does not change local authenticity.

The intended qualification producer is a public GitHub Actions run that checks out exact clean
AttuneGraph and Muse subjects, verifies the gitlink, executes only available fixed commands,
bundles immutable artifacts, and issues a GitHub artifact attestation. The scorer currently has no
live cryptographic verifier and rejects self-declared attested provenance. Eligibility must remain
closed until a verifier validates the public attestation, bundle digest, workflow identity,
repository, ref, and exact subject SHAs. Issuance and verification are separate trust boundaries.

## Migration from v1

V1 restated caller-supplied metadata and cannot be upgraded. Re-capture against clean exact
subjects. Never copy a v1 pass, reuse an artifact path, or treat local/synthetic fixtures as
qualification evidence. Until fixed semantic verifiers and cryptographic verification exist, no
eligible v2 claim is available.
