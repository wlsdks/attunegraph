import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { prepareAttuneGraphRuntime } from "./prepare-attunegraph-runtime.mjs";

const runtimeFiles = [
  "index.js",
  "testing.js",
  "local.js",
  "attunegraph-backend.js",
  "source-adapter.js",
  "admin.js",
  "readonly-working-graph.js",
  "extension-kit.js",
  "attunegraph-portable-encoder.js",
  "attunegraph-portable-decoder.js"
];

async function writeRuntime(root) {
  await mkdir(join(root, "dist"), { recursive: true });
  await Promise.all(runtimeFiles.map((name) => writeFile(join(root, "dist", name), "export {};\n")));
}

it("builds source checkouts but only validates installed artifact runtime bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "attunegraph-runtime-prepare-"));
  try {
    await writeRuntime(root);
    let builds = 0;
    expect(prepareAttuneGraphRuntime({
      packageRoot: root,
      runSourceBuild: () => { builds += 1; }
    })).toMatchObject({ mode: "installed-artifact" });
    expect(builds).toBe(0);

    await Promise.all([
      mkdir(join(root, "src")),
      writeFile(join(root, "tsconfig.build.json"), "{}\n")
    ]);
    expect(prepareAttuneGraphRuntime({
      packageRoot: root,
      runSourceBuild: () => { builds += 1; }
    })).toMatchObject({ mode: "source-build" });
    expect(builds).toBe(1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("fails closed when installed runtime bytes are incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "attunegraph-runtime-incomplete-"));
  try {
    await mkdir(join(root, "dist"));
    expect(() => prepareAttuneGraphRuntime({ packageRoot: root }))
      .toThrow(/dist\/index\.js is missing/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
