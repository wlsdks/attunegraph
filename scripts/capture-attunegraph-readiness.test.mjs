import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  captureReadinessCheck,
  parseReadinessCaptureArguments
} from "./capture-attunegraph-readiness.mjs";
import {
  READINESS_CAPTURE_SCHEMA_V2,
  READINESS_CHECK_SCHEMA_V2,
  READINESS_EVIDENCE_SCHEMA_V2
} from "./score-attunegraph-readiness.mjs";

const CAPTURE_ENTRYPOINT = fileURLToPath(new URL("./capture-attunegraph-readiness.mjs", import.meta.url));

let repositoryFixture;

function git(repository, arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" }).trim();
}

async function initializeRepository(path, filename) {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "capture@example.test"]);
  git(path, ["config", "user.name", "Capture Test"]);
  await writeFile(join(path, filename), `${filename}\n`);
  git(path, ["add", filename]);
  git(path, ["commit", "-qm", `add ${filename}`]);
}

async function seedWorkingGraphRunner(attunegraph) {
  const scripts = join(attunegraph, "scripts");
  await mkdir(scripts);
  for (const filename of [
    "direct-entrypoint.mjs",
    "readiness-check-contracts.mjs",
    "run-working-graph-readiness.mjs"
  ]) {
    await writeFile(
      join(scripts, filename),
      await readFile(new URL(`./${filename}`, import.meta.url))
    );
  }
  await writeFile(join(scripts, "verify-working-graph-golden-corpus.mjs"), [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "export async function verifyWorkingGraphGoldenCorpus() {",
    "  if (process.env.ATTUNEGRAPH_TEST_COMMIT_CONSUMER_DRIFT === '1') {",
    "    const consumer = fileURLToPath(new URL('../../consumer', import.meta.url));",
    "    writeFileSync(new URL('../../consumer/drift.txt', import.meta.url), 'drift\\n');",
    "    execFileSync('git', ['-C', consumer, 'add', 'drift.txt']);",
    "    execFileSync('git', ['-C', consumer, 'commit', '-qm', 'consumer drift']);",
    "  }",
    "  return { abstentionCases: 1, passed: true };",
    "}",
    ""
  ].join("\n"));
  git(attunegraph, ["add", "scripts"]);
  git(attunegraph, ["commit", "-qm", "add readiness runner fixture"]);
}

async function createRepositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-capture-protocol-"));
  const attunegraph = join(directory, "attunegraph");
  const consumer = join(directory, "consumer");
  const muse = join(directory, "muse");
  await Promise.all([mkdir(attunegraph), mkdir(consumer), mkdir(muse)]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await seedWorkingGraphRunner(attunegraph);
  await initializeRepository(consumer, "consumer.txt");
  await initializeRepository(muse, "muse.txt");
  git(consumer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "vendor/attunegraph"]);
  git(consumer, ["add", ".gitmodules", "vendor/attunegraph"]);
  git(consumer, ["commit", "-qm", "bind AttuneGraph consumer gitlink"]);
  git(muse, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "packages/attunegraph"]);
  git(muse, ["add", ".gitmodules", "packages/attunegraph"]);
  git(muse, ["commit", "-qm", "bind AttuneGraph gitlink"]);
  return { attunegraph, consumer, directory, muse };
}

async function createFixture() {
  const directory = await mkdtemp(join(repositoryFixture.directory, "case-"));
  return {
    attunegraph: repositoryFixture.attunegraph,
    consumer: repositoryFixture.consumer,
    directory,
    muse: repositoryFixture.muse,
    output: join(directory, "evidence")
  };
}

function capture(fixture, argv = [], overrides = {}) {
  return spawnSync(process.execPath, [
    CAPTURE_ENTRYPOINT,
    `--name=${overrides.name ?? "inspect"}`,
    `--output-directory=${overrides.output ?? fixture.output}`,
    `--attunegraph-repository=${fixture.attunegraph}`,
    `--muse-repository=${fixture.muse}`,
    `--cwd=${overrides.cwd ?? fixture.attunegraph}`,
    ...(overrides.producerMode ? [`--producer-mode=${overrides.producerMode}`] : []),
    "--",
    ...argv
  ], { encoding: "utf8", timeout: 20_000, env: overrides.env ?? process.env });
}

function captureV2(fixture, argv = [], overrides = {}) {
  return spawnSync(process.execPath, [
    CAPTURE_ENTRYPOINT,
    `--evidence-schema=${READINESS_EVIDENCE_SCHEMA_V2}`,
    `--name=${overrides.name ?? "submodule-pinned"}`,
    `--output-directory=${overrides.output ?? fixture.output}`,
    `--attunegraph-repository=${fixture.attunegraph}`,
    `--consumer-repository=${fixture.consumer}`,
    "--consumer-gitlink=vendor/attunegraph",
    `--cwd=${overrides.cwd ?? fixture.consumer}`,
    "--",
    ...argv
  ], { encoding: "utf8", timeout: 20_000, env: overrides.env ?? process.env });
}

