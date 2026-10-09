const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[a-f0-9]{128}$/;
const MAX_ATTESTATION_TTL_MS = 10 * 60 * 1000;

export class VerificationCoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationCoordinatorError";
    this.code = code;
  }
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function safeReport(report) {
  return {
    taskId: report.taskId,
    projectId: report.projectId,
    commandId: report.commandId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    exitCode: report.exitCode,
    outcome: report.outcome,
    timedOut: report.timedOut,
    cancelled: report.cancelled,
    outputLimitExceeded: report.outputLimitExceeded,
    ...(typeof report.cleanupSucceeded === "boolean" ? { cleanupSucceeded: report.cleanupSucceeded } : {}),
    ...(HASH.test(report.workspaceHash ?? "") ? { workspaceHash: report.workspaceHash } : {}),
    ...(HASH.test(report.workspaceHashAfter ?? "") ? { workspaceHashAfter: report.workspaceHashAfter } : {}),
    ...(typeof report.workspaceChanged === "boolean" ? { workspaceChanged: report.workspaceChanged } : {}),
    ...(report.spawnError ? { spawnError: true } : {}),
    stdoutHash: report.stdoutHash,
    stderrHash: report.stderrHash,
    stdoutBytes: report.stdoutBytes,
    stderrBytes: report.stderrBytes,
    resultHash: report.resultHash,
  };
}

/**
 * Coordinates a configured runner with an external attestation issuer and the
 * append-only event ledger. It intentionally does not possess a signing key.
 * Output text is excluded from the durable ledger; only hashes and metadata
 * are recorded to reduce accidental leakage of secrets.
 */
export class VerificationCoordinator {
  #runner;
  #ledger;
  #attest;
  #clock;
  #inFlight = new Set();

  constructor({ runner, ledger, attest, clock = () => new Date() } = {}) {
    if (!runner || typeof runner.run !== "function") throw new TypeError("a verification runner is required");
    if (!ledger || typeof ledger.append !== "function" || typeof ledger.read !== "function") {
      throw new TypeError("a compatible event ledger is required");
    }
    if (typeof attest !== "function") throw new TypeError("an external attestation issuer is required");
    this.#runner = runner;
    this.#ledger = ledger;
    this.#attest = attest;
    this.#clock = clock;
  }

