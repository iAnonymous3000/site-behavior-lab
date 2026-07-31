// Validation core for the R2 lifecycle readback receipt.
//
// docs/deploy-cloudflare-containers.md requires exactly one reports/ lifecycle
// backstop at eight days or later: disaster cleanup one whole day beyond the
// seven-day application TTL, never racing the app's provenance-aware deletion.
// Production health reads only the app-level TTL (/api/health), so a wrong or
// duplicated bucket rule (the observed 7-day vs 8-day conflict) is invisible
// to every existing check. This module turns the doc's manual "inspect the
// rules" step into a scriptable verdict over the Cloudflare API's rule list.
export const REPORTS_PREFIX = "reports/";
export const MINIMUM_BACKSTOP_DAYS = 8;
const SECONDS_PER_DAY = 86_400;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rulePrefix(rule) {
  const prefix = rule?.conditions?.prefix;
  return typeof prefix === "string" ? prefix : "";
}

function affectsReports(rule) {
  const prefix = rulePrefix(rule);
  return prefix === "" || REPORTS_PREFIX.startsWith(prefix) || prefix.startsWith(REPORTS_PREFIX);
}

function deletionAgeDays(rule) {
  const condition = rule?.deleteObjectsTransition?.condition;
  if (!isRecord(condition)) return null;
  if (condition.type === "Age" && Number.isFinite(condition.maxAge)) {
    return condition.maxAge / SECONDS_PER_DAY;
  }
  // A date-based deletion cannot be a standing backstop; treat it as a
  // violation-bearing rule with an unknowable age.
  return condition.type === "Date" ? 0 : null;
}

/**
 * Judge a bucket's lifecycle rules against the documented retention policy.
 * Returns { ok, violations, observed } where observed lists every enabled
 * deletion rule that touches reports/ with its effective age in days.
 */
export function validateReportsLifecycleRules(rules) {
  const violations = [];
  if (!Array.isArray(rules)) {
    return { ok: false, violations: ["lifecycle rules must be an array"], observed: [] };
  }
  const observed = [];
  for (const rule of rules) {
    if (!isRecord(rule) || rule.enabled !== true) continue;
    if (!affectsReports(rule)) continue;
    const days = deletionAgeDays(rule);
    if (days === null) continue; // multipart-abort or storage-class rules are out of scope
    observed.push({
      id: typeof rule.id === "string" ? rule.id : "(unnamed rule)",
      prefix: rulePrefix(rule),
      effectiveDays: days
    });
  }

  if (observed.length === 0) {
    violations.push(
      `no enabled ${REPORTS_PREFIX} deletion backstop exists; the documented policy requires exactly one at ${MINIMUM_BACKSTOP_DAYS} days or later`
    );
  }
  if (observed.length > 1) {
    violations.push(
      `${observed.length} enabled deletion rules affect ${REPORTS_PREFIX} (${observed
        .map((rule) => `${rule.id}@${rule.effectiveDays}d`)
        .join(", ")}); conflicting rules race each other and the application's own deletion`
    );
  }
  for (const rule of observed) {
    if (rule.effectiveDays < MINIMUM_BACKSTOP_DAYS) {
      violations.push(
        `rule ${rule.id} deletes ${rule.prefix || "(all objects)"} after ${rule.effectiveDays} days; the backstop must never be shorter than ${MINIMUM_BACKSTOP_DAYS} days (it would race application deletion)`
      );
    }
  }
  return { ok: violations.length === 0, violations, observed };
}
