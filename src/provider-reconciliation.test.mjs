import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { OperationRecovery } from "./operation-recovery.mjs";
import { createIdempotencyKey } from "./idempotency-key.mjs";
import { reconcileProviderOperation } from "./provider-reconciliation.mjs";

const inputHash = "a".repeat(64);
const providerScope = "payments:merchant-42";
async function setup(t, operationId = "op-provider-reconcile") {
  const dir = await mkdtemp(join(tmpdir(), "holy-provider-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recovery = new OperationRecovery({ ledger: new EventLedger(join(dir, "events.jsonl")) });
  await recovery.begin({
    operationId, principalId: "agent:worker", toolId: "payments.charge", inputHash, providerScope,
  });
  await recovery.interrupt({
    operationId, principalId: "agent:worker", toolId: "payments.charge", inputHash,
    providerScope,
    reason: "connection lost after dispatch",
  });
  return recovery;
}
function providerResult(expected, status = "confirmed_succeeded") {
  return { operationId: expected.operationId, providerScope: expected.providerScope,
    idempotencyKey: expected.idempotencyKey, status, providerReceipt: "receipt:abc" };
}
const verified = async (result, expected) => ({
  verified: result.operationId === expected.operationId &&
    result.providerScope === expected.providerScope &&
    result.idempotencyKey === expected.idempotencyKey,
  evidenceRef: "provider-audit:receipt-abc",
});

test("scope mismatch is rejected before the provider is queried", async (t) => {
  const recovery = await setup(t);
  let queried = false;

  await assert.rejects(reconcileProviderOperation({
    recovery,
    operationId: "op-provider-reconcile",
    providerScope: "payments:merchant-43",
    resolvedBy: "operator:reviewer",
    lookupOperation: async () => {
      queried = true;
      return {};
    },
    verifyEvidence: verified,
  }), (error) => error.code === "PROVIDER_SCOPE_MISMATCH");

  assert.equal(queried, false);
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});

test("legacy unresolved operation without a durable provider scope is not queried", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "holy-provider-reconcile-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recovery = new OperationRecovery({ ledger: new EventLedger(join(dir, "events.jsonl")) });
  await recovery.recordInterrupted({
    operationId: "op-provider-legacy",
    principalId: "agent:worker",
    toolId: "payments.charge",
    inputHash,
    reason: "legacy interruption without provider binding",
  });
  let queried = false;

  await assert.rejects(reconcileProviderOperation({
    recovery,
    operationId: "op-provider-legacy",
    providerScope,
    resolvedBy: "operator:reviewer",
    lookupOperation: async () => {
      queried = true;
      return {};
    },
    verifyEvidence: verified,
  }), (error) => error.code === "PROVIDER_SCOPE_NOT_JOURNALED");

  assert.equal(queried, false);
  assert.equal((await recovery.get("op-provider-legacy")).status, "unknown_after_interruption");
});

test("reconciles only after a provider response is bound to the exact operation and verified", async (t) => {
  const recovery = await setup(t);
  let expectedLookup;
  const result = await reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async (expected) => {
      expectedLookup = expected;
      return providerResult(expected);
    },
    verifyEvidence: verified,
  });
  assert.equal(expectedLookup.idempotencyKey, createIdempotencyKey({
    providerScope: "payments:merchant-42", operationId: "op-provider-reconcile",
  }));
  assert.equal(result.status, "confirmed_succeeded");
  assert.equal(result.resolved, true);
  assert.equal(result.retryAutomatically, false);
  assert.equal((await recovery.get("op-provider-reconcile")).resolution.resolution, "confirmed_succeeded");
});

test("unknown provider state stays unresolved and never triggers a retry", async (t) => {
  const recovery = await setup(t);
  const result = await reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async (expected) => providerResult(expected, "unknown"),
    verifyEvidence: verified,
  });
  assert.equal(result.resolved, false);
  assert.equal(result.retryAutomatically, false);
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});

test("rejects provider responses bound to a different key or account without resolving", async (t) => {
  const recovery = await setup(t);
  await assert.rejects(reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async (expected) => ({ ...providerResult(expected), idempotencyKey: "wrong-key" }),
    verifyEvidence: verified,
  }), (error) => error.code === "PROVIDER_BINDING_MISMATCH");
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});

test("unverified evidence cannot resolve an operation", async (t) => {
  const recovery = await setup(t);
  await assert.rejects(reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async (expected) => providerResult(expected, "confirmed_not_executed"),
    verifyEvidence: async () => ({ verified: false, evidenceRef: "untrusted:claim" }),
  }), (error) => error.code === "PROVIDER_EVIDENCE_UNVERIFIED");
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});

test("lookup failure preserves uncertainty instead of inferring non-execution", async (t) => {
  const recovery = await setup(t);
  await assert.rejects(reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async () => { throw new Error("provider unavailable"); },
    verifyEvidence: verified,
  }), /provider unavailable/);
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});

test("rejects terminal or missing operations before querying the provider", async (t) => {
  const recovery = await setup(t);
  await recovery.resolve({
    operationId: "op-provider-reconcile", resolvedBy: "operator:reviewer",
    resolution: "confirmed_failed", evidenceRef: "manual-audit:1",
  });
  let queried = false;
  await assert.rejects(reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "operator:reviewer",
    lookupOperation: async () => { queried = true; },
    verifyEvidence: verified,
  }), (error) => error.code === "OPERATION_NOT_PENDING");
  assert.equal(queried, false);
});

test("does not permit the original principal to resolve through the provider adapter", async (t) => {
  const recovery = await setup(t);
  await assert.rejects(reconcileProviderOperation({
    recovery, operationId: "op-provider-reconcile", providerScope: "payments:merchant-42",
    resolvedBy: "agent:worker",
    lookupOperation: async (expected) => providerResult(expected),
    verifyEvidence: verified,
  }), (error) => error.code === "INDEPENDENT_REVIEW_REQUIRED");
  assert.equal((await recovery.get("op-provider-reconcile")).status, "unknown_after_interruption");
});
