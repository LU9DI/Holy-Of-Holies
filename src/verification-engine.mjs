import { createHmac, timingSafeEqual } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_TTL_MS = 10 * 60 * 1000;

export class VerificationEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationEngineError";
    this.code = code;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VerificationEngineError("INVALID_REPORT", field + " must be a non-empty string");
  }
  return value.trim();
}

function canonicalReport(report) {
  return JSON.stringify({
    schemaVersion: 1,
    verificationId: report.verificationId,
    taskId: report.taskId,
    projectId: report.projectId,
    verifierId: report.verifierId,
    outcome: report.outcome,
    resultHash: report.resultHash,
    issuedAt: report.issuedAt,
    expiresAt: report.expiresAt,
  });
}

function digest(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function isValidSignedRecord(record) {
  return Boolean(record && record.schemaVersion === 1 &&
    [record.verificationId, record.taskId, record.projectId, record.verifierId].every((id) => typeof id === "string" && ID.test(id)) &&
    record.outcome === "passed" && HASH.test(record.resultHash ?? "") &&
    typeof record.issuedAt === "string" && Number.isFinite(Date.parse(record.issuedAt)) &&
    typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) > Date.parse(record.issuedAt) &&
    Date.parse(record.expiresAt) - Date.parse(record.issuedAt) <= MAX_TTL_MS &&
    typeof record.signature === "string" && HASH.test(record.signature));
}

/**
 * Validates short-lived attestations from a trusted runner. The HMAC key must
 * remain outside the agent/tool process and be available only to the verifier
 * service. This module does not execute builds/tests or protect key custody.
 */
export class VerificationEngine {
  #key;
  #trustedVerifiers;
  #clock;
  #records = new Map();
  #revoked = new Set();

  constructor({ key, trustedVerifiers, clock = () => new Date() } = {}) {
    if (!(Buffer.isBuffer(key) || key instanceof Uint8Array || typeof key === "string") ||
        Buffer.byteLength(key) < 32) {
      throw new TypeError("verification key must contain at least 32 bytes");
    }
    if (!Array.isArray(trustedVerifiers) || trustedVerifiers.length === 0 ||
        trustedVerifiers.some((id) => typeof id !== "string" || !ID.test(id))) {
      throw new TypeError("trustedVerifiers must be a non-empty array of valid IDs");
    }
    this.#key = Buffer.from(key);
    this.#trustedVerifiers = new Set(trustedVerifiers);
    this.#clock = clock;
  }

  /**
   * Called only by a separately trusted issuer after independent verification.
   * Never expose this signing capability or its key to an untrusted agent.
   */
  attest({ verificationId, taskId, projectId, verifierId, outcome, resultHash, issuedAt, expiresAt }) {
    verificationId = requireString(verificationId, "verificationId");
    taskId = requireString(taskId, "taskId");
    projectId = requireString(projectId, "projectId");
    verifierId = requireString(verifierId, "verifierId");
    if (![verificationId, taskId, projectId, verifierId].every((id) => ID.test(id))) {
      throw new VerificationEngineError("INVALID_REPORT", "report identifiers contain invalid characters");
    }
    if (!this.#trustedVerifiers.has(verifierId)) {
      throw new VerificationEngineError("UNTRUSTED_VERIFIER", "verifier is not on the trusted allowlist");
    }
    if (outcome !== "passed" || typeof resultHash !== "string" || !HASH.test(resultHash)) {
      throw new VerificationEngineError("INVALID_REPORT", "only passed reports with a SHA-256 result hash can attest completion");
    }
    const issued = new Date(issuedAt ?? this.#clock()).toISOString();
    const expires = new Date(expiresAt ?? (Date.parse(issued) + MAX_TTL_MS)).toISOString();
    const issuedMs = Date.parse(issued);
    const expiresMs = Date.parse(expires);
    const nowValue = this.#clock();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (![issuedMs, expiresMs, nowMs].every(Number.isFinite) ||
        issuedMs > nowMs + 30_000 || expiresMs <= nowMs ||
        expiresMs - issuedMs > MAX_TTL_MS) {
      throw new VerificationEngineError("INVALID_REPORT_WINDOW", "attestation must be current and expire within ten minutes of issue");
    }
    const report = {
      schemaVersion: 1, verificationId, taskId, projectId, verifierId,
      outcome, resultHash, issuedAt: issued, expiresAt: expires,
    };
    const signed = Object.freeze({ ...report, signature: digest(this.#key, canonicalReport(report)) });
    this.#records.set(verificationId, signed);
    this.#revoked.delete(verificationId);
    return signed;
  }

  async verifyCompletion({ task, evidence } = {}) {
    if (!task || !evidence || typeof evidence !== "object" || !validTask(task)) return false;
    const verificationId = evidence.verificationId;
    if (!validId(verificationId) || this.#revoked.has(verificationId)) return false;
    const record = this.#records.get(verificationId) ?? evidence.attestation;
    if (!isValidSignedRecord(record) || record.verificationId !== verificationId) return false;
    if (record.taskId !== task.taskId || record.projectId !== task.projectId ||
        record.verifierId !== evidence.verifierId || record.outcome !== evidence.outcome ||
        record.resultHash !== evidence.resultHash || !HASH.test(evidence.resultHash ?? "")) return false;
    const nowValue = this.#clock();
    const now = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (!Number.isFinite(now) || Date.parse(record.issuedAt) > now + 30_000 ||
        Date.parse(record.expiresAt) <= now) return false;
    if (!this.#trustedVerifiers.has(record.verifierId)) return false;
    const expected = Buffer.from(digest(this.#key, canonicalReport(record)), "hex");
    const supplied = Buffer.from(record.signature, "hex");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  revoke(verificationId) {
    if (!validId(verificationId)) return false;
    this.#revoked.add(verificationId);
    this.#records.delete(verificationId);
    return true;
  }

  has(verificationId) {
    return this.#records.has(verificationId);
  }
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validTask(task) {
  return validId(task.taskId) && validId(task.projectId);
}
