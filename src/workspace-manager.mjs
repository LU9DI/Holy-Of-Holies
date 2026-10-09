import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  realpath,
  stat,
  readFile,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep, resolve, basename } from "node:path";

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/**
 * File access constrained to a canonical workspace root.
 * Symlink path components are rejected. Writes use a private temporary file,
 * fsync the file and atomically rename it. A per-target lock and expected hash
 * prevent cooperating writers from silently overwriting each other.
 *
 * This is not a substitute for an OS sandbox, a hostile same-user race-proof
 * openat API, or an isolated workspace account. The workspace directory must
 * not be concurrently controlled by an untrusted local principal.
 */
export class WorkspaceManager {
  #configuredRoot;
  #root;
  #maxReadBytes;
  #maxWriteBytes;

  constructor({ root, maxReadBytes = 1_048_576, maxWriteBytes = 1_048_576 } = {}) {
    if (!nonEmpty(root)) throw new TypeError("workspace root is required");
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0 || maxReadBytes > MAX_WORKSPACE_BYTES) {
      throw new RangeError("maxReadBytes must be between 1 byte and 64 MiB");
    }
    if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes <= 0 || maxWriteBytes > MAX_WORKSPACE_BYTES) {
      throw new RangeError("maxWriteBytes must be between 1 byte and 64 MiB");
    }
    this.#configuredRoot = resolve(root);
    this.#maxReadBytes = maxReadBytes;
    this.#maxWriteBytes = maxWriteBytes;
  }

  async initialize() {
    let canonical;
    try {
      canonical = await realpath(this.#configuredRoot);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new WorkspaceError("WORKSPACE_ROOT_INVALID", "workspace root must exist and be a directory");
    }
    this.#root = canonical;
    return Object.freeze({ root: canonical });
  }

  async readText(relativePath, { maxBytes = this.#maxReadBytes } = {}) {
    this.#requireInitialized();
    this.#validateLimit(maxBytes, "maxBytes");
    const { target, displayPath } = await this.#resolveTarget(relativePath, false);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new WorkspaceError("FILE_NOT_FOUND", "workspace file does not exist");
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new WorkspaceError("UNSAFE_FILE_TYPE", "workspace reads require a regular non-symlink file");
    }

    if (info.size > maxBytes) {
      throw new WorkspaceError("READ_LIMIT_EXCEEDED", "workspace file exceeds the read limit");
    }
    const canonicalTarget = await realpath(target);
    this.#assertInside(canonicalTarget);
    const file = await open(canonicalTarget, "r");
    let buffer;
    try {
      const currentInfo = await file.stat();
      if (!currentInfo.isFile() || currentInfo.size > maxBytes) {
        throw new WorkspaceError("READ_LIMIT_EXCEEDED", "workspace file exceeds the read limit");
      }
      const bounded = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < bounded.length) {
        const { bytesRead } = await file.read(bounded, offset, bounded.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) {
        throw new WorkspaceError("READ_LIMIT_EXCEEDED", "workspace file exceeds the read limit");
      }
      buffer = bounded.subarray(0, offset);
    } finally {
      await file.close();
    }
    return Object.freeze({
      path: displayPath,
      content: buffer.toString("utf8"),
      bytes: buffer.byteLength,
      sha256: hash(buffer),
    });
  }

  async writeText(relativePath, content, {
    expectedSha256,
    createOnly = false,
    maxBytes = this.#maxWriteBytes,
  } = {}) {
    this.#requireInitialized();
    this.#validateLimit(maxBytes, "maxBytes");
    if (typeof content !== "string") throw new TypeError("workspace content must be a string");
    const buffer = Buffer.from(content, "utf8");
    if (buffer.byteLength > maxBytes) {
      throw new WorkspaceError("WRITE_LIMIT_EXCEEDED", "workspace content exceeds the write limit");
    }
    if (expectedSha256 !== undefined &&
        (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
      throw new TypeError("expectedSha256 must be a lowercase SHA-256 hex digest");
    }
    if (createOnly && expectedSha256 !== undefined) {
      throw new TypeError("createOnly and expectedSha256 cannot be combined");
    }

    const { target, parent, displayPath } = await this.#resolveTarget(relativePath, true);
    return this.#withTargetLock(target, async () => {
      let existing;
      try {
        existing = await lstat(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new WorkspaceError("UNSAFE_FILE_TYPE", "workspace writes require a regular non-symlink target");
      }
      if (createOnly && existing) {
        throw new WorkspaceError("FILE_ALREADY_EXISTS", "createOnly refused to replace an existing file");
      }

      let currentHash;
      if (existing) {
        const canonicalTarget = await realpath(target);
        this.#assertInside(canonicalTarget);
        currentHash = hash(await readFile(canonicalTarget));
      }
      if (expectedSha256 !== undefined && currentHash !== expectedSha256) {
        throw new WorkspaceError("STALE_FILE_VERSION", "file hash changed; reload before writing");
      }
      if (expectedSha256 === undefined && !createOnly && !existing) {
        // A missing target is allowed for ordinary writes.
      }

      const temporary = join(parent, "." + basename(target) + ".holy-" + randomUUID() + ".tmp");
      let file;
      try {
        file = await open(temporary, "wx", 0o600);
        await file.writeFile(buffer);
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, target);
      } catch (error) {
        if (file) await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }

      return Object.freeze({
        path: displayPath,
        bytes: buffer.byteLength,
        sha256: hash(buffer),
      });
    });
  }

  async #resolveTarget(relativePath, createParents) {
    const segments = this.#segments(relativePath);
    const parentSegments = segments.slice(0, -1);
    let parent = this.#root;

    for (const segment of parentSegments) {
      const next = join(parent, segment);
      if (createParents) {
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }

      let info;
      try {
        info = await lstat(next);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new WorkspaceError("PARENT_NOT_FOUND", "workspace parent directory does not exist");
        }
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new WorkspaceError("UNSAFE_PATH_COMPONENT", "workspace path contains a symlink or non-directory component");
      }
      const canonical = await realpath(next);
      this.#assertInside(canonical);
      parent = canonical;
    }

    const target = join(parent, segments.at(-1));
    this.#assertInside(target);
    return {
      target,
      parent,
      displayPath: segments.join("/"),
    };
  }

  #segments(value) {
    if (!nonEmpty(value) || value.includes("\0") || isAbsolute(value) ||
        /^[a-zA-Z]:/.test(value) || value.startsWith("\\") || value.startsWith("//")) {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", "path must be a non-empty relative workspace path");
    }
    const segments = value.split(/[\\/]+/);
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new WorkspaceError("INVALID_WORKSPACE_PATH", "path traversal and dot components are not allowed");
    }
    return segments;
  }

  #assertInside(candidate) {
    if (!inside(this.#root, candidate)) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", "resolved path is outside the workspace");
    }
  }

  #validateLimit(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORKSPACE_BYTES) {
      throw new RangeError(field + " must be between 1 byte and 64 MiB");
    }
  }

  #requireInitialized() {
    if (!this.#root) {
      throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "call initialize() before workspace access");
    }
  }

  async #withTargetLock(target, operation) {
    const lockPath = target + ".holy.lock";
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new WorkspaceError("FILE_LOCKED", "workspace target is locked; retry or inspect a stale lock");
      }
      throw error;
    }
    try {
      await lock.writeFile(String(process.pid) + "\n", "utf8");
      await lock.sync();
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}
