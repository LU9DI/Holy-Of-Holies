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

function assertPermissions(permissions) {
  if (!permissions || typeof permissions !== "object") {
    throw new TypeError("permissions are required");
  }
  for (const [key, allowed] of Object.entries(PERMISSION_LEVELS)) {
    if (!allowed.has(permissions[key])) {
      throw new TypeError(`permissions.${key} is missing or invalid`);
    }
  }
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
  if (!limits || typeof limits !== "object") {
    throw new TypeError("resourceLimits are required");
  }
  assertPositiveInteger(limits.timeoutMs, "resourceLimits.timeoutMs");
  assertPositiveInteger(limits.maxOutputBytes, "resourceLimits.maxOutputBytes");
  assertPositiveInteger(limits.maxConcurrentChildren, "resourceLimits.maxConcurrentChildren", { allowZero: true });

  if (input.parentTaskId !== undefined) {
    assertNonEmptyString(input.parentTaskId, "parentTaskId");
    if (input.parentTaskId === input.taskId) {
      throw new TypeError("task cannot be its own parent");
    }
  }

  const at = timestamp(now);
  const task = {
    schemaVersion: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    objective: input.objective.trim(),
    status: "queued",
    requiresApproval: input.requiresApproval === true,
    permissions: { ...input.permissions },
    resourceLimits: { ...limits },
    policyVersion: input.policyVersion,
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
