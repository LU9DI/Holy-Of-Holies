function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  if (!["allow", "deny"].includes(rule.effect) || !nonEmpty(rule.principalId)) return false;
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) return false;
  if (!Array.isArray(rule.resources) || rule.resources.length === 0) return false;
  if (!rule.actions.every(nonEmpty) || !rule.resources.every(nonEmpty)) return false;
  if (rule.id !== undefined && !nonEmpty(rule.id)) return false;
  for (const field of ["notBefore", "expiresAt"]) {
    if (rule[field] !== undefined &&
        (typeof rule[field] !== "string" || !Number.isFinite(Date.parse(rule[field])))) {
      return false;
    }
  }
  return true;
}

function matchesRule(rule, request, nowMs) {
  if (rule.principalId !== request.principalId) return false;
  if (!rule.actions.includes(request.action) || !rule.resources.includes(request.resource)) return false;
  if (rule.notBefore !== undefined && nowMs < Date.parse(rule.notBefore)) return false;
  if (rule.expiresAt !== undefined && nowMs >= Date.parse(rule.expiresAt)) return false;
  return true;
}

/**
 * Evaluate exact-match rules with deny-overrides semantics.
 * This is a decision helper, not an enforcement boundary: every caller must
 * enforce the result at the tool/process/filesystem boundary.
 *
 * The complete policy document is validated before any allow can be returned.
 * Wildcards and implicit inheritance are intentionally unsupported.
 */
export function evaluatePolicy(request = {}) {
  const { principalId, action, resource, rules, now = new Date() } = request ?? {};
  if (!nonEmpty(principalId) || !nonEmpty(action) || !nonEmpty(resource)) {
    return Object.freeze({ allowed: false, reason: "invalid_request", matchedRuleIds: [] });
  }
  if (!Array.isArray(rules)) {
    return Object.freeze({ allowed: false, reason: "no_policy", matchedRuleIds: [] });
  }
  if (!rules.every(isValidRule)) {
    return Object.freeze({ allowed: false, reason: "invalid_policy", matchedRuleIds: [] });
  }

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return Object.freeze({ allowed: false, reason: "invalid_clock", matchedRuleIds: [] });
  }

  const request = { principalId, action, resource };
  const matches = rules.filter((rule) => matchesRule(rule, request, nowMs));
  const denies = matches.filter((rule) => rule.effect === "deny");
  if (denies.length > 0) {
    return Object.freeze({
      allowed: false,
      reason: "explicit_deny",
      matchedRuleIds: denies.map((rule) => rule.id ?? "unidentified"),
    });
  }

  const allows = matches.filter((rule) => rule.effect === "allow");
  if (allows.length === 0) {
    return Object.freeze({ allowed: false, reason: "no_matching_allow", matchedRuleIds: [] });
  }

  return Object.freeze({
    allowed: true,
    reason: "explicit_allow",
    matchedRuleIds: allows.map((rule) => rule.id ?? "unidentified"),
  });
}
