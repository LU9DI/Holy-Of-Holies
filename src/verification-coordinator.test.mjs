import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { VerificationRunner } from "./verification-runner.mjs";
import { VerificationCoordinator } from "./verification-coordinator.mjs";
import { generateKeyPairSync } from "node:crypto";
import { VerificationEngine } from "./verification-engine.mjs";
import { VerificationAttestor } from "./verification-attestor.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "hoh-coordinator-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "check.mjs");
  await writeFile(script, 'process.stdout.write("ok");\n');
  const ledger = new EventLedger(path.join(dir, "audit", "events.jsonl"));
  const runner = new VerificationRunner({
    workspaceRoot: dir,
    commands: [{ id: "check", executable: process.execPath, args: [script], timeoutMs: 3000, maxOutputBytes: 4096, allowedExitCodes: [0] }],
    authorize: async () => ({ allowed: true }),
  });
  return { dir, ledger, runner };
}

function issuer({ verificationId, taskId, projectId, verifierId, outcome, resultHash }) {
  return {
    schemaVersion: 1,
    verificationId, taskId, projectId, verifierId, outcome, resultHash,
    issuedAt: "2026-10-09T12:00:00.000Z",
    expiresAt: "2026-10-09T12:05:00.000Z",
    signature: "a".repeat(128),
  };
}

test("records runner evidence without storing raw stdout or stderr and requests external attestation", async (t) => {
  const { ledger, runner } = await fixture(t);
  let issued = 0;
  const coordinator = new VerificationCoordinator({
    runner, ledger,
    attest: async (input) => { issued++; return issuer({ ...input, verifierId: "ci:trusted" }); },
    clock: () => new Date("2026-10-09T12:00:00.000Z"),
  });
  const result = await coordinator.execute({
    verificationId: "verify-1", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci",
  });
  assert.equal(result.report.outcome, "passed");
  assert.equal(issued, 1);
  assert.equal(result.attestation.resultHash, result.report.resultHash);
  assert.equal(result.completionEvidence.attestation.signature, result.attestation.signature);
  assert.equal(result.completionEvidence.resultHash, result.report.resultHash);
  const events = await ledger.read();
  assert.deepEqual(events.map((event) => event.type), ["verification.started", "verification.completed"]);
  assert.equal("stdout" in events[1].payload, false);
  assert.equal("stderr" in events[1].payload, false);
  assert.match(events[1].payload.attestation.signature, /^[a-f0-9]{128}$/);
  assert.equal(events[1].payload.attestation.resultHash, result.report.resultHash);
  assert.equal(events[1].payload.attestation.schemaVersion, 1);
});

test("does not request an attestation for failed checks", async (t) => {
  const { ledger, runner } = await fixture(t);
  const failingRunner = { run: async (input) => {
    const report = await runner.run(input);
    return { ...report, outcome: "failed" };
  }};
  let issued = false;
  const coordinator = new VerificationCoordinator({ runner: failingRunner, ledger, attest: async () => { issued = true; } });
  const result = await coordinator.execute({
    verificationId: "verify-fail", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci",
  });
  assert.equal(result.report.outcome, "failed");
  assert.equal(result.attestation, null);
  assert.equal(issued, false);
});

test("rejects duplicate verification IDs from durable history", async (t) => {
  const { ledger, runner } = await fixture(t);
  const coordinator = new VerificationCoordinator({ runner, ledger, attest: async (input) => issuer({ ...input, verifierId: "ci:trusted" }) });
  const request = { verificationId: "verify-dup", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci" };
  await coordinator.execute(request);
  await assert.rejects(coordinator.execute(request), (error) => error.code === "DUPLICATE_VERIFICATION");
});

test("rejects malformed requests and refuses an unbound attestation", async (t) => {
  const { ledger, runner } = await fixture(t);
  const coordinator = new VerificationCoordinator({ runner, ledger, attest: async (input) => issuer({ ...input, taskId: "other-task", verifierId: "ci:trusted" }) });
  await assert.rejects(
    coordinator.execute({ verificationId: "bad id", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci" }),
    (error) => error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    coordinator.execute({ verificationId: "verify-bad", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci" }),
    (error) => error.code === "INVALID_ATTESTATION",
  );
  const events = await ledger.read();
  assert.ok(events.some((event) => event.type === "verification.invalid_attestation"));
});

test("persists an attestation that a fresh verification engine can validate", async (t) => {
  const { ledger, runner } = await fixture(t);
  const keyPair = generateKeyPairSync("ed25519");
  const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });
  const clock = () => new Date("2026-10-09T12:00:00.000Z");
  const issuerEngine = new VerificationAttestor({ privateKey, trustedVerifiers: ["ci:trusted"], clock });
  const coordinator = new VerificationCoordinator({
    runner, ledger,
    attest: async (input) => issuerEngine.attest({ ...input, verifierId: "ci:trusted" }),
    clock,
  });
  const result = await coordinator.execute({
    verificationId: "verify-restart", taskId: "task-1", projectId: "project-1", commandId: "check", principalId: "ci",
  });
  const events = await ledger.read();
  const stored = events.find((event) => event.type === "verification.completed").payload.attestation;
  const restartedVerifier = new VerificationEngine({ publicKey, trustedVerifiers: ["ci:trusted"], clock });
  assert.equal(await restartedVerifier.verifyCompletion({
    task: { taskId: "task-1", projectId: "project-1" },
    evidence: {
      verificationId: stored.verificationId,
      verifierId: stored.verifierId,
      outcome: stored.outcome,
      resultHash: stored.resultHash,
      attestation: stored,
    },
  }), true);
  assert.equal(result.attestation.signature, stored.signature);
});
