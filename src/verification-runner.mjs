import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class VerificationRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationRunnerError";
    this.code = code;
  }
}

const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(descriptor.id ?? "") ||
      !path.isAbsolute(descriptor.executable) ||
      !Array.isArray(descriptor.args) ||
      descriptor.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !Number.isInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 100 || descriptor.timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(descriptor.maxOutputBytes) || descriptor.maxOutputBytes < 1024 || descriptor.maxOutputBytes > MAX_OUTPUT_BYTES ||
      !Array.isArray(descriptor.allowedExitCodes) || descriptor.allowedExitCodes.length === 0 ||
      descriptor.allowedExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) {
    throw new VerificationRunnerError("INVALID_COMMAND_DESCRIPTOR", "verification command descriptor is invalid");
  }
  const environment = descriptor.environment ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment) ||
      Object.entries(environment).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))) {
    throw new VerificationRunnerError("INVALID_ENVIRONMENT", "verification environment must be an explicit string map");
  }
  return Object.freeze({
    id: descriptor.id,
    executable: descriptor.executable,
    args: Object.freeze([...descriptor.args]),
    timeoutMs: descriptor.timeoutMs,
    maxOutputBytes: descriptor.maxOutputBytes,
    allowedExitCodes: Object.freeze([...new Set(descriptor.allowedExitCodes)]),
    environment: Object.freeze({ ...environment }),
  });
}

/**
 * Runs only preconfigured verification commands, without a shell. This is a
 * constrained runner interface, not an OS sandbox. The process must be launched
 * inside a separately hardened worker/container for untrusted repositories.
 */
export class VerificationRunner {
  #root;
  #commands;
  #authorize;
  #clock;

  constructor({ workspaceRoot, commands, authorize, clock = () => new Date() } = {}) {
    if (!nonEmpty(workspaceRoot) || !Array.isArray(commands) || commands.length === 0) {
      throw new TypeError("workspaceRoot and a non-empty command allowlist are required");
    }
    if (typeof authorize !== "function") {
      throw new TypeError("an authorization callback is required");
    }
    this.#root = path.resolve(workspaceRoot);
    this.#commands = new Map();
    for (const item of commands) {
      const descriptor = validateDescriptor(item);
      if (this.#commands.has(descriptor.id)) throw new TypeError("duplicate verification command id");
      this.#commands.set(descriptor.id, descriptor);
    }
    this.#authorize = authorize;
    this.#clock = clock;
  }

  async run({ taskId, projectId, commandId, principalId, signal } = {}) {
    if (![taskId, projectId, commandId, principalId].every(nonEmpty)) {
      throw new VerificationRunnerError("INVALID_REQUEST", "taskId, projectId, commandId, and principalId are required");
    }
    if (signal !== undefined && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
      throw new VerificationRunnerError("INVALID_SIGNAL", "signal must be an AbortSignal");
    }
    const command = this.#commands.get(commandId);
    if (!command) throw new VerificationRunnerError("COMMAND_NOT_ALLOWED", "verification command is not allowlisted");
    let decision;
    try {
      decision = await this.#authorize({
        principalId,
        action: "verification.run",
        resource: `project:${projectId}`,
        taskId,
        commandId,
      });
    } catch {
      throw new VerificationRunnerError("AUTHORIZATION_FAILED", "verification denied because policy evaluation failed");
    }
    if (!decision || decision.allowed !== true) {
      throw new VerificationRunnerError("POLICY_DENIED", "verification denied by policy");
    }

    let root;
    let executable;
    try {
      root = await realpath(this.#root);
      executable = await realpath(command.executable);
      const executableStat = await stat(executable);
      if (!executableStat.isFile()) throw new Error("executable is not a file");
    } catch {
      throw new VerificationRunnerError("INVALID_EXECUTION_PATH", "workspace or executable path is invalid");
    }

    const startedAt = this.#clock().toISOString();
    const result = await new Promise((resolve) => {
      let outputBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let overflow = false;
      let settled = false;
      let timer;
      let abortListener;
      let child;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        resolve(value);
      };
      const terminate = (reason) => {
        if (reason === "timeout") timedOut = true;
        if (reason === "cancel") cancelled = true;
        if (reason === "output") overflow = true;
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      };
      if (signal?.aborted) {
        finish({ exitCode: null, stdout, stderr, timedOut, cancelled: true, overflow });
        return;
      }
      try {
        child = spawn(executable, command.args, {
          cwd: root,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: path.dirname(executable), LANG: "C", LC_ALL: "C", ...command.environment },
        });
      } catch {
        finish({ exitCode: null, stdout, stderr, timedOut, cancelled, overflow, spawnError: true });
        return;
      }
      let out = Buffer.alloc(0);
      let err = Buffer.alloc(0);
      const capture = (kind) => (chunk) => {
        if (settled) return;
        outputBytes += chunk.length;
        const remaining = Math.max(0, command.maxOutputBytes - out.length - err.length);
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining);
          if (kind === "stdout") out = Buffer.concat([out, kept]);
          else err = Buffer.concat([err, kept]);
        }
        if (outputBytes > command.maxOutputBytes) terminate("output");
      };
      // Replace the preliminary listeners with bounded collectors.
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdout.on("data", capture("stdout"));
      child.stderr.on("data", capture("stderr"));
      timer = setTimeout(() => terminate("timeout"), command.timeoutMs);
      abortListener = () => terminate("cancel");
      signal?.addEventListener("abort", abortListener, { once: true });
      child.on("error", () => finish({ exitCode: null, stdout: out, stderr: err, timedOut, cancelled, overflow, spawnError: true }));
      child.on("close", (exitCode) => finish({ exitCode, stdout: out, stderr: err, timedOut, cancelled, overflow }));
    });

    const finishedAt = this.#clock().toISOString();
    const stdoutText = result.stdout.toString("utf8");
    const stderrText = result.stderr.toString("utf8");
    const outcome = !result.timedOut && !result.cancelled && !result.overflow &&
      !result.spawnError && command.allowedExitCodes.includes(result.exitCode) ? "passed" : "failed";
    const report = {
      taskId,
      projectId,
      commandId,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      outcome,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputLimitExceeded: result.overflow,
      ...(result.spawnError ? { spawnError: true } : {}),
      stdoutHash: sha256(result.stdout),
      stderrHash: sha256(result.stderr),
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      resultHash: sha256(JSON.stringify({
        taskId, projectId, commandId, startedAt, finishedAt, exitCode: result.exitCode,
        outcome, timedOut: result.timedOut, cancelled: result.cancelled,
        outputLimitExceeded: result.overflow, stdoutHash: sha256(result.stdout), stderrHash: sha256(result.stderr),
      })),
      stdout: stdoutText,
      stderr: stderrText,
    };
    if (!HASH_RE.test(report.resultHash)) throw new VerificationRunnerError("INTERNAL_HASH_ERROR", "verification report hash failed");
    return Object.freeze(report);
  }
}
