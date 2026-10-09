const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_REASON_LENGTH = 512;
const MAX_APPEND_ATTEMPTS = 3;
const GENESIS_HASH = "0".repeat(64);

function validRevocationPayload(payload) {
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
    typeof payload.verificationId === "string" && ID.test(payload.verificationId) &&
    typeof payload.actorId === "string" && ID.test(payload.actorId) &&
    typeof payload.reason === "string" && payload.reason.trim().length > 0 &&
    payload.reason.length <= MAX_REASON_LENGTH);
}

/**
 * Durable verification revocation backed by an EventLedger-compatible store.
 * Compare-and-append avoids writing against a stale ledger head. The hash chain
 * is tamper-evident, not resistant to a privileged full-file rewrite.
 */
export class RevocationRegistry {
  #ledger;
  #clock;

  constructor({ ledger, clock = () => new Date() } = {}) {
    if (!ledger || typeof ledger.append !== "function" || typeof ledger.read !== "function") {
      throw new TypeError("ledger must implement append() and read()");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#ledger = ledger;
    this.#clock = clock;
  }

  async revoke(verificationId, { reason = "unspecified", actorId = "system" } = {}) {
    if (typeof verificationId !== "string" || !ID.test(verificationId)) {
      throw new TypeError("verificationId is invalid");
    }
    if (typeof actorId !== "string" || !ID.test(actorId)) {
      throw new TypeError("actorId is invalid");
    }
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH) {
      throw new TypeError("reason must be a non-empty string of at most 512 characters");
    }

    const payload = { verificationId, actorId, reason: reason.trim() };
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const events = await this.#ledger.read();
      if (this.#hasRevocation(events, verificationId)) {
        return Object.freeze({ verificationId, revoked: false, alreadyRevoked: true });
      }
      const previous = events.at(-1);
      const now = this.#clock();
      const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      try {
        const event = await this.#ledger.append({
          type: "verification.revoked",
          at,
          payload,
          expectedHeadHash: previous?.hash ?? GENESIS_HASH,
        });
        return Object.freeze({ verificationId, revoked: true, alreadyRevoked: false, eventHash: event.hash });
      } catch (error) {
        if (!String(error?.message ?? "").includes("event ledger head changed")) throw error;
        if (attempt === MAX_APPEND_ATTEMPTS - 1) {
          throw new Error("revocation could not be committed because the ledger kept changing");
        }
      }
    }
    throw new Error("revocation could not be committed");
  }

  async isRevoked(verificationId) {
    if (typeof verificationId !== "string" || !ID.test(verificationId)) {
      throw new TypeError("verificationId is invalid");
    }
    return this.#hasRevocation(await this.#ledger.read(), verificationId);
  }

  #hasRevocation(events, verificationId) {
    for (const event of events) {
      if (event.type !== "verification.revoked") continue;
      if (!validRevocationPayload(event.payload)) {
        throw new Error("revocation ledger contains a malformed revocation event");
      }
      if (event.payload.verificationId === verificationId) return true;
    }
    return false;
  }
}
