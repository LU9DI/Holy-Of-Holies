import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { VerificationEngine } from "./verification-engine.mjs";
import { VerificationAttestor } from "./verification-attestor.mjs";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const task = { taskId: "task-42", projectId: "project-7" };
const evidence = { verificationId: "verify-42", verifierId: "ci:trusted", outcome: "passed", resultHash: "a".repeat(64) };
const clock = () => new Date("2026-10-09T12:00:00Z");
const engine = (overrides = {}) => new VerificationEngine({ publicKey, trustedVerifiers: ["ci:trusted"], clock, ...overrides });
const attestor = (overrides = {}) => new VerificationAttestor({ privateKey, trustedVerifiers: ["ci:trusted"], clock, ...overrides });
function report(overrides = {}) {
  return { ...evidence, ...task, issuedAt: "2026-10-09T11:59:00Z", expiresAt: "2026-10-09T12:05:00Z", ...overrides };
}

test("public-key verifier accepts authentic attestations but cannot sign", async () => {
  const signed = attestor().attest(report());
  const verifier = engine();
  assert.equal(typeof verifier.attest, "undefined");
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, attestation: signed } }), true);
});

test("rejects unknown, forged, mismatched, revoked, and expired attestations", async () => {
  const verifier = engine();
  const signer = attestor();
  const signed = signer.attest(report());
  assert.equal(await verifier.verifyCompletion({ task, evidence }), false);
  assert.equal(await verifier.verifyCompletion({ task: { ...task, taskId: "task-other" }, evidence: { ...evidence, attestation: signed } }), false);
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, resultHash: "b".repeat(64), attestation: signed } }), false);
  verifier.revoke(evidence.verificationId);
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, attestation: signed } }), false);
  assert.throws(() => signer.attest(report()), (error) => error.code === "DUPLICATE_VERIFICATION");

  let now = new Date("2026-10-09T12:00:00Z");
  const verifierWithClock = engine({ clock: () => now });
  const signerWithClock = attestor({ clock: () => now });
  const expiring = signerWithClock.attest(report({ verificationId: "verify-expired", expiresAt: "2026-10-09T12:04:00Z" }));
  now = new Date("2026-10-09T12:20:00Z");
  assert.equal(await verifierWithClock.verifyCompletion({ task, evidence: { ...evidence, verificationId: "verify-expired", attestation: expiring } }), false);
});

test("rejects untrusted verifiers, failed outcomes, invalid keys, and excessive windows", () => {
  const signer = attestor();
  assert.throws(() => signer.attest(report({ verifierId: "agent:untrusted" })), (error) => error.code === "UNTRUSTED_VERIFIER");
  assert.throws(() => signer.attest(report({ outcome: "failed" })), (error) => error.code === "INVALID_REPORT");
  assert.throws(() => signer.attest(report({ workspaceHash: "bad", workspaceHashAfter: "bad" })), (error) => error.code === "INVALID_REPORT");
  assert.throws(() => signer.attest(report({ workspaceHash: "a".repeat(64), workspaceHashAfter: "b".repeat(64) })), (error) => error.code === "INVALID_REPORT");
  assert.throws(() => new VerificationEngine({ publicKey: "short", trustedVerifiers: ["ci:trusted"] }), /Ed25519 public key/);
  assert.throws(() => new VerificationAttestor({ privateKey: "short", trustedVerifiers: ["ci:trusted"] }), /Ed25519 private key/);
  assert.throws(() => signer.attest(report({ expiresAt: "2026-10-09T12:20:00Z" })), (error) => error.code === "INVALID_REPORT_WINDOW");
});

test("rejects expired signatures after clock advances", async () => {
  let now = new Date("2026-10-09T12:00:00Z");
  const signer = attestor({ clock: () => now });
  const verifier = engine({ clock: () => now });
  const signed = signer.attest(report());
  now = new Date("2026-10-09T12:06:00Z");
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, attestation: signed } }), false);
});

test("verifies persisted Ed25519 attestations after verifier restart and rejects forgery", async () => {
  const signed = attestor().attest(report());
  const restarted = engine();
  assert.equal(await restarted.verifyCompletion({ task, evidence: { ...evidence, attestation: signed } }), true);
  assert.equal(await restarted.verifyCompletion({ task: { ...task, projectId: "other-project" }, evidence: { ...evidence, attestation: signed } }), false);
  const forged = { ...signed, resultHash: "b".repeat(64) };
  assert.equal(await restarted.verifyCompletion({ task, evidence: { ...evidence, resultHash: forged.resultHash, attestation: forged } }), false);
});

test("binds workspace digest to signed evidence and optional task revision", async () => {
  const digest = "c".repeat(64);
  const signed = attestor().attest(report({ verificationId: "verify-workspace", workspaceHash: digest, workspaceHashAfter: digest }));
  const verifier = engine({ getWorkspaceDigest: async () => digest });
  const workspaceEvidence = {
    ...evidence, verificationId: "verify-workspace", workspaceHash: digest, workspaceHashAfter: digest, attestation: signed,
  };
  assert.equal(await verifier.verifyCompletion({ task, evidence: workspaceEvidence }), true);
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...workspaceEvidence, workspaceHash: "d".repeat(64) } }), false);
  assert.equal(await verifier.verifyCompletion({ task: { ...task, workspaceHash: "d".repeat(64) }, evidence: workspaceEvidence }), false);
  assert.equal(await engine().verifyCompletion({ task, evidence: workspaceEvidence }), false);
  assert.equal(await engine({ getWorkspaceDigest: async () => "d".repeat(64) }).verifyCompletion({ task, evidence: workspaceEvidence }), false);
});
