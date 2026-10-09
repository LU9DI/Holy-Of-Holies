import { createHash } from "node:crypto";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class ToolRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonBytes(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ToolRegistryError("INVALID_JSON_VALUE", "tool values must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new ToolRegistryError("INVALID_JSON_VALUE", "tool values must be JSON-serializable");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError("tool schemas and results must be JSON-compatible");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validateSchema(schema, value, path = "$", depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 32) {
    return { valid: false, path, reason: "invalid_schema_or_depth" };
  }
  const supported = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (schema.type !== undefined && !supported.has(schema.type)) {
    return { valid: false, path, reason: "unsupported_schema_type" };
  }
  if (schema.enum !== undefined &&
      (!Array.isArray(schema.enum) || !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)))) {
    return { valid: false, path, reason: "enum_mismatch" };
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, path, reason: "expected_object" };
    }
    const properties = schema.properties ?? {};
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return { valid: false, path, reason: "invalid_properties" };
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required) || !required.every((key) => typeof key === "string")) {
      return { valid: false, path, reason: "invalid_required" };
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) return { valid: false, path: `${path}.${key}`, reason: "required" };
    }
    if (schema.additionalProperties === false &&
        Object.keys(value).some((key) => !Object.hasOwn(properties, key))) {
      return { valid: false, path, reason: "additional_property" };
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const result = validateSchema(properties[key], child, `${path}.${key}`, depth + 1);
        if (!result.valid) return result;
      }
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      return { valid: false, path, reason: "min_properties" };
    }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) {
      return { valid: false, path, reason: "max_properties" };
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return { valid: false, path, reason: "expected_array" };
    if (schema.minItems !== undefined && value.length < schema.minItems) return { valid: false, path, reason: "min_items" };
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return { valid: false, path, reason: "max_items" };
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        const result = validateSchema(schema.items, value[i], `${path}[${i}]`, depth + 1);
        if (!result.valid) return result;
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return { valid: false, path, reason: "expected_string" };
    if (schema.minLength !== undefined && value.length < schema.minLength) return { valid: false, path, reason: "min_length" };
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return { valid: false, path, reason: "max_length" };
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string" || schema.pattern.length > 256) return { valid: false, path, reason: "invalid_pattern" };
      let matches = false;
      try { matches = new RegExp(schema.pattern, "u").test(value); } catch { return { valid: false, path, reason: "invalid_pattern" }; }
      if (!matches) return { valid: false, path, reason: "pattern_mismatch" };
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      return { valid: false, path, reason: "expected_finite_number" };
    }
    if (schema.minimum !== undefined && value < schema.minimum) return { valid: false, path, reason: "minimum" };
    if (schema.maximum !== undefined && value > schema.maximum) return { valid: false, path, reason: "maximum" };
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    return { valid: false, path, reason: "expected_boolean" };
  } else if (schema.type === "null" && value !== null) {
    return { valid: false, path, reason: "expected_null" };
  }
  return { valid: true };
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Explicit tool allowlist with bounded JSON contracts, fail-closed policy checks,
 * time/resource limits, and short-lived human approval for side-effecting tools.
 * A timeout requests cancellation but cannot kill hostile in-process code: run
 * untrusted tools in a separate OS/container boundary in production.
 */
export class ToolRegistry {
  #tools = new Map();
  #authorize;
  #consumeApproval;
  #clock;

