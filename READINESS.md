# AttuneGraph readiness evidence

AttuneGraph uses a fail-closed evidence-coverage score. The score answers
whether a specific clean AttuneGraph revision and its exact Muse consumer pin
have fresh evidence for the declared engineering contracts. It does not score
product usefulness, personal attunement, or user delight.

## Gates

| Gate | Weight | Required evidence |
| --- | ---: | --- |
| Independent clean room | 15 | install, build, test, example, pack, consumer install |
| Muse integration | 20 | exact submodule pin, narrow public port, no copied Engine, durable v2 path |
| Semantic safety | 20 | conformance, adversarial, property, fault, authority fail-closed |
| Persistence and portability | 10 | SQLite crash/CAS, `.atgx` streaming round trip |
| Retrieval quality | 10 | Working Graph golden corpus, abstention |
| Performance and resources | 15 | 10K/100K/1M corpora, latency, throughput, RSS, cold/warm SQLite open, concurrency, portable encode/decode |
| Operability | 5 | inspect, verify, diagnose, zero hidden mutation |
| Public adoption | 5 | API reference, migration notes, independent example |

All 37 check names are fixed by `attunegraph-readiness-evidence@1`; umbrella or
unknown names are rejected. A gate contributes its full weight only when every
check in that gate passes. `fail`, `not-run`, or stale evidence contributes zero.

`eligible: true` additionally requires a score of at least 90 and passing Muse
integration, semantic safety, and persistence/portability. Semantic safety
always includes `authority-fail-closed`.

## Revision and artifact binding

The evidence manifest names clean, exact 40-hex Git commit and tree identities
for AttuneGraph and Muse. The declared Muse gitlink must equal the AttuneGraph
commit. Each check points to a different regular, non-symlink JSON artifact
inside the evidence directory. Its SHA-256 and strict
`attunegraph-readiness-check@1` content must match the check's name, gate,
command, exit code, state, timestamp, subject, and toolchain digest exactly.

The scorer never reads the wall clock. The caller supplies `--as-of`; evidence
is valid through exactly 168 hours and stale after that boundary. Future
timestamps, dirty or mismatched repositories, path escapes, symlink escapes,
hash mismatches, unknown fields, duplicate checks, and malformed artifacts are
hard errors rather than zero-point results.

## Run the scorer

```sh
pnpm readiness:score -- \
  --as-of=2026-07-31T00:00:00.000Z \
  --evidence=/absolute/path/readiness-evidence.json \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse
```

The command writes the score JSON to stdout and never mutates either repository
or the evidence set. A nonzero exit means the evidence cannot be trusted; it is
not converted into a partial readiness claim.
