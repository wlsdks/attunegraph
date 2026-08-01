import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceCheckoutError() {
  return new Error(
    "revision-bound AttuneGraph evidence requires a source checkout at the repository root"
  );
}

function isInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSameDirectory(left, right) {
  const leftStat = lstatSync(left, { bigint: true });
  const rightStat = lstatSync(right, { bigint: true });
  return leftStat.isDirectory()
    && rightStat.isDirectory()
    && leftStat.dev === rightStat.dev
    && leftStat.ino === rightStat.ino;
}

export function captureSourceCheckoutProvenance({ packageRoot = DEFAULT_PACKAGE_ROOT } = {}) {
  let canonicalRoot;
  let repositoryRoot;
  const git = (...args) => execFileSync("git", ["-C", packageRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  try {
    canonicalRoot = realpathSync(packageRoot);
    repositoryRoot = realpathSync(git("rev-parse", "--show-toplevel"));
    // Windows may spell the same checkout with a differently-cased drive or
    // separator form. Bind to the canonical directory identity, not its text.
    if (!isSameDirectory(canonicalRoot, repositoryRoot)) throw sourceCheckoutError();
  } catch {
    throw sourceCheckoutError();
  }

  const lockfilePath = join(canonicalRoot, "pnpm-lock.yaml");
  let lockfile;
  try {
    const stat = lstatSync(lockfilePath);
    const canonicalLockfile = realpathSync(lockfilePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(canonicalRoot, canonicalLockfile)) {
      throw sourceCheckoutError();
    }
    lockfile = readFileSync(canonicalLockfile);
  } catch {
    throw sourceCheckoutError();
  }

  return Object.freeze({
    packageRoot: canonicalRoot,
    repository: Object.freeze({
      clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
      commit: git("rev-parse", "HEAD"),
      lockfileSha256: sha256(lockfile),
      tree: git("rev-parse", "HEAD^{tree}")
    })
  });
}
