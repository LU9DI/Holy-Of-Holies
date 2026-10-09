const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_REASON_LENGTH = 512;

/**
 * Durable verification revocation backed by an EventLedger-compatible store.
 * Reads fail closed at the verification-engine boundary. The ledger's hash
 * chain is tamper-evident, not resistant to a privileged full-file rewrite.
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
    const alreadyRevoked = await this.isRevoked(verificationId);
    if (alreadyRevoked) return Object.freeze({ verificationId, revoked: false, alreadyRevoked: true });
    const now = this.#clock();
    const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const event = await this.#ledger.append({
      type: "verification.revoked",
      at,
      payload: { verificationId, actorId, reason: reason.trim() },
    });
    return Object.freeze({ verificationId, revoked: true, alreadyRevoked: false, eventHash: event.hash });
  }

  async isRevoked(verificationId) {
    if (typeof verificationId !== "string" || !ID.test(verificationId)) {
      throw new TypeError("verificationId is invalid");
    }
    const events = await this.#ledger.read();
    for (const event of events) {
      if (event.type !== "verification.revoked") continue;
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || typeof payload.verificationId !== "string" ||
          !ID.test(payload.verificationId) || typeof payload.actorId !== "string" ||
          !ID.test(payload.actorId) || typeof payload.reason !== "string" ||
          payload.reason.trim().length === 0 || payload.reason.length > MAX_REASON_LENGTH) {
        throw new Error("revocation ledger contains a malformed revocation event");
      }
      if (payload.verificationId === verificationId) return true;
    }
    return false;
  }
}
