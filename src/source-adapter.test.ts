import { describe, expect, it, vi } from "vitest";

import { openAttuneGraph } from "./attunegraph-engine.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import { createInMemoryAttuneGraphStore } from "./attunegraph-in-memory-store.js";
import type { AttuneGraph, AttuneGraphScope } from "./attunegraph-contracts.js";
import {
  AttuneGraphSourceAdapterError,
  buildAttuneGraphSourceObservation,
  defineAttuneGraphSourceAdapter,
  projectAttuneGraphSource,
  type AttuneGraphSourceExtractionContext
} from "./source-adapter.js";
import type { GraphAssertion, GraphRef } from "./types.js";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:00:01.000Z";
const SCOPE: AttuneGraphScope = {
  sourceId: "external.notes",
  threadId: "thread-source-adapter"
};
const THREAD_ROOT: GraphRef = {
  id: "thread:source-adapter",
  kind: "thread"
};

interface HostMarkdownExtraction {
  readonly anchor: string;
  readonly artifactId: string;
  readonly rawText: string;
}

function assertion(
  context: AttuneGraphSourceExtractionContext,
  input: Readonly<{ readonly anchor: string; readonly artifactId: string }>,
  suffix = "one"
): GraphAssertion {
  return {
    derivation: {
      kind: "projection",
      version: "example.markdown@1"
    },
    epistemicClass: "source-observed",
    id: `assertion:markdown:${suffix}`,
    object: context.threadRoot,
    predicate: "LINKED_TO",
    recordedAt: context.observedAt,
    schemaVersion: 1,
    sourceRefs: [{
      id: input.anchor,
      namespace: "example.markdown",
      version: "sha256:host-owned"
    }],
    subject: {
      id: input.artifactId,
      kind: "artifact"
    }
  };
}

function markdownAdapter(maxAssertionsPerExtraction = 8) {
  return defineAttuneGraphSourceAdapter<
    HostMarkdownExtraction,
    readonly ["markdown", "obsidian-markdown"]
  >({
    capabilities: {
      maxAssertionsPerExtraction,
      sourceKinds: ["markdown", "obsidian-markdown"],
      supportsIncremental: true
    },
    extract: (input, context) => ({
      assertions: [assertion(context, input)]
    }),
    metadata: {
      id: "example.markdown",
      label: "Example Markdown",
      version: "1.0.0"
    }
  });
}

function input(adapter = markdownAdapter()) {
  return {
    adapter,
    correlationKey: "notes/plan.md@sha256:host-owned",
    input: {
      anchor: "notes/plan.md#line=4-8",
      artifactId: "artifact:notes/plan.md",
      rawText: "authoritative bytes stay with the host"
    },
    observedAt: NOW,
    scope: SCOPE,
    sourceFreshness: {
      observedAt: NOW,
      state: "fresh" as const
    },
    sourceKind: "markdown" as const,
    threadRoot: THREAD_ROOT
  };
}

describe("source adapter definition", () => {
  it("creates a frozen typed capability with bounded public metadata", () => {
    const adapter = markdownAdapter();

    expect(adapter).toMatchObject({
      capabilities: {
        maxAssertionsPerExtraction: 8,
        sourceKinds: ["markdown", "obsidian-markdown"],
        supportsIncremental: true
      },
      metadata: {
        id: "example.markdown",
        label: "Example Markdown",
        version: "1.0.0"
      }
    });
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities.sourceKinds)).toBe(true);
    expect(Object.isFrozen(adapter.metadata)).toBe(true);
    expect(adapter).not.toHaveProperty("extract");
  });

  it("rejects hostile and over-budget definitions without invoking accessors", () => {
    let accessed = 0;
    const accessor = {
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"],
        supportsIncremental: false
      },
      metadata: {
        id: "hostile.markdown",
        label: "Hostile",
        version: "1"
      }
    };
    Object.defineProperty(accessor, "extract", {
      enumerable: true,
      get: () => {
        accessed += 1;
        return () => ({ assertions: [] });
      }
    });

    expect(() => defineAttuneGraphSourceAdapter(accessor as never)).toThrow(
      expect.objectContaining({ code: "INVALID_DEFINITION" })
    );
    expect(accessed).toBe(0);
    expect(() => defineAttuneGraphSourceAdapter({
      capabilities: {
        maxAssertionsPerExtraction: 1_025,
        sourceKinds: ["markdown"],
        supportsIncremental: false
      },
      extract: () => ({ assertions: [] }),
      metadata: {
        id: "too.large",
        label: "Too large",
        version: "1"
      }
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(() => defineAttuneGraphSourceAdapter(new Proxy({
      capabilities: {},
      extract: () => ({ assertions: [] }),
      metadata: {}
    }, {}) as never)).toThrow(expect.objectContaining({
      code: "INVALID_DEFINITION"
    }));
  });
});

