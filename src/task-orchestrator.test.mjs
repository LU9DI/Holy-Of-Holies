import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { TaskOrchestrator } from "./task-orchestrator.mjs";

const EVIDENCE = {
  verificationId: "verification-42",
  verifierId: "ci:test-runner",
  outcome: "passed",
  resultHash: "b".repeat(64),
};

function taskInput(taskId = "task-1", overrides = {}) {
  return {
    taskId,
    projectId: "project-1",
    objective: "Inspect the project safely",
    policyVersion: "policy-v1",
    permissions: { filesystem: "read", network: "none", execution: "none" },
    resourceLimits: { timeoutMs: 30_000, maxOutputBytes: 64_000, maxConcurrentChildren: 1 },
    ...overrides,
  };
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "holy-orchestrator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new EventLedger(join(directory, "events.jsonl"));
  const orchestrator = new TaskOrchestrator({
    ledger,
    authorize: async () => ({ allowed: true }),
    ...options,
  });
  await orchestrator.initialize();
  return { ledger, orchestrator };
}

test("persists tasks and reconstructs state after restart", async (t) => {
  const { ledger, orchestrator } = await setup(t);
  const created = await orchestrator.create(taskInput(), { principalId: "user:owner" });
  await orchestrator.transition("task-1", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  assert.equal(created.status, "queued");

  const restarted = new TaskOrchestrator({
    ledger,
    authorize: async () => ({ allowed: true }),
  });
  const result = await restarted.initialize();
  assert.equal(result.taskCount, 1);
  assert.equal(restarted.getTask("task-1").status, "planning");
  assert.equal(restarted.getTask("task-1").events.length, 2);
});

test("requires policy authorization before creating or transitioning tasks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new EventLedger(join(directory, "events.jsonl"));
  const denied = new TaskOrchestrator({
    ledger,
    authorize: async () => ({ allowed: false }),
  });
  await denied.initialize();
  await assert.rejects(
    denied.create(taskInput(), { principalId: "agent:untrusted" }),
    (error) => error.code === "POLICY_DENIED",
  );
  assert.equal((await ledger.verify()).eventCount, 0);
});

