function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function matchesRule(rule, request, nowMs) {
  if (!rule || typeof rule !== "object") return false;
  if (!["allow", "deny"].includes(rule.effect)) return false;
  if (!nonEmpty(rule.principalId)) return false;
  if (!Array.isArray(rule.actions) || !Array.isArray(rule.resources)) return false;
  if (!rule.actions.every(nonEmpty) || !rule.resources.every(nonEmpty)) return false;
  if (!rule.actions.includes(request.action) || !rule.resources.includes(request.resource)) return false;
  if (rule.principalId !== request.principalId) return false;

  if (rule.notBefore !== undefined) {
    const notBefore = Date.parse(rule.notBefore);
    if (!Number.isFinite(notBefore) || nowMs < notBefore) return false;
  }
  if (rule.expiresAt !== undefined) {
    const expiresAt = Date.parse(rule.expiresAt);
    if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return false;
  }
  return true;
}

/**
 * Evaluate exact-match rules with deny-overrides semantics.
 * This is a decision helper, not an enforcement boundary: every caller must
 * enforce the result at the tool/process/filesystem boundary.
 *
 * Unknown, malformed, or absent rules fail closed.
 */
export function evaluatePolicy({ principalId, action, resource, rules, now = new Date() }) {
  if (!nonEmpty(principalId) || !nonEmpty(action) || !nonEmpty(resource)) {
    return Object.freeze({
      allowed: false,
      reason: "invalid_request",
      matchedRuleIds: [],
    });
  }
  if (!Array.isArray(rules)) {
    return Object.freeze({
      allowed: false,
      reason: "no_policy",
      matchedRuleIds: [],
    });
  }

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return Object.freeze({
      allowed: false,
      reason: "invalid_clock",
      matchedRuleIds: [],
    });
  }

  const request = { principalId, action, resource };
  const matches = rules.filter((rule) => matchesRule(rule, request, nowMs));
  const denies = matches.filter((rule) => rule.effect === "deny");
  if (denies.length > 0) {
    return Object.freeze({
      allowed: false,
      reason: "explicit_deny",
      matchedRuleIds: denies.map((rule) => nonEmpty(rule.id) ? rule.id : "unidentified"),
    });
  }

  const allows = matches.filter((rule) => rule.effect === "allow");
  if (allows.length === 0) {
    return Object.freeze({
      allowed: false,
      reason: "no_matching_allow",
      matchedRuleIds: [],
    });
  }

  return Object.freeze({
    allowed: true,
    reason: "explicit_allow",
    matchedRuleIds: allows.map((rule) => nonEmpty(rule.id) ? rule.id : "unidentified"),
  });
}
