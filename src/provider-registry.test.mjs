import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, ProviderRegistryError } from "./provider-registry.mjs";

function adapter(providerId, overrides = {}) {
  return {
    providerId,
    contractVersion: 1,
    capabilities: ["analysis.read", "analysis.summarize"],
    getStatus: async () => ({ available: true }),
    invoke: async ({ input }) => ({ providerId, input }),
    ...overrides,
  };
}

test("registers providers and exposes immutable capability descriptors", () => {
  const registry = new ProviderRegistry();
  const descriptor = registry.register(adapter("rea.local"));
  assert.equal(descriptor.providerId, "rea.local");
  assert.deepEqual(descriptor.capabilities, ["analysis.read", "analysis.summarize"]);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.capabilities));
  assert.equal(registry.list().length, 1);
});

test("requires explicit provider selection and never silently falls back", async () => {
  const registry = new ProviderRegistry();
  registry.register(adapter("rea.local"));
  await assert.rejects(
    registry.resolve({ capability: "analysis.read" }),
    (error) => error instanceof ProviderRegistryError && error.code === "INVALID_PROVIDER_REQUEST",
  );
  await assert.rejects(
    registry.resolve({ providerId: "rea.remote", capability: "analysis.read" }),
    (error) => error.code === "PROVIDER_NOT_REGISTERED",
  );
});

test("rejects unsupported capabilities and duplicate providers", async () => {
  const registry = new ProviderRegistry();
  registry.register(adapter("rea.local"));
  await assert.rejects(
    registry.resolve({ providerId: "rea.local", capability: "binary.execute" }),
    (error) => error.code === "PROVIDER_CAPABILITY_UNSUPPORTED",
  );
  assert.throws(
    () => registry.register(adapter("rea.local")),
    (error) => error.code === "PROVIDER_ALREADY_REGISTERED",
  );
});

test("unavailable or unverifiable providers fail closed", async () => {
  const registry = new ProviderRegistry();
  registry.register(adapter("rea.offline", {
    getStatus: async () => ({ available: false, reason: "binary not installed" }),
  }));
  registry.register(adapter("rea.unknown", {
    getStatus: async () => { throw new Error("probe failed"); },
  }));
  registry.register(adapter("rea.malformed", {
    getStatus: async () => ({ available: "yes" }),
  }));

  await assert.rejects(
    registry.resolve({ providerId: "rea.offline", capability: "analysis.read" }),
    (error) => error.code === "PROVIDER_UNAVAILABLE" && /binary not installed/.test(error.message),
  );
  await assert.rejects(
    registry.resolve({ providerId: "rea.unknown", capability: "analysis.read" }),
    (error) => error.code === "PROVIDER_STATUS_UNKNOWN",
  );
  await assert.rejects(
    registry.resolve({ providerId: "rea.malformed", capability: "analysis.read" }),
    (error) => error.code === "PROVIDER_STATUS_INVALID",
  );
});

test("authorizes every invocation and does not expose adapter internals", async () => {
  let authorizationRequest;
  const registry = new ProviderRegistry({
    authorize: async (request) => {
      authorizationRequest = request;
      return { allowed: true };
    },
  });
  registry.register(adapter("rea.local"));
  const resolved = await registry.resolve({ providerId: "rea.local", capability: "analysis.read" });
  assert.equal("adapter" in resolved, false);

  const result = await registry.invoke({
    providerId: "rea.local",
    capability: "analysis.read",
    principalId: "user:owner",
    input: { projectId: "project-1" },
  });
  assert.deepEqual(authorizationRequest, {
    principalId: "user:owner",
    action: "provider.invoke",
    resource: "provider:rea.local:analysis.read",
  });
  assert.deepEqual(result, {
    providerId: "rea.local",
    input: { projectId: "project-1" },
  });
});

test("denies provider invocation if policy is absent or denies", async () => {
  const noPolicy = new ProviderRegistry();
  noPolicy.register(adapter("rea.local"));
  await assert.rejects(
    noPolicy.invoke({
      providerId: "rea.local",
      capability: "analysis.read",
      principalId: "user:owner",
    }),
    (error) => error.code === "POLICY_ENGINE_UNAVAILABLE",
  );

  const denied = new ProviderRegistry({ authorize: async () => ({ allowed: false }) });
  denied.register(adapter("rea.local"));
  await assert.rejects(
    denied.invoke({
      providerId: "rea.local",
      capability: "analysis.read",
      principalId: "user:owner",
    }),
    (error) => error.code === "POLICY_DENIED",
  );
});

test("rejects invalid adapter contracts", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({}), /providerId/);
  assert.throws(() => registry.register(adapter("bad id")), /providerId/);
  assert.throws(() => registry.register(adapter("wrong.version", { contractVersion: 2 })), /contract version/);
  assert.throws(() => registry.register(adapter("no.capabilities", { capabilities: [] })), /capabilities/);
});
