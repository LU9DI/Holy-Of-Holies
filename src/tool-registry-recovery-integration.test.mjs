import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { OperationRecovery } from "./operation-recovery.mjs";
import { ToolRegistry } from "./tool-registry.mjs";

const now = () => new Date("2026-10-09T12:00:00Z");
const approval = {
  approved: true,
  approvalId: "approval-integration",
  approvedBy: "user:reviewer",
  expiresAt: "2026-10-09T12:10:00Z",
};
const request = {
  toolId: "billing.charge",
  principalId: "agent:worker",
  operationId: "op-integration",
  input: { amount: 17 },
  approval,
};
const definition = (handler) => ({
  toolId: "billing.charge",
  description: "Perform a controlled billing action",
  readOnly: false,
  inputSchema: {
    type: "object",
    required: ["amount"],
    additionalProperties: false,
    properties: { amount: { type: "integer", minimum: 1 } },
  },
  outputSchema: { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } },
  handler,
});

async function setup(t, { appendFailure, handler, consumeApproval = async () => true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "holy-tool-recovery-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "operations.jsonl");
  const ledger = new EventLedger(path);
  const wrappedLedger = appendFailure
    ? {
        read: () => ledger.read(),
        append: async (event, options) => {
          if (appendFailure(event)) throw new Error("simulated durable storage failure");
          return ledger.append(event, options);
        },
      }
    : ledger;
  const recovery = new OperationRecovery({ ledger: wrappedLedger, clock: now });
  const tools = new ToolRegistry({
    authorize: async () => ({ allowed: true }),
    consumeApproval,
    operationJournal: recovery,
    clock: now,
  });
  let dispatched = 0;
  tools.register(definition(async () => {
    dispatched += 1;
    return handler ? handler() : { ok: true };
  }));
  return { tools, recovery, ledger, path, get dispatched() { return dispatched; } };
}

test("failed durable intent prevents handler dispatch", async (t) => {
  const env = await setup(t, { appendFailure: (event) => event.type === "operation.started" });
  await assert.rejects(
    env.tools.invoke(request),
    (error) => error.code === "OPERATION_JOURNAL_BEGIN_FAILED",
  );
  assert.equal(env.dispatched, 0);
  assert.equal((await env.ledger.read()).length, 0);
});

test("handler failure is durably interrupted and cannot be mistaken for safe retry", async (t) => {
  const env = await setup(t, { handler: async () => { throw new Error("simulated handler failure"); } });
  await assert.rejects(
    env.tools.invoke(request),
    (error) => error.code === "TOOL_EXECUTION_FAILED" && error.outcomeUnknown === true,
  );
  assert.equal(env.dispatched, 1);
  assert.equal((await env.recovery.get(request.operationId)).status, "unknown_after_interruption");
  assert.equal((await env.recovery.inspect()).pending[0].retryAutomatically, false);
});

test("failed completion persistence surfaces outcome uncertainty and retains started state", async (t) => {
  const env = await setup(t, { appendFailure: (event) => event.type === "operation.completed" });
  await assert.rejects(
    env.tools.invoke(request),
    (error) => error.code === "OPERATION_JOURNAL_COMPLETE_FAILED" && error.outcomeUnknown === true,
  );
  assert.equal(env.dispatched, 1);
  assert.equal((await env.recovery.get(request.operationId)).status, "in_flight_after_restart");
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.started").length, 1);
  assert.equal((await env.ledger.read()).some((event) => event.type === "operation.completed"), false);
});

test("approval-consumption failure blocks dispatch and leaves no operation intent", async (t) => {
  const env = await setup(t, { consumeApproval: async () => { throw new Error("approval store unavailable"); } });
  await assert.rejects(
    env.tools.invoke(request),
    (error) => error.code === "APPROVAL_NOT_CONSUMED",
  );
  assert.equal(env.dispatched, 0);
  assert.equal((await env.ledger.read()).length, 0);
});


test("concurrent duplicate operation IDs never dispatch the side effect twice", async (t) => {
  const env = await setup(t);
  const outcomes = await Promise.allSettled([
    env.tools.invoke(request),
    env.tools.invoke(request),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = outcomes.find((item) => item.status === "rejected");
  assert.ok(["OPERATION_ALREADY_CLAIMED", "OPERATION_JOURNAL_BEGIN_FAILED"].includes(rejected.reason.code));
  assert.equal(env.dispatched, 1);
  assert.equal((await env.recovery.get(request.operationId)).status, "completed");
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.started").length, 1);
});


test("a recreated registry cannot redispatch a completed operation after restart", async (t) => {
  const env = await setup(t);
  await env.tools.invoke(request);
  assert.equal(env.dispatched, 1);

  let restartedDispatches = 0;
  const restartedRecovery = new OperationRecovery({ ledger: new EventLedger(env.path), clock: now });
  const restartedTools = new ToolRegistry({
    authorize: async () => ({ allowed: true }),
    consumeApproval: async () => true,
    operationJournal: restartedRecovery,
    clock: now,
  });
  restartedTools.register(definition(async () => {
    restartedDispatches += 1;
    return { ok: true };
  }));

  await assert.rejects(
    restartedTools.invoke(request),
    (error) => error.code === "OPERATION_ALREADY_CLAIMED",
  );
  assert.equal(restartedDispatches, 0);
  assert.equal((await restartedRecovery.get(request.operationId)).status, "completed");
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.started").length, 1);
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.completed").length, 1);
});


test("a restarted registry never retries an operation whose external outcome is uncertain", async (t) => {
  const env = await setup(t, { appendFailure: (event) => event.type === "operation.completed" });
  await assert.rejects(
    env.tools.invoke(request),
    (error) => error.code === "OPERATION_JOURNAL_COMPLETE_FAILED" && error.outcomeUnknown === true,
  );
  assert.equal(env.dispatched, 1);

  let restartedDispatches = 0;
  const restartedRecovery = new OperationRecovery({ ledger: new EventLedger(env.path), clock: now });
  const restartedTools = new ToolRegistry({
    authorize: async () => ({ allowed: true }),
    consumeApproval: async () => true,
    operationJournal: restartedRecovery,
    clock: now,
  });
  restartedTools.register(definition(async () => {
    restartedDispatches += 1;
    return { ok: true };
  }));

  await assert.rejects(
    restartedTools.invoke(request),
    (error) => error.code === "OPERATION_ALREADY_CLAIMED",
  );
  assert.equal(restartedDispatches, 0);
  assert.equal((await restartedRecovery.get(request.operationId)).status, "in_flight_after_restart");
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.started").length, 1);
  assert.equal((await env.ledger.read()).filter((event) => event.type === "operation.completed").length, 0);
});
