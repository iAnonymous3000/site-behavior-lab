/**
 * Functional roles are a shared policy layer over the catalog's exact
 * maintainer-reviewed category strings. Reports interpret them at read time,
 * while the CNAME and privacy-policy producers use the same decisions during
 * collection. They deliberately stay separate from TrackerMatch so the frozen
 * report wire and tracker-catalog digest do not change; the Node detector
 * registry binds the exact taxonomy version and digest independently.
 */
export const SERVICE_ROLES = Object.freeze([
  "tracking-analytics",
  "advertising",
  "session-replay",
  "tag-customer-data",
  "operational-monitoring",
  "support-messaging",
  "security-anti-abuse",
  "cdn-hosting",
  "consent-management",
  "other-unknown"
] as const);

export type ServiceRole = (typeof SERVICE_ROLES)[number];

type NonEmptyServiceRoles = readonly [ServiceRole, ...ServiceRole[]];

export const SERVICE_ROLE_TAXONOMY_VERSION = "service-role-taxonomy-v1";
export const SERVICE_ROLE_TAXONOMY_DIGEST =
  "dfccf71d4119c154e71bf7908dd2914557e8fc981951941594b16b00b712ed67";

const TRACKING_SERVICE_ROLES = [
  "tracking-analytics",
  "advertising",
  "session-replay",
  "tag-customer-data"
] as const satisfies readonly ServiceRole[];

/**
 * Exact assignments only. Unknown or newly introduced category strings fall
 * through to other-unknown; they must never become tracking-related merely
 * because a word inside the category resembles a tracking term.
 *
 * Two current catalog categories ("experimentation" and "customer
 * engagement") are deliberately reviewed as other-unknown until their
 * functional behavior can be classified more narrowly.
 */
const CATEGORY_SERVICE_ROLE_ASSIGNMENTS = {
  "advertising": ["advertising"],
  "advertising / analytics": ["tracking-analytics", "advertising"],
  "advertising / data management": ["advertising", "tag-customer-data"],
  "advertising / demand-side platform": ["advertising"],
  "advertising / exchange": ["advertising"],
  "advertising / marketing data": ["advertising", "tag-customer-data"],
  "advertising / measurement": ["tracking-analytics", "advertising"],
  "advertising / publisher monetization": ["advertising"],
  "advertising / recommendations": ["advertising"],
  "advertising / retargeting": ["advertising"],
  "advertising / supply-side platform": ["advertising"],
  "advertising measurement / verification": ["tracking-analytics", "advertising"],
  "analytics": ["tracking-analytics"],
  "analytics / advertising": ["tracking-analytics", "advertising"],
  "analytics / tag management": ["tracking-analytics", "tag-customer-data"],
  "audience analytics": ["tracking-analytics"],
  "audience measurement": ["tracking-analytics"],
  "cdn / hosting": ["cdn-hosting"],
  "consent management": ["consent-management"],
  "customer data platform": ["tag-customer-data"],
  "customer engagement": ["other-unknown"],
  "customer messaging": ["support-messaging"],
  "customer messaging / marketing": ["tag-customer-data", "support-messaging"],
  "customer support": ["support-messaging"],
  "email marketing": ["tag-customer-data"],
  "error monitoring": ["operational-monitoring"],
  "event analytics": ["tracking-analytics"],
  "experimentation": ["other-unknown"],
  "experimentation / behavior analytics": ["tracking-analytics"],
  "experimentation / product analytics": ["tracking-analytics"],
  "identity / advertising": ["advertising", "tag-customer-data"],
  "marketing automation": ["tag-customer-data"],
  "marketing automation / analytics": ["tracking-analytics", "tag-customer-data"],
  "performance monitoring": ["operational-monitoring"],
  "product analytics": ["tracking-analytics"],
  "security / anti-abuse": ["security-anti-abuse"],
  "session replay": ["session-replay"],
  "session replay / behavior analytics": ["tracking-analytics", "session-replay"],
  "session replay / product analytics": ["tracking-analytics", "session-replay"],
  "social / advertising pixel": ["tracking-analytics", "advertising"],
  "tag management / customer data": ["tag-customer-data"],
  "tracking (Brave Shields list)": ["tracking-analytics"],
  "web analytics": ["tracking-analytics"]
} as const satisfies Readonly<Record<string, NonEmptyServiceRoles>>;

