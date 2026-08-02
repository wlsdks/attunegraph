import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  captureContentAddressedSourceCheckoutProvenance,
  captureSourceCheckoutProvenance
} from "./source-checkout-provenance.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "attunegraph-source-provenance-"));
  await Promise.all([
    writeFile(join(root, ".gitignore"), "generated/\n"),
    writeFile(join(root, "package.json"), "{}\n"),
    writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  ]);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "attunegraph-test@example.invalid");
  git(root, "config", "user.name", "AttuneGraph Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

async function directoryIdentity(path) {
  const stat = await lstat(path, { bigint: true });
  return {
    device: stat.dev,
    inode: stat.ino,
    isDirectory: stat.isDirectory()
  };
}

it("binds revision evidence to the exact clean source-checkout root", async () => {
  const root = await createRepository();
  try {
    const captured = captureSourceCheckoutProvenance({ packageRoot: root });
    expect(await directoryIdentity(captured.packageRoot))
      .toEqual(await directoryIdentity(root));
    expect(captured.repository).toMatchObject({
      clean: true,
      commit: git(root, "rev-parse", "HEAD"),
      tree: git(root, "rev-parse", "HEAD^{tree}")
    });
    expect(captured.repository.lockfileSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("content-addresses staged, unstaged, and non-ignored untracked source state", async () => {
  const root = await createRepository();
  try {
    const clean = captureContentAddressedSourceCheckoutProvenance({ packageRoot: root });
    expect(clean.repository).toMatchObject({
      clean: true,
      sourceIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      sourceState: {
        schema: "attunegraph-source-state@1",
        claim: "exact-clean-commit-tree-lockfile",
        staged: { files: [] },
        unstaged: { files: [] },
        untracked: { files: [] }
      }
    });

    await writeFile(join(root, "package.json"), "{\"candidate\":1}\n");
    await writeFile(join(root, "candidate.mjs"), "export const candidate = 1;\n");
    const dirty = captureContentAddressedSourceCheckoutProvenance({ packageRoot: root });
    expect(dirty.repository).toMatchObject({
      clean: false,
      commit: clean.repository.commit,
      tree: clean.repository.tree,
      sourceState: {
        claim: "exact-content-addressed-dirty-source-state",
        staged: { files: [] },
        unstaged: { files: ["package.json"] },
        untracked: { files: [{ path: "candidate.mjs", kind: "file" }] }
      }
    });
    expect(dirty.repository.sourceIdentity).not.toBe(clean.repository.sourceIdentity);

    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "runtime.json"), "ignored runtime output\n");
    const withIgnoredRuntime = captureContentAddressedSourceCheckoutProvenance({ packageRoot: root });
    expect(withIgnoredRuntime.repository.sourceIdentity).toBe(dirty.repository.sourceIdentity);
    expect(withIgnoredRuntime.repository.sourceState.untracked.files).toEqual(
      dirty.repository.sourceState.untracked.files
    );

    git(root, "add", "package.json");
    const staged = captureContentAddressedSourceCheckoutProvenance({ packageRoot: root });
    expect(staged.repository.sourceState.staged.files).toEqual(["package.json"]);
    expect(staged.repository.sourceState.unstaged.files).toEqual([]);
    expect(staged.repository.sourceIdentity).not.toBe(dirty.repository.sourceIdentity);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("rejects an untracked symlink and remains rejected after target mutation", async () => {
  const root = await createRepository();
  const target = join(root, "target.mjs");
  try {
    await writeFile(target, "export const target = 1;\n");
    await symlink("target.mjs", join(root, "candidate-link.mjs"));
    expect(() => captureContentAddressedSourceCheckoutProvenance({ packageRoot: root }))
      .toThrow(/requires a source checkout/u);
    await writeFile(target, "export const target = 2;\n");
    expect(() => captureContentAddressedSourceCheckoutProvenance({ packageRoot: root }))
      .toThrow(/requires a source checkout/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("rejects installed or nested package roots instead of borrowing a consumer repository identity", async () => {
  const root = await createRepository();
  const installed = join(root, "node_modules", "@attunegraph", "core");
  try {
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(() => captureSourceCheckoutProvenance({ packageRoot: installed }))
      .toThrow(/requires a source checkout/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("rejects a missing lockfile", async () => {
  const root = await createRepository();
  try {
    await rm(join(root, "pnpm-lock.yaml"));
    expect(() => captureSourceCheckoutProvenance({ packageRoot: root }))
      .toThrow(/requires a source checkout/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
