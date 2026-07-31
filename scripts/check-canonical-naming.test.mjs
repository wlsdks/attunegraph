import { expect, test } from "vitest";

import { scanCanonicalNaming } from "./check-canonical-naming.mjs";

const word = (...parts) => parts.join("");
const short = word("m", "ag");
const fixture = (path, content) => scanCanonicalNaming({
  cwd: "/no-such-root",
  paths: [path],
  read: () => Buffer.from(content, "utf8")
});

for (const [label, path, content] of [
  ["old package", word("packages/attunement-", "graph/src/index.ts"), "export {}"],
  ["old long identity", "note.md", word("Attunement", "Graph")],
  ["old acronym", "note.md", short.toUpperCase()],
  ["old camel type", "note.md", `${short[0].toUpperCase()}${short.slice(1)}Store`],
  ["old portable extension", word("fixture.", short, "x"), "fixture"],
  ["old dotted namespace", "note.md", word("muse.", short, ".projection")]
]) {
  test(`rejects ${label}`, () => {
    expect(fixture(path, content).length).toBeGreaterThan(0);
  });
}

test("allows the canonical identity and unrelated words", () => {
  expect(fixture(
    "src/attunegraph-engine.ts",
    "const magnitude = 1; const magic = true; const name = 'AttuneGraph';"
  )).toEqual([]);
});
