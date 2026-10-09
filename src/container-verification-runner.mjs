import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat, readdir, lstat } from "node:fs/promises";
import path from "node:path";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class ContainerVerificationRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContainerVerificationRunnerError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function workspaceDigest(root, { maxBytes, maxFiles }) {
  const manifest = [];
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(directory, relative = "", depth = 0) {
    if (depth > 64) throw new Error("workspace nesting limit exceeded");
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const rel = relative ? `${relative}/${name}` : name;
      const before = await lstat(absolute);
      fileCount += 1;
      if (fileCount > maxFiles) throw new Error("workspace file-count limit exceeded");
      if (before.isSymbolicLink()) throw new Error("workspace contains a symbolic link");
      if (before.isDirectory()) {
        manifest.push({ path: rel, type: "directory", mode: before.mode & 0o777 });
        await walk(absolute, rel, depth + 1);
        continue;
      }
      if (!before.isFile()) throw new Error("workspace contains a non-regular file");
      totalBytes += before.size;
      if (totalBytes > maxBytes) throw new Error("workspace byte limit exceeded");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      const after = await lstat(absolute);
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error("workspace changed while hashing");
      }
      manifest.push({ path: rel, type: "file", mode: before.mode & 0o777, size: before.size, hash: hash.digest("hex") });
    }
  }
  await walk(root);
  return sha256(JSON.stringify(manifest));
}
function validEnv(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, val]) =>
      /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof val === "string" && !val.includes("\0"));
}
function descriptor(input) {
  if (!input || typeof input !== "object" || !ID.test(input.id ?? "") ||
      typeof input.image !== "string" || !IMAGE.test(input.image) ||
      typeof input.executable !== "string" || !input.executable.startsWith("/") || input.executable.includes("\0") ||
      !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes < 1024 || input.maxOutputBytes > MAX_OUTPUT_BYTES ||
      !Array.isArray(input.allowedExitCodes) || input.allowedExitCodes.length === 0 ||
      input.allowedExitCodes.some((code) => !Number.isInteger(code) || code < 0 || code > 255) ||
      !validEnv(input.environment ?? {}) ||
      ["HOME", "PATH", "LANG", "LC_ALL"].some((key) => Object.hasOwn(input.environment ?? {}, key))) {
    throw new ContainerVerificationRunnerError("INVALID_COMMAND_DESCRIPTOR", "container verification descriptor is invalid");
  }
  return Object.freeze({
    id: input.id, image: input.image, executable: input.executable,
    args: Object.freeze([...input.args]), timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    allowedExitCodes: Object.freeze([...new Set(input.allowedExitCodes)]),
    environment: Object.freeze({ ...(input.environment ?? {}) }),
  });
}

/**
 * Runs allowlisted verification commands in a digest-pinned OCI container.
 * This is stronger than a host process launcher but is not a VM or a formal
 * sandbox; prefer a rootless runtime and a disposable dedicated worker.
 */
export class ContainerVerificationRunner {
  #root;
  #runtime;
  #runtimeEnvironment;
  #commands;
  #authorize;
  #clock;
  #memory;
  #cpus;
  #pids;
  #maxWorkspaceBytes;
  #maxWorkspaceFiles;

