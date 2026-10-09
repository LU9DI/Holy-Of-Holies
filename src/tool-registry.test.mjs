import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, ToolRegistryError } from "./tool-registry.mjs";

const inputSchema = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: { path: { type: "string", minLength: 1, maxLength: 100 } },
};
const outputSchema = { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } };
function definition(toolId = "workspace.read", overrides = {}) {
  return {
    toolId, description: "Read a project file", readOnly: true,
    inputSchema, outputSchema, handler: async () => ({ ok: true }), ...overrides,
  };
}
function registry(options = {}) {
  return new ToolRegistry({ authorize: async () => ({ allowed: true }), ...options });
}
const baseRequest = { toolId: "workspace.read", principalId: "agent:planner", input: { path: "README.md" } };

test("registers explicit tool contracts and exposes frozen descriptors", () => {
  const tools = registry();
  const descriptor = tools.register(definition());
  assert.equal(descriptor.toolId, "workspace.read");
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.inputSchema));
  assert.equal(tools.list().length, 1);
});

test("rejects malformed and duplicate registrations", () => {
  const tools = registry();
  assert.throws(() => tools.register(definition("bad id")), /toolId/);
  assert.throws(() => tools.register(definition("no.readonly", { readOnly: undefined })), /readOnly/);
  tools.register(definition());
  assert.throws(() => tools.register(definition()), (error) => error.code === "TOOL_ALREADY_REGISTERED");
});

test("authorizes each call and validates strict input and output schemas", async () => {
  let calls = 0;
  const tools = registry();
  tools.register(definition("workspace.read", { handler: async ({ input }) => { calls++; return { ok: input.path.length > 0 }; } }));
  assert.deepEqual(await tools.invoke(baseRequest), { ok: true });
  await assert.rejects(tools.invoke({ ...baseRequest, input: { path: "x", injected: true } }), (error) => error.code === "INPUT_SCHEMA_INVALID");
  assert.equal(calls, 1);
});

test("denies closed if policy is missing, errors, or rejects", async () => {
  const noPolicy = new ToolRegistry();
  noPolicy.register(definition());
  await assert.rejects(noPolicy.invoke(baseRequest), (error) => error.code === "POLICY_ENGINE_UNAVAILABLE");
  const denied = registry({ authorize: async () => ({ allowed: false }) });
  denied.register(definition());
  await assert.rejects(denied.invoke(baseRequest), (error) => error.code === "POLICY_DENIED");
  const broken = registry({ authorize: async () => { throw new Error("secret"); } });
  broken.register(definition());
  await assert.rejects(broken.invoke(baseRequest), (error) => error.code === "POLICY_EVALUATION_FAILED");
});

test("requires distinct, short-lived human approval for side-effecting tools", async () => {
  const tools = registry({ clock: () => new Date("2026-10-09T12:00:00Z"), verifyApproval: async ({ approval }) => approval.approvalId === "approval-1" });
  tools.register(definition("workspace.write", { readOnly: false, handler: async () => ({ ok: true }) }));
  await assert.rejects(tools.invoke({ ...baseRequest, toolId: "workspace.write" }), (error) => error.code === "APPROVAL_REQUIRED");
  const approval = { approved: true, approvalId: "approval-1", approvedBy: "user:reviewer", expiresAt: "2026-10-09T12:10:00Z" };
  assert.deepEqual(await tools.invoke({ ...baseRequest, toolId: "workspace.write", approval }), { ok: true });
  await assert.rejects(tools.invoke({ ...baseRequest, toolId: "workspace.write", approval: { ...approval, approvedBy: baseRequest.principalId } }), (error) => error.code === "APPROVAL_REQUIRED");
  await assert.rejects(tools.invoke({ ...baseRequest, toolId: "workspace.write", approval: { ...approval, expiresAt: "2026-10-09T12:16:00Z" } }), (error) => error.code === "APPROVAL_INVALID_OR_EXPIRED");
});

test("enforces input and output byte limits", async () => {
  const smallInput = registry({ defaults: { maxInputBytes: 32, maxOutputBytes: 1024, timeoutMs: 100 } });
  smallInput.register(definition());
  await assert.rejects(smallInput.invoke({ ...baseRequest, input: { path: "x".repeat(80) } }), (error) => error.code === "INPUT_TOO_LARGE");

  const smallOutput = registry({ defaults: { maxInputBytes: 1024, maxOutputBytes: 16, timeoutMs: 100 } });
  smallOutput.register(definition("workspace.read", { handler: async () => ({ ok: true, extra: "this is much too long" }) , outputSchema: { type: "object" } }));
  await assert.rejects(smallOutput.invoke(baseRequest), (error) => error.code === "OUTPUT_TOO_LARGE");
});

test("enforces timeout and passes a cancellation signal to the handler", async () => {
  let receivedSignal;
  const tools = registry({ defaults: { maxInputBytes: 1024, maxOutputBytes: 1024, timeoutMs: 20 } });
  tools.register(definition("workspace.read", { handler: ({ context }) => {
    receivedSignal = context.signal;
    return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ ok: true }), { once: true }));
  } }));
  await assert.rejects(tools.invoke(baseRequest), (error) => error.code === "TOOL_TIMEOUT");
  assert.equal(receivedSignal.aborted, true);
});

test("supports caller cancellation before dispatch and during execution", async () => {
  const tools = registry();
  tools.register(definition("workspace.read", { handler: ({ context }) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ ok: true }), { once: true })) }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools.invoke({ ...baseRequest, signal: controller.signal }), (error) => error.code === "TOOL_CALL_CANCELLED");

  const active = new AbortController();
  const call = tools.invoke({ ...baseRequest, signal: active.signal });
  active.abort();
  await assert.rejects(call, (error) => error.code === "TOOL_CALL_CANCELLED");
});

test("rejects unsupported schema types and malformed schema contracts at invocation", async () => {
  const tools = registry();
  tools.register(definition("workspace.read", { inputSchema: { type: "magic" } }));
  await assert.rejects(tools.invoke(baseRequest), (error) => error.code === "INPUT_SCHEMA_INVALID");
});

test("rejects non-JSON and invalid request payloads", async () => {
  const tools = registry();
  tools.register(definition());
  await assert.rejects(tools.invoke({ toolId: "workspace.read", principalId: "agent:planner", input: undefined }), (error) => error.code === "INVALID_JSON_VALUE");
  await assert.rejects(tools.invoke({ toolId: "workspace.read", principalId: "", input: {} }), (error) => error.code === "INVALID_TOOL_REQUEST");
});

test("fails closed when approval metadata is forged or no trusted verifier exists", async () => {
  const approval = { approved: true, approvalId: "fake", approvedBy: "user:reviewer", expiresAt: "2026-10-09T12:10:00Z" };
  const noVerifier = registry({ clock: () => new Date("2026-10-09T12:00:00Z") });
  noVerifier.register(definition("workspace.write", { readOnly: false }));
  await assert.rejects(
    noVerifier.invoke({ ...baseRequest, toolId: "workspace.write", approval }),
    (error) => error.code === "APPROVAL_VERIFIER_UNAVAILABLE",
  );
  const trusted = registry({
    clock: () => new Date("2026-10-09T12:00:00Z"),
    verifyApproval: async ({ approval: candidate }) => candidate.approvalId === "real-record",
  });
  trusted.register(definition("workspace.write", { readOnly: false }));
  await assert.rejects(
    trusted.invoke({ ...baseRequest, toolId: "workspace.write", approval }),
    (error) => error.code === "APPROVAL_NOT_VERIFIED",
  );
});