  async execute({ verificationId, taskId, projectId, commandId, principalId, signal } = {}) {
    if (![verificationId, taskId, projectId, commandId, principalId].every(validId)) {
      throw new VerificationCoordinatorError("INVALID_REQUEST", "verificationId, taskId, projectId, commandId, and principalId must be valid identifiers");
    }
    if (this.#inFlight.has(verificationId)) {
      throw new VerificationCoordinatorError("DUPLICATE_IN_FLIGHT", "this verification ID is already executing");
    }

    this.#inFlight.add(verificationId);
    try {
      let started = false;
      for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
        const history = await this.#ledger.read();
        if (history.some((event) => event.payload?.verificationId === verificationId)) {
          throw new VerificationCoordinatorError("DUPLICATE_VERIFICATION", "verification ID already exists in durable history");
        }
        const previous = history.at(-1);
        try {
          await this.#ledger.append({
            type: "verification.started",
            at: this.#clock().toISOString(),
            expectedHeadHash: previous?.hash ?? "0".repeat(64),
            payload: { verificationId, taskId, projectId, commandId, principalId },
          });
          started = true;
        } catch (error) {
          if (!String(error?.message ?? "").includes("event ledger head changed")) throw error;
          if (attempt === 2) {
            const latest = await this.#ledger.read();
            if (latest.some((event) => event.payload?.verificationId === verificationId)) {
              throw new VerificationCoordinatorError("DUPLICATE_VERIFICATION", "verification ID already exists in durable history");
            }
            throw new VerificationCoordinatorError("CONCURRENT_LEDGER_WRITES", "verification start conflicted with concurrent ledger writes; retry the request");
          }
        }
      }

      let report;
      try {
        report = await this.#runner.run({ taskId, projectId, commandId, principalId, signal });
      } catch (error) {
        await this.#ledger.append({
          type: "verification.runner_error",
          at: this.#clock().toISOString(),
          payload: {
            verificationId, taskId, projectId, commandId,
            errorCode: typeof error?.code === "string" ? error.code.slice(0, 80) : "RUNNER_ERROR",
          },
        });
        throw new VerificationCoordinatorError("RUNNER_FAILED", "verification runner did not return a report");
      }

      if (!report || report.taskId !== taskId || report.projectId !== projectId ||
          report.commandId !== commandId || !["passed", "failed"].includes(report.outcome) ||
          !HASH.test(report.resultHash ?? "") || !HASH.test(report.stdoutHash ?? "") ||
          !HASH.test(report.stderrHash ?? "") ||
          (report.workspaceHash !== undefined && !HASH.test(report.workspaceHash ?? "")) ||
          (report.workspaceHashAfter !== undefined && report.workspaceHashAfter !== null && !HASH.test(report.workspaceHashAfter)) ||
          (report.workspaceChanged !== undefined && typeof report.workspaceChanged !== "boolean")) {
        await this.#ledger.append({
          type: "verification.invalid_report",
          at: this.#clock().toISOString(),
          payload: { verificationId, taskId, projectId, commandId },
        });
        throw new VerificationCoordinatorError("INVALID_RUNNER_REPORT", "runner report failed contract validation");
      }

      const result = safeReport(report);
      let attestation = null;
      if (report.outcome === "passed") {
        try {
          attestation = await this.#attest({
            verificationId,
            taskId,
            projectId,
            verifierId: principalId,
            outcome: "passed",
            resultHash: report.resultHash,
          });
        } catch {
          await this.#ledger.append({
            type: "verification.attestation_error",
            at: this.#clock().toISOString(),
            payload: { verificationId, taskId, projectId, commandId, resultHash: report.resultHash },
          });
          throw new VerificationCoordinatorError("ATTESTATION_FAILED", "trusted attestation service did not attest the result");
        }
        const issuedMs = Date.parse(attestation?.issuedAt ?? "");
        const expiresMs = Date.parse(attestation?.expiresAt ?? "");
        if (!attestation || attestation.verificationId !== verificationId ||
            attestation.taskId !== taskId || attestation.projectId !== projectId ||
            attestation.outcome !== "passed" || attestation.schemaVersion !== 3 || attestation.resultHash !== report.resultHash ||
            !validId(attestation.verifierId) || !SIGNATURE.test(attestation.signature ?? "") ||
            !Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs ||
            expiresMs - issuedMs > MAX_ATTESTATION_TTL_MS ||
            (typeof report.workspaceHash === "string" &&
              (attestation.workspaceHash !== report.workspaceHash || attestation.workspaceHashAfter !== report.workspaceHashAfter)) ||
            (report.workspaceHash === undefined &&
              (attestation.workspaceHash !== undefined || attestation.workspaceHashAfter !== undefined))) {
          await this.#ledger.append({
            type: "verification.invalid_attestation",
            at: this.#clock().toISOString(),
            payload: { verificationId, taskId, projectId, commandId, resultHash: report.resultHash },
          });
          throw new VerificationCoordinatorError("INVALID_ATTESTATION", "attestation failed identity and result binding checks");
        }
      }

      await this.#ledger.append({
        type: "verification.completed",
        at: this.#clock().toISOString(),
        payload: {
          verificationId,
          ...result,
          ...(attestation ? {
            attestation: {
              verificationId: attestation.verificationId,
              verifierId: attestation.verifierId,
              issuedAt: attestation.issuedAt,
              expiresAt: attestation.expiresAt,
              signature: attestation.signature,
              schemaVersion: attestation.schemaVersion,
              ...(typeof attestation.workspaceHash === "string" ? {
                workspaceHash: attestation.workspaceHash, workspaceHashAfter: attestation.workspaceHashAfter,
              } : {}),
              taskId: attestation.taskId,
              projectId: attestation.projectId,
              outcome: attestation.outcome,
              resultHash: attestation.resultHash,
            },
          } : {}),
        },
      });

      const completionEvidence = attestation ? Object.freeze({
        verificationId: attestation.verificationId,
        verifierId: attestation.verifierId,
        outcome: attestation.outcome,
        resultHash: attestation.resultHash,
        attestation,
      }) : null;
      return Object.freeze({ report: Object.freeze(result), attestation, completionEvidence });
    } finally {
      this.#inFlight.delete(verificationId);
    }
  }
}
