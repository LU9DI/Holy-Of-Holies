import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./tool-registry.mjs";
import { createIdempotencyKey } from "./idempotency-key.mjs";

const approval = {
  approved: true,
  approvalId: "approval-provider-key",
  approvedBy: "operator:reviewer",
  expiresAt: "2026-10-09T12:10:00.000Z",
};
const now = () => new Date("2026-10-09T12:00:00.000Z");
const journal = () => ({
  begin: async () => ({ duplicate: false }),
  complete: async () => {},
  interrupt: async () => {},
});

function makeRegistry({ providerScope = "payments:merchant-42", readOnly = false, handler, operationJournal = journal() } = {}) {
  const registry = new ToolRegistry({
    authorize: async () => ({ allowed: true }),
    consumeApproval: async () => true,
    operationJournal,
    clock: now,
  });
  registry.register({
    toolId: "payments.charge",
    description: "Charge a payment provider account",
    readOnly,
    ...(providerScope !== undefined ? { providerScope } : {}),
    inputSchema: {
      type: "object",
      required: ["amount"],
      additionalProperties: false,
      properties: { amount: { type: "integer", minimum: 1 } },
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
    handler: handler ?? (async () => ({ ok: true })),
  });
  return registry;
}

const request = (operationId) => ({
  toolId: "payments.charge",
  principalId: "agent:billing",
  operationId,
  input: { amount: 25 },
  approval,
});

test("provider idempotency key is exposed to side-effect handlers and stable across registry restarts", async () => {
  const observed = [];
  const handler = async ({ context }) => {
    observed.push(context.idempotencyKey);
    return { ok: true };
  };
  await makeRegistry({ handler }).invoke(request("op-payment-1001"));
  await makeRegistry({ handler }).invoke(request("op-payment-1001"));

  const expected = createIdempotencyKey({
    providerScope: "payments:merchant-42",
    operationId: "op-payment-1001",
  });
  assert.deepEqual(observed, [expected, expected]);
  assert.match(observed[0], /^[a-f0-9]{64}$/);
});

test("provider account scope isolates otherwise identical operation IDs", async () => {
  const observed = [];
  const handler = async ({ context }) => {
    observed.push(context.idempotencyKey);
    return { ok: true };
  };
  await makeRegistry({ handler, providerScope: "payments:merchant-42" }).invoke(request("op-payment-1002"));
  await makeRegistry({ handler, providerScope: "payments:merchant-43" }).invoke(request("op-payment-1002"));
  assert.notEqual(observed[0], observed[1]);
});

test("provider-scoped side effects require a stable operation ID", async () => {
  const registry = makeRegistry();
  const { operationId, ...withoutOperationId } = request("op-payment-1003");
  await assert.rejects(
    registry.invoke(withoutOperationId),
    (error) => error.code === "OPERATION_ID_REQUIRED",
  );
});

test("provider scope is rejected for read-only tools and malformed scopes", () => {
  assert.throws(() => makeRegistry({ readOnly: true, providerScope: "payments:merchant-42" }), /providerScope/);
  for (const providerScope of ["", " payments ", "x".repeat(257)]) {
    assert.throws(() => makeRegistry({ providerScope }), /providerScope/);
  }
});