describe("source observation building", () => {
  it("passes host-owned input once and retains only bounded canonical evidence", async () => {
    const extract = vi.fn((
      hostInput: HostMarkdownExtraction,
      context: AttuneGraphSourceExtractionContext<"markdown">
    ) => ({ assertions: [assertion(context, hostInput)] }));
    const adapter = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 4,
        sourceKinds: ["markdown"],
        supportsIncremental: false
      },
      extract,
      metadata: {
        id: "example.markdown.once",
        label: "Markdown once",
        version: "1"
      }
    });
    const request = input(adapter);

    const observation = await buildAttuneGraphSourceObservation(request);

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]?.[0]).toBe(request.input);
    expect(Object.isFrozen(extract.mock.calls[0]?.[1])).toBe(true);
    expect(observation).toMatchObject({
      observationKey: "attunegraph-source-adapter@1:[\"example.markdown.once\",\"1\",\"markdown\",\"notes/plan.md@sha256:host-owned\"]",
      observedAt: NOW,
      schemaVersion: 2,
      scope: SCOPE,
      sourceFreshness: request.sourceFreshness,
      threadRoot: THREAD_ROOT
    });
    expect(observation.assertions[0]?.sourceRefs).toEqual([{
      id: request.input.anchor,
      namespace: "example.markdown",
      version: "sha256:host-owned"
    }]);
    expect(JSON.stringify(observation)).not.toContain(request.input.rawText);
    expect(observation.scope).not.toBe(request.scope);
    expect(observation.threadRoot).not.toBe(request.threadRoot);
    expect([
      observation,
      observation.assertions,
      observation.assertions[0],
      observation.assertions[0]?.derivation,
      observation.assertions[0]?.object,
      observation.assertions[0]?.sourceRefs,
      observation.assertions[0]?.sourceRefs[0],
      observation.assertions[0]?.subject,
      observation.scope,
      observation.sourceFreshness,
      observation.threadRoot
    ].every(Object.isFrozen)).toBe(true);
    expect(() => {
      (observation.assertions[0]?.sourceRefs[0] as { id: string }).id = "tampered";
    }).toThrow(TypeError);
    expect(observation.assertions[0]?.sourceRefs[0]?.id).toBe(request.input.anchor);
  });

  it("content-binds adapter identity, version, and source kind", async () => {
    const firstAdapter = markdownAdapter();
    const nextVersion = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 8,
        sourceKinds: ["markdown"],
        supportsIncremental: true
      },
      extract: (hostInput, context) => ({
        assertions: [assertion(context, hostInput)]
      }),
      metadata: {
        id: "example.markdown",
        label: "Example Markdown",
        version: "2.0.0"
      }
    });
    const markdown = await buildAttuneGraphSourceObservation(input(firstAdapter));
    const obsidian = await buildAttuneGraphSourceObservation({
      ...input(firstAdapter),
      sourceKind: "obsidian-markdown"
    });
    const versionTwo = await buildAttuneGraphSourceObservation(input(nextVersion));

    expect(new Set([
      markdown.observationKey,
      obsidian.observationKey,
      versionTwo.observationKey
    ]).size).toBe(3);
    expect(markdown.observationKey).toContain("example.markdown");
    expect(obsidian.observationKey).toContain("obsidian-markdown");
    expect(versionTwo.observationKey).toContain("2.0.0");
  });

  it("rejects invalid operation structure before adapter extraction", async () => {
    const extract = vi.fn(() => ({ assertions: [] }));
    const adapter = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract,
      metadata: {
        id: "example.preflight",
        label: "Preflight",
        version: "1"
      }
    });
    let accessed = 0;
    const hostile = input(adapter);
    Object.defineProperty(hostile, "scope", {
      enumerable: true,
      get: () => {
        accessed += 1;
        return SCOPE;
      }
    });

    await expect(buildAttuneGraphSourceObservation(hostile)).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    await expect(buildAttuneGraphSourceObservation({
      ...input(adapter),
      observedAt: "not-an-instant"
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(buildAttuneGraphSourceObservation({
      ...input(adapter),
      sourceKind: "pdf"
    } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(accessed).toBe(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects invalid or over-budget extraction before graph I/O", async () => {
    const invalid = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract: () => ({
        assertions: [{
          ...assertion({
            adapter: markdownAdapter().metadata,
            observedAt: NOW,
            scope: SCOPE,
            sourceFreshness: { observedAt: NOW, state: "fresh" },
            sourceKind: "markdown",
            threadRoot: THREAD_ROOT
          }, input().input),
          sourceRefs: []
        }]
      }),
      metadata: {
        id: "example.invalid-extraction",
        label: "Invalid extraction",
        version: "1"
      }
    });
    const overBudget = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract: (_hostInput, context) => ({
        assertions: [
          assertion(context, input().input, "one"),
          assertion(context, input().input, "two")
        ]
      }),
      metadata: {
        id: "example.over-budget",
        label: "Over budget",
        version: "1"
      }
    });
    const projectAgainstHead = vi.fn();
    const graph = { projectAgainstHead } as unknown as AttuneGraph;

    await expect(projectAttuneGraphSource({
      ...input(invalid),
      attuneGraph: graph
    })).rejects.toMatchObject({ code: "INVALID_EXTRACTION" });
    await expect(projectAttuneGraphSource({
      ...input(overBudget),
      attuneGraph: graph
    })).rejects.toMatchObject({ code: "INVALID_EXTRACTION" });
    expect(projectAgainstHead).not.toHaveBeenCalled();
  });

  it.each([
    "assertion",
    "derivation",
    "object",
    "sourceRef",
    "subject"
  ] as const)("rejects a nested %s Proxy before invoking reflection traps", async (position) => {
    let traps = 0;
    const hostile = <Value extends object>(value: Value): Value => new Proxy(value, {
      get() {
        traps += 1;
        throw new Error("get trap must not run");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("descriptor trap must not run");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("prototype trap must not run");
      },
      ownKeys() {
        traps += 1;
        throw new Error("ownKeys trap must not run");
      }
    });
    const adapter = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract: (hostInput, context) => {
        const emitted = assertion(context, hostInput);
        if (position === "assertion") return { assertions: [hostile(emitted)] };
        return { assertions: [{
          ...emitted,
          derivation: position === "derivation"
            ? hostile(emitted.derivation)
            : emitted.derivation,
          object: position === "object" ? hostile(emitted.object) : emitted.object,
          sourceRefs: position === "sourceRef"
            ? [hostile(emitted.sourceRefs[0]!)]
            : emitted.sourceRefs,
          subject: position === "subject" ? hostile(emitted.subject) : emitted.subject
        }] };
      },
      metadata: {
        id: `example.proxy-${position === "sourceRef" ? "source-ref" : position}`,
        label: `Proxy ${position}`,
        version: "1"
      }
    });

    await expect(buildAttuneGraphSourceObservation(input(adapter))).rejects.toMatchObject({
      code: "INVALID_EXTRACTION"
    });
    expect(traps).toBe(0);
  });

  it("wraps adapter failures without converting graph failures", async () => {
    const extractionCause = new Error("host parser failed");
    const adapter = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract: () => Promise.reject(extractionCause),
      metadata: {
        id: "example.failure",
        label: "Failure",
        version: "1"
      }
    });
    const graphFailure = new AttuneGraphError(
      "SNAPSHOT_CONFLICT",
      "concurrent winner"
    );
    const graph = {
      projectAgainstHead: vi.fn(() => Promise.reject(graphFailure))
    } as unknown as AttuneGraph;

    await expect(buildAttuneGraphSourceObservation(input(adapter))).rejects.toSatisfy(
      (cause: unknown) => cause instanceof AttuneGraphSourceAdapterError
        && cause.code === "EXTRACTION_FAILED"
        && cause.cause === extractionCause
    );
    await expect(projectAttuneGraphSource({
      ...input(),
      attuneGraph: graph
    })).rejects.toBe(graphFailure);
  });

  it("wraps source-adapter-shaped extractor errors as untrusted callback failures", async () => {
    const spoofed = new AttuneGraphSourceAdapterError(
      "INVALID_INPUT",
      "host attempted to spoof an SDK error"
    );
    const adapter = defineAttuneGraphSourceAdapter<
      HostMarkdownExtraction,
      readonly ["markdown"]
    >({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["markdown"] as const,
        supportsIncremental: false
      },
      extract: () => Promise.reject(spoofed),
      metadata: {
        id: "example.error-spoof",
        label: "Error spoof",
        version: "1"
      }
    });

    await expect(buildAttuneGraphSourceObservation(input(adapter))).rejects.toSatisfy(
      (cause: unknown) => cause instanceof AttuneGraphSourceAdapterError
        && cause !== spoofed
        && cause.code === "EXTRACTION_FAILED"
        && cause.cause === spoofed
    );
  });
});

