import { createPublicKey, verify as verifySignature } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[a-f0-9]{128}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_TTL_MS = 10 * 60 * 1000;

export class VerificationEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationEngineError";
    this.code = code;
  }
}

function canonicalReport(report) {
  return JSON.stringify({
    schemaVersion: 3, verificationId: report.verificationId, taskId: report.taskId,
    projectId: report.projectId, verifierId: report.verifierId, outcome: report.outcome,
    resultHash: report.resultHash, issuedAt: report.issuedAt, expiresAt: report.expiresAt,
    workspaceHash: report.workspaceHash ?? null, workspaceHashAfter: report.workspaceHashAfter ?? null,
  });
}
function validId(value) { return typeof value === "string" && ID.test(value); }
function isValidSignedRecord(record) {
  return Boolean(record && record.schemaVersion === 3 &&
    [record.verificationId, record.taskId, record.projectId, record.verifierId].every(validId) &&
    record.outcome === "passed" && HASH.test(record.resultHash ?? "") &&
    typeof record.issuedAt === "string" && Number.isFinite(Date.parse(record.issuedAt)) &&
    typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.parse(record.issuedAt) &&
    Date.parse(record.expiresAt) - Date.parse(record.issuedAt) <= MAX_TTL_MS &&
    typeof record.signature === "string" && SIGNATURE.test(record.signature) &&
    ((record.workspaceHash === undefined && record.workspaceHashAfter === undefined) ||
      (HASH.test(record.workspaceHash ?? "") && HASH.test(record.workspaceHashAfter ?? "") && record.workspaceHash === record.workspaceHashAfter)));
}
function validTask(task) { return validId(task.taskId) && validId(task.projectId); }

/** Public-key-only verifier. It cannot issue attestations. */
export class VerificationEngine {
  #publicKey;
  #trustedVerifiers;
  #clock;
  #revoked = new Set();
  #revocationRegistry;
  #getWorkspaceDigest;

  constructor({ publicKey, trustedVerifiers, clock = () => new Date(), revocationRegistry, getWorkspaceDigest } = {}) {
    try { this.#publicKey = createPublicKey(publicKey); }
    catch { throw new TypeError("publicKey must be a valid Ed25519 public key"); }
    if (this.#publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("publicKey must be an Ed25519 public key");
    if (!Array.isArray(trustedVerifiers) || trustedVerifiers.length === 0 || trustedVerifiers.some((id) => !validId(id))) {
      throw new TypeError("trustedVerifiers must be a non-empty array of valid IDs");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#trustedVerifiers = new Set(trustedVerifiers);
    this.#clock = clock;
    if (revocationRegistry !== undefined &&
        (!revocationRegistry || typeof revocationRegistry.isRevoked !== "function" || typeof revocationRegistry.revoke !== "function")) {
      throw new TypeError("revocationRegistry must implement isRevoked() and revoke()");
    }
    this.#revocationRegistry = revocationRegistry;
    if (getWorkspaceDigest !== undefined && typeof getWorkspaceDigest !== "function") {
      throw new TypeError("getWorkspaceDigest must be a function");
    }
    this.#getWorkspaceDigest = getWorkspaceDigest;
  }

  async verifyCompletion({ task, evidence } = {}) {
    if (!task || !evidence || typeof evidence !== "object" || !validTask(task)) return false;
    const verificationId = evidence.verificationId;
    if (!validId(verificationId) || this.#revoked.has(verificationId)) return false;
    if (this.#revocationRegistry) {
      try { if (await this.#revocationRegistry.isRevoked(verificationId)) return false; }
      catch { return false; }
    }
    const record = evidence.attestation;
    if (!isValidSignedRecord(record) || record.verificationId !== verificationId) return false;
    if (record.taskId !== task.taskId || record.projectId !== task.projectId ||
        record.verifierId !== evidence.verifierId || record.outcome !== evidence.outcome ||
        record.resultHash !== evidence.resultHash || !HASH.test(evidence.resultHash ?? "") ||
        record.workspaceHash !== evidence.workspaceHash || record.workspaceHashAfter !== evidence.workspaceHashAfter ||
        (record.workspaceHash !== undefined && task.workspaceHash !== undefined && task.workspaceHash !== record.workspaceHash)) return false;
    if (record.workspaceHash !== undefined) {
      if (!this.#getWorkspaceDigest) return false;
      let currentWorkspaceHash;
      try { currentWorkspaceHash = await this.#getWorkspaceDigest({ task, evidence }); }
      catch { return false; }
      if (currentWorkspaceHash !== record.workspaceHash) return false;
    }
    const nowValue = this.#clock();
    const now = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (!Number.isFinite(now) || Date.parse(record.issuedAt) > now + 30_000 || Date.parse(record.expiresAt) <= now) return false;
    if (!this.#trustedVerifiers.has(record.verifierId)) return false;
    try {
      return verifySignature(null, Buffer.from(canonicalReport(record), "utf8"), this.#publicKey, Buffer.from(record.signature, "hex"));
    } catch { return false; }
  }

  revoke(verificationId) {
    if (!validId(verificationId)) return false;
    this.#revoked.add(verificationId);
    return true;
  }

  async revokePersistently(verificationId, details = {}) {
    if (!validId(verificationId)) throw new VerificationEngineError("INVALID_VERIFICATION_ID", "verificationId is invalid");
    if (!this.#revocationRegistry) throw new VerificationEngineError("REVOCATION_STORE_UNAVAILABLE", "durable revocation registry is not configured");
    await this.#revocationRegistry.revoke(verificationId, details);
    this.revoke(verificationId);
    return true;
  }
}
