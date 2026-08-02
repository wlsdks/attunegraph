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

function splitNul(value) {
  return value.toString("utf8").split("\0").filter((path) => path !== "").sort();
}

function exactRepositoryPath(root, path) {
  const candidate = resolve(root, path);
  if (!isInside(root, candidate)) throw sourceCheckoutError();
  return candidate;
}

function untrackedManifest(root, paths) {
  return paths.map((path) => {
    const candidate = exactRepositoryPath(root, path);
    const stat = lstatSync(candidate);
    // A link target can escape the checkout or change independently of the
    // path text. Evidence must close over target bytes or reject the state.
    if (stat.isSymbolicLink()) throw sourceCheckoutError();
    if (!stat.isFile()) throw sourceCheckoutError();
    return Object.freeze({
      path,
      kind: "file",
      mode: stat.mode & 0o7777,
      sha256: sha256(readFileSync(candidate))
    });
  });
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

/**
 * Captures a dirty checkout without pretending that HEAD^{tree} identifies the
 * executable candidate. Git-ignored untracked build/runtime outputs are the
 * only omitted worktree paths; every included path is named in sourceState.
 */
export function captureContentAddressedSourceCheckoutProvenance({
  packageRoot = DEFAULT_PACKAGE_ROOT
} = {}) {
  const base = captureSourceCheckoutProvenance({ packageRoot });
  const root = base.packageRoot;
  const gitBuffer = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"]
  });
  try {
    const stagedPatch = gitBuffer(
      "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--"
    );
    const unstagedPatch = gitBuffer(
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--"
    );
    const stagedFiles = splitNul(gitBuffer("diff", "--cached", "--name-only", "-z", "HEAD", "--"));
    const unstagedFiles = splitNul(gitBuffer("diff", "--name-only", "-z", "--"));
    const untrackedFiles = splitNul(gitBuffer("ls-files", "--others", "--exclude-standard", "-z", "--"));
    const untracked = untrackedManifest(root, untrackedFiles);
    const stateIdentityInput = Object.freeze({
      schema: "attunegraph-source-state-identity-input@1",
      stagedPatchSha256: sha256(stagedPatch),
      unstagedPatchSha256: sha256(unstagedPatch),
      untrackedManifestSha256: sha256(Buffer.from(JSON.stringify(untracked), "utf8"))
    });
    const aggregateSha256 = sha256(Buffer.from(JSON.stringify(stateIdentityInput), "utf8"));
    const sourceIdentityInput = Object.freeze({
      schema: "attunegraph-source-checkout-identity-input@1",
      commit: base.repository.commit,
      tree: base.repository.tree,
      lockfileSha256: base.repository.lockfileSha256,
      sourceStateAggregateSha256: aggregateSha256
    });
    const sourceState = Object.freeze({
      schema: "attunegraph-source-state@1",
      claim: base.repository.clean
        ? "exact-clean-commit-tree-lockfile"
        : "exact-content-addressed-dirty-source-state",
      included: Object.freeze([
        "tracked staged patch against HEAD",
        "tracked unstaged patch against the index",
        "untracked files not matched by Git ignore rules"
      ]),
      excluded: Object.freeze([
        "untracked files matched by Git ignore rules, including generated build and runtime outputs"
      ]),
      staged: Object.freeze({ files: Object.freeze(stagedFiles), patchSha256: stateIdentityInput.stagedPatchSha256 }),
      unstaged: Object.freeze({ files: Object.freeze(unstagedFiles), patchSha256: stateIdentityInput.unstagedPatchSha256 }),
      untracked: Object.freeze({
        files: Object.freeze(untracked),
        manifestSha256: stateIdentityInput.untrackedManifestSha256
      }),
      aggregateSha256
    });
    return Object.freeze({
      packageRoot: root,
      repository: Object.freeze({
        ...base.repository,
        sourceIdentity: sha256(Buffer.from(JSON.stringify(sourceIdentityInput), "utf8")),
        sourceState
      })
    });
  } catch {
    throw sourceCheckoutError();
  }
}
