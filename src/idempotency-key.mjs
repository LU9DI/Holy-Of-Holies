import { createHash } from "node:crypto";

const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

/**
 * Derive a stable, provider-scoped idempotency key for a durable operation.
 *
 * Pass the returned key to the downstream provider on every attempt for the
 * same operation, and query provider status before resolving an uncertain
 * outcome. This helper does not itself provide exactly-once execution.
 */
export function createIdempotencyKey({ providerScope, operationId } = {}) {
  if (typeof providerScope !== "string" || providerScope.trim().length === 0 || providerScope.length > 256) {
    throw new TypeError("providerScope must be a non-empty string of at most 256 characters");
  }
  if (providerScope !== providerScope.trim()) {
    throw new TypeError("providerScope must not have surrounding whitespace");
  }
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    throw new TypeError("operationId has an invalid format");
  }

  return createHash("sha256")
    .update("holy-of-holies:idempotency:v1\0", "utf8")
    .update(providerScope, "utf8")
    .update("\0", "utf8")
    .update(operationId, "utf8")
    .digest("hex");
}
