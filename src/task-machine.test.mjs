import test from "node:test";
import assert from "node:assert/strict";
import { createTask, transitionTask } from "./task-machine.mjs";

function input(overrides = {}) {
  return {
    taskId: "task-1",
    projectId: "project-1",
    objective: "Inspect the project and propose a safe change",
    policyVersion: "policy-v1",
    permissions: {
      filesystem: "read",
      network: "none",
      execution: "none",
    },
    resourceLimits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      maxConcurrentChildren: 2,
    },
    ...overrides,
  };
}

test("creates a queued task with deterministic timestamps and creation event", () => {
  const task = createTask(input(), { now: "2026-01-01T00:00:00.000Z" });
  assert.equal(task.status, "queued");
  assert.equal(task.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(task.events.length, 1);
  assert.equal(task.events[0].type, "task.created");
  assert.ok(Object.isFrozen(task));
  assert.ok(Object.isFrozen(task.permissions));
});

test("rejects invalid limits, unknown permissions and self-parenting", () => {
  assert.throws(
    () => createTask(input({ resourceLimits: { timeoutMs: 0, maxOutputBytes: 1, maxConcurrentChildren: 0 } })),
    /timeoutMs/,
  );
  assert.throws(
    () => createTask(input({ permissions: { filesystem: "read", network: "none", execution: "none", shell: "enabled" } })),
    /unknown fields/,
  );
  assert.throws(
    () => createTask(input({ parentTaskId: "task-1" })),
    /own parent/,
  );
  assert.throws(
    () => createTask(input({ taskId: " task-1 ", parentTaskId: "task-1" })),
    /own parent/,
  );
});

test("enforces the legal lifecycle and prevents terminal-state mutation", () => {
  const queued = createTask(input());
  assert.throws(() => transitionTask(queued, "completed"), /invalid task transition/);
  const planning = transitionTask(queued, "planning");
  const running = transitionTask(planning, "running");
  const verifying = transitionTask(running, "verifying");
  const completed = transitionTask(verifying, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.events.length, 5);
  assert.throws(() => transitionTask(completed, "queued"), /terminal task status/);
  assert.equal(queued.status, "queued", "transitions must not mutate prior snapshots");
});

test("requires an explicit approver for tasks gated by approval", () => {
  const task = createTask(input({ requiresApproval: true }));
  const planning = transitionTask(task, "planning");
  assert.throws(() => transitionTask(planning, "running"), /requires approval/);
  const waiting = transitionTask(planning, "awaiting_approval");
  assert.throws(() => transitionTask(waiting, "running"), /explicit approval/);
  const running = transitionTask(waiting, "running", {
    approved: true,
    approvedBy: "user:local-owner",
  });
  assert.equal(running.status, "running");
  assert.equal(running.events.at(-1).approvedBy, "user:local-owner");
});

test("interrupted tasks require resume verification before requeue", () => {
  const task = createTask(input());
  const planning = transitionTask(task, "planning");
  const running = transitionTask(planning, "running");
  const interrupted = transitionTask(running, "interrupted");
  assert.throws(() => transitionTask(interrupted, "queued"), /resume verification/);
  const resumed = transitionTask(interrupted, "queued", { resumeVerified: true });
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.events.at(-1).resumeVerified, true);
});
