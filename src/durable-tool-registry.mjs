import { ToolRegistry } from "./tool-registry.mjs";
import { OperationRecovery } from "./operation-recovery.mjs";

/**
 * Construct the safe-by-default composition for durable side-effect journaling.
 * Every non-read-only tool registered on the returned registry must provide a
 * stable operationId and successfully persist intent before its handler dispatches.
 *
 * The caller still owns policy evaluation, atomic approval consumption, ledger
 * placement, and independent authorization of recovery resolutions.
 */
export function createDurableToolRegistry({ ledger, authorize, consumeApproval, clock = () => new Date(), defaults = {} } = {}) {
  if (!ledger || typeof ledger.read !== "function" || typeof ledger.append !== "function") {
    throw new TypeError("a compatible durable event ledger is required");
  }
  if (typeof authorize !== "function") {
    throw new TypeError("an explicit policy evaluator is required");
  }
  if (typeof consumeApproval !== "function") {
    throw new TypeError("an atomic approval consumer is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const recovery = new OperationRecovery({ ledger, clock });
  const tools = new ToolRegistry({ authorize, consumeApproval, operationJournal: recovery, clock, defaults });
  return Object.freeze({ tools, recovery });
}