const OTHER_UNKNOWN_ROLES = ["other-unknown"] as const satisfies NonEmptyServiceRoles;
const trackingRoleSet = new Set<ServiceRole>(TRACKING_SERVICE_ROLES);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical role-policy representation. It is intentionally independent of
 * the canonical tracker catalog: role changes leave that catalog identity
 * stable while advancing the Node detector registry identity separately.
 */
export function canonicalServiceRoleTaxonomyContents(): string {
  return JSON.stringify({
    domain: "site-behavior-lab-service-role-taxonomy",
    version: SERVICE_ROLE_TAXONOMY_VERSION,
    roles: SERVICE_ROLES,
    trackingRoles: TRACKING_SERVICE_ROLES,
    categoryAssignments: Object.entries(CATEGORY_SERVICE_ROLE_ASSIGNMENTS)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([category, roles]) => ({ category, roles }))
  });
}

export const serviceRoleTaxonomyMetadata = {
  version: SERVICE_ROLE_TAXONOMY_VERSION,
  roles: SERVICE_ROLES.length,
  categoryAssignments: Object.keys(CATEGORY_SERVICE_ROLE_ASSIGNMENTS).length,
  // SHA-256 of canonicalServiceRoleTaxonomyContents(). Kept checked in so the
  // shared browser/Cloudflare module does not need a runtime crypto API.
  digest: SERVICE_ROLE_TAXONOMY_DIGEST
} as const;

/** Return an exact reviewed assignment, or null when the category is unknown. */
export function serviceRoleAssignmentForCategory(category: string): NonEmptyServiceRoles | null {
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_SERVICE_ROLE_ASSIGNMENTS, category)) return null;
  const assignment = CATEGORY_SERVICE_ROLE_ASSIGNMENTS[
    category as keyof typeof CATEGORY_SERVICE_ROLE_ASSIGNMENTS
  ] as NonEmptyServiceRoles;
  return [...assignment] as NonEmptyServiceRoles;
}

/** Return roles for one category, conservatively classifying unknowns. */
export function serviceRolesForCategory(category: string): NonEmptyServiceRoles {
  return serviceRoleAssignmentForCategory(category) ?? [...OTHER_UNKNOWN_ROLES];
}

/**
 * Resolve an entity's complete category set. Roles are deduplicated and
 * returned in the closed vocabulary's stable order.
 */
export function serviceRolesForCategories(categories: readonly string[]): NonEmptyServiceRoles {
  const assigned = new Set<ServiceRole>();
  if (categories.length === 0) assigned.add("other-unknown");

  for (const category of categories) {
    for (const role of serviceRolesForCategory(category)) assigned.add(role);
  }

  return SERVICE_ROLES.filter((role) => assigned.has(role)) as unknown as NonEmptyServiceRoles;
}

/** True only for an explicitly tracking-bearing role. */
export function isTrackingServiceRole(role: ServiceRole): boolean {
  return trackingRoleSet.has(role);
}

/** True when at least one exact category assignment has a tracking-bearing role. */
export function isTrackingRelatedEntity(categories: readonly string[]): boolean {
  return serviceRolesForCategories(categories).some(isTrackingServiceRole);
}

/** True when at least one category has not been assigned a more specific role. */
export function hasUnknownServiceRole(categories: readonly string[]): boolean {
  return serviceRolesForCategories(categories).includes("other-unknown");
}

/**
 * True only when every role is explicitly non-tracking and classified.
 * Unknown categories are neither tracking-related nor operational-only.
 */
export function isOperationalOnlyEntity(categories: readonly string[]): boolean {
  const roles = serviceRolesForCategories(categories);
  return !roles.includes("other-unknown") && !roles.some(isTrackingServiceRole);
}
