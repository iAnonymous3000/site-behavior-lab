import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION,
  TRACKING_SERVICE_ROLES
} from "./service-role";

export const METRIC_CONTRACT_VERSION = "metric-contract-v1";
export const METRIC_CONTRACT_DIGEST =
  "19bd5b62d1530480481080a1f208d2664e3769ac16300560a1f3df5894eb9680";

/**
 * The exact ServiceRole taxonomy dependency bound by metric-contract-v1.
 *
 * Consumers that validate a metric-contract-v1 artifact must compare against
 * this dependency, not merely accept any syntactically valid taxonomy tuple.
 */
export const METRIC_CONTRACT_SERVICE_ROLE_TAXONOMY = {
  version: SERVICE_ROLE_TAXONOMY_VERSION,
  digest: SERVICE_ROLE_TAXONOMY_DIGEST
} as const;

/**
 * Canonical, machine-readable definitions for the two request metrics whose
 * similar historical names otherwise invite incompatible interpretations.
 *
 * The digest is checked in rather than computed at runtime so this shared
 * browser/Cloudflare module does not require a crypto implementation.
 */
export function canonicalMetricContractContents(): string {
  return JSON.stringify({
    domain: "site-behavior-lab-metric-contract",
    version: METRIC_CONTRACT_VERSION,
    metrics: [
      {
        id: "knownTrackerRequests",
        status: "frozen-report-wire",
        unit: "retained-request-row",
        definition: {
          directCatalogMatchRequired: true,
          thirdPartyRequired: false,
          serviceRoleRequired: false,
          matchScope: "exact-request-row",
          includesCnameOnlyEvidence: false
        },
        incompleteEvidenceMeaning: "retained-lower-bound"
      },
      {
        id: "trackingServiceRequests",
        status: "read-time-derived",
        unit: "retained-request-row",
        definition: {
          directCatalogMatchRequired: true,
          thirdPartyRequired: true,
          serviceRoleRequired: true,
          matchScope: "exact-tracker-match-category",
          trackingServiceRoles: TRACKING_SERVICE_ROLES,
          includesCnameOnlyEvidence: false
        },
        incompleteEvidenceMeaning: "retained-lower-bound"
      }
    ],
    publicAliases: [
      {
        id: "cataloguedServiceRequests",
        valueSource: "knownTrackerRequests",
        relationship: "exact-value-alias",
        wireFieldRemains: "knownTrackerRequests"
      }
    ],
    deltaCompatibility: {
      trackingServiceRequests: {
        requiresIdentical: [
          "tracker-catalog-identity",
          "service-role-taxonomy-identity",
          "metric-contract-identity"
        ]
      }
    },
    dependencies: {
      serviceRoleTaxonomy: METRIC_CONTRACT_SERVICE_ROLE_TAXONOMY,
      trackerCatalog: "recorded-report-catalog-identity"
    }
  });
}

export const metricContractMetadata = {
  version: METRIC_CONTRACT_VERSION,
  // SHA-256 of canonicalMetricContractContents().
  digest: METRIC_CONTRACT_DIGEST
} as const;
