import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { runCurrentHeadMaterializationProfile } from "./benchmark-attunegraph-current-head-materialization.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("rejects source mutation during the final v3 child execution", async () => {
  const created = mkdtempSync(join(tmpdir(), "attunegraph-materialization-source-mutation-"));
  const directory = realpathSync(created);
  const mutationPath = join(PACKAGE_ROOT, "materialization-source-mutation.fixture");
  let timer;
  try {
    writeFileSync(mutationPath, "before\n");
    const running = runCurrentHeadMaterializationProfile({
      profile: "v3",
      scale: 64,
      databasePath: join(directory, "v3.sqlite")
    });
    timer = setTimeout(() => writeFileSync(mutationPath, "after\n"), 0);
    await expect(running).rejects.toThrow(/v3 child source or runtime identity changed/u);
  } finally {
    clearTimeout(timer);
    rmSync(mutationPath, { force: true });
    rmSync(directory, { force: true, recursive: true });
  }
});

it("rejects mutation of ignored prepared runtime bytes during v3 execution", async () => {
  const created = mkdtempSync(join(tmpdir(), "attunegraph-materialization-runtime-mutation-"));
  const directory = realpathSync(created);
  const runtimePath = join(PACKAGE_ROOT, "dist", "attunegraph-backend.js");
  const original = readFileSync(runtimePath);
  let timer;
  try {
    const running = runCurrentHeadMaterializationProfile({
      profile: "v3",
      scale: 64,
      databasePath: join(directory, "v3.sqlite")
    });
    timer = setTimeout(() => {
      writeFileSync(runtimePath, Buffer.concat([original, Buffer.from("\n// mutation fixture\n", "utf8")]));
    }, 0);
    await expect(running).rejects.toThrow(/v3 child source or runtime identity changed/u);
  } finally {
    clearTimeout(timer);
    writeFileSync(runtimePath, original);
    rmSync(directory, { force: true, recursive: true });
  }
});