  constructor({
    workspaceRoot, runtime, commands, authorize, clock = () => new Date(),
    runtimeEnvironment = {}, memoryLimit = "512m", cpuLimit = 1, pidsLimit = 64,
    maxWorkspaceBytes = 512 * 1024 * 1024, maxWorkspaceFiles = 100000,
  } = {}) {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim() ||
        typeof runtime !== "string" || !path.isAbsolute(runtime) ||
        !Array.isArray(commands) || commands.length === 0) {
      throw new TypeError("workspaceRoot, an absolute container runtime path, and command allowlist are required");
    }
    if (typeof authorize !== "function") throw new TypeError("an authorization callback is required");
    if (!validEnv(runtimeEnvironment) || ["PATH", "LANG", "LC_ALL"].some((key) => Object.hasOwn(runtimeEnvironment, key))) {
      throw new TypeError("runtimeEnvironment must be explicit and cannot override PATH, LANG, or LC_ALL");
    }
    const memoryMatch = typeof memoryLimit === "string" ? /^([1-9][0-9]*)(m|g)$/.exec(memoryLimit) : null;
    if (!memoryMatch || (memoryMatch[2] === "m" ? Number(memoryMatch[1]) > 16384 : Number(memoryMatch[1]) > 16) ||
        typeof cpuLimit !== "number" || !Number.isFinite(cpuLimit) || cpuLimit < 0.1 || cpuLimit > 8 ||
        !Number.isInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 512 ||
        !Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1024 || maxWorkspaceBytes > 4 * 1024 * 1024 * 1024 ||
        !Number.isInteger(maxWorkspaceFiles) || maxWorkspaceFiles < 1 || maxWorkspaceFiles > 1000000) {
      throw new TypeError("container resource limits are invalid");
    }
    this.#root = path.resolve(workspaceRoot);
    this.#runtime = runtime;
    this.#runtimeEnvironment = Object.freeze({ ...runtimeEnvironment });
    this.#commands = new Map();
    for (const item of commands) {
      const command = descriptor(item);
      if (this.#commands.has(command.id)) throw new TypeError("duplicate container command ID");
      this.#commands.set(command.id, command);
    }
    this.#authorize = authorize;
    this.#clock = clock;
    this.#memory = memoryLimit;
    this.#cpus = cpuLimit;
    this.#pids = pidsLimit;
    this.#maxWorkspaceBytes = maxWorkspaceBytes;
    this.#maxWorkspaceFiles = maxWorkspaceFiles;
  }

