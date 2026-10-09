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
 * Registration does not imply trust, sandboxing, or authorization to invoke.
 */
export class ProviderRegistry {
  #providers = new Map();

  register(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new TypeError("provider adapter is required");
    }
    const { providerId, contractVersion, capabilities, getStatus, invoke } = adapter;
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
    if (typeof getStatus !== "function" || typeof invoke !== "function") {
      throw new TypeError("provider must implement getStatus and invoke");
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

  async resolve({ providerId, capability }) {
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
      adapter: entry.adapter,
      status: Object.freeze({ available: true }),
    });
  }
}