async function withFixture(callback) {
  const fixture = await createFixture();
  await callback(fixture);
}

beforeAll(async () => {
  repositoryFixture = await createRepositoryFixture();
});

afterAll(async () => {
  if (repositoryFixture) {
    await rm(repositoryFixture.directory, { force: true, recursive: true });
  }
});

describe("AttuneGraph readiness evidence capture protocol", () => {
  it("accepts the package-manager separator before fixed capture options", () => {
    const args = [
      "--",
      "--name=inspect",
      "--output-directory=/tmp/evidence",
      "--attunegraph-repository=/tmp/attunegraph",
      "--muse-repository=/tmp/muse",
      "--cwd=/tmp/attunegraph",
      "--"
    ];
    const expected = {
      argv: [],
      attunegraphRepository: "/tmp/attunegraph",
      cwd: "/tmp/attunegraph",
      gate: "operability",
      museGitlinkPath: "packages/attunegraph",
      museRepository: "/tmp/muse",
      name: "inspect",
      outputDirectory: "/tmp/evidence",
      producerMode: "local-unattested"
    };
    expect(JSON.stringify(parseReadinessCaptureArguments(args))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(parseReadinessCaptureArguments([
      "--evidence-schema=attunegraph-readiness-evidence@1",
      ...args.slice(1)
    ]))).toBe(JSON.stringify(expected));
  });

  it("captures a V2 consumer check without a Muse subject or command role", async () => {
    await withFixture(async (fixture) => {
      const parsed = parseReadinessCaptureArguments([
        `--evidence-schema=${READINESS_EVIDENCE_SCHEMA_V2}`,
        "--name=submodule-pinned",
        "--output-directory=/tmp/evidence",
        "--attunegraph-repository=/tmp/attunegraph",
        "--consumer-repository=/tmp/consumer",
        "--consumer-gitlink=vendor/attunegraph",
        "--cwd=/tmp/consumer",
        "--"
      ]);
      expect(parsed).toMatchObject({
        consumerGitlinkPath: "vendor/attunegraph",
        consumerRepository: "/tmp/consumer",
        evidenceSchema: READINESS_EVIDENCE_SCHEMA_V2,
        gate: "consumer-integration"
      });
      expect(parsed).not.toHaveProperty("museRepository");

      const result = captureV2(fixture);
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      expect(descriptor).toMatchObject({
        schema: READINESS_CAPTURE_SCHEMA_V2,
        subject: { consumer: { attunegraphGitlink: { path: "vendor/attunegraph" } } }
      });
      expect(descriptor.subject).not.toHaveProperty("muse");
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured).toMatchObject({
        command: {
          cwdRole: "consumer",
          id: "attunegraph-readiness-check-contract@2:submodule-pinned"
        },
        cwd: realpathSync(fixture.consumer),
        gate: "consumer-integration",
        provenance: {
          producer: "capture-attunegraph-readiness@2",
          schema: "attunegraph-readiness-provenance@2"
        },
        schema: READINESS_CHECK_SCHEMA_V2,
        state: "not-run"
      });
      expect(captured.subject).not.toHaveProperty("muse");
    });
  });

  it("captures an actual V2 available command with an @2 contract id and @1 raw schema", async () => {
    await withFixture(async (fixture) => {
      const result = captureV2(fixture, [
        "node",
        "scripts/run-working-graph-readiness.mjs",
        "--check=working-graph-golden-corpus",
        "--contract-schema=attunegraph-readiness-check-contract@2"
      ], { cwd: fixture.attunegraph, name: "working-graph-golden-corpus" });
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured).toMatchObject({
        command: {
          id: "attunegraph-readiness-check-contract@2:working-graph-golden-corpus"
        },
        gate: "retrieval-quality",
        schema: READINESS_CHECK_SCHEMA_V2,
        state: "pass"
      });
      const raw = JSON.parse(await readFile(join(fixture.output, captured.stdout.path), "utf8"));
      expect(raw).toMatchObject({
        contractId: "attunegraph-readiness-check-contract@2:working-graph-golden-corpus",
        schema: "attunegraph-readiness-command-output@1"
      });
    });
  });

  it("fails closed when the generic consumer subject changes during V2 capture", async () => {
    const isolated = await createRepositoryFixture();
    const fixture = { ...isolated, output: join(isolated.directory, "evidence") };
    try {
      const result = captureV2(fixture, [
        "node",
        "scripts/run-working-graph-readiness.mjs",
        "--check=working-graph-golden-corpus",
        "--contract-schema=attunegraph-readiness-check-contract@2"
      ], {
        cwd: fixture.attunegraph,
        env: { ...process.env, ATTUNEGRAPH_TEST_COMMIT_CONSUMER_DRIFT: "1" },
        name: "working-graph-golden-corpus"
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/repository subjects changed while the command was running/u);
    } finally {
      await rm(isolated.directory, { force: true, recursive: true });
    }
  });

  it("rejects mixed V1 and V2 capture arguments before repository access", () => {
    expect(() => parseReadinessCaptureArguments([
      `--evidence-schema=${READINESS_EVIDENCE_SCHEMA_V2}`,
      "--name=submodule-pinned",
      "--output-directory=/tmp/evidence",
      "--attunegraph-repository=/tmp/attunegraph",
      "--consumer-repository=/tmp/consumer",
      "--consumer-gitlink=vendor/attunegraph",
      "--muse-repository=/tmp/muse",
      "--cwd=/tmp/consumer",
      "--"
    ])).toThrow(/must not mix V1 Muse and V2 consumer arguments/u);
    expect(() => parseReadinessCaptureArguments([
      "--evidence-schema=attunegraph-readiness-evidence@1",
      "--name=submodule-pinned",
      "--output-directory=/tmp/evidence",
      "--attunegraph-repository=/tmp/attunegraph",
      "--consumer-repository=/tmp/consumer",
      "--consumer-gitlink=vendor/attunegraph",
      "--cwd=/tmp/consumer",
      "--"
    ])).toThrow(/must not mix V1 Muse and V2 consumer arguments/u);
    expect(() => parseReadinessCaptureArguments([
      "--evidence-schema=attunegraph-readiness-evidence@3",
      "--name=inspect",
      "--output-directory=/tmp/evidence",
      "--attunegraph-repository=/tmp/attunegraph",
      "--muse-repository=/tmp/muse",
      "--cwd=/tmp/attunegraph",
      "--"
    ])).toThrow(/unsupported readiness evidence schema/u);
    expect(() => captureReadinessCheck({
      argv: [],
      attunegraphRepository: "/tmp/attunegraph",
      consumerGitlinkPath: "vendor/attunegraph",
      consumerRepository: "/tmp/consumer",
      cwd: "/tmp/consumer",
      evidenceSchema: READINESS_EVIDENCE_SCHEMA_V2,
      gate: "consumer-integration",
      museRepository: "/tmp/muse",
      name: "submodule-pinned",
      outputDirectory: "/tmp/evidence",
      producerMode: "local-unattested"
    })).rejects.toThrow(/must not mix V1 Muse and V2 consumer arguments/u);
  });

  it("captures an unavailable fixed contract only as local-unattested not-run", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture);
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured).toMatchObject({
        command: {
          availability: "unavailable",
          cwdRole: "attunegraph",
          id: "attunegraph-readiness-check-contract@1:inspect",
          parameters: {}
        },
        executable: null,
        exitCode: null,
        provenance: { kind: "local-unattested" },
        state: "not-run"
      });
      expect(Buffer.from(await readFile(join(fixture.output, captured.stdout.path)))).toHaveLength(0);
      expect(Buffer.from(await readFile(join(fixture.output, captured.stderr.path)))).toHaveLength(0);
      expect(isAbsolute(captured.cwd)).toBe(true);
      expect(await readFile(join(captured.cwd, "attunegraph.txt"), "utf8")).toBe("attunegraph.txt\n");
      expect(statSync(captured.cwd).isDirectory()).toBe(true);
    });
  });

  it.each([
    ["node --version", [process.execPath, "--version"]],
    ["node synthetic pass", [process.execPath, "-e", "process.exit(0)"]]
  ])("refuses substitute argv: %s", async (_label, argv) => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/unavailable.*substitute argv/u);
    });
  });

  it("refuses /usr/bin/true when present", async () => {
    if (process.platform === "win32") return;
    await withFixture(async (fixture) => {
      const result = capture(fixture, ["/usr/bin/true"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/substitute argv/u);
    });
  });

  it("ignores a fake PATH executable and records the actual fixed child identity", async () => {
    await withFixture(async (fixture) => {
      const fakeBin = join(fixture.directory, "fake-bin");
      await mkdir(fakeBin);
      await writeFile(join(fakeBin, process.platform === "win32" ? "node.cmd" : "node"), "fake\n");
      const result = capture(fixture, [
        "node",
        "scripts/run-working-graph-readiness.mjs",
        "--check=working-graph-golden-corpus"
      ], {
        name: "working-graph-golden-corpus",
        env: { ...process.env, PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }
      });
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured.state).toBe("pass");
      expect(captured.executable).toMatchObject({ path: expect.any(String), version: process.version });
      expect(captured.executable.path).not.toContain("fake-bin");
    });
  });

  it("refuses self-asserted GitHub attestation producer mode", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, [], { producerMode: "github-actions-attested" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/external cryptographic verification/u);
    });
  });

  it("requires the contract's canonical repository role", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, [], { cwd: fixture.muse });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/canonical attunegraph repository root/u);
    });
  });
});
