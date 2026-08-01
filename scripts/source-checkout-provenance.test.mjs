import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { captureSourceCheckoutProvenance } from "./source-checkout-provenance.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "attunegraph-source-provenance-"));
  await Promise.all([
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

it("binds revision evidence to the exact clean source-checkout root", async () => {
  const root = await createRepository();
  try {
    const captured = captureSourceCheckoutProvenance({ packageRoot: root });
    expect(captured.packageRoot).toBe(await realpath(root));
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
