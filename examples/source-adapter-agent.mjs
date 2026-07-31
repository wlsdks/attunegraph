import { openAttuneGraph } from "@attunegraph/core";
import {
  defineAttuneGraphSourceAdapter,
  projectAttuneGraphSource
} from "@attunegraph/core/source-adapter";
import { createInMemoryAttuneGraphStore } from "@attunegraph/core/testing";

const scope = { sourceId: "acme.agent.notes", threadId: "launch-plan" };
const threadRoot = { id: "thread:launch-plan", kind: "thread" };
const observedAt = "2026-08-01T00:00:00.000Z";

// A host parser produced this record. AttuneGraph never receives the Markdown
// bytes and does not choose a parser or model.
const hostExtraction = {
  artifactId: "artifact:notes/launch.md",
  sourceAnchor: "notes/launch.md#line=12-18",
  sourceVersion: "sha256:2a6b-host-owned"
};

const markdown = defineAttuneGraphSourceAdapter({
  capabilities: {
    maxAssertionsPerExtraction: 16,
    sourceKinds: ["markdown"],
    supportsIncremental: true
  },
  extract: (input, context) => ({
    assertions: [{
      derivation: { kind: "projection", version: "acme.markdown@1" },
      epistemicClass: "source-observed",
      id: "assertion:launch-note-linked",
      object: context.threadRoot,
      predicate: "LINKED_TO",
      recordedAt: context.observedAt,
      schemaVersion: 1,
      sourceRefs: [{
        id: input.sourceAnchor,
        namespace: "acme.markdown",
        version: input.sourceVersion
      }],
      subject: { id: input.artifactId, kind: "artifact" }
    }]
  }),
  metadata: {
    id: "acme.markdown",
    label: "Acme Markdown",
    version: "1.0.0"
  }
});

const graph = await openAttuneGraph({
  scope,
  store: createInMemoryAttuneGraphStore()
});

try {
  const projected = await projectAttuneGraphSource({
    adapter: markdown,
    attuneGraph: graph,
    correlationKey: "notes/launch.md@sha256:2a6b-host-owned",
    input: hostExtraction,
    observedAt,
    scope,
    sourceFreshness: { state: "fresh", observedAt },
    sourceKind: "markdown",
    threadRoot
  });
  console.log(JSON.stringify({
    adapter: markdown.metadata,
    observationKey: projected.observation.observationKey,
    snapshot: projected.snapshot
  }, null, 2));
} finally {
  await graph.close();
}