test("approval transition uses a distinct authorization action", async (t) => {
  const requests = [];
  const { orchestrator } = await setup(t, {
    authorize: async (request) => {
      requests.push(request);
      return { allowed: true };
    },
  });
  await orchestrator.create(taskInput("task-approved", {
    requiresApproval: false,
    permissions: { filesystem: "write", network: "none", execution: "none" },
  }), {
    principalId: "user:owner",
  });
  await orchestrator.transition("task-approved", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  await orchestrator.transition("task-approved", "awaiting_approval", {
    principalId: "user:owner",
    expectedStatus: "planning",
  });
  await orchestrator.transition("task-approved", "running", {
    principalId: "user:reviewer",
    expectedStatus: "awaiting_approval",
  });

  assert.equal(orchestrator.getTask("task-approved").status, "running");
  assert.ok(requests.some((request) => request.action === "task.approve" && request.principalId === "user:reviewer"));
  assert.equal(orchestrator.getTask("task-approved").events.at(-1).approvedBy, "user:reviewer");
});

test("requires trusted verification before task completion and replays evidence", async (t) => {
  const { ledger, orchestrator } = await setup(t, {
    verifyCompletion: async ({ task, evidence }) =>
      task.taskId === "task-complete" && evidence.verificationId === "verification-42",
  });
  await orchestrator.create(taskInput("task-complete"), { principalId: "user:owner" });
  await orchestrator.transition("task-complete", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  await orchestrator.transition("task-complete", "running", {
    principalId: "user:owner",
    expectedStatus: "planning",
  });
  await orchestrator.transition("task-complete", "verifying", {
    principalId: "user:owner",
    expectedStatus: "running",
  });
  const completed = await orchestrator.transition("task-complete", "completed", {
    principalId: "user:owner",
    expectedStatus: "verifying",
    evidence: EVIDENCE,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.events.at(-1).evidence.resultHash, EVIDENCE.resultHash);

  const restarted = new (orchestrator.constructor)({
    ledger,
    authorize: async () => ({ allowed: true }),
  });
  await restarted.initialize();
  assert.equal(restarted.getTask("task-complete").status, "completed");
  assert.equal(restarted.getTask("task-complete").events.at(-1).evidence.verificationId, "verification-42");
});

test("completion fails closed when no verifier is configured", async (t) => {
  const { ledger, orchestrator } = await setup(t);
  await orchestrator.create(taskInput("task-no-verifier"), { principalId: "user:owner" });
  await orchestrator.transition("task-no-verifier", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  await orchestrator.transition("task-no-verifier", "running", {
    principalId: "user:owner",
    expectedStatus: "planning",
  });
  await orchestrator.transition("task-no-verifier", "verifying", {
    principalId: "user:owner",
    expectedStatus: "running",
  });
  await assert.rejects(
    orchestrator.transition("task-no-verifier", "completed", {
      principalId: "user:owner",
      expectedStatus: "verifying",
      evidence: EVIDENCE,
    }),
    (error) => error.code === "VERIFICATION_ENGINE_UNAVAILABLE",
  );
  assert.equal(orchestrator.getTask("task-no-verifier").status, "verifying");
  assert.equal((await ledger.verify()).eventCount, 4);
});

test("requires resume verification and expected status", async (t) => {
  const { orchestrator } = await setup(t, {
    verifyResume: async () => true,
  });
  await orchestrator.create(taskInput(), { principalId: "user:owner" });
  await assert.rejects(
    orchestrator.transition("task-1", "planning", {
      principalId: "user:owner",
      expectedStatus: "running",
    }),
    (error) => error.code === "STALE_TASK_STATE",
  );
  await orchestrator.transition("task-1", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  await orchestrator.transition("task-1", "running", {
    principalId: "user:owner",
    expectedStatus: "planning",
  });
  await orchestrator.transition("task-1", "interrupted", {
    principalId: "user:owner",
    expectedStatus: "running",
  });
  const resumed = await orchestrator.transition("task-1", "queued", {
    principalId: "user:owner",
    expectedStatus: "interrupted",
  });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.events.at(-1).resumeVerified, true);
});

test("does not run resume verification before authorization", async (t) => {
  let resumeChecks = 0;
  const { orchestrator } = await setup(t, {
    authorize: async (request) => ({ allowed: request.action !== "task.resume" }),
    verifyResume: async () => {
      resumeChecks += 1;
      return true;
    },
  });
  await orchestrator.create(taskInput(), { principalId: "user:owner" });
  await orchestrator.transition("task-1", "planning", {
    principalId: "user:owner",
    expectedStatus: "queued",
  });
  await orchestrator.transition("task-1", "running", {
    principalId: "user:owner",
    expectedStatus: "planning",
  });
  await orchestrator.transition("task-1", "interrupted", {
    principalId: "user:owner",
    expectedStatus: "running",
  });
  await assert.rejects(
    orchestrator.transition("task-1", "queued", {
      principalId: "agent:untrusted",
      expectedStatus: "interrupted",
    }),
    (error) => error.code === "POLICY_DENIED",
  );
  assert.equal(resumeChecks, 0);
});

test("detects another writer and requires reload before continuing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-writers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new EventLedger(join(directory, "events.jsonl"));
  const allow = async () => ({ allowed: true });
  const first = new TaskOrchestrator({ ledger, authorize: allow });
  const second = new TaskOrchestrator({ ledger, authorize: allow });
  await first.initialize();
  await second.initialize();

  await first.create(taskInput("task-first"), { principalId: "user:owner" });
  await assert.rejects(
    second.create(taskInput("task-second"), { principalId: "user:owner" }),
    (error) => error.code === "PERSISTENCE_CONFLICT",
  );
  assert.throws(
    () => second.listTasks(),
    (error) => error.code === "NOT_INITIALIZED",
  );
  await second.initialize();
  assert.equal(second.listTasks().length, 1);
  assert.equal(second.getTask("task-first").status, "queued");
});
