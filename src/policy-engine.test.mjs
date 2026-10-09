import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "./policy-engine.mjs";

const request = {
  principalId: "agent:planner",
  action: "workspace.read",
  resource: "project:alpha",
  now: "2026-01-01T12:00:00.000Z",
};

const allow = {
  id: "allow-read-alpha",
  effect: "allow",
  principalId: "agent:planner",
  actions: ["workspace.read"],
  resources: ["project:alpha"],
};

test("denies by default when no policy or matching allow exists", () => {
  assert.equal(evaluatePolicy({ ...request, rules: [] }).allowed, false);
  assert.equal(evaluatePolicy({ ...request, rules: undefined }).reason, "no_policy");
  assert.equal(evaluatePolicy({ ...request, rules: [allow], action: "workspace.write" }).allowed, false);
});

test("allows an exact principal, action and resource match", () => {
  const result = evaluatePolicy({ ...request, rules: [allow] });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "explicit_allow");
  assert.deepEqual(result.matchedRuleIds, ["allow-read-alpha"]);
});

test("explicit deny overrides a matching allow", () => {
  const deny = {
    id: "deny-sensitive",
    effect: "deny",
    principalId: "agent:planner",
    actions: ["workspace.read"],
    resources: ["project:alpha"],
  };
  const result = evaluatePolicy({ ...request, rules: [allow, deny] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "explicit_deny");
  assert.deepEqual(result.matchedRuleIds, ["deny-sensitive"]);
});

test("expired and not-yet-active rules do not authorize", () => {
  const expired = { ...allow, expiresAt: "2026-01-01T11:59:59.000Z" };
  const future = { ...allow, notBefore: "2026-01-01T12:00:01.000Z" };
  assert.equal(evaluatePolicy({ ...request, rules: [expired] }).allowed, false);
  assert.equal(evaluatePolicy({ ...request, rules: [future] }).allowed, false);
});

test("malformed policy documents fail closed even when another rule allows", () => {
  const malformedDeny = {
    effect: "deny",
    principalId: "agent:planner",
    actions: ["workspace.read"],
    resources: "project:alpha",
  };
  const result = evaluatePolicy({ ...request, rules: [allow, malformedDeny] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "invalid_policy");
});

test("malformed requests and invalid clocks fail closed", () => {
  assert.equal(evaluatePolicy({ ...request, principalId: "", rules: [allow] }).reason, "invalid_request");
  assert.equal(evaluatePolicy({ ...request, now: "not-a-date", rules: [allow] }).reason, "invalid_clock");
});
