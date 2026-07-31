import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

const word = (...parts) => parts.join("");
const short = word("m", "ag");
const long = word("Attunement", "Graph");
const oldFormat = word("muse-", short, "-portable");
const oldExtension = word(".", short, "x");

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patterns = [
  ["old long product identity", new RegExp(escape(long), "iu")],
  ["old portable format", new RegExp(escape(oldFormat), "iu")],
  ["old portable extension", new RegExp(escape(oldExtension), "iu")],
  ["superseded acronym identity", new RegExp(`(^|[^A-Za-z0-9])(?:${short.toUpperCase()}s?|${short}|${short[0].toUpperCase()}${short.slice(1)}(?:[A-Z][A-Za-z0-9]*|\\*)?|${short}[A-Z][A-Za-z0-9]*|${short}(?:[_-][A-Za-z0-9]+|\\.[A-Za-z0-9]+))(?=$|[^A-Za-z0-9])|[a-z0-9]${short[0].toUpperCase()}${short.slice(1)}(?:[A-Z][A-Za-z0-9]*)?(?=$|[^A-Za-z0-9])`, "u")],
  ["old dotted graph namespace", new RegExp(`muse\\.${short}|muse\\.${word("attunement", "-graph")}|${short}[-.]local|${short}[-.]admin|${short}[-.]portable`, "iu")]
];

function gitPaths(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function repositoryPaths(cwd = process.cwd()) {
  return [...new Set([
    ...gitPaths(["ls-files", "-z"], cwd),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"], cwd)
  ])].sort();
}

export function scanCanonicalNaming({
  cwd = process.cwd(),
  paths = repositoryPaths(cwd),
  read = readFileSync
} = {}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const findings = [];
  for (const path of paths) {
    const fullPath = join(cwd, path);
    if (read === readFileSync && !existsSync(fullPath)) continue;
    for (const [family, expression] of patterns) {
      if (expression.test(path)) findings.push({ family, path, where: "path" });
    }
    let content;
    try {
      const bytes = read(fullPath);
      if (Buffer.isBuffer(bytes) && bytes.includes(0)) continue;
      content = decoder.decode(bytes);
    } catch {
      continue;
    }
    for (const [family, expression] of patterns) {
      if (expression.test(content)) findings.push({ family, path, where: "content" });
    }
  }
  return findings;
}

export function assertCanonicalNaming(options) {
  const findings = scanCanonicalNaming(options);
  if (findings.length > 0) {
    throw new Error(
      `Superseded AttuneGraph naming found:\n${findings
        .map((finding) => `${finding.path} (${finding.where}: ${finding.family})`)
        .join("\n")}`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertCanonicalNaming();
    process.stdout.write("AttuneGraph canonical naming check passed.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
