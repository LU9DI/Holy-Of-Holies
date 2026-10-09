import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerVerificationRunner, ContainerVerificationRunnerError } from "./container-verification-runner.mjs";

const image = "registry.example/ci/node@sha256:" + "a".repeat(64);
const allow = async () => ({ allowed: true });
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-container-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "fake-runtime.cjs");
  await writeFile(runtime, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(runtime, 0o755);
  return new ContainerVerificationRunner({
    workspaceRoot: root, runtime, authorize: allow,
    commands: [{
      id: "unit-tests", image, executable: "/usr/bin/node", args: ["--test"],
      timeoutMs: 3000, maxOutputBytes: 4096, allowedExitCodes: [0],
    }],
    runtimeEnvironment: {}, ...options,
  });
}

test("uses pinned images, read-only source, no network, and resource limits", async (t) => {
  const runner = await fixture(t, {
    commands: [{
      id: "unit-tests", image, executable: "/usr/bin/node", args: ["--test"],
      timeoutMs: 3000, maxOutputBytes: 4096, allowedExitCodes: [0],
    }],
  });
  const result = await runner.run({ taskId: "task-1", projectId: "project-1", commandId: "unit-tests", principalId: "ci" });
  assert.equal(result.outcome, "passed");
  const argv = JSON.parse(result.stdout);
  assert.ok(argv.includes("--network=none"));
  assert.ok(argv.includes("--read-only"));
  assert.ok(argv.includes("--cap-drop=ALL"));
  assert.ok(argv.includes("--security-opt=no-new-privileges"));
  assert.ok(argv.some((arg) => arg.startsWith("--memory=")));
  assert.ok(argv.some((arg) => arg.startsWith("--pids-limit=")));
  assert.ok(argv.includes(image));
  assert.ok(argv.includes("--workdir=/workspace"));
  assert.ok(argv.some((arg) => arg.includes("dst=/workspace,readonly")));
});

test("rejects unpinned images and invalid resource limits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-container-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => new ContainerVerificationRunner({
    workspaceRoot: root, runtime: process.execPath, authorize: allow,
    commands: [{ id: "unit-tests", image: "node:22", executable: "/usr/bin/node", args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowedExitCodes: [0] }],
  }), (error) => error.code === "INVALID_COMMAND_DESCRIPTOR");
  assert.throws(() => new ContainerVerificationRunner({
    workspaceRoot: root, runtime: process.execPath, authorize: allow, commands: [{
      id: "unit-tests", image, executable: "/usr/bin/node", args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowedExitCodes: [0],
    }], pidsLimit: 10000,
  }), /resource limits/);
});

test("fails closed when authorization is denied", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hoh-container-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = await fixture(t, { workspaceRoot: root, authorize: async () => ({ allowed: false }) });
  await assert.rejects(runner.run({ taskId: "t", projectId: "p", commandId: "unit-tests", principalId: "u" }),
    (error) => error.code === "POLICY_DENIED");
});
