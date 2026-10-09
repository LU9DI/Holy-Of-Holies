import { createIdempotencyKey } from "./idempotency-key.mjs";

const PROVIDER_STATES = new Set([
  "confirmed_succeeded",
  "confirmed_failed",
  "confirmed_not_executed",
  "unknown",
]);

export class ProviderReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderReconciliationError";
    this.code = code;
  }
}

/**
 * Query a configured provider adapter and, only after independent evidence
 * verification, persist a terminal reconciliation decision. Never dispatches
 * or retries the side effect. The adapter and verifier are trusted deployment
 * boundaries and must be implemented accordingly.
 */
export async function reconcileProviderOperation({
  recovery,
  operationId,
  providerScope,
  lookupOperation,
  verifyEvidence,
  resolvedBy,
} = {}) {
  if (!recovery || typeof recovery.inspect !== "function" || typeof recovery.resolve !== "function") {
    throw new TypeError("a compatible OperationRecovery instance is required");
  }
  if (typeof lookupOperation !== "function") throw new TypeError("lookupOperation must be a function");
  if (typeof verifyEvidence !== "function") throw new TypeError("verifyEvidence must be a function");
  if (typeof providerScope !== "string" || providerScope.trim().length === 0 ||
      providerScope.length > 256 || providerScope !== providerScope.trim()) {
    throw new ProviderReconciliationError("INVALID_PROVIDER_SCOPE", "providerScope must be a stable, trimmed, non-empty string of at most 256 characters");
  }
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) {
    throw new ProviderReconciliationError("INVALID_OPERATION_ID", "operationId has an invalid format");
  }
  if (typeof resolvedBy !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(resolvedBy)) {
    throw new ProviderReconciliationError("INVALID_RESOLVER", "resolvedBy has an invalid format");
  }

  const snapshot = await recovery.inspect();
  const record = snapshot.pending.find((item) => item.operationId === operationId);
  if (!record) {
    throw new ProviderReconciliationError("OPERATION_NOT_PENDING", "operation is not unresolved; no provider lookup or mutation was performed");
  }

  const idempotencyKey = createIdempotencyKey({ providerScope, operationId });
  const expected = Object.freeze({
    operationId,
    providerScope,
    idempotencyKey,
    principalId: record.principalId,
    toolId: record.toolId,
    inputHash: record.inputHash,
  });

  // Exceptions deliberately propagate: a failed lookup is not proof of non-execution.
  const providerResult = await lookupOperation(expected);
  if (!providerResult || typeof providerResult !== "object" || Array.isArray(providerResult)) {
    throw new ProviderReconciliationError("INVALID_PROVIDER_RESPONSE", "provider lookup must return a structured response");
  }
  for (const field of ["operationId", "providerScope", "idempotencyKey"]) {
    if (providerResult[field] !== expected[field]) {
      throw new ProviderReconciliationError("PROVIDER_BINDING_MISMATCH", `provider response does not match expected ${field}`);
    }
  }
  if (!PROVIDER_STATES.has(providerResult.status)) {
    throw new ProviderReconciliationError("INVALID_PROVIDER_STATUS", "provider status is not a supported reconciliation state");
  }
  if (providerResult.status === "unknown") {
    return Object.freeze({
      operationId,
      status: "unknown",
      resolved: false,
      retryAutomatically: false,
      reason: "provider outcome remains inconclusive",
    });
  }

  // The verifier must authenticate provider evidence and bind it to the exact
  // operation, account scope, idempotency key, and returned provider state.
  const verification = await verifyEvidence(providerResult, expected);
  if (!verification || verification.verified !== true ||
      typeof verification.evidenceRef !== "string" ||
      verification.evidenceRef.trim().length === 0 ||
      verification.evidenceRef.length > 500) {
    throw new ProviderReconciliationError("PROVIDER_EVIDENCE_UNVERIFIED", "provider evidence was not independently verified; operation remains unresolved");
  }

  const resolution = providerResult.status;
  const persisted = await recovery.resolve({
    operationId,
    resolvedBy,
    resolution,
    evidenceRef: verification.evidenceRef.trim(),
  });
  return Object.freeze({
    operationId,
    status: resolution,
    resolved: true,
    retryAutomatically: false,
    eventHash: persisted.eventHash,
  });
}