  async run({ taskId, projectId, commandId, principalId, signal } = {}) {
    if (![taskId, projectId, commandId, principalId].every((v) => typeof v === "string" && v.trim())) {
      throw new ContainerVerificationRunnerError("INVALID_REQUEST", "taskId, projectId, commandId, and principalId are required");
    }
    if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean")) {
      throw new ContainerVerificationRunnerError("INVALID_SIGNAL", "signal must be an AbortSignal");
    }
    const command = this.#commands.get(commandId);
    if (!command) throw new ContainerVerificationRunnerError("COMMAND_NOT_ALLOWED", "container command is not allowlisted");
    let decision;
    try {
      decision = await this.#authorize({
        principalId, action: "verification.run", resource: `project:${projectId}`, taskId, commandId,
      });
    } catch {
      throw new ContainerVerificationRunnerError("AUTHORIZATION_FAILED", "verification denied because policy evaluation failed");
    }
    if (!decision || decision.allowed !== true) {
      throw new ContainerVerificationRunnerError("POLICY_DENIED", "verification denied by policy");
    }

    let root;
    let runtime;
    try {
      root = await realpath(this.#root);
      if (!(await stat(root)).isDirectory() || root.includes(",")) throw new Error("workspace path is not safely mountable");
      runtime = await realpath(this.#runtime);
      if (!(await stat(runtime)).isFile()) throw new Error("runtime is not a file");
    } catch {
      throw new ContainerVerificationRunnerError("INVALID_EXECUTION_PATH", "workspace or container runtime path is invalid");
    }
    let workspaceHash;
    try {
      workspaceHash = await workspaceDigest(root, { maxBytes: this.#maxWorkspaceBytes, maxFiles: this.#maxWorkspaceFiles });
    } catch {
      throw new ContainerVerificationRunnerError("WORKSPACE_SNAPSHOT_INVALID", "workspace contains unsupported entries, changed while hashing, or exceeded snapshot limits");
    }

    const startedAt = new Date(this.#clock()).toISOString();
    const name = `hoh-verify-${randomUUID()}`;
    const args = [
      "run", "--name", name, "--pull=never",
      "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", `--pids-limit=${this.#pids}`,
      `--memory=${this.#memory}`, `--cpus=${this.#cpus}`,
      "--user=65532:65532",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
      "--mount", `type=bind,src=${root},dst=/workspace,readonly`,
      "--workdir=/workspace",
      "--env", "HOME=/tmp", "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env", "LANG=C", "--env", "LC_ALL=C",
    ];
    for (const [key, value] of Object.entries(command.environment)) args.push("--env", `${key}=${value}`);
    args.push("--entrypoint", command.executable, command.image, ...command.args);

    const result = await new Promise((resolve) => {
      let child;
      let timer;
      let abortListener;
      let outputBytes = 0;
      let out = Buffer.alloc(0);
      let err = Buffer.alloc(0);
      let timedOut = false;
      let cancelled = false;
      let overflow = false;
      let spawnError = false;
      let terminationRequested = false;
      let settled = false;

      const cleanupContainer = async () => {
        return await new Promise((done) => {
          let cleanup;
          let completed = false;
          const finishCleanup = (ok) => {
            if (completed) return;
            completed = true;
            clearTimeout(cleanupTimer);
            done(ok);
          };
          let cleanupTimer = setTimeout(() => {
            cleanup?.kill("SIGKILL");
            finishCleanup(false);
          }, 3000);
          try {
            cleanup = spawn(runtime, ["rm", "-f", name], {
              shell: false, windowsHide: true, stdio: "ignore",
              env: { PATH: path.dirname(runtime), LANG: "C", LC_ALL: "C", ...this.#runtimeEnvironment },
            });
            cleanup.on("error", () => finishCleanup(false));
            cleanup.on("close", (code) => finishCleanup(code === 0));
          } catch {
            finishCleanup(false);
          }
        });
      };
      const finish = async (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        const cleanupSucceeded = await cleanupContainer();
        resolve({
          exitCode, stdout: out, stderr: err, timedOut, cancelled, overflow, spawnError, cleanupSucceeded,
        });
      };
      const terminate = (reason) => {
        if (terminationRequested || settled) return;
        terminationRequested = true;
        if (reason === "timeout") timedOut = true;
        if (reason === "cancel") cancelled = true;
        if (reason === "output") overflow = true;
        child?.kill("SIGKILL");
      };
      if (signal?.aborted) {
        cancelled = true;
        finish(null);
        return;
      }
      try {
        child = spawn(runtime, args, {
          shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: path.dirname(runtime), LANG: "C", LC_ALL: "C", ...this.#runtimeEnvironment },
        });
      } catch {
        spawnError = true;
        finish(null);
        return;
      }
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
      child.stdout.on("data", capture("stdout"));
      child.stderr.on("data", capture("stderr"));
      timer = setTimeout(() => terminate("timeout"), command.timeoutMs);
      abortListener = () => terminate("cancel");
      signal?.addEventListener("abort", abortListener, { once: true });
      child.on("error", () => { spawnError = true; finish(null); });
      child.on("close", (code) => finish(code));
    });

    const finishedAt = new Date(this.#clock()).toISOString();
    const stdoutHash = sha256(result.stdout);
    const stderrHash = sha256(result.stderr);
    let workspaceHashAfter = null;
    let workspaceChanged = true;
    try {
      workspaceHashAfter = await workspaceDigest(root, { maxBytes: this.#maxWorkspaceBytes, maxFiles: this.#maxWorkspaceFiles });
      workspaceChanged = workspaceHashAfter !== workspaceHash;
    } catch {
      workspaceChanged = true;
    }
    const outcome = !result.timedOut && !result.cancelled && !result.overflow && !result.spawnError &&
      result.cleanupSucceeded && !workspaceChanged && command.allowedExitCodes.includes(result.exitCode) ? "passed" : "failed";
    const reportBody = {
      taskId, projectId, commandId, startedAt, finishedAt, exitCode: result.exitCode, outcome,
      timedOut: result.timedOut, cancelled: result.cancelled, outputLimitExceeded: result.overflow,
      cleanupSucceeded: result.cleanupSucceeded, workspaceHash, workspaceHashAfter, workspaceChanged, stdoutHash, stderrHash,
      stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length,
    };
    const report = {
      ...reportBody, resultHash: sha256(JSON.stringify(reportBody)),
      stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"),
      ...(result.spawnError ? { spawnError: true } : {}),
    };
    if (!HASH.test(report.resultHash)) throw new ContainerVerificationRunnerError("INTERNAL_HASH_ERROR", "container report hash failed");
    return Object.freeze(report);
  }
}
