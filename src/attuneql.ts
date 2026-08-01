import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphDecisionQuery } from "./attunegraph-contracts.js";
import { normalizeDecisionQuery } from "./decision-query.js";
import { GRAPH_NODE_KINDS } from "./types.js";

const MAX_ATTUNEQL_CODE_UNITS = 8_192;
const MAX_ATTUNEQL_TOKENS = 64;

export class AttuneQLSyntaxError extends Error {
  readonly code = "INVALID_SYNTAX" as const;
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, offset: number, source: string) {
    super(message);
    this.name = "AttuneQLSyntaxError";
    this.offset = offset;
    const prefix = source.slice(0, offset);
    this.line = prefix.split("\n").length;
    this.column = offset - prefix.lastIndexOf("\n");
  }
}

type Token = Readonly<{
  readonly kind: "word" | "integer" | "string" | "punctuation";
  readonly value: string;
  readonly offset: number;
}>;

function syntax(source: string, offset: number, message: string): never {
  throw new AttuneQLSyntaxError(message, offset, source);
}

function tokenize(source: string): readonly Token[] {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_ATTUNEQL_CODE_UNITS) {
    syntax(typeof source === "string" ? source : "", 0, "AttuneQL input must be bounded non-empty text");
  }
  const tokens: Token[] = [];
  for (let offset = 0; offset < source.length;) {
    const character = source[offset];
    if (character && /\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (character && "(),;".includes(character)) {
      tokens.push(Object.freeze({ kind: "punctuation", value: character, offset }));
      offset += 1;
    } else if (character === '"') {
      const start = offset;
      offset += 1;
      let escaped = false;
      while (offset < source.length) {
        const current = source[offset];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
        offset += 1;
      }
      if (offset >= source.length || source[offset] !== '"') {
        syntax(source, start, "AttuneQL string is unterminated");
      }
      const raw = source.slice(start, offset + 1);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        syntax(source, start, "AttuneQL string is not valid JSON text");
      }
      if (typeof value !== "string") syntax(source, start, "AttuneQL literal must be a string");
      tokens.push(Object.freeze({ kind: "string", value, offset: start }));
      offset += 1;
    } else if (character && /[0-9]/u.test(character)) {
      const start = offset;
      while (offset < source.length && /[0-9]/u.test(source[offset] ?? "")) offset += 1;
      tokens.push(Object.freeze({ kind: "integer", value: source.slice(start, offset), offset: start }));
    } else if (character && /[A-Za-z]/u.test(character)) {
      const start = offset;
      while (offset < source.length && /[A-Za-z0-9_-]/u.test(source[offset] ?? "")) offset += 1;
      tokens.push(Object.freeze({ kind: "word", value: source.slice(start, offset), offset: start }));
    } else {
      syntax(source, offset, "AttuneQL contains an unsupported token");
    }
    if (tokens.length > MAX_ATTUNEQL_TOKENS) {
      syntax(source, offset, "AttuneQL token budget exceeded");
    }
  }
  return Object.freeze(tokens);
}

export function parseAttuneQL(source: string): AttuneGraphDecisionQuery {
  const tokens = tokenize(source);
  let index = 0;
  const take = (): Token => {
    const token = tokens[index];
    if (!token) syntax(source, source.length, "AttuneQL ended before the query was complete");
    index += 1;
    return token;
  };
  const expectWord = (expected: string): void => {
    const token = take();
    if (token.kind !== "word" || token.value.toUpperCase() !== expected) {
      syntax(source, token.offset, `AttuneQL expected ${expected}`);
    }
  };
  const expectPunctuation = (expected: string): void => {
    const token = take();
    if (token.kind !== "punctuation" || token.value !== expected) {
      syntax(source, token.offset, `AttuneQL expected ${expected}`);
    }
  };
  const takeString = (): string => {
    const token = take();
    if (token.kind !== "string") syntax(source, token.offset, "AttuneQL expected a JSON string");
    return token.value;
  };
  const takeInteger = (): number => {
    const token = take();
    if (token.kind !== "integer") syntax(source, token.offset, "AttuneQL expected an integer");
    const value = Number(token.value);
    if (!Number.isSafeInteger(value)) syntax(source, token.offset, "AttuneQL integer is out of range");
    return value;
  };

  expectWord("EVIDENCE");
  expectWord("FOR");
  const kindToken = take();
  if (
    kindToken.kind !== "word"
    || !GRAPH_NODE_KINDS.includes(kindToken.value.toLowerCase() as never)
  ) {
    syntax(source, kindToken.offset, "AttuneQL expected a graph node kind");
  }
  expectPunctuation("(");
  const seedId = takeString();
  expectPunctuation(")");
  expectWord("IN");
  expectWord("SCOPE");
  expectPunctuation("(");
  const sourceId = takeString();
  expectPunctuation(",");
  const threadId = takeString();
  expectPunctuation(")");
  expectWord("AS");
  expectWord("OF");
  const asOf = takeString();
  expectWord("AT");
  const headToken = take();
  let head: AttuneGraphDecisionQuery["head"];
  if (headToken.kind === "word" && headToken.value.toUpperCase() === "CURRENT") {
    expectWord("HEAD");
    head = { mode: "current" };
  } else if (headToken.kind === "word" && headToken.value.toUpperCase() === "HEAD") {
    head = { mode: "exact", generation: takeInteger(), commitId: takeString() };
  } else {
    syntax(source, headToken.offset, "AttuneQL expected CURRENT HEAD or HEAD <generation> <commitId>");
  }
  expectWord("REQUIRE");
  expectWord("FRESH");
  expectWord("BUDGET");
  const maxEstimatedTokens = takeInteger();
  expectWord("TOKENS");
  const terminal = tokens[index];
  if (terminal?.kind === "punctuation" && terminal.value === ";") index += 1;
  if (index !== tokens.length) {
    syntax(source, tokens[index]?.offset ?? source.length, "AttuneQL has trailing tokens");
  }

  try {
    return normalizeDecisionQuery({
      operator: "decision-query@1",
      scope: { sourceId, threadId },
      seed: { kind: kindToken.value.toLowerCase() as never, id: seedId },
      asOf,
      head,
      freshness: { require: "fresh" },
      budget: { maxEstimatedTokens }
    });
  } catch (cause) {
    if (cause instanceof AttuneGraphError) throw cause;
    throw new AttuneGraphError("INVALID_INPUT", "AttuneQL semantic normalization failed", { cause });
  }
}
