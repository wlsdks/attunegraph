# Source adapter SDK

`@attunegraph/core/source-adapter` is the zero-dependency boundary between a
host's source extraction and AttuneGraph projection. It is intentionally not a
document parser, connector framework, crawler, OCR system, or LLM pipeline.

The host remains authoritative for bytes, credentials, parsing, model calls,
and source-specific permissions. An adapter receives one host-owned typed value
and returns only bounded graph assertions with exact `GraphEvidenceRef`s. The
SDK validates those assertions, builds `canonical-projection@2`, and submits one
`projectAgainstHead` call. It never stores or returns the host input.

## Define and project

```ts
import type { GraphAssertion } from "@attunegraph/core";
import {
  defineAttuneGraphSourceAdapter,
  projectAttuneGraphSource
} from "@attunegraph/core/source-adapter";

type ParsedMarkdown = {
  artifactId: string;
  anchor: string;
  sourceVersion: string;
};

const markdown = defineAttuneGraphSourceAdapter<
  ParsedMarkdown,
  readonly ["markdown"]
>({
  metadata: {
    id: "acme.markdown",
    label: "Acme Markdown",
    version: "1.0.0"
  },
  capabilities: {
    sourceKinds: ["markdown"],
    maxAssertionsPerExtraction: 32,
    supportsIncremental: true
  },
  extract: (input, context) => ({
    assertions: [{
      schemaVersion: 1,
      id: `assertion:${input.artifactId}`,
      subject: { kind: "artifact", id: input.artifactId },
      predicate: "LINKED_TO",
      object: context.threadRoot,
      epistemicClass: "source-observed",
      sourceRefs: [{
        namespace: "acme.markdown",
        id: input.anchor,
        version: input.sourceVersion
      }],
      recordedAt: context.observedAt,
      derivation: { kind: "projection", version: "acme.markdown@1" }
    } satisfies GraphAssertion]
  })
});

const result = await projectAttuneGraphSource({
  adapter: markdown,
  attuneGraph,
  correlationKey: "Projects/Launch.md@sha256:host-owned",
  input: hostParsedMarkdown,
  scope: { sourceId: "acme.notes", threadId: "launch" },
  threadRoot: { kind: "thread", id: "thread:launch" },
  observedAt: "2026-08-01T00:00:00.000Z",
  sourceFreshness: {
    state: "fresh",
    observedAt: "2026-08-01T00:00:00.000Z"
  },
  sourceKind: "markdown"
});
```

The SDK content-binds adapter `id`, adapter `version`, `sourceKind`, and the
caller correlation key into the observation key. Two adapters or source kinds
therefore cannot silently share an observation identity domain. The adapter
context is frozen before extraction. `sourceFreshness` is explicitly declared
by the caller; AttuneGraph does not independently verify it.

`buildAttuneGraphSourceObservation` performs the same bounded extraction and
returns the detached v2 observation without projecting it. This is useful for a
host-owned review or queue. The returned observation contains assertions and
evidence references only, never the generic extraction input.

## Ownership boundary

| Host or adapter owns | AttuneGraph SDK owns |
| --- | --- |
| Reading MD/TXT/PDF/XLSX bytes | Strict adapter, request, and assertion validation |
| Notion/Obsidian/API credentials and permissions | Bounded metadata and capability projection |
| OCR, parsers, table extraction, and optional LLM calls | Adapter/version/kind-bound observation identity |
| Resolving source-specific anchors and revisions | Canonical v2 observation construction |
| Retention and deletion of authoritative source bytes | One `projectAgainstHead` submission, without write retry |

The adapter's `maxAssertionsPerExtraction` is both declared and enforced, with
a hard SDK ceiling of 1,024. Source kinds are unique bounded strings, metadata
is fixed-field and bounded, and every assertion still passes AttuneGraph's
normal source-reference, epistemic, temporal, endpoint, and connectivity rules
before Store I/O.

## Evidence anchor recipes

These are host conventions, not universal locator standards. Pick one scheme,
version it, and make it deterministic enough for the host to resolve the same
authoritative evidence again. Always bind mutable coordinates to a source
revision or digest in `GraphEvidenceRef.version`.

### Markdown and plain text

- Namespace: a host-owned domain such as `acme.files`.
- ID: `Projects/Launch.md#line=12-18` or `notes.txt#line=40-44`.
- Version: a content digest, immutable revision ID, or exact repository commit.

Line anchors are meaningful only with their version. The host parses the text
and decides line semantics; the SDK receives only the parsed record.

### PDF

- Namespace: a host-owned domain such as `acme.pdf`.
- ID: `manual.pdf#page=17` or a host-defined page plus bounding-box anchor.
- Version: the PDF digest or immutable document revision.

Page numbering, OCR, text coordinates, and tagged-PDF structure are parser
concerns. AttuneGraph does not read the PDF or claim that page coordinates are
portable between different PDF revisions.

### Spreadsheets

- Namespace: `acme.sheets` or another provider-specific host namespace.
- ID: `<spreadsheet-id>/<sheet-id>#range=Sheet1!A1:D8`.
- Version: an immutable export digest or provider revision captured by the host.

For Google Sheets, the official API documentation defines spreadsheet IDs,
numeric sheet IDs, and [A1 range notation](https://developers.google.com/workspace/sheets/api/guides/concepts).
Other spreadsheet hosts can use the same shape only if their adapter defines
equivalent resolution semantics. AttuneGraph does not open XLSX files.

### Obsidian vaults

- Namespace: `acme.obsidian`.
- ID: `<vault-id>/Projects/Launch.md#line=12-18`.
- Version: a file digest or repository commit.

Use a vault-relative normalized path, not a machine-specific absolute path.
The host owns vault discovery and file access; see Obsidian's official
[vault documentation](https://obsidian.md/help/vault).

### Notion pages and blocks

- Namespace: `acme.notion`.
- ID: `page/<page-id>/block/<block-id>`.
- Version: a host-captured immutable digest or revision token.

Notion exposes page and block identifiers, and page content is retrieved as
blocks. Use the exact IDs returned to the host integration; do not persist
temporary file URLs as evidence identity. See the official Notion
[Block reference](https://developers.notion.com/reference/block) and
[page-content guide](https://developers.notion.com/guides/data-apis/working-with-page-content).

## Failure and safety semantics

- Invalid adapter definitions fail before registration.
- Invalid requests, unsupported source kinds, and missing graph capabilities
  fail before adapter extraction.
- Invalid or over-budget extraction fails before graph or Store I/O.
- Adapter exceptions become `EXTRACTION_FAILED` with the original cause.
- AttuneGraph errors, including `SNAPSHOT_CONFLICT`, remain unchanged.
- The SDK does not retry extraction or graph writes.

See [`examples/source-adapter-agent.mjs`](examples/source-adapter-agent.mjs) for
a runnable host-neutral consumer.
