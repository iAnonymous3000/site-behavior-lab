import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_SERVICE_ROLE_TAXONOMY,
  METRIC_CONTRACT_VERSION,
  canonicalMetricContractContents,
  metricContractMetadata
} from "./metric-contract";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION,
  TRACKING_SERVICE_ROLES
} from "./service-role";

test("metric contract digest binds the complete canonical formula", () => {
  const canonical = canonicalMetricContractContents();
  const contract = JSON.parse(canonical) as {
    version: string;
    metrics: Array<{
      id: string;
      definition: {
        thirdPartyRequired: boolean;
        matchScope: string;
        trackingServiceRoles?: string[];
        includesCnameOnlyEvidence: boolean;
      };
      incompleteEvidenceMeaning: string;
    }>;
    dependencies: {
      serviceRoleTaxonomy: { version: string; digest: string };
    };
    publicAliases: Array<{
      id: string;
      valueSource: string;
      relationship: string;
      wireFieldRemains: string;
    }>;
    deltaCompatibility: {
      trackingServiceRequests: { requiresIdentical: string[] };
    };
  };

  assert.equal(contract.version, METRIC_CONTRACT_VERSION);
  assert.deepEqual(
    contract.metrics.map(({ id }) => id),
    ["knownTrackerRequests", "trackingServiceRequests"]
  );
  assert.deepEqual(contract.metrics[0].definition, {
    directCatalogMatchRequired: true,
    thirdPartyRequired: false,
    serviceRoleRequired: false,
    matchScope: "exact-request-row",
    includesCnameOnlyEvidence: false
  });
  assert.deepEqual(contract.metrics[1].definition.trackingServiceRoles, TRACKING_SERVICE_ROLES);
  assert.equal(contract.metrics[1].definition.thirdPartyRequired, true);
  assert.equal(contract.metrics[1].definition.matchScope, "exact-tracker-match-category");
  assert.equal(contract.metrics[1].definition.includesCnameOnlyEvidence, false);
  assert.equal(contract.metrics[1].incompleteEvidenceMeaning, "retained-lower-bound");
  assert.deepEqual(contract.publicAliases, [
    {
      id: "cataloguedServiceRequests",
      valueSource: "knownTrackerRequests",
      relationship: "exact-value-alias",
      wireFieldRemains: "knownTrackerRequests"
    }
  ]);
  assert.deepEqual(
    contract.deltaCompatibility.trackingServiceRequests.requiresIdentical,
    [
      "tracker-catalog-identity",
      "service-role-taxonomy-identity",
      "metric-contract-identity"
    ]
  );
  assert.deepEqual(contract.dependencies.serviceRoleTaxonomy, {
    version: SERVICE_ROLE_TAXONOMY_VERSION,
    digest: SERVICE_ROLE_TAXONOMY_DIGEST
  });
  assert.deepEqual(
    contract.dependencies.serviceRoleTaxonomy,
    METRIC_CONTRACT_SERVICE_ROLE_TAXONOMY
  );
  assert.equal(createHash("sha256").update(canonical).digest("hex"), METRIC_CONTRACT_DIGEST);
  assert.deepEqual(metricContractMetadata, {
    version: METRIC_CONTRACT_VERSION,
    digest: METRIC_CONTRACT_DIGEST
  });
});

test("published metric contract exactly matches the canonical code contract and digest", () => {
  const artifact = JSON.parse(
    readFileSync(path.join(process.cwd(), "public", "metric-contract.v1.json"), "utf8")
  ) as {
    metadata: { version: string; digest: string };
    contract: unknown;
  };

  assert.deepEqual(artifact.metadata, metricContractMetadata);
  assert.deepEqual(artifact.contract, JSON.parse(canonicalMetricContractContents()));
  assert.equal(
    createHash("sha256").update(JSON.stringify(artifact.contract)).digest("hex"),
    artifact.metadata.digest
  );
});