  constructor({ authorize, consumeApproval, clock = () => new Date(), defaults = {} } = {}) {
    this.#authorize = authorize;
    this.#consumeApproval = consumeApproval;
    this.#clock = clock;
    this.defaults = Object.freeze({
      maxInputBytes: defaults.maxInputBytes ?? 256 * 1024,
      maxOutputBytes: defaults.maxOutputBytes ?? 1024 * 1024,
      timeoutMs: defaults.timeoutMs ?? 30_000,
    });
    for (const [key, value] of Object.entries(this.defaults)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer`);
    }
  }

  register(definition) {
    if (!definition || typeof definition !== "object") throw new TypeError("tool definition is required");
    const { toolId, description, inputSchema, outputSchema, readOnly, handler, limits = {} } = definition;
    if (typeof toolId !== "string" || !ID.test(toolId)) throw new TypeError("toolId has an invalid format");
    if (!nonEmpty(description) || description.length > 500) throw new TypeError("tool description must be 1-500 characters");
    if (typeof readOnly !== "boolean") throw new TypeError("readOnly must be explicitly true or false");
    if (typeof handler !== "function") throw new TypeError("tool handler must be a function");
    if (this.#tools.has(toolId)) throw new ToolRegistryError("TOOL_ALREADY_REGISTERED", `tool already registered: ${toolId}`);

    const input = freezeDeep(cloneJson(inputSchema));
    const output = freezeDeep(cloneJson(outputSchema));
    if (!input || !output || typeof input !== "object" || typeof output !== "object") {
      throw new TypeError("inputSchema and outputSchema are required JSON schema objects");
    }
    const effectiveLimits = {};
    for (const key of Object.keys(this.defaults)) {
      const value = limits[key] ?? this.defaults[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > this.defaults[key]) {
        throw new TypeError(`${key} must be a positive integer no greater than registry defaults`);
      }
      effectiveLimits[key] = value;
    }
    const descriptor = freezeDeep({
      toolId, description, readOnly,
      inputSchema: input,
      outputSchema: output,
      limits: effectiveLimits,
    });
    this.#tools.set(toolId, { descriptor, handler });
    return descriptor;
  }

  list() {
    return Object.freeze([...this.#tools.values()].map(({ descriptor }) => descriptor));
  }

  async invoke(request = {}) {
    const { toolId, principalId, input, approval, signal } = request ?? {};
    if (typeof toolId !== "string" || !ID.test(toolId) || !nonEmpty(principalId)) {
      throw new ToolRegistryError("INVALID_TOOL_REQUEST", "explicit toolId and principalId are required");
    }
    const entry = this.#tools.get(toolId);
    if (!entry) throw new ToolRegistryError("TOOL_NOT_REGISTERED", `tool is not registered: ${toolId}`);
    const { descriptor } = entry;
    if (signal?.aborted) throw new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled before dispatch");

    if (!descriptor.readOnly) this.#validateApprovalShape(approval, principalId);
    if (typeof this.#authorize !== "function") {
      throw new ToolRegistryError("POLICY_ENGINE_UNAVAILABLE", "tool invocation denied because no policy evaluator is configured");
    }
    let decision;
    try {
      decision = await this.#authorize({
        principalId,
        action: descriptor.readOnly ? "tool.invoke" : "tool.invoke.side_effect",
        resource: `tool:${toolId}`,
      });
    } catch {
      throw new ToolRegistryError("POLICY_EVALUATION_FAILED", "tool invocation denied because policy evaluation failed");
    }
    if (!decision || decision.allowed !== true) {
      throw new ToolRegistryError("POLICY_DENIED", "policy denied tool invocation");
    }

    if (signal?.aborted) throw new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled before dispatch");

    let inputBytes;
    try { inputBytes = jsonBytes(input); } catch (error) { throw error; }
    if (inputBytes > descriptor.limits.maxInputBytes) {
      throw new ToolRegistryError("INPUT_TOO_LARGE", "tool input exceeds its configured byte limit");
    }
    const inputResult = validateSchema(descriptor.inputSchema, input);
    if (!inputResult.valid) {
      throw new ToolRegistryError("INPUT_SCHEMA_INVALID", `tool input rejected at ${inputResult.path}: ${inputResult.reason}`);
    }

    // Consume only after policy and input validation, immediately before dispatch.
    // The backing implementation MUST atomically claim approvalId as single-use.
    if (!descriptor.readOnly) {
      if (typeof this.#consumeApproval !== "function") {
        throw new ToolRegistryError("APPROVAL_CONSUMER_UNAVAILABLE", "side-effecting tool denied because no atomic approval consumer is configured");
      }
      if (signal?.aborted) throw new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled before dispatch");
      let consumed = false;
      try {
        consumed = await this.#consumeApproval({
          approval,
          principalId,
          toolId,
          action: "tool.invoke.side_effect",
          resource: `tool:${toolId}`,
          inputHash: sha256Json(input),
        }) === true;
      } catch {
        consumed = false;
      }
      if (!consumed) {
        throw new ToolRegistryError("APPROVAL_NOT_CONSUMED", "side-effecting tool denied because approval was invalid, revoked, or already consumed");
      }
      if (signal?.aborted) throw new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled after approval consumption and before dispatch");
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort(new Error("tool timeout")), descriptor.limits.timeoutMs);
    let timer;
    try {
      const operation = Promise.resolve().then(() => entry.handler({
        input: cloneJson(input),
        context: Object.freeze({
          toolId,
          principalId,
          signal: controller.signal,
          ...(approval ? { approval: Object.freeze({ approvalId: approval.approvalId, approvedBy: approval.approvedBy }) } : {}),
        }),
      }));
      const timedOut = new Promise((_, reject) => {
        timer = () => reject(new ToolRegistryError("TOOL_TIMEOUT", `tool exceeded ${descriptor.limits.timeoutMs}ms`));
        controller.signal.addEventListener("abort", () => {
          if (signal?.aborted) reject(new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled"));
          else timer();
        }, { once: true });
      });
      const output = await Promise.race([operation, timedOut]);
      const outputBytes = jsonBytes(output);
      if (outputBytes > descriptor.limits.maxOutputBytes) {
        throw new ToolRegistryError("OUTPUT_TOO_LARGE", "tool output exceeds its configured byte limit");
      }
      const outputResult = validateSchema(descriptor.outputSchema, output);
      if (!outputResult.valid) {
        throw new ToolRegistryError("OUTPUT_SCHEMA_INVALID", `tool output rejected at ${outputResult.path}: ${outputResult.reason}`);
      }
      return cloneJson(output);
    } catch (error) {
      if (error instanceof ToolRegistryError) throw error;
      if (controller.signal.aborted && signal?.aborted) {
        throw new ToolRegistryError("TOOL_CALL_CANCELLED", "tool call cancelled");
      }
      throw new ToolRegistryError("TOOL_EXECUTION_FAILED", "tool execution failed; sensitive handler details are suppressed");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #validateApprovalShape(approval, principalId) {
    if (!approval || approval.approved !== true || !nonEmpty(approval.approvalId) ||
        !nonEmpty(approval.approvedBy) || approval.approvedBy === principalId ||
        !nonEmpty(approval.expiresAt)) {
      throw new ToolRegistryError("APPROVAL_REQUIRED", "side-effecting tool requires a distinct approver and explicit approval");
    }
    const expiresAt = Date.parse(approval.expiresAt);
    const nowValue = this.#clock();
    const now = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now ||
        expiresAt - now > 15 * 60 * 1000) {
      throw new ToolRegistryError("APPROVAL_INVALID_OR_EXPIRED", "approval must be valid and expire within 15 minutes");
    }
  }
}
