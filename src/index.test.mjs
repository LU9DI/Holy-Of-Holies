import test from "node:test";
import assert from "node:assert/strict";
import * as core from "./index.mjs";

test("exports the supported core primitives", () => {
  for (const name of [
    "createTask",
    "getTaskStatuses",
    "transitionTask",
    "evaluatePolicy",
    "EventLedger",
    "ProviderRegistry",
    "ProviderRegistryError",
    "TaskOrchestrator",
    "TaskOrchestratorError",
  ]) {
    assert.ok(name in core, `missing public export: ${name}`);
  }
});
