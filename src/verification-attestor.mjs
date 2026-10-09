import { createPrivateKey, sign } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_TTL_MS = 10 * 60 * 1000;

export class VerificationAttestorError extends Error {
  constructor(code, message) { super(message); this.name = "VerificationAttestorError"; this.code = code; }
}
function validId(value) { return typeof value === "string" && ID.test(value); }
function canonicalReport(report) {
  return JSON.stringify({
    schemaVersion: 3, verificationId: report.verificationId, taskId: report.taskId,
    projectId: report.projectId, verifierId: report.verifierId, outcome: report.outcome,
    resultHash: report.resultHash, issuedAt: report.issuedAt, expiresAt: report.expiresAt,
    workspaceHash: report.workspaceHash ?? null, workspaceHashAfter: report.workspaceHashAfter ?? null,
  });
}

/** Signing-only capability for a trusted issuer; keep the private key out of the agent process. */
export class VerificationAttestor {
  #privateKey;
  #trustedVerifiers;
  #clock;
  #issued = new Set();

  constructor({ privateKey, trustedVerifiers, clock = () => new Date() } = {}) {
    try { this.#privateKey = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey); }
    catch { throw new TypeError("privateKey must be a valid Ed25519 private key"); }
    if (this.#privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("privateKey must be an Ed25519 private key");
    if (!Array.isArray(trustedVerifiers) || trustedVerifiers.length === 0 || trustedVerifiers.some((id) => !validId(id))) {
      throw new TypeError("trustedVerifiers must be a non-empty array of valid IDs");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#trustedVerifiers = new Set(trustedVerifiers);
    this.#clock = clock;
  }

  attest({ verificationId, taskId, projectId, verifierId, outcome, resultHash, issuedAt, expiresAt, workspaceHash, workspaceHashAfter } = {}) {
    if (![verificationId, taskId, projectId, verifierId].every(validId)) {
      throw new VerificationAttestorError("INVALID_REPORT", "report identifiers are invalid");
    }
    if (this.#issued.has(verificationId)) throw new VerificationAttestorError("DUPLICATE_VERIFICATION", "verification ID was already attested by this issuer");
    if (!this.#trustedVerifiers.has(verifierId)) throw new VerificationAttestorError("UNTRUSTED_VERIFIER", "verifier is not on the trusted allowlist");
    if (outcome !== "passed" || typeof resultHash !== "string" || !HASH.test(resultHash)) {
      throw new VerificationAttestorError("INVALID_REPORT", "only passed reports with a SHA-256 result hash can be attested");
    }
    if ((workspaceHash !== undefined || workspaceHashAfter !== undefined) &&
        (!HASH.test(workspaceHash ?? "") || !HASH.test(workspaceHashAfter ?? "") || workspaceHash !== workspaceHashAfter)) {
      throw new VerificationAttestorError("INVALID_REPORT", "workspace hashes must be valid and unchanged for a passing attestation");
    }
    let issued;
    let expires;
    try {
      issued = new Date(issuedAt ?? this.#clock()).toISOString();
      expires = new Date(expiresAt ?? (Date.parse(issued) + MAX_TTL_MS)).toISOString();
    } catch { throw new VerificationAttestorError("INVALID_REPORT_WINDOW", "attestation timestamps must be valid"); }
    const issuedMs = Date.parse(issued);
    const expiresMs = Date.parse(expires);
    const nowValue = this.#clock();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (![issuedMs, expiresMs, nowMs].every(Number.isFinite) || issuedMs > nowMs + 30_000 ||
        expiresMs <= nowMs || expiresMs - issuedMs > MAX_TTL_MS) {
      throw new VerificationAttestorError("INVALID_REPORT_WINDOW", "attestation must be current and expire within ten minutes of issue");
    }
    const report = {
      schemaVersion: 3, verificationId, taskId, projectId, verifierId, outcome, resultHash,
      issuedAt: issued, expiresAt: expires,
      ...(workspaceHash !== undefined ? { workspaceHash, workspaceHashAfter } : {}),
    };
    const signature = sign(null, Buffer.from(canonicalReport(report), "utf8"), this.#privateKey).toString("hex");
    this.#issued.add(verificationId);
    return Object.freeze({ ...report, signature });
  }
}
