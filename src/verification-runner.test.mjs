import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VerificationRunner, VerificationRunnerError } from "./verification-runner.mjs";

const allow = async () => ({ allowed: true });
let root;
test("verification runner fixture", async (t) => {
  root = await mkdtemp(path.join(os.tmpdir(), "hoh-runner-"));
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, 'process.stdout.write("verification-ok");\n');
  const node = process.execPath;
  const runner = new VerificationRunner({
    workspaceRoot: root,
    commands: [{
      id: "unit-tests",
      executable: node,
      args: [script],
      timeoutMs: 3000,
      maxOutputBytes: 4096,
      allowedExitCodes: [0],
      environment: {},
    }],
    authorize: allow,
  });
  t.after(async () => rm(root, { recursive: true, force: true }));

  const result = await runner.run({
    taskId: "task-1", projectId: "project-1", commandId: "unit-tests", principalId: "ci",
  });
  assert.equal(result.outcome, "passed");
  assert.equal(result.stdout, "verification-ok");
  assert.match(result.resultHash, /^[a-f0-9]{64}$/);
});

test("rejects unknown commands and denied authorization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoh-runner-deny-"));
  try {
    const base = {
      workspaceRoot: dir,
      commands: [{ id: "check", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000, maxOutputBytes: 1024, allowedExitCodes: [0] }],
      authorize: allow,
    };
    const runner = new VerificationRunner(base);
    await assert.rejects(
      runner.run({ taskId: "t", projectId: "p", commandId: "not-allowed", principalId: "u" }),
      (error) => error.code === "COMMAND_NOT_ALLOWED",
    );
    const denied = new VerificationRunner({ ...base, authorize: async () => ({ allowed: false }) });
    await assert.rejects(
      denied.run({ taskId: "t", projectId: "p", commandId: "check", principalId: "u" }),
      (error) => error.code === "POLICY_DENIED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid descriptors and requires policy callback", () => {
  assert.throws(() => new VerificationRunner({ workspaceRoot: "/tmp", commands: [], authorize: allow }), /non-empty command allowlist/);
  assert.throws(() => new VerificationRunner({
    workspaceRoot: "/tmp",
    commands: [{ id: "bad", executable: "node", args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowedExitCodes: [0] }],
    authorize: allow,
  }), (error) => error.code === "INVALID_COMMAND_DESCRIPTOR");
  assert.throws(() => new VerificationRunner({
    workspaceRoot: "/tmp",
    commands: [{ id: "ok", executable: process.execPath, args: [], timeoutMs: 1000, maxOutputBytes: 1024, allowedExitCodes: [0] }],
  }), /authorization callback/);
});

test("fails closed when command exceeds output budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoh-runner-output-"));
  try {
    const runner = new VerificationRunner({
      workspaceRoot: dir,
      commands: [{
        id: "too-chatty", executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(8192))"],
        timeoutMs: 3000, maxOutputBytes: 1024, allowedExitCodes: [0],
      }],
      authorize: allow,
    });
    const result = await runner.run({ taskId: "t", projectId: "p", commandId: "too-chatty", principalId: "ci" });
    assert.equal(result.outcome, "failed");
    assert.equal(result.outputLimitExceeded, true);
    assert.ok(result.stdoutBytes <= 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminates a command that exceeds its deadline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoh-runner-timeout-"));
  try {
    const runner = new VerificationRunner({
      workspaceRoot: dir,
      commands: [{
        id: "slow", executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 100, maxOutputBytes: 1024, allowedExitCodes: [0],
      }],
      authorize: allow,
    });
    const result = await runner.run({ taskId: "t", projectId: "p", commandId: "slow", principalId: "ci" });
    assert.equal(result.outcome, "failed");
    assert.equal(result.timedOut, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
