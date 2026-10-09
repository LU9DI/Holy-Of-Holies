import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyKey } from "./idempotency-key.mjs";

test("provider-scoped idempotency key is stable across retries and process restarts", () => {
  const binding = { providerScope: "payments:merchant-42", operationId: "op-charge-0001" };
  const first = createIdempotencyKey(binding);
  const afterRestart = createIdempotencyKey({ ...binding });
  assert.equal(first, afterRestart);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("idempotency keys differ across operation IDs and provider scopes", () => {
  const base = { providerScope: "payments:merchant-42", operationId: "op-charge-0001" };
  assert.notEqual(createIdempotencyKey(base), createIdempotencyKey({ ...base, operationId: "op-charge-0002" }));
  assert.notEqual(createIdempotencyKey(base), createIdempotencyKey({ ...base, providerScope: "payments:merchant-43" }));
  assert.notEqual(createIdempotencyKey(base), createIdempotencyKey({ ...base, providerScope: "shipping:merchant-42" }));
});

test("idempotency key rejects missing, ambiguous, or malformed bindings", () => {
  for (const input of [
    {},
    { providerScope: "", operationId: "op-1" },
    { providerScope: " payments ", operationId: "op-1" },
    { providerScope: "payments", operationId: "../op-1" },
    { providerScope: "x".repeat(257), operationId: "op-1" },
  ]) {
    assert.throws(() => createIdempotencyKey(input), TypeError);
  }
});
