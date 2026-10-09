import test from "node:test";
import assert from "node:assert/strict";
import { VerificationEngine } from "./verification-engine.mjs";

const key = "test-only-secret-key-at-least-32-bytes-long";
const task = { taskId: "task-42", projectId: "project-7" };
const evidence = {
  verificationId: "verify-42",
  verifierId: "ci:trusted",
  outcome: "passed",
  resultHash: "a".repeat(64),
};

function engine(clock = () => new Date("2026-10-09T12:00:00Z")) {
  return new VerificationEngine({ key, trustedVerifiers: ["ci:trusted"], clock });
}
function report(overrides = {}) {
  return {
    ...evidence,
    taskId: task.taskId,
    projectId: task.projectId,
    issuedAt: "2026-10-09T11:59:00Z",
    expiresAt: "2026-10-09T12:05:00Z",
    ...overrides,
  };
}

test("accepts an authentic, current attestation bound to task and project", async () => {
  const verifier = engine();
  verifier.attest(report());
  assert.equal(await verifier.verifyCompletion({ task, evidence }), true);
});

test("rejects unknown, forged, mismatched, revoked, and expired attestations", async () => {
  const verifier = engine();
  assert.equal(await verifier.verifyCompletion({ task, evidence }), false);
  verifier.attest(report());
  assert.equal(await verifier.verifyCompletion({ task: { ...task, taskId: "task-other" }, evidence }), false);
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, resultHash: "b".repeat(64) } }), false);
  verifier.revoke(evidence.verificationId);
  assert.equal(await verifier.verifyCompletion({ task, evidence }), false);

  let expiredNow = new Date("2026-10-09T12:00:00Z");
  const expired = new VerificationEngine({ key, trustedVerifiers: ["ci:trusted"], clock: () => expiredNow });
  expired.attest(report({ verificationId: "verify-expired", issuedAt: "2026-10-09T11:59:00Z", expiresAt: "2026-10-09T12:04:00Z" }));
  expiredNow = new Date("2026-10-09T12:20:00Z");
  assert.equal(await expired.verifyCompletion({ task, evidence: { ...evidence, verificationId: "verify-expired" } }), false);
});

test("rejects untrusted verifiers and failed outcomes", () => {
  const verifier = engine();
  assert.throws(() => verifier.attest(report({ verifierId: "agent:untrusted" })), (error) => error.code === "UNTRUSTED_VERIFIER");
  assert.throws(() => verifier.attest(report({ outcome: "failed" })), (error) => error.code === "INVALID_REPORT");
});

test("rejects malformed keys and excessive attestation windows", () => {
  assert.throws(() => new VerificationEngine({ key: "short", trustedVerifiers: ["ci:trusted"] }), /32 bytes/);
  const verifier = engine();
  assert.throws(() => verifier.attest(report({ expiresAt: "2026-10-09T12:20:00Z" })), (error) => error.code === "INVALID_REPORT_WINDOW");
});

test("rejects attestation when clock moves past expiry", async () => {
  let now = new Date("2026-10-09T12:00:00Z");
  const verifier = new VerificationEngine({ key, trustedVerifiers: ["ci:trusted"], clock: () => now });
  verifier.attest(report());
  now = new Date("2026-10-09T12:06:00Z");
  assert.equal(await verifier.verifyCompletion({ task, evidence }), false);
});
