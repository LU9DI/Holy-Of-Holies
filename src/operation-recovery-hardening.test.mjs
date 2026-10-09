import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { OperationRecovery } from "./operation-recovery.mjs";

const binding = {
  operationId: "op-history-check",
  principalId: "agent:worker",
  toolId: "billing.charge",
  inputHash: "a".repeat(64),
};

async function ledgerInTemp(t) {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-hardening-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new EventLedger(join(dir, "events.jsonl"));
}

test("recovery rejects a hash-valid completion event without a matching start", async (t) => {
  const ledger = await ledgerInTemp(t);
  await ledger.append({ type: "operation.completed", payload: binding });
  const recovery = new OperationRecovery({ ledger });
  await assert.rejects(recovery.inspect(), (error) => error.code === "RECOVERY_LEDGER_INVALID");
});

test("recovery rejects completion after a terminal pre-dispatch abort", async (t) => {
  const ledger = await ledgerInTemp(t);
  await ledger.append({ type: "operation.started", payload: binding });
  await ledger.append({
    type: "operation.aborted_before_dispatch",
    payload: { ...binding, reason: "cancelled_before_dispatch" },
  });
  await ledger.append({ type: "operation.completed", payload: binding });
  const recovery = new OperationRecovery({ ledger });
  await assert.rejects(recovery.get(binding.operationId), (error) => error.code === "RECOVERY_LEDGER_INVALID");
});

test("recovery rejects conflicting second resolution even when the event hash chain is valid", async (t) => {
  const ledger = await ledgerInTemp(t);
  await ledger.append({ type: "operation.started", payload: binding });
  await ledger.append({
    type: "operation.resolved",
    payload: {
      operationId: binding.operationId,
      resolvedBy: "operator:first",
      resolution: "confirmed_succeeded",
      evidenceRef: "audit:first",
    },
  });
  await ledger.append({
    type: "operation.resolved",
    payload: {
      operationId: binding.operationId,
      resolvedBy: "operator:second",
      resolution: "confirmed_failed",
      evidenceRef: "audit:second",
    },
  });
  const recovery = new OperationRecovery({ ledger });
  await assert.rejects(recovery.inspect(), (error) => error.code === "RECOVERY_LEDGER_INVALID");
});

test("a failed durable intent write prevents side-effect dispatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-write-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new EventLedger(join(dir, "events.jsonl"));
  const recovery = new OperationRecovery({
    ledger: {
      read: () => ledger.read(),
      append: async (event) => {
        if (event.type === "operation.started") throw new Error("simulated storage failure");
        return ledger.append(event);
      },
    },
  });
  await assert.rejects(
    recovery.begin(binding),
    /simulated storage failure/,
  );
  assert.equal((await ledger.read()).length, 0);
});