describe("source projection", () => {
  it("projects canonical-projection@2 through projectAgainstHead", async () => {
    const attuneGraph = await openAttuneGraph({
      scope: SCOPE,
      store: createInMemoryAttuneGraphStore()
    });

    try {
      const first = await projectAttuneGraphSource({
        ...input(),
        attuneGraph
      });
      const second = await projectAttuneGraphSource({
        ...input(),
        attuneGraph,
        input: {
          ...input().input,
          anchor: "notes/plan.md#line=10-12"
        },
        correlationKey: "notes/plan.md@sha256:next",
        observedAt: LATER,
        sourceFreshness: {
          observedAt: LATER,
          state: "fresh"
        }
      });

      expect(first.snapshot.generation).toBe(1);
      expect(second.snapshot.generation).toBe(2);
      expect(second.observation.schemaVersion).toBe(2);
      expect(Object.isFrozen(second.observation)).toBe(true);
      expect(Object.isFrozen(second.observation.assertions[0])).toBe(true);
      expect(() => {
        (second.observation.assertions[0] as { id: string }).id = "tampered";
      }).toThrow(TypeError);
      await expect(attuneGraph.head()).resolves.toEqual(second.snapshot);
    } finally {
      await attuneGraph.close();
    }
  });

  it("validates graph capability before invoking the adapter", async () => {
    const extract = vi.fn(() => ({ assertions: [] }));
    const adapter = defineAttuneGraphSourceAdapter({
      capabilities: {
        maxAssertionsPerExtraction: 1,
        sourceKinds: ["text"] as const,
        supportsIncremental: false
      },
      extract,
      metadata: {
        id: "example.graph-preflight",
        label: "Graph preflight",
        version: "1"
      }
    });

    await expect(projectAttuneGraphSource({
      ...input(adapter as never),
      attuneGraph: Object.create(null) as AttuneGraph,
      sourceKind: "text"
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(extract).not.toHaveBeenCalled();
  });
});
