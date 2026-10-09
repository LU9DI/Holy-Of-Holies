import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "./event-ledger.mjs";
import { RevocationRegistry } from "./revocation-registry.mjs";
import { VerificationEngine } from "./verification-engine.mjs";
import { VerificationAttestor } from "./verification-attestor.mjs";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const task = { taskId: "task-42", projectId: "project-7" };
const evidence = { verificationId: "verify-42", verifierId: "ci:trusted", outcome: "passed", resultHash: "a".repeat(64) };
const clock = () => new Date("2026-10-09T12:00:00Z");
function report() {
  return { ...evidence, ...task, issuedAt: "2026-10-09T11:59:00Z", expiresAt: "2026-10-09T12:05:00Z" };
}
async function temporaryLedger(t, directory) {
  const path = join(directory, "events.jsonl");
  const ledger = new EventLedger(path);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { ledger, path };
}

test("revocation is durable across registry and verifier restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-revocation-"));
  const { ledger, path } = await temporaryLedger(t, directory);
  const issuer = new VerificationAttestor({ privateKey, trustedVerifiers: ["ci:trusted"], clock });
  const signed = issuer.attest(report());
  const registry = new RevocationRegistry({ ledger, clock });
  const verifier = new VerificationEngine({ publicKey, trustedVerifiers: ["ci:trusted"], clock, revocationRegistry: registry });
  const persistedEvidence = { ...evidence, attestation: signed };
  assert.equal(await verifier.verifyCompletion({ task, evidence: persistedEvidence }), true);
  assert.equal(await verifier.revokePersistently(evidence.verificationId, { reason: "runner compromised", actorId: "security:ops" }), true);
  assert.equal(await verifier.verifyCompletion({ task, evidence: persistedEvidence }), false);

  const restartedRegistry = new RevocationRegistry({ ledger: new EventLedger(path), clock });
  const restartedVerifier = new VerificationEngine({ publicKey, trustedVerifiers: ["ci:trusted"], clock, revocationRegistry: restartedRegistry });
  assert.equal(await restartedVerifier.verifyCompletion({ task, evidence: persistedEvidence }), false);
  assert.equal(await restartedRegistry.isRevoked(evidence.verificationId), true);
});

test("revocation is idempotent and validates audit metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-revocation-"));
  const { ledger } = await temporaryLedger(t, directory);
  const registry = new RevocationRegistry({ ledger, clock });
  assert.equal((await registry.revoke("verify-1", { reason: "bad result", actorId: "operator-1" })).revoked, true);
  assert.equal((await registry.revoke("verify-1", { reason: "duplicate", actorId: "operator-1" })).alreadyRevoked, true);
  assert.equal((await ledger.read()).filter((event) => event.type === "verification.revoked").length, 1);
  await assert.rejects(registry.revoke("../bad", { reason: "reason", actorId: "operator-1" }), /verificationId/);
  await assert.rejects(registry.revoke("verify-2", { reason: "", actorId: "operator-1" }), /reason/);
});

test("verification fails closed if durable revocation storage is unavailable", async () => {
  const brokenRegistry = { async isRevoked() { throw new Error("store offline"); }, async revoke() {} };
  const issuer = new VerificationAttestor({ privateKey, trustedVerifiers: ["ci:trusted"], clock });
  const signed = issuer.attest(report());
  const verifier = new VerificationEngine({ publicKey, trustedVerifiers: ["ci:trusted"], clock, revocationRegistry: brokenRegistry });
  assert.equal(await verifier.verifyCompletion({ task, evidence: { ...evidence, attestation: signed } }), false);
});


test("revocation retries a stale ledger head without losing the revocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "holy-revocation-race-"));
  const { ledger } = await temporaryLedger(t, directory);
  let injectConcurrentEvent = true;
  const racingLedger = {
    async read() {
      const snapshot = await ledger.read();
      if (injectConcurrentEvent) {
        injectConcurrentEvent = false;
        await ledger.append({
          type: "test.concurrent_writer",
          at: clock().toISOString(),
          payload: { marker: "interleaved" },
          expectedHeadHash: snapshot.at(-1)?.hash ?? "0".repeat(64),
        });
      }
      return snapshot;
    },
    append: (...args) => ledger.append(...args),
  };
  const registry = new RevocationRegistry({ ledger: racingLedger, clock });
  const result = await registry.revoke("verify-race", { reason: "stale report", actorId: "operator-2" });
  assert.equal(result.revoked, true);
  assert.equal(await registry.isRevoked("verify-race"), true);
  const events = await ledger.read();
  assert.equal(events.filter((event) => event.type === "verification.revoked").length, 1);
  assert.ok(events.findIndex((event) => event.type === "test.concurrent_writer") <
    events.findIndex((event) => event.type === "verification.revoked"));
});
