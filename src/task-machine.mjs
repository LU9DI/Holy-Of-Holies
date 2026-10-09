const TASK_STATUSES = new Set([
  "queued",
  "planning",
  "awaiting_approval",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const TRANSITIONS = new Map([
  ["queued", new Set(["planning", "cancelled"])],
  ["planning", new Set(["awaiting_approval", "running", "failed", "cancelled"])],
  ["awaiting_approval", new Set(["running", "cancelled"])],
  ["running", new Set(["verifying", "failed", "cancelled", "interrupted"])],
  ["verifying", new Set(["completed", "failed", "interrupted"])],
  ["interrupted", new Set(["queued", "cancelled"])],
  ["completed", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()],
]);

const PERMISSION_LEVELS = {
  filesystem: new Set(["none", "read", "write"]),
  network: new Set(["none", "restricted", "approved"]),
  execution: new Set(["none", "sandboxed"]),
};

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(`${field} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function assertExactKeys(value, expectedKeys, field) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} contains missing or unknown fields`);
  }
}

function assertPermissions(permissions) {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new TypeError("permissions are required");
  }
  assertExactKeys(permissions, Object.keys(PERMISSION_LEVELS), "permissions");
  for (const [key, allowed] of Object.entries(PERMISSION_LEVELS)) {
    if (!allowed.has(permissions[key])) {
      throw new TypeError(`permissions.${key} is missing or invalid`);
    }
  }
}

function validateCompletionEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("completion requires verification evidence");
  }
  const expected = ["verificationId", "verifierId", "outcome", "resultHash"].sort();
  const keys = Object.keys(evidence).sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("completion evidence contains missing or unknown fields");
  }
  assertNonEmptyString(evidence.verificationId, "evidence.verificationId");
  assertNonEmptyString(evidence.verifierId, "evidence.verifierId");
  if (evidence.outcome !== "passed") {
    throw new TypeError("completion evidence outcome must be passed");
  }
  if (typeof evidence.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(evidence.resultHash)) {
    throw new TypeError("evidence.resultHash must be a lowercase SHA-256 hex digest");
  }
  return Object.freeze({
    verificationId: evidence.verificationId.trim(),
    verifierId: evidence.verifierId.trim(),
    outcome: "passed",
    resultHash: evidence.resultHash,
  });
}

function timestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("now must be a valid date or ISO timestamp");
  }
  return date.toISOString();
}

/**
 * Create a serializable task record. This module validates orchestration state;
 * it does not execute tools, persist data, or establish a sandbox.
 */
export function createTask(input, { now } = {}) {
  if (!input || typeof input !== "object") {
    throw new TypeError("task input is required");
  }

  assertNonEmptyString(input.taskId, "taskId");
  assertNonEmptyString(input.projectId, "projectId");
  assertNonEmptyString(input.objective, "objective");
  assertNonEmptyString(input.policyVersion, "policyVersion");
  assertPermissions(input.permissions);

  const limits = input.resourceLimits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("resourceLimits are required");
  }
  assertExactKeys(limits, ["timeoutMs", "maxOutputBytes", "maxConcurrentChildren"], "resourceLimits");
  assertPositiveInteger(limits.timeoutMs, "resourceLimits.timeoutMs");
  assertPositiveInteger(limits.maxOutputBytes, "resourceLimits.maxOutputBytes");
  assertPositiveInteger(limits.maxConcurrentChildren, "resourceLimits.maxConcurrentChildren", { allowZero: true });

  const taskId = input.taskId.trim();
  const projectId = input.projectId.trim();
  const policyVersion = input.policyVersion.trim();
  const parentTaskId = input.parentTaskId === undefined ? undefined : input.parentTaskId.trim();
  if (input.parentTaskId !== undefined) {
    assertNonEmptyString(input.parentTaskId, "parentTaskId");
    if (parentTaskId === taskId) {
      throw new TypeError("task cannot be its own parent");
    }
  }

  const at = timestamp(now);
  const task = {
    schemaVersion: 1,
    taskId,
    projectId,
    ...(parentTaskId ? { parentTaskId } : {}),
    objective: input.objective.trim(),
    status: "queued",
    requiresApproval: input.requiresApproval === true,
    permissions: { ...input.permissions },
    resourceLimits: { ...limits },
    policyVersion,
    createdAt: at,
    updatedAt: at,
    events: [{
      type: "task.created",
      at,
      status: "queued",
    }],
  };

  return Object.freeze({
    ...task,
    permissions: Object.freeze(task.permissions),
    resourceLimits: Object.freeze(task.resourceLimits),
    events: Object.freeze(task.events.map((event) => Object.freeze(event))),
  });
}

/**
 * Apply a legal state transition and return a new immutable record.
 * Approval is explicit and must identify the approving principal.
 */
export function transitionTask(task, nextStatus, options = {}) {
  if (!task || typeof task !== "object" || !TASK_STATUSES.has(task.status)) {
    throw new TypeError("task is missing or has an invalid status");
  }
  if (!TASK_STATUSES.has(nextStatus)) {
    throw new TypeError("nextStatus is invalid");
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`terminal task status ${task.status} cannot transition`);
  }
  if (!TRANSITIONS.get(task.status)?.has(nextStatus)) {
    throw new Error(`invalid task transition: ${task.status} -> ${nextStatus}`);
  }
  if (task.requiresApproval && task.status === "planning" && nextStatus === "running") {
    throw new Error("task requires approval before execution");
  }
  if (task.status === "awaiting_approval" && nextStatus === "running") {
    if (options.approved !== true) {
      throw new Error("explicit approval is required");
    }
    assertNonEmptyString(options.approvedBy, "approvedBy");
  }
  if (nextStatus === "queued" && task.status === "interrupted" && options.resumeVerified !== true) {
    throw new Error("interrupted task requires resume verification before requeue");
  }

  let evidence;
  if (nextStatus === "completed") {
    evidence = validateCompletionEvidence(options.evidence);
  } else if (options.evidence !== undefined) {
    throw new TypeError("verification evidence is only valid when completing a task");
  }

  const at = timestamp(options.now);
  const event = {
    type: "task.transitioned",
    at,
    from: task.status,
    to: nextStatus,
    ...(options.reason ? { reason: String(options.reason).slice(0, 500) } : {}),
    ...(task.status === "awaiting_approval" && nextStatus === "running"
      ? { approvedBy: options.approvedBy.trim() }
      : {}),
    ...(task.status === "interrupted" && nextStatus === "queued"
      ? { resumeVerified: true }
      : {}),
    ...(evidence ? { evidence } : {}),
  };

  return Object.freeze({
    ...task,
    status: nextStatus,
    updatedAt: at,
    events: Object.freeze([
      ...task.events,
      Object.freeze(event),
    ]),
  });
}

export function getTaskStatuses() {
  return [...TASK_STATUSES];
}
