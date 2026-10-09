import { createTask, transitionTask } from "./task-machine.mjs";

const GENESIS_HASH = "0".repeat(64);

export class TaskOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskOrchestratorError";
    this.code = code;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotInput(task) {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    objective: task.objective,
    requiresApproval: task.requiresApproval,
    permissions: task.permissions,
    resourceLimits: task.resourceLimits,
    policyVersion: task.policyVersion,
  };
}

/**
 * Durable single-writer orchestration over an EventLedger.
 * Ledger compare-and-append detects other writers; after a conflict the
 * orchestrator requires re-initialization instead of continuing on stale state.
 */
export class TaskOrchestrator {
  #ledger;
  #authorize;
  #verifyResume;
  #clock;
  #tasks = new Map();
  #headHash = GENESIS_HASH;
  #initialized = false;
  #queue = Promise.resolve();

  constructor({ ledger, authorize, verifyResume, clock = () => new Date() } = {}) {
    if (!ledger || typeof ledger.read !== "function" || typeof ledger.append !== "function") {
      throw new TypeError("a compatible event ledger is required");
    }
    this.#ledger = ledger;
    this.#authorize = authorize;
    this.#verifyResume = verifyResume;
    this.#clock = clock;
  }

  initialize() {
    return this.#serialize(async () => {
      const events = await this.#ledger.read();
      const tasks = new Map();

      for (const event of events) {
        if (event.type === "task.created") {
          const task = event.payload?.task;
          if (!task || typeof task !== "object" || task.status !== "queued" ||
              !nonEmpty(task.taskId) || tasks.has(task.taskId)) {
            throw new TaskOrchestratorError("INVALID_EVENT_HISTORY", "task creation event is invalid or duplicated");
          }
          const rebuilt = createTask(snapshotInput(task), { now: task.createdAt });
          if (JSON.stringify(rebuilt) !== JSON.stringify(task) || event.at !== task.createdAt) {
            throw new TaskOrchestratorError("INVALID_EVENT_HISTORY", "task creation snapshot does not match its schema");
          }
          tasks.set(task.taskId, rebuilt);
          continue;
        }

        if (event.type === "task.transitioned") {
          const change = event.payload;
          const current = tasks.get(change?.taskId);
          if (!current || current.status !== change.from || !nonEmpty(change.to)) {
            throw new TaskOrchestratorError("INVALID_EVENT_HISTORY", "task transition does not match prior state");
          }
          const next = transitionTask(current, change.to, {
            now: event.at,
            ...(change.reason ? { reason: change.reason } : {}),
            ...(current.status === "awaiting_approval" && change.to === "running"
              ? { approved: true, approvedBy: change.approvedBy }
              : {}),
            ...(current.status === "interrupted" && change.to === "queued"
              ? { resumeVerified: change.resumeVerified === true }
              : {}),
          });
          tasks.set(current.taskId, next);
          continue;
        }

        throw new TaskOrchestratorError("INVALID_EVENT_HISTORY", `unknown event type: ${event.type}`);
      }

      this.#tasks = tasks;
      this.#headHash = events.at(-1)?.hash ?? GENESIS_HASH;
      this.#initialized = true;
      return Object.freeze({
        taskCount: tasks.size,
        headHash: this.#headHash,
      });
    });
  }

  create(input, { principalId } = {}) {
    return this.#serialize(async () => {
      this.#requireInitialized();
      if (!nonEmpty(principalId)) {
        throw new TaskOrchestratorError("INVALID_PRINCIPAL", "principalId is required");
      }

      let task = createTask(input, { now: this.#clock() });
      const requiresApproval =
        task.requiresApproval ||
        task.permissions.filesystem === "write" ||
        task.permissions.network !== "none" ||
        task.permissions.execution !== "none";
      if (requiresApproval && !task.requiresApproval) {
        task = createTask({ ...snapshotInput(task), requiresApproval: true }, { now: task.createdAt });
      }
      await this.#authorizeOrDeny({
        principalId,
        action: "task.create",
        resource: `project:${task.projectId}`,
      });
      if (this.#tasks.has(task.taskId)) {
        throw new TaskOrchestratorError("TASK_ALREADY_EXISTS", "task identifier is already in use");
      }

      const event = await this.#appendOrInvalidate({
        type: "task.created",
        at: task.createdAt,
        payload: { task },
      });
      this.#tasks.set(task.taskId, task);
      this.#headHash = event.hash;
      return task;
    });
  }

  transition(taskId, nextStatus, { principalId, expectedStatus, reason } = {}) {
    return this.#serialize(async () => {
      this.#requireInitialized();
      if (!nonEmpty(principalId) || !nonEmpty(taskId)) {
        throw new TaskOrchestratorError("INVALID_REQUEST", "principalId and taskId are required");
      }

      const current = this.#tasks.get(taskId);
      if (!current) throw new TaskOrchestratorError("TASK_NOT_FOUND", `task not found: ${taskId}`);
      if (!nonEmpty(expectedStatus) || expectedStatus !== current.status) {
        throw new TaskOrchestratorError("STALE_TASK_STATE", "expectedStatus does not match the current task state");
      }

      let action = "task.transition";
      let resumeVerified = false;
      let approvedBy;
      if (current.status === "awaiting_approval" && nextStatus === "running") {
        action = "task.approve";
        approvedBy = principalId;
      }
      if (current.status === "interrupted" && nextStatus === "queued") {
        action = "task.resume";
        if (typeof this.#verifyResume !== "function") {
          throw new TaskOrchestratorError("RESUME_VERIFIER_UNAVAILABLE", "resume denied because no verifier is configured");
        }
        try {
          resumeVerified = await this.#verifyResume(current) === true;
        } catch {
          resumeVerified = false;
        }
        if (!resumeVerified) {
          throw new TaskOrchestratorError("RESUME_VERIFICATION_FAILED", "resume verification failed");
        }
      }

      await this.#authorizeOrDeny({
        principalId,
        action,
        resource: `task:${taskId}`,
      });

      const at = this.#clock();
      const next = transitionTask(current, nextStatus, {
        now: at,
        ...(reason ? { reason } : {}),
        ...(approvedBy ? { approved: true, approvedBy } : {}),
        ...(current.status === "interrupted" && nextStatus === "queued"
          ? { resumeVerified }
          : {}),
      });

      const event = await this.#appendOrInvalidate({
        type: "task.transitioned",
        at: next.updatedAt,
        payload: {
          taskId,
          from: current.status,
          to: next.status,
          ...(reason ? { reason: String(reason).slice(0, 500) } : {}),
          ...(approvedBy ? { approvedBy } : {}),
          ...(current.status === "interrupted" && nextStatus === "queued" ? { resumeVerified } : {}),
        },
      });
      this.#tasks.set(taskId, next);
      this.#headHash = event.hash;
      return next;
    });
  }

  getTask(taskId) {
    this.#requireInitialized();
    return this.#tasks.get(taskId);
  }

  listTasks() {
    this.#requireInitialized();
    return Object.freeze(
      [...this.#tasks.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.taskId.localeCompare(right.taskId),
      ),
    );
  }

  async #authorizeOrDeny(request) {
    if (typeof this.#authorize !== "function") {
      throw new TaskOrchestratorError("POLICY_ENGINE_UNAVAILABLE", "operation denied because no policy evaluator is configured");
    }
    let decision;
    try {
      decision = await this.#authorize(request);
    } catch {
      throw new TaskOrchestratorError("POLICY_EVALUATION_FAILED", "operation denied because policy evaluation failed");
    }
    if (!decision || decision.allowed !== true) {
      throw new TaskOrchestratorError("POLICY_DENIED", `policy denied action ${request.action}`);
    }
  }

  async #appendOrInvalidate(event) {
    try {
      return await this.#ledger.append({
        ...event,
        expectedHeadHash: this.#headHash,
      });
    } catch (error) {
      this.#initialized = false;
      throw new TaskOrchestratorError(
        "PERSISTENCE_CONFLICT",
        `event could not be committed; reinitialize before retrying: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  #requireInitialized() {
    if (!this.#initialized) {
      throw new TaskOrchestratorError("NOT_INITIALIZED", "call initialize() before using the orchestrator");
    }
  }

  #serialize(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }
}
