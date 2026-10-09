const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const RESOLUTIONS = new Set(["confirmed_succeeded", "confirmed_failed", "confirmed_not_executed"]);
const BINDING = ["principalId", "toolId", "inputHash"];

export class OperationRecoveryError extends Error {
  constructor(code, message) { super(message); this.name = "OperationRecoveryError"; this.code = code; }
}
function requireId(value, field) {
  if (typeof value !== "string" || !ID.test(value)) throw new OperationRecoveryError("INVALID_OPERATION_RECORD", `${field} has an invalid format`);
}
function validateBinding({ operationId, principalId, toolId, inputHash }) {
  requireId(operationId, "operationId"); requireId(principalId, "principalId"); requireId(toolId, "toolId");
  if (typeof inputHash !== "string" || !HASH.test(inputHash)) throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "inputHash must be a SHA-256 hex digest");
}
function sameBinding(a, b) { return BINDING.every((key) => a[key] === b[key]); }

/**
 * Durable operation journal and evidence-backed reconciliation over EventLedger.
 * It never retries external effects and cannot guarantee exactly-once execution.
 */
export class OperationRecovery {
  #ledger;
  #clock;
  constructor({ ledger, clock = () => new Date() } = {}) {
    if (!ledger || typeof ledger.read !== "function" || typeof ledger.append !== "function") throw new TypeError("a compatible durable event ledger is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#ledger = ledger; this.#clock = clock;
  }

  /** ToolRegistry journal hook: durably claim a stable operation ID before dispatch. */
  async begin(binding) {
    validateBinding(binding);
    const result = await this.#appendTransition("operation.started", binding, (record) => {
      if (!record) return "append";
      if (!sameBinding(record.binding, binding)) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is already bound to different operation data");
      if (record.resolution) throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "operation already has a reconciliation decision");
      if (record.status === "started") return "duplicate";
      throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "operation ID has already advanced beyond the started state");
    });
    // A matching existing intent is safe to inspect, but never grants a second
    // caller permission to dispatch the external effect.
    return Object.freeze({ operationId: binding.operationId, duplicate: result === "duplicate" });
  }

  /** ToolRegistry journal hook: completion must be durably recorded before success returns. */
  async complete(binding) {
    validateBinding(binding);
    await this.#appendTransition("operation.completed", binding, (record) => {
      if (!record) throw new OperationRecoveryError("OPERATION_NOT_FOUND", "operation intent must exist before completion");
      if (!sameBinding(record.binding, binding)) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is bound to different operation data");
      if (record.resolution) throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "operation already has a reconciliation decision");
      if (record.status === "completed") return "duplicate";
      if (record.status !== "started") throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "only an in-flight operation can be completed");
      return "append";
    });
  }

  /** ToolRegistry journal hook: a post-dispatch failure is an uncertain outcome. */
  async interrupt({ operationId, principalId, toolId, inputHash, reason }) {
    const binding = { operationId, principalId, toolId, inputHash };
    validateBinding(binding);
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "reason must contain 1-500 characters");
    await this.#appendTransition("operation.interrupted", { ...binding, reason: reason.trim() }, (record) => {
      if (!record) throw new OperationRecoveryError("OPERATION_NOT_FOUND", "operation intent must exist before interruption");
      if (!sameBinding(record.binding, binding)) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is bound to different operation data");
      if (record.resolution) throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "operation already has a reconciliation decision");
      if (record.status === "interrupted") {
        if (record.reason !== reason.trim()) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation already has a different interruption reason");
        return "duplicate";
      }
      if (record.status !== "started") throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "only an in-flight operation can be interrupted");
      return "append";
    });
  }

  /** Record a cancellation known to happen before handler dispatch. */
  async abortBeforeDispatch({ operationId, principalId, toolId, inputHash, reason }) {
    const binding = { operationId, principalId, toolId, inputHash };
    validateBinding(binding);
    if (reason !== "cancelled_before_dispatch") throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "pre-dispatch abort reason is not recognized");
    await this.#appendTransition("operation.aborted_before_dispatch", { ...binding, reason }, (record) => {
      if (!record) throw new OperationRecoveryError("OPERATION_NOT_FOUND", "operation intent must exist before pre-dispatch abort");
      if (!sameBinding(record.binding, binding)) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is bound to different operation data");
      if (record.status === "aborted_before_dispatch") {
        if (record.reason !== reason) throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation already has a different abort reason");
        return "duplicate";
      }
      if (record.status !== "started" || record.resolution) throw new OperationRecoveryError("OPERATION_ALREADY_TERMINAL", "only an unresolved in-flight intent can be aborted before dispatch");
      return "append";
    });
  }

  /** Backward-compatible API for imported/legacy interruption records. */
  async recordInterrupted({ operationId, principalId, toolId, inputHash, reason }) {
    validateBinding({ operationId, principalId, toolId, inputHash });
    if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > 500) throw new OperationRecoveryError("INVALID_OPERATION_RECORD", "reason must contain 1-500 characters");
    const payload = { operationId, principalId, toolId, inputHash, reason: reason.trim() };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = await this.#snapshot();
      const existing = snapshot.get(operationId);
      if (existing) {
        if (!sameBinding(existing.binding, payload) || existing.reason !== payload.reason || existing.status !== "interrupted") throw new OperationRecoveryError("OPERATION_ID_CONFLICT", "operation ID is already bound to different operation data or lifecycle state");
        return Object.freeze({ operationId, duplicate: true });
      }
      const events = await this.#ledger.read();
      try {
        const event = await this.#ledger.append({ type: "operation.interrupted", payload, at: this.#now(), expectedHeadHash: events.at(-1)?.hash ?? "0".repeat(64) });
        return Object.freeze({ operationId, eventHash: event.hash, duplicate: false });
      } catch (error) {
        const message = String(error?.message ?? "");
        if (!message.includes("head changed") && !message.includes("event ledger is locked")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new OperationRecoveryError("LEDGER_CONTENTION", "could not safely record operation after concurrent ledger updates");
  }

  async resolve({ operationId, resolvedBy, resolution, evidenceRef }) {
    requireId(operationId, "operationId"); requireId(resolvedBy, "resolvedBy");
    if (!RESOLUTIONS.has(resolution)) throw new OperationRecoveryError("INVALID_RESOLUTION", "resolution must explicitly confirm success, failure, or non-execution");
    if (typeof evidenceRef !== "string" || evidenceRef.trim().length < 1 || evidenceRef.length > 500) throw new OperationRecoveryError("EVIDENCE_REQUIRED", "a bounded reference to reconciliation evidence is required");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const snapshot = await this.#snapshot();
      const record = snapshot.get(operationId);
      if (!record || !["interrupted", "started"].includes(record.status)) throw new OperationRecoveryError("OPERATION_NOT_FOUND", "no unresolved operation with this ID exists");
      if (record.resolution) throw new OperationRecoveryError("OPERATION_ALREADY_RESOLVED", "operation already has a durable resolution");
      if (resolvedBy === record.binding.principalId) throw new OperationRecoveryError("INDEPENDENT_REVIEW_REQUIRED", "the resolver must differ from the original principal");
      const events = await this.#ledger.read();
      try {
        const event = await this.#ledger.append({ type: "operation.resolved", payload: { operationId, resolvedBy, resolution, evidenceRef: evidenceRef.trim() }, at: this.#now(), expectedHeadHash: events.at(-1)?.hash ?? "0".repeat(64) });
        return Object.freeze({ operationId, resolution, eventHash: event.hash });
      } catch (error) {
        const message = String(error?.message ?? "");
        if (!message.includes("head changed") && !message.includes("event ledger is locked")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new OperationRecoveryError("LEDGER_CONTENTION", "could not safely record resolution after concurrent ledger updates");
  }

  async inspect() {
    const records = await this.#snapshot();
    const pending = []; const resolved = []; const completed = []; const aborted = [];
    for (const [operationId, record] of records) {
      const base = { operationId, principalId: record.binding.principalId, toolId: record.binding.toolId, inputHash: record.binding.inputHash, retryAutomatically: false };
      if (record.status === "completed") completed.push(Object.freeze({ ...base, status: "completed" }));
      else if (record.status === "aborted_before_dispatch") aborted.push(Object.freeze({ ...base, status: "aborted_before_dispatch", reason: record.reason }));
      else if (record.resolution) resolved.push(Object.freeze({ ...base, status: "resolved", interrupted: record.reason ? Object.freeze({ ...record.binding, reason: record.reason }) : null, resolution: Object.freeze({ ...record.resolution }) }));
      else pending.push(Object.freeze({ ...base, status: record.status === "started" ? "in_flight_after_restart" : "unknown_after_interruption", interrupted: record.reason ? Object.freeze({ ...record.binding, reason: record.reason }) : null, reason: record.reason ?? null }));
    }
    const order = (a,b) => a.operationId.localeCompare(b.operationId);
    pending.sort(order); resolved.sort(order); completed.sort(order); aborted.sort(order);
    return Object.freeze({ pending: Object.freeze(pending), resolved: Object.freeze(resolved), completed: Object.freeze(completed), aborted: Object.freeze(aborted), retryAutomatically: false });
  }

  async get(operationId) {
    requireId(operationId, "operationId");
    const records = await this.#snapshot();
    const record = records.get(operationId);
    if (!record) return null;
    if (record.status === "completed") return Object.freeze({ operationId, status: "completed", retryAutomatically: false });
    if (record.status === "aborted_before_dispatch") return Object.freeze({ operationId, status: "aborted_before_dispatch", reason: record.reason, retryAutomatically: false });
    if (record.resolution) return Object.freeze({ operationId, status: "resolved", interrupted: record.reason ? Object.freeze({ ...record.binding, reason: record.reason }) : null, resolution: Object.freeze({ ...record.resolution }), retryAutomatically: false });
    return Object.freeze({ operationId, status: record.status === "started" ? "in_flight_after_restart" : "unknown_after_interruption", interrupted: record.reason ? Object.freeze({ ...record.binding, reason: record.reason }) : null, retryAutomatically: false });
  }

  async #appendTransition(type, payload, decide) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const records = await this.#snapshot();
      const existing = records.get(payload.operationId);
      const decision = decide(existing);
      if (decision === "duplicate") return "duplicate";
      const events = await this.#ledger.read();
      try {
        await this.#ledger.append({ type, payload, at: this.#now(), expectedHeadHash: events.at(-1)?.hash ?? "0".repeat(64) });
        return "appended";
      } catch (error) {
        const message = String(error?.message ?? "");
        if (!message.includes("head changed") && !message.includes("event ledger is locked")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new OperationRecoveryError("LEDGER_CONTENTION", "could not safely record operation after concurrent ledger updates");
  }

  async #snapshot() {
    const events = await this.#ledger.read();
    const records = new Map();
    for (const event of events) {
      if (!["operation.started", "operation.completed", "operation.interrupted", "operation.aborted_before_dispatch", "operation.resolved"].includes(event.type)) continue;
      const p = event.payload;
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "operation event has an invalid payload");
      requireId(p.operationId, "operationId");
      let record = records.get(p.operationId);
      if (event.type === "operation.started") {
        validateBinding(p);
        if (record) throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "duplicate start or reused operation ID");
        record = { binding: { operationId: p.operationId, principalId: p.principalId, toolId: p.toolId, inputHash: p.inputHash }, status: "started", reason: null, resolution: null };
        records.set(p.operationId, record);
      } else if (event.type === "operation.completed") {
        validateBinding(p);
        if (!record || record.status !== "started" || !sameBinding(record.binding, p)) throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "completion must follow a matching start exactly once");
        record.status = "completed";
      } else if (event.type === "operation.interrupted") {
        validateBinding(p);
        if (typeof p.reason !== "string" || p.reason.trim().length < 1 || p.reason.length > 500) throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "invalid interruption reason");
        if (!record) {
          // Compatibility with older ledgers where interruptions were recorded without an intent event.
          record = { binding: { operationId: p.operationId, principalId: p.principalId, toolId: p.toolId, inputHash: p.inputHash }, status: "interrupted", reason: p.reason, resolution: null };
          records.set(p.operationId, record);
        } else {
          if (record.status !== "started" || !sameBinding(record.binding, p)) throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "interruption must follow a matching start exactly once");
          record.status = "interrupted"; record.reason = p.reason;
        }
      } else if (event.type === "operation.aborted_before_dispatch") {
        validateBinding(p);
        if (p.reason !== "cancelled_before_dispatch" || !record || record.status !== "started" || !sameBinding(record.binding, p)) {
          throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "pre-dispatch abort must follow a matching start exactly once");
        }
        record.status = "aborted_before_dispatch"; record.reason = p.reason;
      } else {
        requireId(p.resolvedBy, "resolvedBy");
        if (!record || !["started", "interrupted"].includes(record.status) || record.resolution ||
            p.resolvedBy === record.binding.principalId || !RESOLUTIONS.has(p.resolution) ||
            typeof p.evidenceRef !== "string" || !p.evidenceRef.trim() || p.evidenceRef.length > 500) {
          throw new OperationRecoveryError("RECOVERY_LEDGER_INVALID", "invalid, duplicate, or unauthorized operation resolution");
        }
        record.resolution = { resolvedBy: p.resolvedBy, resolution: p.resolution, evidenceRef: p.evidenceRef };
      }
    }
    return records;
  }

  #now() {
    const value = this.#clock(); const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("clock must return a valid date");
    return date.toISOString();
  }
}
