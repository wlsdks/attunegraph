import { expect, it } from "vitest";

import { AttuneGraphError } from "./attunegraph-error.js";
import { AttuneQLSyntaxError, parseAttuneQL } from "./attuneql.js";

const CURRENT = `
  EVIDENCE FOR thread("thread:trip-planning")
  IN SCOPE("notes", "trip-planning")
  AS OF "2026-08-01T09:00:00.000Z"
  AT CURRENT HEAD
  REQUIRE FRESH
  BUDGET 2000 TOKENS;
`;

it("normalizes equivalent AttuneQL spellings to one frozen decision query", () => {
  const first = parseAttuneQL(CURRENT);
  const second = parseAttuneQL(
    'evidence for THREAD("thread:trip-planning") in scope("notes","trip-planning") as of "2026-08-01T09:00:00.000Z" at current head require fresh budget 2000 tokens'
  );

  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(first).toEqual({
    operator: "decision-query@1",
    scope: { sourceId: "notes", threadId: "trip-planning" },
    seed: { id: "thread:trip-planning", kind: "thread" },
    asOf: "2026-08-01T09:00:00.000Z",
    head: { mode: "current" },
    freshness: { require: "fresh" },
    budget: { maxEstimatedTokens: 2_000 }
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.scope)).toBe(true);
  expect(Object.isFrozen(first.budget)).toBe(true);
});

it("parses an exact current-head constraint without inventing historical lookup", () => {
  const query = parseAttuneQL(`
    EVIDENCE FOR action("action:send-draft")
    IN SCOPE("tasks", "follow-up")
    AS OF "2026-08-01T10:30:00.000Z"
    AT HEAD 7 "attunegraph-commit:observation-7"
    REQUIRE FRESH
    BUDGET 512 TOKENS;
  `);

  expect(query.head).toEqual({
    mode: "exact",
    generation: 7,
    commitId: "attunegraph-commit:observation-7"
  });
});

it.each([
  ["unknown node kind", CURRENT.replace("thread(", "person(")],
  ["missing freshness clause", CURRENT.replace("REQUIRE FRESH", "")],
  ["unknown trailing clause", `${CURRENT} RETURN ALL`],
  ["unterminated string", CURRENT.replace('"notes"', '"notes')],
  ["negative integer", CURRENT.replace("2000 TOKENS", "-1 TOKENS")]
])("fails closed on %s", (_name, source) => {
  expect(() => parseAttuneQL(source)).toThrow(AttuneQLSyntaxError);
});

it("separates syntax coordinates from semantic admission errors", () => {
  try {
    parseAttuneQL(`${CURRENT} ?`);
    throw new Error("expected AttuneQL syntax rejection");
  } catch (cause) {
    expect(cause).toBeInstanceOf(AttuneQLSyntaxError);
    expect(cause).toMatchObject({ code: "INVALID_SYNTAX" });
    expect((cause as AttuneQLSyntaxError).line).toBeGreaterThan(0);
    expect((cause as AttuneQLSyntaxError).column).toBeGreaterThan(0);
  }

  expect(() => parseAttuneQL(
    CURRENT.replace("2026-08-01T09:00:00.000Z", "not-an-instant")
  )).toThrow(AttuneGraphError);
  expect(() => parseAttuneQL(CURRENT.replace("2000 TOKENS", "0 TOKENS")))
    .toThrow(AttuneGraphError);
});

it("rejects control characters after JSON string decoding", () => {
  expect(() => parseAttuneQL(CURRENT.replace('"notes"', '"notes\\u0000shadow"')))
    .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("rejects unpaired UTF-16 surrogates after JSON string decoding", () => {
  expect(() => parseAttuneQL(CURRENT.replace(
    '"thread:trip-planning"',
    '"thread:trip-\\ud800planning"'
  ))).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
});

it("bounds text before tokenization", () => {
  expect(() => parseAttuneQL(`${CURRENT}${" ".repeat(8_192)}`))
    .toThrow(AttuneQLSyntaxError);
});
