import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { publishBuild } from "./build.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "attunegraph-build-"));
  const distRoot = join(root, "dist");
  mkdirSync(distRoot);
  writeFileSync(join(distRoot, "previous.js"), "previous");
  return { distRoot, root, stagingParent: root };
}

test("a compiler failure preserves the previous complete dist", () => {
  const context = fixture();
  try {
    expect(() => publishBuild({
      ...context,
      runCompiler(stagingRoot) {
        writeFileSync(join(stagingRoot, "partial.js"), "partial");
        return { status: 1 };
      }
    })).toThrow(/TypeScript build failed/u);
    expect(readFileSync(join(context.distRoot, "previous.js"), "utf8")).toBe("previous");
    expect(readdirSync(context.root)).toEqual(["dist"]);
  } finally {
    rmSync(context.root, { force: true, recursive: true });
  }
});

test("a successful compiler atomically replaces dist and removes staging data", () => {
  const context = fixture();
  try {
    publishBuild({
      ...context,
      runCompiler(stagingRoot) {
        writeFileSync(join(stagingRoot, "current.js"), "current");
        return { status: 0 };
      }
    });
    expect(readFileSync(join(context.distRoot, "current.js"), "utf8")).toBe("current");
    expect(readdirSync(context.distRoot)).toEqual(["current.js"]);
    expect(readdirSync(context.root)).toEqual(["dist"]);
  } finally {
    rmSync(context.root, { force: true, recursive: true });
  }
});
