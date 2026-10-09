function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validProviderId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

export class ProviderRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

/**
 * Registry for explicitly selected external adapters.
 * Registration does not imply trust or sandboxing. Invocation is authorized
 * against the exact provider/capability resource before adapter code is called.
 */
export class ProviderRegistry {
  #providers = new Map();
  #authorize;

  constructor({ authorize } = {}) {
    this.#authorize = authorize;
  }

  register(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new TypeError("provider adapter is required");
    }
    const { providerId, contractVersion, capabilities, getStatus, validateInput, validateOutput, invoke } = adapter;
    if (!validProviderId(providerId)) {
      throw new TypeError("providerId has an invalid format");
    }
    if (contractVersion !== 1) {
      throw new TypeError("unsupported provider contract version");
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0 ||
        !capabilities.every(nonEmpty) ||
        new Set(capabilities).size !== capabilities.length) {
      throw new TypeError("provider capabilities must be non-empty, unique strings");
    }
    if (typeof getStatus !== "function" || typeof validateInput !== "function" ||
        typeof validateOutput !== "function" || typeof invoke !== "function") {
      throw new TypeError("provider must implement getStatus, validateInput, validateOutput and invoke");
    }
    if (this.#providers.has(providerId)) {
      throw new ProviderRegistryError("PROVIDER_ALREADY_REGISTERED", `provider already registered: ${providerId}`);
    }

    const descriptor = Object.freeze({
      providerId,
      contractVersion,
      capabilities: Object.freeze([...capabilities]),
    });
    this.#providers.set(providerId, { adapter, descriptor });
    return descriptor;
  }

  list() {
    return Object.freeze(
      [...this.#providers.values()].map(({ descriptor }) => descriptor),
    );
  }

  async resolve(request = {}) {
    const { providerId, capability } = request ?? {};
    if (!validProviderId(providerId) || !nonEmpty(capability)) {
      throw new ProviderRegistryError("INVALID_PROVIDER_REQUEST", "providerId and capability must be explicit");
    }

    const entry = this.#providers.get(providerId);
    if (!entry) {
      throw new ProviderRegistryError("PROVIDER_NOT_REGISTERED", `provider is not registered: ${providerId}`);
    }
    if (!entry.descriptor.capabilities.includes(capability)) {
      throw new ProviderRegistryError(
        "PROVIDER_CAPABILITY_UNSUPPORTED",
        `provider ${providerId} does not declare capability ${capability}`,
      );
    }

    let status;
    try {
      status = await entry.adapter.getStatus();
    } catch {
      throw new ProviderRegistryError("PROVIDER_STATUS_UNKNOWN", `provider status could not be verified: ${providerId}`);
    }
    if (!status || typeof status !== "object" || typeof status.available !== "boolean") {
      throw new ProviderRegistryError("PROVIDER_STATUS_INVALID", `provider returned invalid status: ${providerId}`);
    }
    if (!status.available) {
      const reason = nonEmpty(status.reason) ? status.reason.trim() : "no reason supplied";
      throw new ProviderRegistryError(
        "PROVIDER_UNAVAILABLE",
        `provider ${providerId} is unavailable: ${reason}`,
      );
    }

    return Object.freeze({
      providerId,
      contractVersion: entry.descriptor.contractVersion,
      capability,
      status: Object.freeze({ available: true }),
    });
  }

  async invoke(request = {}) {
    const { providerId, capability, principalId, input, signal } = request ?? {};
    if (!validProviderId(providerId) || !nonEmpty(capability) || !nonEmpty(principalId)) {
      throw new ProviderRegistryError("INVALID_PROVIDER_REQUEST", "providerId, capability and principalId must be explicit");
    }
    if (signal?.aborted) {
      throw new ProviderRegistryError("PROVIDER_CALL_CANCELLED", "provider call was cancelled before dispatch");
    }
    if (typeof this.#authorize !== "function") {
      throw new ProviderRegistryError("POLICY_ENGINE_UNAVAILABLE", "provider invocation is denied because no policy evaluator is configured");
    }

    let decision;
    try {
      decision = await this.#authorize({
        principalId,
        action: "provider.invoke",
        resource: `provider:${providerId}:${capability}`,
      });
    } catch {
      throw new ProviderRegistryError("POLICY_EVALUATION_FAILED", "provider invocation denied because policy evaluation failed");
    }
    if (!decision || decision.allowed !== true) {
      throw new ProviderRegistryError("POLICY_DENIED", "policy denied provider invocation");
    }

    await this.resolve({ providerId, capability });
    const entry = this.#providers.get(providerId);
    try {
      if (entry.adapter.validateInput(capability, input) !== true) {
        throw new ProviderRegistryError("PROVIDER_INPUT_INVALID", "provider input did not pass its declared validator");
      }
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw error;
      throw new ProviderRegistryError("PROVIDER_INPUT_INVALID", "provider input validation failed");
    }

    let output;
    try {
      output = await entry.adapter.invoke({
        capability,
        input,
        context: Object.freeze({ providerId, principalId, signal }),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ProviderRegistryError("PROVIDER_CALL_CANCELLED", "provider call was cancelled");
      }
      throw error;
    }

    try {
      if (entry.adapter.validateOutput(capability, output) !== true) {
        throw new ProviderRegistryError("PROVIDER_OUTPUT_INVALID", "provider output did not pass its declared validator");
      }
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw error;
      throw new ProviderRegistryError("PROVIDER_OUTPUT_INVALID", "provider output validation failed");
    }
    return output;
  }
}
