import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  SERVICE_ROLES,
  canonicalServiceRoleTaxonomyContents,
  hasUnknownServiceRole,
  isOperationalOnlyEntity,
  isTrackingRelatedEntity,
  isTrackingServiceRole,
  serviceRoleAssignmentForCategory,
  serviceRolesForCategories,
  serviceRolesForCategory,
  serviceRoleTaxonomyMetadata
} from "./service-role";
import {
  findTrackerMatch,
  trackerCatalogMetadata,
  trackerCatalogRecords
} from "./tracker-catalog";

test("service roles use the complete closed vocabulary", () => {
  assert.deepEqual(SERVICE_ROLES, [
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
  ]);
  assert.equal(serviceRoleTaxonomyMetadata.roles, SERVICE_ROLES.length);
});

test("service-role taxonomy metadata covers the canonical exact policy", () => {
  const canonical = canonicalServiceRoleTaxonomyContents();
  const parsed = JSON.parse(canonical) as {
    categoryAssignments: Array<{ category: string; roles: string[] }>;
  };

  assert.deepEqual(
    parsed.categoryAssignments.map(({ category }) => category),
    [...parsed.categoryAssignments.map(({ category }) => category)].sort()
  );
  assert.equal(
    parsed.categoryAssignments.length,
    serviceRoleTaxonomyMetadata.categoryAssignments
  );
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    serviceRoleTaxonomyMetadata.digest
  );
});

test("every current curated catalog category has an explicit reviewed assignment", () => {
  const categories = [...new Set(trackerCatalogRecords().map(({ category }) => category))].sort();
  const missing = categories.filter((category) => serviceRoleAssignmentForCategory(category) === null);

  assert.deepEqual(missing, []);
  assert.equal(categories.length, 38);
});

test("exact matching never infers tracking from unknown category substrings", () => {
  for (const category of [
    "unknown analytics vendor",
    "advertising adjacent",
    "session replay helper",
    "marketing",
    "security"
  ]) {
    assert.equal(serviceRoleAssignmentForCategory(category), null);
    assert.deepEqual(serviceRolesForCategory(category), ["other-unknown"]);
    assert.equal(isTrackingRelatedEntity([category]), false);
    assert.equal(isOperationalOnlyEntity([category]), false);
    assert.equal(hasUnknownServiceRole([category]), true);
  }
});

test("deliberately unresolved catalog categories are unknown and never tracking", () => {
  for (const category of ["experimentation", "customer engagement"]) {
    assert.deepEqual(serviceRoleAssignmentForCategory(category), ["other-unknown"]);
    assert.equal(isTrackingRelatedEntity([category]), false);
    assert.equal(isOperationalOnlyEntity([category]), false);
    assert.equal(hasUnknownServiceRole([category]), true);
  }
});

test("tracking, operational, support, security, CDN, consent, and fallback roles stay distinct", () => {
  assert.deepEqual(serviceRolesForCategory("tracking (Brave Shields list)"), ["tracking-analytics"]);
  assert.deepEqual(serviceRolesForCategory("error monitoring"), ["operational-monitoring"]);
  assert.deepEqual(serviceRolesForCategory("customer support"), ["support-messaging"]);
  assert.deepEqual(serviceRolesForCategory("security / anti-abuse"), ["security-anti-abuse"]);
  assert.deepEqual(serviceRolesForCategory("cdn / hosting"), ["cdn-hosting"]);
  assert.deepEqual(serviceRolesForCategory("consent management"), ["consent-management"]);

  assert.equal(isTrackingRelatedEntity(["advertising"]), true);
  assert.equal(isOperationalOnlyEntity(["performance monitoring", "customer messaging"]), true);
  assert.equal(isOperationalOnlyEntity(["security / anti-abuse", "cdn / hosting"]), true);
  assert.equal(isTrackingServiceRole("other-unknown"), false);
});

test("multi-category entities merge roles in stable vocabulary order", () => {
  assert.deepEqual(
    serviceRolesForCategories([
      "customer messaging",
      "analytics / tag management",
      "unknown analytics vendor",
      "advertising"
    ]),
    [
      "tracking-analytics",
      "advertising",
      "tag-customer-data",
      "support-messaging",
      "other-unknown"
    ]
  );
  assert.equal(isTrackingRelatedEntity(["analytics", "unknown analytics vendor"]), true);
  assert.equal(hasUnknownServiceRole(["analytics", "unknown analytics vendor"]), true);
  assert.deepEqual(serviceRolesForCategories([]), ["other-unknown"]);
});

test("roles remain outside detector matches and the frozen catalog identity", () => {
  const match = findTrackerMatch("doubleclick.net");
  assert.ok(match);
  assert.equal("roles" in match, false);
  assert.equal("serviceRoles" in match, false);
  assert.equal(
    trackerCatalogMetadata.digest,
    "7cade02ae20c3bb88e28e0de1135ef63c48f586e7196de3c02c13478f70c95bc"
  );
});
