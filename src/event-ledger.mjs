import { createHash } from "node:crypto";
import { open, readFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const GENESIS_HASH = "0".repeat(64);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function eventBody({ sequence, previousHash, at, type, payload }) {
  return { sequence, previousHash, at, type, payload };
}

function digest(body) {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Local append-only JSONL event ledger with a SHA-256 hash chain.
 *
 * The chain detects accidental changes and unsophisticated edits; it is not a
 * digital signature and cannot prevent a privileged attacker from rewriting
 * the entire file. File-system permissions, backups and external anchoring are
 * separate controls. A stale lock after a crash fails closed and needs manual
 * operator review rather than automatic lock stealing.
 */
export class EventLedger {
  #path;
  #lockPath;
  #queue = Promise.resolve();

  constructor(path) {
    if (!nonEmpty(path)) throw new TypeError("ledger path must be a non-empty string");
    this.#path = path;
    this.#lockPath = `${path}.lock`;
  }

  async append({ type, payload, at = new Date().toISOString(), expectedHeadHash }) {
    if (!nonEmpty(type)) throw new TypeError("event type must be a non-empty string");
    if (!payload || typeof payload !== "object") {
      throw new TypeError("event payload must be an object or array");
    }
    if (!validTimestamp(at)) throw new TypeError("event timestamp must be valid");

    let payloadSnapshot;
    try {
      payloadSnapshot = JSON.parse(JSON.stringify(payload));
    } catch {
      throw new TypeError("event payload must be JSON-serializable");
    }

    return this.#serialize(() => this.#withLock(async () => {
      const previousEvents = await this.#readAndVerify();
      const previous = previousEvents.at(-1);
      const actualHeadHash = previous ? previous.hash : GENESIS_HASH;
      if (expectedHeadHash !== undefined) {
        if (typeof expectedHeadHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHeadHash)) {
          throw new TypeError("expectedHeadHash must be a SHA-256 hex digest");
        }
        if (expectedHeadHash !== actualHeadHash) {
          throw new Error("event ledger head changed; reload and retry");
        }
      }
      const body = eventBody({
        sequence: previous ? previous.sequence + 1 : 1,
        previousHash: previous ? previous.hash : GENESIS_HASH,
        at: new Date(at).toISOString(),
        type: type.trim(),
        payload: payloadSnapshot,
      });
      const entry = { ...body, hash: digest(body) };
      const file = await open(this.#path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      return Object.freeze(entry);
    }));
  }

  async read() {
    return this.#serialize(() => this.#withLock(async () => {
      const events = await this.#readAndVerify();
      return Object.freeze(events.map((entry) => Object.freeze(entry)));
    }));
  }

  async verify() {
    const events = await this.read();
    const last = events.at(-1);
    return Object.freeze({
      valid: true,
      eventCount: events.length,
      lastSequence: last?.sequence ?? 0,
      headHash: last?.hash ?? GENESIS_HASH,
    });
  }

  #serialize(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #withLock(operation) {
    await mkdir(dirname(this.#path), { recursive: true });
    let lock;
    try {
      lock = await open(this.#lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("event ledger is locked; retry later or investigate a stale lock");
      }
      throw error;
    }

    try {
      await lock.writeFile(`${process.pid}\n`, "utf8");
      await lock.sync();
      return await operation();
    } finally {
      await lock.close();
      await unlink(this.#lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async #readAndVerify() {
    let contents;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    if (contents.length === 0) return [];
    if (!contents.endsWith("\n")) {
      throw new Error("event ledger ends with an incomplete record");
    }

    const lines = contents.slice(0, -1).split("\n");
    const events = [];
    let previousHash = GENESIS_HASH;

    for (let index = 0; index < lines.length; index += 1) {
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        throw new Error(`event ledger contains invalid JSON at line ${index + 1}`);
      }

      const expectedSequence = index + 1;
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          entry.sequence !== expectedSequence ||
          entry.previousHash !== previousHash ||
          !validTimestamp(entry.at) ||
          !nonEmpty(entry.type) ||
          !entry.payload || typeof entry.payload !== "object" ||
          typeof entry.hash !== "string") {
        throw new Error(`event ledger integrity failure at sequence ${expectedSequence}`);
      }

      const allowedKeys = ["at", "hash", "payload", "previousHash", "sequence", "type"];
      const actualKeys = Object.keys(entry).sort();
      if (actualKeys.length !== allowedKeys.length ||
          actualKeys.some((key, keyIndex) => key !== allowedKeys[keyIndex])) {
        throw new Error(`event ledger contains unexpected fields at sequence ${expectedSequence}`);
      }

      const body = eventBody(entry);
      const expectedHash = digest(body);
      if (entry.hash !== expectedHash) {
        throw new Error(`event ledger hash mismatch at sequence ${expectedSequence}`);
      }
      events.push(entry);
      previousHash = entry.hash;
    }

    return events;
  }
}
