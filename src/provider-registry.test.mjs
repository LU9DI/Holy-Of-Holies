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

test("rejects invalid adapter contracts", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({}), /providerId/);
  assert.throws(() => registry.register(adapter("bad id")), /providerId/);
  assert.throws(() => registry.register(adapter("wrong.version", { contractVersion: 2 })), /contract version/);
  assert.throws(() => registry.register(adapter("no.capabilities", { capabilities: [] })), /capabilities/);
});
