import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { OperationRecovery, OperationRecoveryError } from "./operation-recovery.mjs";

const hash = "a".repeat(64);
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new EventLedger(join(dir, "events.jsonl"));
  return new OperationRecovery({ ledger, clock: () => new Date("2026-10-09T12:00:00Z") });
}
const interrupted = {
  operationId: "op-001", principalId: "agent:worker", toolId: "billing.charge",
  inputHash: hash, reason: "connection lost after dispatch",
};

test("records unknown outcome durably and never recommends automatic retry", async (t) => {
  const recovery = await setup(t);
  await recovery.recordInterrupted(interrupted);
  const status = await recovery.get("op-001");
  assert.equal(status.status, "unknown_after_interruption");
  assert.equal(status.retryAutomatically, false);
  assert.equal(status.interrupted.inputHash, hash);
});

test("identical interruption recording is idempotent but conflicting reuse is rejected", async (t) => {
  const recovery = await setup(t);
  const first = await recovery.recordInterrupted(interrupted);
  const duplicate = await recovery.recordInterrupted(interrupted);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    recovery.recordInterrupted({ ...interrupted, inputHash: "b".repeat(64) }),
    (error) => error.code === "OPERATION_ID_CONFLICT",
  );
});

test("requires independent evidence-backed resolution and rejects second resolution", async (t) => {
  const recovery = await setup(t);
  await recovery.recordInterrupted(interrupted);
  await assert.rejects(
    recovery.resolve({ operationId: "op-001", resolvedBy: "agent:worker", resolution: "confirmed_succeeded", evidenceRef: "receipt:123" }),
    (error) => error.code === "INDEPENDENT_REVIEW_REQUIRED",
  );
  await assert.rejects(
    recovery.resolve({ operationId: "op-001", resolvedBy: "operator:1", resolution: "confirmed_succeeded" }),
    (error) => error.code === "EVIDENCE_REQUIRED",
  );
  await recovery.resolve({ operationId: "op-001", resolvedBy: "operator:1", resolution: "confirmed_not_executed", evidenceRef: "provider-audit:456" });
  const status = await recovery.get("op-001");
  assert.equal(status.status, "resolved");
  assert.equal(status.resolution.resolution, "confirmed_not_executed");
  assert.equal(status.retryAutomatically, false);
  await assert.rejects(
    recovery.resolve({ operationId: "op-001", resolvedBy: "operator:2", resolution: "confirmed_failed", evidenceRef: "audit:789" }),
    (error) => error.code === "OPERATION_ALREADY_RESOLVED",
  );
});

test("rejects missing operations and unsupported retry decisions", async (t) => {
  const recovery = await setup(t);
  await assert.rejects(
    recovery.resolve({ operationId: "missing", resolvedBy: "operator:1", resolution: "retry", evidenceRef: "ticket:1" }),
    (error) => error.code === "INVALID_RESOLUTION",
  );
  assert.equal(await recovery.get("missing"), null);
});

test("reconstructs pending and resolved operations from a fresh instance after restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "events.jsonl");
  const first = new OperationRecovery({ ledger: new EventLedger(ledgerPath) });
  await first.recordInterrupted(interrupted);
  await first.recordInterrupted({ ...interrupted, operationId: "op-002" });
  await first.resolve({ operationId: "op-002", resolvedBy: "operator:1", resolution: "confirmed_succeeded", evidenceRef: "receipt:op-002" });

  const restarted = new OperationRecovery({ ledger: new EventLedger(ledgerPath) });
  const snapshot = await restarted.inspect();
  assert.deepEqual(snapshot.pending.map((item) => item.operationId), ["op-001"]);
  assert.deepEqual(snapshot.resolved.map((item) => item.operationId), ["op-002"]);
  assert.equal(snapshot.pending[0].retryAutomatically, false);
  assert.equal(snapshot.resolved[0].resolution.resolution, "confirmed_succeeded");
});

test("fails closed when durable ledger contains an orphan resolution", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-corrupt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new EventLedger(join(dir, "events.jsonl"));
  await ledger.append({
    type: "operation.resolved",
    payload: { operationId: "op-orphan", resolvedBy: "operator:1", resolution: "confirmed_failed", evidenceRef: "audit:1" },
  });
  const recovery = new OperationRecovery({ ledger });
  await assert.rejects(recovery.inspect(), (error) => error.code === "RECOVERY_LEDGER_INVALID");
});

test("rejects resolution events that precede interruption or violate independent review", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-recovery-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new EventLedger(join(dir, "events.jsonl"));
  const resolution = (operationId, resolvedBy) => ({
    type: "operation.resolved",
    payload: { operationId, resolvedBy, resolution: "confirmed_failed", evidenceRef: "audit:order" },
  });
  await ledger.append(resolution("op-before", "operator:1"));
  await ledger.append({
    type: "operation.interrupted",
    payload: { ...interrupted, operationId: "op-before" },
  });
  const recovery = new OperationRecovery({ ledger });
  await assert.rejects(recovery.inspect(), (error) => error.code === "RECOVERY_LEDGER_INVALID");

  const secondDir = await mkdtemp(join(tmpdir(), "holy-recovery-review-"));
  t.after(() => rm(secondDir, { recursive: true, force: true }));
  const secondLedger = new EventLedger(join(secondDir, "events.jsonl"));
  await secondLedger.append({
    type: "operation.interrupted",
    payload: { ...interrupted, operationId: "op-same-principal" },
  });
  await secondLedger.append(resolution("op-same-principal", interrupted.principalId));
  const secondRecovery = new OperationRecovery({ ledger: secondLedger });
  await assert.rejects(secondRecovery.inspect(), (error) => error.code === "RECOVERY_LEDGER_INVALID");
});
