const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const RESOLUTIONS = new Set(["confirmed_succeeded", "confirmed_failed", "confirmed_not_executed"]);

export class OperationRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperationRecoveryError";
    this.code = code;
  }
}

function requireId(value, field) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new OperationRecoveryError("INVALID_OPERATION_RECORD", `${field} has an invalid format`);
  }
}

/**
 * Durable, fail-closed reconciliation for side effects whose outcome became
 * unknown after interruption. This records evidence and operator decisions;
 * it never retries an external operation and cannot provide exactly-once effects.
 */
export class OperationRecovery {
  #ledger;
  #clock;

  constructor({ ledger, clock = () => new Date() } = {}) {
    if (!ledger || typeof ledger.read !== "function" || typeof ledger.append !== "function") {
      throw new TypeError("a compatible durable event ledger is required");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#ledger = ledger;
    this.#clock = clock;
  }

  async recordInterrupted({ operationId, principalId, toolId, inputHash, reason }) {
    requireId(operationId, "operationId");
    requireId(principalId, "principalId");
    requireId(toolId, "toolId");
    if (typeof inputHash !== "string" || !HASH.test(inputHash)) {
      throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "inputHash must be a SHA-256 hex digest");
    }
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) {
      throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "reason must contain 1-500 characters");
    }

    return this.#appendUnique("operation.interrupted", {
      operationId, principalId, toolId, inputHash, reason: reason.trim(),
    });
  }

  async resolve({ operationId, resolvedBy, resolution, evidenceRef }) {
    requireId(operationId, "operationId");
    requireId(resolvedBy, "resolvedBy");
    if (!RESOLUTIONS.has(resolution)) {
      throw new OperationRecoveryError("INVALID_RESOLUTION", "resolution must explicitly confirm success, failure, or non-execution");
    }
    if (typeof evidenceRef !== "string" || evidenceRef.trim().length < 1 || evidenceRef.length > 500) {
      throw new OperationRecoveryError("EVIDENCE_REQUIRED", "a bounded reference to reconciliation evidence is required");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const events = await this.#ledger.read();
      const operationEvents = events.filter((event) => event.payload?.operationId === operationId &&
        ["operation.interrupted", "operation.resolved"].includes(event.type));
      const interrupted = operationEvents.find((event) => event.type === "operation.interrupted");
      if (!interrupted) throw new OperationRecoveryError("OPERATION_NOT_FOUND", "no interrupted operation with this ID exists");
      if (operationEvents.some((event) => event.type === "operation.resolved")) {
        throw new OperationRecoveryError("OPERATION_ALREADY_RESOLVED", "operation already has a durable resolution");
      }
      if (resolvedBy === interrupted.payload.principalId) {
        throw new OperationRecoveryError("INDEPENDENT_REVIEW_REQUIRED", "the resolver must differ from the original principal");
      }
      const head = events.at(-1)?.hash ?? "0".repeat(64);
      try {
        const event = await this.#ledger.append({
          type: "operation.resolved",
          payload: { operationId, resolvedBy, resolution, evidenceRef: evidenceRef.trim() },
          at: this.#now(),
          expectedHeadHash: head,
        });
        return Object.freeze({ operationId, resolution, eventHash: event.hash });
      } catch (error) {
        if (!String(error?.message ?? "").includes("head changed")) throw error;
      }
    }
    throw new OperationRecoveryError("LEDGER_CONTENTION", "could not safely record resolution after concurrent ledger updates");
  }

  async get(operationId) {
    requireId(operationId, "operationId");
    const events = await this.#ledger.read();
    const interrupted = events.find((event) => event.type === "operation.interrupted" && event.payload.operationId === operationId);
    if (!interrupted) return null;
    const resolved = events.find((event) => event.type === "operation.resolved" && event.payload.operationId === operationId);
    return Object.freeze({
      operationId,
      status: resolved ? "resolved" : "unknown_after_interruption",
      interrupted: Object.freeze({ ...interrupted.payload }),
      ...(resolved ? { resolution: Object.freeze({ ...resolved.payload }) } : {}),
      retryAutomatically: false,
    });
  }

  async #appendUnique(type, payload) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const events = await this.#ledger.read();
      const existing = events.find((event) => event.type === "operation.interrupted" && event.payload.operationId === payload.operationId);
      if (existing) {
        const same = ["principalId", "toolId", "inputHash", "reason"].every((key) => existing.payload[key] === payload[key]);
        if (!same) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is already bound to different operation data");
        return Object.freeze({ ...existing, duplicate: true });
      }
      const head = events.at(-1)?.hash ?? "0".repeat(64);
      try {
        const event = await this.#ledger.append({ type, payload, at: this.#now(), expectedHeadHash: head });
        return Object.freeze({ ...event, duplicate: false });
      } catch (error) {
        if (!String(error?.message ?? "").includes("head changed")) throw error;
      }
    }
    throw new OperationRecoveryError("LEDGER_CONTENTION", "could not safely record operation after concurrent ledger updates");
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("clock must return a valid date");
    return date.toISOString();
  }
}
