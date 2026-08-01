# AttuneGraph readiness integrity

AttuneGraph readiness answers one narrow question:

> Can a clean AttuneGraph revision and the exact consumer that pins it produce
> structurally valid, bounded, non-substituted evidence for the fixed gates?

It does **not** score product usefulness, personal attunement, or user delight.
Local evidence is explicitly unattested and can never become qualification-
eligible merely by passing every available command.

## Profiles

| Profile | Status | Subject | Integration gate | CLI family |
| --- | --- | --- | --- | --- |
| `attunegraph-readiness-evidence@2` | Recommended | `attunegraph` + `consumer` | `consumer-integration` | `--consumer-*` |
| `attunegraph-readiness-evidence@1` | Frozen compatibility | `attunegraph` + historical Muse-shaped consumer | `muse-integration` | `--muse-*` |

V2 is an additive host-neutral profile. It does not relabel, reinterpret, or
upgrade V1 bytes. A producer/scorer invocation must select exactly one profile;
mixed schema, subject, descriptor, gate, cwd-role, or argument families fail
closed. Unknown future schemas are rejected.

The V2 subject is deliberately small:

```json
{
  "attunegraph": { "clean": true, "sha": "<git-sha>", "tree": "<tree-sha>" },
  "consumer": {
    "clean": true,
    "sha": "<git-sha>",
    "tree": "<tree-sha>",
    "attunegraphGitlink": {
      "path": "vendor/attunegraph",
      "sha": "<same-attunegraph-git-sha>"
    }
  }
}
```

The exact Gitlink profile is intentional. Other dependency-integrity profiles
may be versioned later; V2 does not pretend a package lockfile is a Gitlink.

## V2 gates

| Gate | Weight | Required checks |
| --- | ---: | --- |
| Independent clean room | 15 | install, build, test, example, pack, consumer install |
| Consumer integration | 20 | exact submodule pin, narrow public port, no copied engine, durable `canonical-projection@2` path |
| Semantic safety | 20 | conformance, adversarial, property, fault, authority fail-closed |
| Persistence and portability | 10 | SQLite crash/CAS, `.atgx` streaming round trip |
| Retrieval quality | 10 | Working Graph golden corpus, abstention |
| Performance and resources | 15 | 10K/100K/1M corpora, latency, throughput, RSS, SQLite open, concurrency, portable encode/decode |
| Operability | 5 | inspect, verify, diagnose, zero hidden mutation |
| Public adoption | 5 | API reference, migration notes, independent example |

The 37 check names are fixed. A gate contributes its full weight only when all
of its checks pass. Structural integrity requires a score of at least 90 plus
passing consumer integration, semantic safety, and persistence/portability.
Eligibility is separate; `local-unattested` always returns `eligible: false`.

`pnpm verify:working-graph-golden` is verifier substrate for two distinct
checks. One stdout report cannot be reused or relabeled as both. The fixed
adapter emits one strict envelope per check; a golden-corpus result is never
organic usefulness evidence.

## Evidence model

V2 contains the clean exact AttuneGraph/consumer commit and tree subject,
37 `{ name, gate, result }` descriptors, and exactly one descriptor from the
separate unscored measurement registry:
`mixed-durable-agent-decision-observation`.

Every descriptor binds:

- one fixed check or measurement contract;
- canonical repository cwd role;
- fixed argv and parameters;
- process outcome and strict output semantics;
- capture toolchain and subject identities;
- unique content-hashed stdout/stderr artifacts;
- timestamps with an exact 168-hour freshness boundary.

Unavailable checks are honest `not-run` results with `executable: null` and
empty streams. They cannot be replaced with `/usr/bin/true`, `node --version`,
a PATH substitute, or caller-selected argv.

Traversal, symlink escape, artifact reuse, hash mismatch, malformed process
state, stale/future timestamps, contract drift, dirty subjects, wrong cwd,
repository mismatch, Gitlink mismatch, and subject changes during capture fail
closed.

Measurements are inventory, not checks. They cannot contribute weight, satisfy
`performance-resources` or `concurrency`, alter the threshold, or become
qualification evidence. The score exposes them only as `observed`, `failed`,
or `stale`, always with `claimEligible: false`.

The raw command-output, measurement-contract, and mixed-durable tracer schemas
remain host-neutral `@1` contracts. Check contracts and the capture, result,
provenance, evidence, and score envelopes advance together where consumer gate,
cwd-role, producer identity, or subject semantics differ.

## Capture and score V2

Keep evidence outside both repositories. V2 selection is explicit and requires
only the consumer argument family.

Capture one fixed check:

```sh
pnpm readiness:capture -- \
  --evidence-schema=attunegraph-readiness-evidence@2 \
  --name=inspect \
  --output-directory=/absolute/path/readiness-evidence \
  --attunegraph-repository=/absolute/path/attunegraph \
  --consumer-repository=/absolute/path/consumer \
  --consumer-gitlink=vendor/attunegraph \
  --cwd=/absolute/path/attunegraph --
```

Capture the one measurement under the same private evidence root. Its fixed
child has a 30-second watchdog, 2 MiB stdout and 64 KiB stderr ceilings, and a
minimal environment. Both repositories must stay clean and byte-identical:

```sh
pnpm readiness:capture-measurement -- \
  --evidence-schema=attunegraph-readiness-evidence@2 \
  --name=mixed-durable-agent-decision-observation \
  --output-directory=/absolute/path/readiness-evidence \
  --attunegraph-repository=/absolute/path/attunegraph \
  --consumer-repository=/absolute/path/consumer \
  --consumer-gitlink=vendor/attunegraph \
  --cwd=/absolute/path/attunegraph -- \
  node scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs
```

Use the returned descriptor as the sole `measurements` entry, assemble exactly
one descriptor per check with the same subject, then score without mutation:

```sh
pnpm readiness:score -- \
  --evidence-schema=attunegraph-readiness-evidence@2 \
  --as-of=2026-07-31T00:00:00.000Z \
  --evidence=/absolute/path/readiness-evidence/readiness-evidence.json \
  --attunegraph-repository=/absolute/path/attunegraph \
  --consumer-repository=/absolute/path/consumer \
  --consumer-gitlink=vendor/attunegraph
```

The output remains `authenticity: "unattested"` and `eligible: false`. A
successful measurement does not turn an unavailable performance check into a
pass. A nonzero exit means structural integrity was not established.

V1 parsers remain available only for already versioned evidence and their exact
historical `--muse-repository`/default Gitlink contract. New integrations should
not produce V1 evidence.

## Attested producer boundary

CI runs producer-contract tests on Node 24.15 for Ubuntu and Windows and issues
GitHub build provenance for the producer bundle. The bundle contains the fixed
registries, bounded capture entrypoints, and scorer. That attests producer bytes,
not the 37 executions, and does not change local authenticity.

A future qualification producer must check out exact clean AttuneGraph and
consumer subjects, verify the Gitlink, execute only registered commands, bundle
immutable artifacts, and issue a verifiable public attestation. The current
scorer has no live cryptographic verifier and rejects self-declared attested
provenance. Eligibility stays closed until bundle digest, workflow identity,
repository, ref, and exact subject SHAs are independently verified.

## Pre-release artifact reset

Artifacts produced under a different profile are not upgradeable. Re-capture
against clean exact subjects. Never relabel a schema string, copy a pass, reuse
an artifact path, or synthesize measurement output.
