import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { createDurableToolRegistry } from "./durable-tool-registry.mjs";

test("durable registry composition journals side effects and refuses missing operation IDs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-durable-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new EventLedger(join(dir, "operations.jsonl"));
  const { tools, recovery } = createDurableToolRegistry({
    ledger,
    authorize: async () => ({ allowed: true }),
    consumeApproval: async () => true,
    clock: () => new Date("2026-10-09T12:00:00Z"),
  });

  let dispatches = 0;
  tools.register({
    toolId: "billing.charge",
    description: "Test side-effecting action",
    readOnly: false,
    inputSchema: { type: "object", required: ["amount"], additionalProperties: false, properties: { amount: { type: "integer", minimum: 1 } } },
    outputSchema: { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } },
    handler: async () => { dispatches += 1; return { ok: true }; },
  });

  const approval = {
    approved: true,
    approvalId: "approval-durable-composition",
    approvedBy: "user:reviewer",
    expiresAt: "2026-10-09T12:10:00Z",
  };
  const request = {
    toolId: "billing.charge",
    principalId: "agent:planner",
    input: { amount: 10 },
    approval,
  };

  await assert.rejects(
    tools.invoke(request),
    (error) => error.code === "OPERATION_ID_REQUIRED",
  );
  assert.equal(dispatches, 0);

  const result = await tools.invoke({ ...request, operationId: "op-durable-composition" });
  assert.deepEqual(result, { ok: true });
  assert.equal(dispatches, 1);
  assert.equal((await recovery.get("op-durable-composition")).status, "completed");

  const restarted = createDurableToolRegistry({
    ledger: new EventLedger(join(dir, "operations.jsonl")),
    authorize: async () => ({ allowed: true }),
    consumeApproval: async () => true,
  });
  assert.equal((await restarted.recovery.get("op-durable-composition")).status, "completed");
});

test("durable registry composition rejects missing security dependencies", () => {
  assert.throws(() => createDurableToolRegistry(), /durable event ledger/);
  assert.throws(() => createDurableToolRegistry({
    ledger: { read: async () => [], append: async () => ({}) },
  }), /policy evaluator/);
  assert.throws(() => createDurableToolRegistry({
    ledger: { read: async () => [], append: async () => ({}) },
    authorize: async () => ({ allowed: true }),
  }), /approval consumer/);
});
