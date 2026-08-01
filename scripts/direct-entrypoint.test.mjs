import { expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const CANONICAL_PATH = resolve("canonical", "package", "scripts", "tool.mjs");
const ALIAS_PATH = resolve("alias", "package", "scripts", "tool.mjs");
const OTHER_PATH = resolve("canonical", "package", "scripts", "other.mjs");
const MODULE_URL = pathToFileURL(CANONICAL_PATH).href;

it("recognizes the same canonical entrypoint through lexical aliases", () => {
  const aliases = new Map([
    [ALIAS_PATH, CANONICAL_PATH],
    [CANONICAL_PATH, CANONICAL_PATH]
  ]);
  expect(isDirectEntrypoint(
    MODULE_URL,
    ALIAS_PATH,
    (path) => aliases.get(path) ?? path
  )).toBe(true);
});

it("rejects imports, other programs, and paths that cannot be canonicalized", () => {
  expect(isDirectEntrypoint(MODULE_URL, undefined)).toBe(false);
  expect(isDirectEntrypoint(
    MODULE_URL,
    OTHER_PATH,
    (path) => path
  )).toBe(false);
  expect(isDirectEntrypoint(MODULE_URL, resolve("missing"), () => { throw new Error("missing"); }))
    .toBe(false);
});
