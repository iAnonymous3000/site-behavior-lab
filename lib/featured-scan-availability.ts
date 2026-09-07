/** Shared acquisition and trusted-publication selection policy. */
const FEATURED_UNAVAILABLE_REASONS = new Set([
  "automation-blocked",
  "navigation-incomplete",
  "authentication-required",
  "access-denied",
  "rate-limited"
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const FEATURED_UNAVAILABILITY_MAX_DAYS = 28;
type Environment = Record<string, string | undefined>;
function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Strict historical deferral validation, including the frozen-study deadline. */
export function featuredSiteUnavailability(site: unknown, today = new Date().toISOString().slice(0, 10)) {
  const candidate = record(site);
  if (!candidate || candidate.scanAvailability === undefined) return null;
  const value = record(candidate.scanAvailability);
  const invalid = (): never => { throw new Error(`Invalid scanAvailability metadata for ${candidate.domain || "unknown site"}.`); };
  if (!value || value.status !== "temporarily-unavailable" || typeof value.reason !== "string" || !FEATURED_UNAVAILABLE_REASONS.has(value.reason)) return invalid();
  if (!validIsoDate(value.observedAt) || !validIsoDate(value.reviewAfter) || !validIsoDate(today)) return invalid();
  if (value.observedAt > today || value.reviewAfter <= value.observedAt || value.reviewAfter < today ||
      Date.parse(value.reviewAfter) - Date.parse(value.observedAt) > FEATURED_UNAVAILABILITY_MAX_DAYS * DAY_MS) return invalid();
  const workflowRunIds = Array.isArray(value.workflowRunIds) ? [...new Set(value.workflowRunIds)] : [];
  if (workflowRunIds.length < 2 || !workflowRunIds.every((id): id is string => typeof id === "string" && /^\d{6,20}$/.test(id))) return invalid();
  return { status: value.status, reason: value.reason, observedAt: value.observedAt, reviewAfter: value.reviewAfter, workflowRunIds };
}

export function activeFeaturedSiteUnavailability(site: unknown, environment: Environment, today = new Date().toISOString().slice(0, 10)) {
  const freeze = environment.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE;
  if (freeze !== undefined && freeze !== "" && freeze !== "0" && freeze !== "1") {
    throw new Error("SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE must be exactly 0, 1, empty, or unset.");
  }
  // Ordinary publication uses the immutable workflow creation day, independently
  // read by both jobs. A midnight boundary or publisher rerun cannot change its
  // target roster. Frozen studies retain their actual-current-date expiry gate.
  const date = freeze === "1" ? today : environment.FEATURED_ACQUISITION_DATE ?? today;
  if (!validIsoDate(date) || !validIsoDate(today) || date > today) throw new Error("Invalid FEATURED_ACQUISITION_DATE.");
  const reviewAfter = record(record(site)?.scanAvailability)?.reviewAfter;
  const expired = freeze !== "1" && validIsoDate(reviewAfter) && reviewAfter < date;
  const availability = featuredSiteUnavailability(site, expired ? reviewAfter : date);
  return expired ? null : availability;
}

export function featuredAcquisitionDateFromRun(metadata: unknown, runId: string, sourceCommit: string, now = new Date()): string {
  const run = record(metadata);
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[0-9a-f]{40}$/.test(sourceCommit) || !run ||
      String(run.id) !== runId || run.head_sha !== sourceCommit || typeof run.created_at !== "string") {
    throw new Error("Featured acquisition run identity does not match the workflow source.");
  }
  const timestamp = Date.parse(run.created_at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(run.created_at) || !Number.isFinite(timestamp) || timestamp > now.getTime() ||
      new Date(timestamp).toISOString().replace(".000Z", "Z") !== run.created_at) {
    throw new Error("Featured acquisition run has an invalid creation timestamp.");
  }
  return run.created_at.slice(0, 10);
}
