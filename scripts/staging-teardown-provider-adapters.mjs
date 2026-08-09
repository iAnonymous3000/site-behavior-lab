import {
  isRecord,
  serializeCanonicalEvidence as serializeCanonicalEvidenceUnchecked,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import { parseStrictJson } from "../lib/strict-json.ts";
import { STAGING_RESOURCE_CONTRACT } from "./staging-teardown-evidence-lib.mjs";
import {
  createBoundedProviderClient,
  createProviderRequestLedger,
  STAGING_TEARDOWN_PROVIDER_REQUEST_MAX_COUNT,
  STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
  stagingTeardownProviderEvidence,
  unwrapCloudflareResponse
} from "./staging-teardown-provider-http.mjs";
import {
  STAGING_TEARDOWN_GITHUB_APP_REQUEST_BUDGET
} from "./staging-teardown-github-app-token.mjs";
import {
  assertStagingTeardownProjectionNfc,
  canonicalStagingTeardownProjection as canonicalProjection,
  compareStagingTeardownCodeUnits,
  normalizeStagingTeardownContainerApplication as normalizedContainerApplication,
  normalizeStagingTeardownContainerCollection as normalizedContainerCollection,
  normalizeStagingTeardownInactiveContainerDurableObject as normalizedInactiveContainerDurableObject,
  normalizeStagingTeardownR2LifecycleRules as normalizeLifecycleRules,
  normalizeStagingTeardownWorkerBindings as normalizedWorkerBindings,
  normalizeStagingTeardownWorkerDeployments as normalizedDeployments,
  normalizeStagingTeardownWorkerScriptSettings as normalizedScriptSettings,
  normalizeStagingTeardownWorkerVersionResources as normalizedVersionResources,
  normalizeStagingTeardownWorkerVersionSettings as normalizedVersionSettings,
  projectStagingTeardownCertificatePack as projectedCertificatePack,
  projectStagingTeardownDnsRecord as dnsRecordProjection,
  projectStagingTeardownR2Bucket as r2BucketProjection,
  projectStagingTeardownR2Object as r2ObjectProjection,
  projectStagingTeardownStoppedWorkerBuild as projectedStoppedWorkerBuild,
  projectStagingTeardownWorkerDomain as projectedWorkerDomain,
  projectStagingTeardownWorkerSecretName as parseWorkerSecret,
  projectStagingTeardownWorkerVersionListItem as parseWorkerVersionListItem,
  stagingTeardownProjectionSha256 as projectionSha256,
  stagingTeardownProviderTimestamp as providerTimestamp
} from "./staging-teardown-target-projections.mjs";

export const STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND =
  "cloudflare-github-exact-v1";
export const STAGING_TEARDOWN_TARGET_MANIFEST_KIND =
  "site-behavior-staging-teardown-exact-targets";
export const STAGING_TEARDOWN_TARGET_MANIFEST_SCHEMA_VERSION = 1;
export const STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES = 48 * 1024;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ZONE_ID = /^[0-9a-f]{32}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID =
  "2efd5506f9c8494dacb1fa10a3e7d5b6";
const R2_DATA_CATALOG_WRITE_PERMISSION_GROUP_ID =
  "d229766a2f7f4d299f20eaa8c9b1fde9";
const REQUIRED_R2_WRITER_PERMISSION_GROUPS = Object.freeze([
  Object.freeze({
    name: "Workers R2 Storage Write",
    scope: "com.cloudflare.api.account",
    pinnedId: null
  }),
  Object.freeze({
    name: "Workers R2 Storage Bucket Item Write",
    scope: "com.cloudflare.edge.r2.bucket",
    pinnedId: R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID
  }),
  Object.freeze({
    name: "Workers R2 Data Catalog Write",
    scope: "com.cloudflare.api.account",
    pinnedId: R2_DATA_CATALOG_WRITE_PERMISSION_GROUP_ID
  })
]);
const STAGING_R2_LIFECYCLE_RULE_ID =
  "durable-replay-staging-cleanup";
export const STAGING_TEARDOWN_RUNNER_LABELS = Object.freeze([
  "Linux",
  "X64",
  "durable-replay-staging",
  "self-hosted"
]);
export const STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT = 180;
export const STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES = 10;
const STAGING_TEARDOWN_EMAIL_ZONE_LIST_MAX_PAGES = 4;
const STAGING_TEARDOWN_EMAIL_ZONE_MAX_COUNT = 10;
const STAGING_TEARDOWN_EMAIL_RULE_LIST_MAX_PAGES = 2;
const STAGING_TEARDOWN_EMAIL_RULE_MAX_COUNT_PER_ZONE = 100;
const STAGING_TEARDOWN_WORKER_ROUTE_MAX_COUNT_PER_ZONE = 1_000;
const STAGING_TEARDOWN_WORKER_BUILD_ATTACHMENT_MAX_COUNT = 200;
const STAGING_TEARDOWN_WORKER_BUILD_LIST_MAX_PAGES = 2;
const STAGING_TEARDOWN_WORKER_BUILD_MAX_COUNT = 400;
const STAGING_TEARDOWN_EVENT_SUBSCRIPTION_LIST_MAX_PAGES = 2;
const STAGING_TEARDOWN_EVENT_SUBSCRIPTION_MAX_COUNT = 200;
const STAGING_TEARDOWN_WORKER_VERSION_LIST_MAX_PAGES = 2;
const STAGING_TEARDOWN_WORKER_VERSION_MAX_COUNT = 20;
const STAGING_TEARDOWN_WORKER_SECRET_MAX_COUNT = 64;
const STAGING_TEARDOWN_WORKER_SCRIPT_LIST_MAX_COUNT = 1_000;
const STAGING_TEARDOWN_CONTAINER_DEPLOYMENT_MAX_COUNT = 100;
const STAGING_TEARDOWN_CONTAINER_ROLLOUT_PAGE_SIZE = 100;
const STAGING_TEARDOWN_CONTAINER_ROLLOUT_MAX_PAGES = 2;
const STAGING_TEARDOWN_CONTAINER_INSTANCE_PAGE_SIZE = 100;
const STAGING_TEARDOWN_CONTAINER_INSTANCE_MAX_PAGES = 2;
export const STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT = 20;
export const STAGING_TEARDOWN_PROVIDER_CONVERGENCE_MAX_ATTEMPTS = 3;
export const STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF = Object.freeze({
  // before + immediate identity/dependency rechecks + bounded convergence +
  // after. These are deliberately conservative upper bounds.
  // Existing Worker/domain/container reads, deletions, and convergence, plus
  // six complete two-page container-instance sweeps (initial, pre-Worker, and
  // pre-application deletion for both staging applications).
  cloudflareCompute: 202,
  // 22 before + 22 after + 22 fresh remove rebind + 20 post-domain
  // pages + 20 immediate per-id identity GETs + 20 DELETEs + 20 exact 404
  // race proofs + 10 certificate calls.
  cloudflareDns: 156,
  // Target-scoped bucket/object reads and deletions. The six former four-page
  // default-jurisdiction account inventories are isolated below, leaving this
  // mutation-capable client under its local 250-request ceiling.
  cloudflareR2: 44 + STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT,
  // One cached before inventory, two uncached remove-check inventories, and
  // one cached after inventory. Every inventory enumerates all three R2
  // jurisdictions and permits at most four cursor pages per jurisdiction.
  cloudflareR2Inventory: 48,
  // Twenty-eight exact bucket-configuration reads plus three external-writer
  // passes, each with one operator-token verification and up to ten Super
  // Slurper pages, isolated from the object-delete client.
  cloudflareR2Configuration: 61,
  // Existing credential inventories/details/revocations plus up to ten
  // account-token pages in each of the three external-writer proofs.
  cloudflareTokenAdmin: 99,
  // Two before inventories plus two immediate pre-delete inventories: four
  // all-type Zone pages, then for at most ten zones two Email Routing rule
  // pages, one catch-all, and one classic Worker-route read (44 per pass).
  // Two unpaginated Worker Builds inventories (triggers and deploy hooks), two
  // 200-item Worker Builds history pages both before and after the final sealed
  // projection, and two 100-item Event Subscriptions pages make each pass 52
  // requests. A larger
  // account inventory is refused before mutation.
  cloudflareEmailAndRouteObservation: 208,
  // Each of four present-Worker passes reads settings and immutable identity, the
  // complete script/settings/secrets/deployments projection, up to two version
  // pages, and at most twenty version details (28 requests per pass), plus
  // four absent-Worker after reads and two fault-hook settings reads.
  cloudflareWorkerProjectionObservation: 118,
  // Initial proof plus one fresh proof immediately before each of the two
  // bucket object-deletion loops. W_MAX=20 and two active versions per Worker:
  // 3 * (one script list + twenty deployment lists + forty version reads).
  cloudflareR2WriterWorkerObservation: 183,
  // Up to ten pages in the initial proof and each of the two fresh per-bucket
  // proofs, isolated from the other observation-token request counters.
  cloudflareR2WriterPipelineObservation: 30,
  // One R2 Data Catalog read in each present bucket's before inventory and
  // immediate remove-check inventory.
  cloudflareCatalogObservation: 4,
  githubAppCredential: STAGING_TEARDOWN_GITHUB_APP_REQUEST_BUDGET,
  githubRunnerAdmin: (3 * STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES) + 1
});
export const STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF = Object.freeze({
  cloudflareComputeToken:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareCompute,
  cloudflareDnsToken:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareDns,
  cloudflareR2Token:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2 +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2Inventory +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2Configuration,
  cloudflareTokenAdminToken:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareTokenAdmin,
  cloudflareObservationToken:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareEmailAndRouteObservation +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareWorkerProjectionObservation +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2WriterWorkerObservation +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2WriterPipelineObservation +
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareCatalogObservation,
  githubAppCredential:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.githubAppCredential,
  githubRunnerInstallationToken:
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.githubRunnerAdmin
});
export const STAGING_TEARDOWN_PROVIDER_WORST_CASE_MILLISECONDS =
  Object.values(STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF)
    .reduce((total, requests) => total + requests, 0) *
    STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS + 60_000;
export const STAGING_TEARDOWN_WORKFLOW_NON_PROVIDER_RESERVE_MILLISECONDS =
  30 * 60_000;

const WORKER_NAMES = Object.freeze([
  "site-behavior-lab-scanner-staging",
  "site-behavior-lab-watch-staging"
]);
const EVENT_SUBSCRIPTION_SOURCE_TYPES = new Set([
  "access",
  "artifacts",
  "artifacts.repo",
  "email.sending",
  "images",
  "kv",
  "r2",
  "superSlurper",
  "superSlurper.job",
  "vectorize",
  "workersAi.model",
  "workersBuilds.worker",
  "workflows.workflow"
]);
const WORKER_DURABLE_OBJECT_BINDING_NAME = "SCANNER";
const WORKER_DURABLE_OBJECT_CLASS_NAME = "ScannerContainer";
const DNS_TARGETS = Object.freeze([
  Object.freeze({
    logicalName: "scan-staging.sitebehavior.org",
    hostname: "scan-staging.sitebehavior.org",
    workerName: "site-behavior-lab-scanner-staging"
  }),
  Object.freeze({
    logicalName: "scan-watch-staging.sitebehavior.org",
    hostname: "scan-watch-staging.sitebehavior.org",
    workerName: "site-behavior-lab-watch-staging"
  })
]);
const CONTAINER_NAMES = Object.freeze([
  "site-behavior-lab-scanner-staging-container",
  "site-behavior-lab-watch-staging-container"
]);
const BUCKET_NAMES = Object.freeze([
  "site-behavior-lab-reports-staging",
  "site-behavior-lab-reports-watch-staging"
]);
const R2_JURISDICTIONS = Object.freeze(["default", "eu", "fedramp"]);
const CREDENTIAL_NAMES = Object.freeze([
  "durable-replay-staging-only-authority",
  "encrypted-watch-staging-only-authority"
]);
const FAULT_HOOK_NAME = "durable-replay-staging-fault-hook";
const RUNNER_LOGICAL_NAME = "durable-replay-staging-runner-registration";

// Close ingress/scheduling first, then compute, state, credentials, and the
// fault-hook assertion that is satisfied only by deletion of its exact Worker.
export const STAGING_TEARDOWN_REMOVAL_ORDER = Object.freeze([
  RUNNER_LOGICAL_NAME,
  ...DNS_TARGETS.map((entry) => entry.logicalName),
  ...WORKER_NAMES,
  ...CREDENTIAL_NAMES,
  ...CONTAINER_NAMES,
  ...BUCKET_NAMES,
  FAULT_HOOK_NAME
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function serializeCanonicalEvidence(value) {
  assertStagingTeardownProjectionNfc(
    value,
    "staging teardown exact canonical input"
  );
  return serializeCanonicalEvidenceUnchecked(value);
}

for (const [authority, requests] of Object.entries(STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF)) {
  requireValue(
    requests <= STAGING_TEARDOWN_PROVIDER_REQUEST_MAX_COUNT,
    `${authority} worst-case request proof exceeds the bounded provider-client budget`
  );
}

function exactKeys(value, keys, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareStagingTeardownCodeUnits);
  const expected = [...keys].sort(compareStagingTeardownCodeUnits);
  requireValue(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${label} must contain exactly ${expected.join(", ")}`
  );
}

function exactArray(value, expected, label) {
  requireValue(
    Array.isArray(value) && value.length === expected.length,
    `${label} must contain exactly ${expected.length} entries`
  );
  return value.map((entry, index) => {
    requireValue(
      entry?.logicalName === expected[index],
      `${label}[${index}].logicalName must be exactly ${expected[index]}`
    );
    return entry;
  });
}

function validateRequiredStagingLifecycleRules(value, present, label) {
  requireValue(Array.isArray(value), `${label} must be an array`);
  if (!present) {
    requireValue(value.length === 0, `${label} must be empty when the bucket is absent`);
    return;
  }
  requireValue(
    value.length === 1 && isRecord(value[0]),
    `${label} must contain exactly the reviewed one-day cleanup rule`
  );
  const rule = value[0];
  const allowedRuleKeys = new Set([
    "id", "conditions", "enabled", "abortMultipartUploadsTransition",
    "deleteObjectsTransition", "storageClassTransitions"
  ]);
  requireValue(
    Object.keys(rule).every((key) => allowedRuleKeys.has(key)),
    `${label} contains an unreviewed lifecycle field`
  );
  requireValue(
    rule.id === STAGING_R2_LIFECYCLE_RULE_ID && rule.enabled === true,
    `${label} must be the enabled canonical staging cleanup rule`
  );
  exactKeys(rule.conditions, ["prefix"], `${label} conditions`);
  requireValue(rule.conditions.prefix === "", `${label} must cover the whole bucket`);
  for (const [transitionName, transition] of [
    ["deleteObjectsTransition", rule.deleteObjectsTransition],
    ["abortMultipartUploadsTransition", rule.abortMultipartUploadsTransition]
  ]) {
    exactKeys(transition, ["condition"], `${label} ${transitionName}`);
    exactKeys(
      transition.condition,
      ["maxAge", "type"],
      `${label} ${transitionName} condition`
    );
    requireValue(
      transition.condition.type === "Age" && transition.condition.maxAge === 86_400,
      `${label} ${transitionName} must use exactly one day`
    );
  }
  requireValue(
    rule.storageClassTransitions === undefined ||
      (Array.isArray(rule.storageClassTransitions) && rule.storageClassTransitions.length === 0),
    `${label} must not contain a storage-class transition`
  );
}

function sortedUniqueStrings(value, label, { maximum = 512 } = {}) {
  requireValue(Array.isArray(value), `${label} must be an array`);
  const sorted = [...value].sort(compareStagingTeardownCodeUnits);
  requireValue(
    value.every(
      (entry, index) =>
        typeof entry === "string" && entry.length >= 1 &&
        entry.length <= maximum && entry === entry.trim() &&
        !/[\u0000-\u001f\u007f]/.test(entry) && entry === sorted[index]
    ) && new Set(value).size === value.length,
    `${label} must contain unique, sorted, bounded strings`
  );
  return value;
}

function validateR2ObjectFact(value, label) {
  exactKeys(
    value,
    [
      "key", "etag", "size", "lastModified", "ssec", "storageClass",
      "customMetadata", "httpMetadata"
    ],
    label
  );
  requireValue(
    typeof value.key === "string" && value.key === value.key.normalize("NFC"),
    `${label}.key must already be NFC because R2 object keys are byte-distinct`
  );
  encodeCloudflareR2ObjectKeyPath(value.key);
  requireValue(
    typeof value.etag === "string" && value.etag.length >= 1 &&
      value.etag.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value.etag),
    `${label}.etag must be a bounded raw provider ETag`
  );
  requireValue(
    Number.isSafeInteger(value.size) && value.size >= 0,
    `${label}.size must be a non-negative safe integer`
  );
  requireValue(
    typeof value.lastModified === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value.lastModified) &&
      Number.isFinite(Date.parse(value.lastModified)),
    `${label}.lastModified must be a UTC provider instant`
  );
  requireValue(typeof value.ssec === "boolean", `${label}.ssec must be boolean`);
  requireValue(
    value.storageClass === "Standard" || value.storageClass === "InfrequentAccess",
    `${label}.storageClass is invalid`
  );
  requireValue(
    isRecord(value.customMetadata) &&
      Object.keys(value.customMetadata).length <= 32 &&
      Object.entries(value.customMetadata).every(([key, entry]) =>
        key.length >= 1 && key.length <= 128 && typeof entry === "string" &&
          entry.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(key)
      ) &&
      Buffer.byteLength(serializeCanonicalEvidence(value.customMetadata), "utf8") <= 4096,
    `${label}.customMetadata must be a bounded string map`
  );
  const httpMetadataKeys = new Set([
    "cacheControl", "cacheExpiry", "contentDisposition", "contentEncoding",
    "contentLanguage", "contentType"
  ]);
  requireValue(
    isRecord(value.httpMetadata) &&
      Object.keys(value.httpMetadata).every((key) => httpMetadataKeys.has(key)) &&
      Object.values(value.httpMetadata).every((entry) =>
        typeof entry === "string" && entry.length <= 1024 &&
          !/[\u0000-\u001f\u007f]/.test(entry)
      ) &&
      Buffer.byteLength(serializeCanonicalEvidence(value.httpMetadata), "utf8") <= 4096,
    `${label}.httpMetadata must contain only bounded provider HTTP metadata`
  );
  if (Object.hasOwn(value.httpMetadata, "cacheExpiry")) {
    requireValue(
      Number.isFinite(Date.parse(value.httpMetadata.cacheExpiry)),
      `${label}.httpMetadata.cacheExpiry must be an instant`
    );
  }
  return value;
}

function optionalProviderId(value, expectedPresent, label) {
  if (expectedPresent) {
    requireValue(
      typeof value === "string" && PROVIDER_ID.test(value),
      `${label} must pin a provider identifier when expectedPresent is true`
    );
  } else {
    requireValue(value === null, `${label} must be null when expectedPresent is false`);
  }
}

function expectedPresent(value, label) {
  requireValue(
    isRecord(value) && typeof value.expectedPresent === "boolean",
    `${label}.expectedPresent must be boolean`
  );
  return value.expectedPresent;
}

function validateExactR2CredentialPolicies(value, label, accountId, allowedBucket) {
  requireValue(
    Array.isArray(value) && value.length === 1 && isRecord(value[0]),
    `${label} must contain exactly one allow-only staging-bucket policy`
  );
  const policy = value[0];
  const policyKeys = Object.keys(policy).sort(compareStagingTeardownCodeUnits);
  requireValue(
    policyKeys.every((key) => ["effect", "id", "permission_groups", "resources"].includes(key)) &&
      policyKeys.includes("effect") && policyKeys.includes("permission_groups") &&
      policyKeys.includes("resources"),
    `${label} policy contains an unapproved field`
  );
  if (Object.hasOwn(policy, "id")) {
    requireValue(PROVIDER_ID.test(policy.id), `${label} policy id is invalid`);
  }
  requireValue(policy.effect === "allow", `${label} policy must be allow-only`);
  requireValue(
    Array.isArray(policy.permission_groups) && policy.permission_groups.length === 1 &&
      isRecord(policy.permission_groups[0]),
    `${label} must contain exactly one approved permission group`
  );
  const group = policy.permission_groups[0];
  const groupKeys = Object.keys(group).sort(compareStagingTeardownCodeUnits);
  requireValue(
    groupKeys.every((key) => ["id", "meta", "name"].includes(key)) &&
      groupKeys.includes("id") && groupKeys.includes("name"),
    `${label} permission group contains an unapproved field`
  );
  requireValue(
    group.id === R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID &&
      group.name === "Workers R2 Storage Bucket Item Write",
    `${label} must use only the exact R2 bucket-item write permission group`
  );
  if (Object.hasOwn(group, "meta")) {
    requireValue(isRecord(group.meta), `${label} permission group meta must be an object`);
    requireValue(
      Object.keys(group.meta).every((key) => key === "key" || key === "value"),
      `${label} permission group meta contains an unapproved field`
    );
    requireValue(
      (!Object.hasOwn(group.meta, "key") ||
        (typeof group.meta.key === "string" && group.meta.key.length <= 128)) &&
        (!Object.hasOwn(group.meta, "value") ||
          (typeof group.meta.value === "string" && group.meta.value.length <= 512)),
      `${label} permission group meta must contain bounded strings`
    );
  }
  const expectedResource =
    `com.cloudflare.edge.r2.bucket.${accountId}_default_${allowedBucket}`;
  requireValue(
    isRecord(policy.resources) &&
      Object.keys(policy.resources).length === 1 &&
      policy.resources[expectedResource] === "*",
    `${label} must select only the exact default-jurisdiction staging bucket and no account or wildcard resource`
  );
}

/** Validate every destructive target before the first provider request. */
export function validateStagingTeardownTargetManifest(value, trustedCommit) {
  assertStagingTeardownProjectionNfc(value, "staging teardown target manifest");
  exactKeys(
    value,
    ["schemaVersion", "artifactKind", "stagingSourceCommit", "cloudflare", "github"],
    "staging teardown target manifest"
  );
  requireValue(
    value.schemaVersion === STAGING_TEARDOWN_TARGET_MANIFEST_SCHEMA_VERSION &&
      value.artifactKind === STAGING_TEARDOWN_TARGET_MANIFEST_KIND,
    "staging teardown target manifest has the wrong identity"
  );
  requireValue(
    typeof trustedCommit === "string" && FULL_SHA.test(trustedCommit) &&
      value.stagingSourceCommit === trustedCommit,
    "staging teardown target manifest must bind the exact trusted workflow commit"
  );

  const cloudflare = value.cloudflare;
  exactKeys(
    cloudflare,
    ["accountId", "zoneId", "workers", "dns", "containers", "buckets", "credentialSets", "faultHook"],
    "staging teardown Cloudflare targets"
  );
  requireValue(ACCOUNT_ID.test(cloudflare.accountId), "Cloudflare accountId must be 32 lowercase hex");
  requireValue(ZONE_ID.test(cloudflare.zoneId), "Cloudflare zoneId must be 32 lowercase hex");

  const workers = exactArray(cloudflare.workers, WORKER_NAMES, "Cloudflare worker targets");
  for (const [index, entry] of workers.entries()) {
    exactKeys(
      entry,
      [
        "logicalName", "scriptName", "workerId", "expectedPresent", "durableObjectBindingName",
        "durableObjectClassName", "durableObjectNamespaceId", "containerApplicationName",
        "createdOn", "modifiedOn", "latestScriptEtag", "versionSettingsSha256",
        "scriptSettingsSha256", "deploymentsSha256", "stoppedBuildsSha256",
        "versionState", "secretNames"
      ],
      `Cloudflare worker target ${index}`
    );
    requireValue(entry.scriptName === WORKER_NAMES[index], `Cloudflare worker target ${index} scriptName is not canonical`);
    const present = expectedPresent(entry, `Cloudflare worker target ${index}`);
    optionalProviderId(entry.workerId, present, `Cloudflare worker target ${index}.workerId`);
    requireValue(
      entry.durableObjectBindingName === WORKER_DURABLE_OBJECT_BINDING_NAME &&
        entry.durableObjectClassName === WORKER_DURABLE_OBJECT_CLASS_NAME &&
        entry.containerApplicationName === CONTAINER_NAMES[index],
      `Cloudflare worker target ${index} must bind the canonical Durable Object and container application`
    );
    optionalProviderId(
      entry.durableObjectNamespaceId,
      present,
      `Cloudflare worker target ${index}.durableObjectNamespaceId`
    );
    const scalarProjectionFields = [
      "versionSettingsSha256", "scriptSettingsSha256",
      "deploymentsSha256", "stoppedBuildsSha256"
    ];
    if (present) {
      providerTimestamp(entry.createdOn, `Cloudflare worker target ${index}.createdOn`);
      providerTimestamp(entry.modifiedOn, `Cloudflare worker target ${index}.modifiedOn`);
      boundedProviderText(
        entry.latestScriptEtag,
        256,
        `Cloudflare worker target ${index}.latestScriptEtag`
      );
      for (const field of scalarProjectionFields) {
        requireValue(
          typeof entry[field] === "string" && SHA256.test(entry[field]),
          `Cloudflare worker target ${index}.${field} must be 64 lowercase hex`
        );
      }
      requireValue(
        Array.isArray(entry.versionState) && entry.versionState.length >= 1 &&
          entry.versionState.length <= STAGING_TEARDOWN_WORKER_VERSION_MAX_COUNT,
        `Cloudflare worker target ${index}.versionState must contain 1 through 20 versions`
      );
      const versionIds = new Set();
      const versionNumbers = new Set();
      for (const [versionIndex, version] of entry.versionState.entries()) {
        exactKeys(
          version,
          ["id", "number", "metadataSha256", "resourcesSha256", "scriptEtag"],
          `Cloudflare worker target ${index}.versionState[${versionIndex}]`
        );
        requireValue(
          typeof version.id === "string" && PROVIDER_ID.test(version.id) &&
            !versionIds.has(version.id),
          `Cloudflare worker target ${index}.versionState contains an invalid or repeated id`
        );
        requireValue(
          Number.isSafeInteger(version.number) && version.number >= 1 &&
            !versionNumbers.has(version.number),
          `Cloudflare worker target ${index}.versionState contains an invalid or repeated number`
        );
        for (const field of ["metadataSha256", "resourcesSha256", "scriptEtag"]) {
          requireValue(
            typeof version[field] === "string" && SHA256.test(version[field]),
            `Cloudflare worker target ${index}.versionState[${versionIndex}].${field} must be 64 lowercase hex`
          );
        }
        versionIds.add(version.id);
        versionNumbers.add(version.number);
      }
      sortedUniqueStrings(
        entry.secretNames,
        `Cloudflare worker target ${index}.secretNames`,
        { maximum: 128 }
      );
      requireValue(
        entry.secretNames.length <= STAGING_TEARDOWN_WORKER_SECRET_MAX_COUNT,
        `Cloudflare worker target ${index}.secretNames exceeds the bounded item limit`
      );
    } else {
      requireValue(
        entry.createdOn === null && entry.modifiedOn === null &&
          entry.latestScriptEtag === null &&
          scalarProjectionFields.every((field) => entry[field] === null) &&
          Array.isArray(entry.versionState) && entry.versionState.length === 0 &&
          Array.isArray(entry.secretNames) && entry.secretNames.length === 0,
        `Cloudflare worker target ${index} sealed projection must be empty when absent`
      );
    }
  }

  const dns = exactArray(
    cloudflare.dns,
    DNS_TARGETS.map((entry) => entry.logicalName),
    "Cloudflare DNS targets"
  );
  for (const [index, entry] of dns.entries()) {
    exactKeys(
      entry,
      [
        "logicalName", "hostname", "workerName", "expectedPresent",
        "workerDomainExpectedPresent", "workerDomainId", "workerDomainCertId",
        "dnsRecords", "certificatePackId", "certificateHosts", "certificatePack",
        "certificatePackSha256"
      ],
      `Cloudflare DNS target ${index}`
    );
    const expected = DNS_TARGETS[index];
    requireValue(
      entry.hostname === expected.hostname && entry.workerName === expected.workerName,
      `Cloudflare DNS target ${index} must bind the canonical staging hostname and Worker`
    );
    const present = expectedPresent(entry, `Cloudflare DNS target ${index}`);
    requireValue(
      typeof entry.workerDomainExpectedPresent === "boolean",
      `Cloudflare DNS target ${index}.workerDomainExpectedPresent must be boolean`
    );
    optionalProviderId(
      entry.workerDomainId,
      entry.workerDomainExpectedPresent,
      `Cloudflare DNS target ${index}.workerDomainId`
    );
    requireValue(Array.isArray(entry.dnsRecords), `Cloudflare DNS target ${index}.dnsRecords must be an array`);
    const recordIds = [];
    for (const [recordIndex, record] of entry.dnsRecords.entries()) {
      exactKeys(
        record,
        [
          "id", "type", "name", "content", "proxied", "ttl", "priority",
          "comment", "commentModifiedOn", "data", "meta", "proxiable",
          "tags", "settings", "tagsModifiedOn", "createdOn", "modifiedOn",
          "zoneId", "zoneName"
        ],
        `Cloudflare DNS target ${index}.dnsRecords[${recordIndex}]`
      );
      requireValue(PROVIDER_ID.test(record.id), `Cloudflare DNS target ${index} record id is invalid`);
      requireValue(
        typeof record.type === "string" && /^[A-Z][A-Z0-9]{0,15}$/.test(record.type) &&
          record.name === entry.hostname &&
          typeof record.content === "string" && record.content.length >= 1 && record.content.length <= 1024 &&
          typeof record.proxied === "boolean" && Number.isSafeInteger(record.ttl) &&
          record.ttl >= 1 && record.ttl <= 86_400 &&
          (record.priority === null ||
            (Number.isSafeInteger(record.priority) && record.priority >= 0 && record.priority <= 65_535)) &&
          (record.comment === null ||
            (typeof record.comment === "string" && record.comment.length <= 512 &&
              !/[\u0000-\u001f\u007f]/.test(record.comment))) &&
          (record.commentModifiedOn === null ||
            (typeof record.commentModifiedOn === "string" &&
              Number.isFinite(Date.parse(record.commentModifiedOn)))) &&
          (record.data === null ||
            (isRecord(record.data) &&
              Buffer.byteLength(serializeCanonicalEvidence(record.data), "utf8") <= 4096)) &&
          isRecord(record.meta) &&
          Buffer.byteLength(serializeCanonicalEvidence(record.meta), "utf8") <= 4096 &&
          typeof record.proxiable === "boolean" &&
          Array.isArray(record.tags) && record.tags.length <= 32 &&
          record.tags.every((tag) => typeof tag === "string" && tag.length <= 256) &&
          JSON.stringify(record.tags) === JSON.stringify(
            [...record.tags].sort(compareStagingTeardownCodeUnits)
          ) &&
          isRecord(record.settings) &&
          Buffer.byteLength(serializeCanonicalEvidence(record.settings), "utf8") <= 4096 &&
          (record.tagsModifiedOn === null ||
            (typeof record.tagsModifiedOn === "string" &&
              Number.isFinite(Date.parse(record.tagsModifiedOn)))) &&
          typeof record.createdOn === "string" && Number.isFinite(Date.parse(record.createdOn)) &&
          typeof record.modifiedOn === "string" && Number.isFinite(Date.parse(record.modifiedOn)) &&
          record.zoneId === cloudflare.zoneId &&
          typeof record.zoneName === "string" && record.zoneName.length >= 1 &&
          record.zoneName.length <= 253,
        `Cloudflare DNS target ${index} record must pin its complete stable provider state`
      );
      recordIds.push(record.id);
    }
    sortedUniqueStrings(recordIds, `Cloudflare DNS target ${index}.dnsRecords ids`);
    if (entry.certificatePackId === null) {
      requireValue(
        Array.isArray(entry.certificateHosts) && entry.certificateHosts.length === 0 &&
          entry.certificatePack === null &&
          entry.certificatePackSha256 === null,
        `Cloudflare DNS target ${index} certificate projection must be empty without a certificate pack`
      );
    } else {
      requireValue(
        PROVIDER_ID.test(entry.certificatePackId),
        `Cloudflare DNS target ${index}.certificatePackId must identify a present dedicated pack`
      );
      requireValue(
        JSON.stringify(entry.certificateHosts) === JSON.stringify([entry.hostname]),
        `Cloudflare DNS target ${index} certificate pack must be dedicated to exactly ${entry.hostname}`
      );
      requireValue(
        typeof entry.certificatePackSha256 === "string" &&
          SHA256.test(entry.certificatePackSha256),
        `Cloudflare DNS target ${index}.certificatePackSha256 must seal the complete certificate pack`
      );
      const packProjection = projectedCertificatePack(
        entry.certificatePack,
        `Cloudflare DNS target ${index}.certificatePack`
      );
      requireValue(
        serializeCanonicalEvidence(packProjection) ===
          serializeCanonicalEvidence(entry.certificatePack) &&
          packProjection.id === entry.certificatePackId &&
          packProjection.type === "advanced" &&
          JSON.stringify(packProjection.hosts) === JSON.stringify(entry.certificateHosts) &&
          packProjection.certificates.every((certificate) =>
            JSON.stringify(certificate.hosts) === JSON.stringify([entry.hostname])
          ) &&
          projectionSha256(packProjection) === entry.certificatePackSha256,
        `Cloudflare DNS target ${index} must expose and seal the complete dedicated certificate pack`
      );
      if (entry.workerDomainExpectedPresent) {
        requireValue(
          packProjection.certificates.filter((certificate) =>
            certificate.id === entry.workerDomainCertId
          ).length === 1,
          `Cloudflare DNS target ${index} must link its present Worker domain to exactly one reviewed certificate child`
        );
      }
    }
    requireValue(
      !entry.workerDomainExpectedPresent || entry.certificatePackId !== null,
      `Cloudflare DNS target ${index} must pin the Advanced Certificate generated for every present Worker custom domain`
    );
    optionalProviderId(
      entry.workerDomainCertId,
      entry.workerDomainExpectedPresent,
      `Cloudflare DNS target ${index}.workerDomainCertId`
    );
    requireValue(
      present === (
        entry.workerDomainExpectedPresent ||
        entry.dnsRecords.length > 0 ||
        entry.certificatePackId !== null
      ),
      `Cloudflare DNS target ${index}.expectedPresent must equal the union of its exact domain, DNS-record, and certificate-pack components`
    );
  }
  requireValue(
    dns.reduce((total, entry) => total + entry.dnsRecords.length, 0) <=
      STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT,
    `Cloudflare DNS targets may delete at most ${STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT} exact records across both hostnames`
  );

  const containers = exactArray(cloudflare.containers, CONTAINER_NAMES, "Cloudflare container targets");
  for (const [index, entry] of containers.entries()) {
    exactKeys(
      entry,
      [
        "logicalName", "applicationName", "applicationId", "workerName",
        "durableObjectNamespaceId", "expectedPresent", "resolvedImageDigest",
        "applicationSha256", "deploymentsSha256", "rolloutsSha256",
        "inactiveDurableObjectsSha256"
      ],
      `Cloudflare container target ${index}`
    );
    requireValue(entry.applicationName === CONTAINER_NAMES[index], `Cloudflare container target ${index} name is not canonical`);
    requireValue(entry.workerName === WORKER_NAMES[index], `Cloudflare container target ${index} Worker association is not canonical`);
    const present = expectedPresent(entry, `Cloudflare container target ${index}`);
    optionalProviderId(entry.applicationId, present, `Cloudflare container target ${index}.applicationId`);
    optionalProviderId(
      entry.durableObjectNamespaceId,
      present,
      `Cloudflare container target ${index}.durableObjectNamespaceId`
    );
    requireValue(
      present
        ? /^sha256:[0-9a-f]{64}$/.test(entry.resolvedImageDigest) &&
          SHA256.test(entry.applicationSha256) && SHA256.test(entry.deploymentsSha256) &&
          SHA256.test(entry.rolloutsSha256) && SHA256.test(entry.inactiveDurableObjectsSha256)
        : entry.resolvedImageDigest === null && entry.applicationSha256 === null &&
          entry.deploymentsSha256 === null && entry.rolloutsSha256 === null &&
          entry.inactiveDurableObjectsSha256 === null,
      `Cloudflare container target ${index} must pin exact application, image, deployment, rollout, and inactive Durable Object state when present`
    );
    if (present && workers[index].expectedPresent) {
      requireValue(
        entry.durableObjectNamespaceId === workers[index].durableObjectNamespaceId,
        `Cloudflare container target ${index} namespace must equal its present Worker's reviewed namespace`
      );
    }
  }

  const buckets = exactArray(cloudflare.buckets, BUCKET_NAMES, "Cloudflare R2 bucket targets");
  for (const [index, entry] of buckets.entries()) {
    exactKeys(
      entry,
      [
        "logicalName", "bucketName", "expectedPresent", "expectedCreationDate",
        "expectedJurisdiction", "expectedLocation", "expectedStorageClass",
        "expectedLifecycleRules", "managedDomainBucketId", "managedDomainDomain",
        "objects"
      ],
      `Cloudflare R2 bucket target ${index}`
    );
    requireValue(entry.bucketName === BUCKET_NAMES[index], `Cloudflare R2 bucket target ${index} name is not canonical`);
    const present = expectedPresent(entry, `Cloudflare R2 bucket target ${index}`);
    requireValue(
      present
        ? typeof entry.expectedCreationDate === "string" && entry.expectedCreationDate.length >= 1 && entry.expectedCreationDate.length <= 80
        : entry.expectedCreationDate === null,
      `Cloudflare R2 bucket target ${index}.expectedCreationDate must match expected presence`
    );
    requireValue(
      present
        ? entry.expectedJurisdiction === "default"
        : entry.expectedJurisdiction === null,
      `Cloudflare R2 bucket target ${index}.expectedJurisdiction must be the supported default jurisdiction when present`
    );
    requireValue(
      present
        ? entry.expectedLocation === null ||
          ["apac", "eeur", "enam", "weur", "wnam", "oc"].includes(entry.expectedLocation)
        : entry.expectedLocation === null,
      `Cloudflare R2 bucket target ${index}.expectedLocation must match expected presence`
    );
    requireValue(
      present
        ? ["Standard", "InfrequentAccess"].includes(entry.expectedStorageClass)
        : entry.expectedStorageClass === null,
      `Cloudflare R2 bucket target ${index}.expectedStorageClass must match expected presence`
    );
    validateRequiredStagingLifecycleRules(
      entry.expectedLifecycleRules,
      present,
      `Cloudflare R2 bucket target ${index}.expectedLifecycleRules`
    );
    optionalProviderId(
      entry.managedDomainBucketId,
      present,
      `Cloudflare R2 bucket target ${index}.managedDomainBucketId`
    );
    requireValue(
      present
        ? typeof entry.managedDomainDomain === "string" &&
          entry.managedDomainDomain.length >= 1 && entry.managedDomainDomain.length <= 253 &&
          entry.managedDomainDomain === entry.managedDomainDomain.trim() &&
          !/[\u0000-\u001f\u007f]/.test(entry.managedDomainDomain)
        : entry.managedDomainDomain === null,
      `Cloudflare R2 bucket target ${index}.managedDomainDomain must match expected presence`
    );
    requireValue(Array.isArray(entry.objects), `Cloudflare R2 bucket target ${index}.objects must be an array`);
    entry.objects.forEach((object, objectIndex) =>
      validateR2ObjectFact(object, `Cloudflare R2 bucket target ${index}.objects[${objectIndex}]`)
    );
    const objectKeys = entry.objects.map((object) => object.key);
    requireValue(
      JSON.stringify(objectKeys) === JSON.stringify(
        [...objectKeys].sort(compareStagingTeardownCodeUnits)
      ) &&
        new Set(objectKeys).size === objectKeys.length,
      `Cloudflare R2 bucket target ${index}.objects must be uniquely sorted by key`
    );
    requireValue(
      present || entry.objects.length === 0,
      `Cloudflare R2 bucket target ${index}.objects must be empty when absent`
    );
  }
  requireValue(
    buckets.reduce((total, entry) => total + entry.objects.length, 0) <=
      STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT,
    `Cloudflare R2 target manifest may delete at most ${STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT} objects across both buckets so the ceremony cannot exhaust its request budget after partial deletion`
  );

  const credentials = exactArray(cloudflare.credentialSets, CREDENTIAL_NAMES, "Cloudflare credential targets");
  for (const [index, entry] of credentials.entries()) {
    exactKeys(
      entry,
      [
        "logicalName", "expectedPresent", "tokenId", "tokenName", "allowedBucketName",
        "expectedPolicies", "expectedPolicySha256"
      ],
      `Cloudflare credential target ${index}`
    );
    const present = expectedPresent(entry, `Cloudflare credential target ${index}`);
    optionalProviderId(entry.tokenId, present, `Cloudflare credential target ${index}.tokenId`);
    requireValue(
      entry.tokenName === CREDENTIAL_NAMES[index],
      `Cloudflare credential target ${index}.tokenName must be the canonical staging-only name`
    );
    requireValue(
      entry.allowedBucketName === BUCKET_NAMES[index],
      `Cloudflare credential target ${index}.allowedBucketName is not canonical`
    );
    if (present) {
      requireValue(Array.isArray(entry.expectedPolicies) && entry.expectedPolicies.length >= 1, `Cloudflare credential target ${index} must pin at least one policy`);
      requireValue(
        typeof entry.expectedPolicySha256 === "string" && SHA256.test(entry.expectedPolicySha256) &&
          sha256Bytes(serializeCanonicalEvidence(entry.expectedPolicies)) === entry.expectedPolicySha256,
        `Cloudflare credential target ${index}.expectedPolicySha256 must bind the exact canonical policies`
      );
      validateExactR2CredentialPolicies(
        entry.expectedPolicies,
        `Cloudflare credential target ${index}.expectedPolicies`,
        cloudflare.accountId,
        entry.allowedBucketName
      );
    } else {
      requireValue(
        Array.isArray(entry.expectedPolicies) && entry.expectedPolicies.length === 0 &&
          entry.expectedPolicySha256 === null,
        `Cloudflare credential target ${index} policy fields must be empty when absent`
      );
    }
  }

  const faultHook = cloudflare.faultHook;
  exactKeys(
    faultHook,
    ["logicalName", "workerName", "expectedPresent", "activationBindingName", "secretBindingName"],
    "Cloudflare fault-hook target"
  );
  requireValue(
    faultHook.logicalName === FAULT_HOOK_NAME &&
      faultHook.workerName === WORKER_NAMES[0] &&
      faultHook.activationBindingName === "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS" &&
      faultHook.secretBindingName === "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN",
    "Cloudflare fault-hook target must bind the canonical scanner Worker and exact bindings"
  );
  expectedPresent(faultHook, "Cloudflare fault-hook target");

  const github = value.github;
  exactKeys(github, ["repository", "runner"], "staging teardown GitHub targets");
  requireValue(github.repository === REPOSITORY, `GitHub target repository must be exactly ${REPOSITORY}`);
  exactKeys(github.runner, ["logicalName", "expectedPresent", "id", "name", "labels"], "GitHub runner target");
  requireValue(github.runner.logicalName === RUNNER_LOGICAL_NAME, "GitHub runner logicalName is not canonical");
  const runnerPresent = expectedPresent(github.runner, "GitHub runner target");
  requireValue(
    runnerPresent
      ? Number.isSafeInteger(github.runner.id) && github.runner.id >= 1
      : github.runner.id === null,
    "GitHub runner id must match expected presence"
  );
  requireValue(
    typeof github.runner.name === "string" && github.runner.name.length >= 1 &&
      github.runner.name.length <= 100 && /staging/i.test(github.runner.name) &&
      !/production|\bprod\b/i.test(github.runner.name),
    "GitHub runner name must remain an exact staging-only identity even when expected absent"
  );
  sortedUniqueStrings(github.runner.labels, "GitHub runner labels", { maximum: 100 });
  requireValue(
    JSON.stringify(github.runner.labels) === JSON.stringify(STAGING_TEARDOWN_RUNNER_LABELS),
    `GitHub runner labels must be exactly ${STAGING_TEARDOWN_RUNNER_LABELS.join(", ")}`
  );

  requireValue(
    Buffer.byteLength(serializeCanonicalEvidence(value), "utf8") <=
      STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES,
    `staging teardown target manifest exceeds the ${STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES}-byte GitHub Actions secret limit`
  );

  return value;
}

function requireCredentials(credentials) {
  requireValue(isRecord(credentials), "staging teardown credentials must be an object");
  const cloudflareNames = [
    "cloudflareComputeToken",
    "cloudflareDnsToken",
    "cloudflareR2Token",
    "cloudflareTokenAdminToken",
    "cloudflareObservationToken"
  ];
  const githubNames = [
    "githubRunnerAdminToken",
    "githubRunnerAdminTokenProvider"
  ];
  const presentGithubNames = githubNames.filter((name) =>
    Object.hasOwn(credentials, name)
  );
  requireValue(
    presentGithubNames.length === 1 &&
      Object.keys(credentials).length === cloudflareNames.length + 1 &&
      cloudflareNames.every((name) => Object.hasOwn(credentials, name)),
    "staging teardown credentials must contain five Cloudflare tokens and exactly one GitHub runner token or token provider"
  );
  for (const name of cloudflareNames) {
    const value = credentials[name];
    requireValue(
      typeof value === "string" && value.length >= 20 && value.length <= 4096 && !/\s/.test(value),
      `${name} must be a bounded non-whitespace token`
    );
  }
  if (presentGithubNames[0] === "githubRunnerAdminToken") {
    const value = credentials.githubRunnerAdminToken;
    requireValue(
      typeof value === "string" && value.length >= 20 && value.length <= 4096 && !/\s/.test(value),
      "githubRunnerAdminToken must be a bounded non-whitespace token"
    );
  } else {
    requireValue(
      typeof credentials.githubRunnerAdminTokenProvider === "function",
      "githubRunnerAdminTokenProvider must be a function"
    );
  }
  requireValue(
    new Set([
      credentials.cloudflareComputeToken,
      credentials.cloudflareDnsToken,
      credentials.cloudflareR2Token,
      credentials.cloudflareTokenAdminToken,
      credentials.cloudflareObservationToken
    ]).size === 5,
    "the five Cloudflare authorities must be distinct least-privilege tokens"
  );
  return credentials;
}

function responseResult(response, label) {
  return unwrapCloudflareResponse(response.value, label);
}

function externalIdsDigest(externalIds) {
  return sha256Bytes(serializeCanonicalEvidence(
    [...externalIds].sort(compareStagingTeardownCodeUnits)
  ));
}

function evidence({ kind, sessionId, provider, logicalName, phase, state, externalIds, details = {} }) {
  return stagingTeardownProviderEvidence({
    kind,
    sessionId,
    provider,
    logicalName,
    phase,
    selectedFacts: {
      state,
      externalIdCount: externalIds.length,
      externalIdsSha256: externalIdsDigest(externalIds),
      ...details
    }
  });
}

function assertExpected(target, state, logicalName, phase) {
  const expected = target.expectedPresent ? "present" : "absent";
  if (phase === "before") {
    requireValue(
      state === expected,
      `${logicalName} provider state is ${state}, but the reviewed target manifest requires ${expected}; refusing before mutation`
    );
  }
}

function cloudflarePath(...parts) {
  return `/${parts.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

/**
 * Encode one R2 object key for Cloudflare's path-parameter DELETE endpoint.
 * Object-key slashes remain path separators; every reserved/non-ASCII byte in
 * each segment is percent encoded. Dot-only path segments are refused before
 * any provider call because WHATWG/fetch URL normalization can otherwise move
 * the request outside the pinned object-key suffix.
 */
export function encodeCloudflareR2ObjectKeyPath(key) {
  requireValue(
    typeof key === "string" && key.length >= 1 &&
      new TextEncoder().encode(key).byteLength <= 1024 &&
      !/[\u0000-\u001f\u007f]/.test(key) && key === key.normalize("NFC"),
    "R2 object key must contain 1 through 1024 bounded NFC UTF-8 bytes"
  );
  const segments = key.split("/");
  requireValue(
    segments.every((segment) => segment !== "." && segment !== ".."),
    "R2 object key must not contain traversal-like dot path segments"
  );
  return segments.map((segment) =>
    encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
  ).join("/");
}

function queryPath(path, entries) {
  const search = new URLSearchParams(entries);
  return `${path}?${search.toString()}`;
}

function selectedCloudflareArray(response, label) {
  const result = responseResult(response, label);
  requireValue(Array.isArray(result), `${label} result must be an array`);
  return result;
}

async function listCloudflareNumberedPages({
  client,
  basePath,
  label,
  rawName,
  select,
  perPage = 100,
  maxPages = STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
  queryEntries = []
}) {
  requireValue(
    Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= 100,
    `${label} per-page size must be between 1 and 100`
  );
  requireValue(
    Number.isSafeInteger(maxPages) && maxPages >= 1 &&
      maxPages <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    `${label} page limit is invalid`
  );
  requireValue(
    Array.isArray(queryEntries) && queryEntries.every((entry) =>
      Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && typeof entry[1] === "string"
    ),
    `${label} fixed query entries are invalid`
  );
  const results = [];
  let expectedTotal;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request({
      path: queryPath(
        basePath,
        [...queryEntries, ["per_page", String(perPage)], ["page", String(page)]]
      ),
      label: `${label} page ${page}`,
      rawName: rawName(page)
    });
    const pageItems = select(response, `${label} page ${page}`);
    results.push(...pageItems);
    const info = response.value?.result_info;
    if (info !== undefined) {
      requireValue(isRecord(info), `${label} result_info must be an object`);
      if (info.total_count !== undefined) {
        requireValue(Number.isSafeInteger(info.total_count) && info.total_count >= 0, `${label} total_count is invalid`);
        if (expectedTotal === undefined) expectedTotal = info.total_count;
        requireValue(info.total_count === expectedTotal, `${label} total_count changed while paginating`);
      }
      if (info.total_pages !== undefined) {
        if (info.total_pages === 0) {
          requireValue(
            page === 1 && pageItems.length === 0 && info.total_count === 0 &&
              (info.count === undefined || info.count === 0),
            `${label} may report zero total_pages only for one exact empty first page`
          );
          return results;
        }
        requireValue(
          Number.isSafeInteger(info.total_pages) && info.total_pages >= 1 &&
            info.total_pages <= maxPages,
          `${label} total_pages is invalid or exceeds the bounded page budget`
        );
        if (page === info.total_pages) {
          if (expectedTotal !== undefined) requireValue(results.length === expectedTotal, `${label} did not retrieve the declared total_count`);
          return results;
        }
        requireValue(page < info.total_pages, `${label} pagination exceeded total_pages`);
        continue;
      }
    }
    if (pageItems.length < perPage) {
      if (expectedTotal !== undefined) requireValue(results.length === expectedTotal, `${label} did not retrieve the declared total_count`);
      return results;
    }
  }
  throw new Error(`${label} exceeded the ${maxPages}-page pagination limit`);
}

/**
 * Enumerate security-sensitive Cloudflare lists only when every pagination
 * fact is internally consistent. These inventories gate Worker deletion, so
 * an omitted or drifting result_info field is an incomplete proof rather than
 * permission to continue.
 */
async function listCloudflareStrictNumberedPages({
  client,
  basePath,
  label,
  rawName,
  parseItem,
  identity,
  selectItems = selectedCloudflareArray,
  perPage,
  maximumPerPage = 100,
  maxPages,
  maxItems,
  queryEntries = []
}) {
  requireValue(
    Number.isSafeInteger(maximumPerPage) && maximumPerPage >= 1 && maximumPerPage <= 200 &&
      Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= maximumPerPage,
    `${label} strict per-page size is invalid`
  );
  requireValue(
    Number.isSafeInteger(maxPages) && maxPages >= 1 &&
      maxPages <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    `${label} strict page limit is invalid`
  );
  requireValue(
    Number.isSafeInteger(maxItems) && maxItems >= 0 && maxItems <= 10_000,
    `${label} strict item limit is invalid`
  );
  requireValue(
    Array.isArray(queryEntries) && queryEntries.every((entry) =>
      Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && typeof entry[1] === "string"
    ),
    `${label} strict fixed query entries are invalid`
  );
  requireValue(
    typeof parseItem === "function" && typeof identity === "function" &&
      typeof selectItems === "function",
    `${label} strict item parser is invalid`
  );

  const results = [];
  const identities = new Set();
  let expectedTotalCount;
  let expectedTotalPages;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request({
      path: queryPath(
        basePath,
        [...queryEntries, ["per_page", String(perPage)], ["page", String(page)]]
      ),
      label: `${label} page ${page}`,
      rawName: rawName(page)
    });
    const pageItems = selectItems(response, `${label} page ${page}`);
    requireValue(Array.isArray(pageItems), `${label} page result must be an array`);
    const info = response.value?.result_info;
    requireValue(isRecord(info), `${label} must return result_info on every page`);
    requireValue(
      Number.isSafeInteger(info.count) && info.count === pageItems.length,
      `${label} result_info.count does not match the page result`
    );
    requireValue(info.page === page, `${label} result_info.page is not the requested page`);
    requireValue(
      info.per_page === perPage,
      `${label} result_info.per_page is not the requested bounded page size`
    );
    requireValue(
      Number.isSafeInteger(info.total_count) && info.total_count >= 0 &&
        info.total_count <= maxItems,
      `${label} total_count is invalid or exceeds the bounded item limit`
    );
    requireValue(
      Number.isSafeInteger(info.total_pages) && info.total_pages >= 0 &&
        info.total_pages <= maxPages,
      `${label} total_pages is invalid or exceeds the bounded page limit`
    );
    const calculatedPages = info.total_count === 0
      ? 0
      : Math.ceil(info.total_count / perPage);
    requireValue(
      info.total_pages === calculatedPages,
      `${label} total_pages is inconsistent with total_count and per_page`
    );
    if (expectedTotalCount === undefined) {
      expectedTotalCount = info.total_count;
      expectedTotalPages = info.total_pages;
    }
    requireValue(
      info.total_count === expectedTotalCount && info.total_pages === expectedTotalPages,
      `${label} pagination totals changed while enumerating`
    );
    if (expectedTotalPages === 0) {
      requireValue(
        page === 1 && pageItems.length === 0,
        `${label} may report zero total_pages only for one exact empty first page`
      );
      return results;
    }
    const expectedPageCount = page < expectedTotalPages
      ? perPage
      : expectedTotalCount - ((page - 1) * perPage);
    requireValue(
      pageItems.length === expectedPageCount,
      `${label} page length is inconsistent with the declared pagination totals`
    );
    for (const [index, item] of pageItems.entries()) {
      const parsed = parseItem(item, `${label} page ${page} item ${index}`);
      const itemIdentity = identity(parsed);
      requireValue(
        typeof itemIdentity === "string" && itemIdentity.length >= 1 &&
          itemIdentity.length <= 512 && !identities.has(itemIdentity),
        `${label} returned an invalid or repeated item identity`
      );
      identities.add(itemIdentity);
      results.push(parsed);
    }
    if (page === expectedTotalPages) {
      requireValue(
        results.length === expectedTotalCount,
        `${label} did not retrieve the declared total_count`
      );
      return results;
    }
  }
  throw new Error(`${label} exceeded the ${maxPages}-page strict pagination limit`);
}

function boundedProviderText(value, maxLength, label) {
  requireValue(
    typeof value === "string" && value.length >= 1 && value.length <= maxLength &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `${label} must be bounded non-control text`
  );
  return value;
}

function parseEmailRoutingMatcher(matcher, label) {
  requireValue(isRecord(matcher), `${label} must be an object`);
  requireValue(
    Object.keys(matcher).every((key) => ["field", "type", "value"].includes(key)),
    `${label} contains an unsupported matcher field`
  );
  if (matcher.type === "all") {
    requireValue(
      (matcher.field === undefined || matcher.field === null || matcher.field === "") &&
        (matcher.value === undefined || matcher.value === null || matcher.value === ""),
      `${label} all matcher must not select one address`
    );
    return { type: "all" };
  }
  requireValue(matcher.type === "literal", `${label} has an unsupported matcher type`);
  requireValue(matcher.field === "to", `${label} has an unsupported matcher field`);
  boundedProviderText(matcher.value, 320, `${label}.value`);
  return { type: "literal" };
}

function parseEmailRoutingAction(action, label) {
  requireValue(isRecord(action), `${label} must be an object`);
  requireValue(
    Object.keys(action).every((key) => ["type", "value"].includes(key)),
    `${label} contains an unsupported action field`
  );
  requireValue(
    action.type === "drop" || action.type === "forward" || action.type === "worker",
    `${label} has an unsupported action type`
  );
  const values = action.value ?? [];
  requireValue(
    Array.isArray(values) && values.length <= 8,
    `${label}.value must be a bounded array`
  );
  if (action.type === "drop") {
    requireValue(values.length === 0, `${label} drop action must have no targets`);
    return { type: "drop", workerNames: [] };
  }
  requireValue(values.length >= 1, `${label} action must have at least one target`);
  for (const [index, value] of values.entries()) {
    boundedProviderText(value, 320, `${label}.value[${index}]`);
  }
  if (action.type === "worker") {
    requireValue(
      values.every((value) => PROVIDER_ID.test(value)),
      `${label} Worker action targets must be exact bounded Worker names`
    );
    return { type: "worker", workerNames: [...values] };
  }
  return { type: "forward", workerNames: [] };
}

function parseEmailRoutingRule(rule, label, { catchAll = false } = {}) {
  requireValue(isRecord(rule), `${label} must be an object`);
  requireValue(
    typeof rule.id === "string" && PROVIDER_ID.test(rule.id),
    `${label}.id must be a bounded provider identity`
  );
  requireValue(typeof rule.enabled === "boolean", `${label}.enabled must be boolean`);
  requireValue(
    Array.isArray(rule.matchers) && rule.matchers.length >= 1 && rule.matchers.length <= 8,
    `${label}.matchers must be a bounded non-empty array`
  );
  const matchers = rule.matchers.map((matcher, index) =>
    parseEmailRoutingMatcher(matcher, `${label}.matchers[${index}]`)
  );
  requireValue(
    !catchAll || matchers.every((matcher) => matcher.type === "all"),
    `${label} catch-all must use the exact all matcher`
  );
  requireValue(
    Array.isArray(rule.actions) && rule.actions.length >= 1 && rule.actions.length <= 8,
    `${label}.actions must be a bounded non-empty array`
  );
  const actions = rule.actions.map((action, index) =>
    parseEmailRoutingAction(action, `${label}.actions[${index}]`)
  );
  if (rule.source !== undefined) {
    requireValue(
      rule.source === "api" || rule.source === "wrangler",
      `${label}.source is unsupported`
    );
  }
  return { id: rule.id, workerNames: actions.flatMap((action) => action.workerNames) };
}

function parseAccountZone(zone, accountId, label) {
  requireValue(isRecord(zone), `${label} must be an object`);
  requireValue(
    typeof zone.id === "string" && ZONE_ID.test(zone.id),
    `${label}.id must be 32 lowercase hex`
  );
  boundedProviderText(zone.name, 253, `${label}.name`);
  requireValue(
    zone.type === "full" || zone.type === "partial" ||
      zone.type === "secondary" || zone.type === "internal",
    `${label}.type is unsupported`
  );
  requireValue(
    isRecord(zone.account) && zone.account.id === accountId,
    `${label}.account does not match the reviewed account`
  );
  return { id: zone.id, type: zone.type };
}

function parseClassicWorkerRoute(route, label) {
  requireValue(isRecord(route), `${label} must be an object`);
  requireValue(
    typeof route.id === "string" && PROVIDER_ID.test(route.id),
    `${label}.id must be a bounded provider identity`
  );
  boundedProviderText(route.pattern, 1_024, `${label}.pattern`);
  requireValue(
    route.script === null ||
      (typeof route.script === "string" && PROVIDER_ID.test(route.script)),
    `${label}.script must be null or one exact bounded Worker name`
  );
  return { id: route.id, script: route.script };
}

function parseWorkerBuildAttachment(item, identityField, label) {
  requireValue(isRecord(item), `${label} must be an object`);
  const id = item[identityField];
  requireValue(
    typeof id === "string" && PROVIDER_ID.test(id),
    `${label} must expose one bounded attachment identity`
  );
  return { id };
}

function parseEventSubscription(item, label) {
  requireValue(isRecord(item), `${label} must be an object`);
  requireValue(
    typeof item.id === "string" && item.id.length <= 32 && PROVIDER_ID.test(item.id),
    `${label}.id must be a bounded subscription identity`
  );
  requireValue(isRecord(item.source), `${label}.source must be an object`);
  requireValue(
    EVENT_SUBSCRIPTION_SOURCE_TYPES.has(item.source.type),
    `${label}.source.type is unsupported`
  );
  const source = item.source;
  if (item.source.type === "workersBuilds.worker") {
    exactKeys(source, ["type", "worker_name"], `${label}.source`);
    requireValue(
      typeof source.worker_name === "string" && PROVIDER_ID.test(source.worker_name),
      `${label}.source.worker_name must be one exact bounded Worker name`
    );
    return { id: item.id, workerName: source.worker_name };
  }
  if (source.type === "artifacts.repo") {
    exactKeys(source, ["type", "namespace", "repo_name"], `${label}.source`);
    boundedProviderText(source.namespace, 256, `${label}.source.namespace`);
    boundedProviderText(source.repo_name, 256, `${label}.source.repo_name`);
  } else if (source.type === "email.sending") {
    exactKeys(source, ["type", "zone_id", "domain"], `${label}.source`);
    requireValue(ZONE_ID.test(source.zone_id), `${label}.source.zone_id must be one zone id`);
    boundedProviderText(source.domain, 253, `${label}.source.domain`);
  } else if (source.type === "superSlurper.job") {
    exactKeys(source, ["type", "job_id"], `${label}.source`);
    requireValue(PROVIDER_ID.test(source.job_id), `${label}.source.job_id is invalid`);
  } else if (source.type === "workersAi.model") {
    requireValue(
      Object.keys(source).every((key) => key === "type" || key === "model_name"),
      `${label}.source contains an unsupported Workers AI field`
    );
    if (source.model_name !== undefined) {
      boundedProviderText(source.model_name, 256, `${label}.source.model_name`);
    }
  } else if (source.type === "workflows.workflow") {
    requireValue(
      Object.keys(source).every((key) => key === "type" || key === "workflow_name"),
      `${label}.source contains an unsupported Workflow field`
    );
    if (source.workflow_name !== undefined) {
      requireValue(
        PROVIDER_ID.test(source.workflow_name),
        `${label}.source.workflow_name is invalid`
      );
    }
  } else {
    exactKeys(source, ["type"], `${label}.source`);
  }
  return { id: item.id, workerName: null };
}

async function listCloudflareCursorPages({
  client,
  basePath,
  label,
  rawName,
  extract,
  maxPages = STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
  perPage = 1000,
  cloudflareR2Jurisdiction
}) {
  requireValue(
    Number.isSafeInteger(maxPages) && maxPages >= 1 &&
      maxPages <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    `${label} cursor page limit is invalid`
  );
  requireValue(
    Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= 1000,
    `${label} cursor per-page size is invalid`
  );
  const results = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const entries = [["per_page", String(perPage)]];
    if (cursor !== null) entries.push(["cursor", cursor]);
    const response = await client.request({
      path: queryPath(basePath, entries),
      label: `${label} page ${page}`,
      rawName: rawName(page),
      ...(cloudflareR2Jurisdiction === undefined
        ? {}
        : { cloudflareR2Jurisdiction })
    });
    const { items, nextCursor, isTruncated } = extract(response, `${label} page ${page}`);
    requireValue(Array.isArray(items), `${label} page ${page} items must be an array`);
    requireValue(typeof isTruncated === "boolean", `${label} page ${page} must declare boolean result_info.is_truncated`);
    results.push(...items);
    if (!isTruncated) {
      requireValue(
        nextCursor === null || nextCursor === "",
        `${label} returned a cursor while result_info.is_truncated is false`
      );
      return results;
    }
    requireValue(
      typeof nextCursor === "string" && nextCursor.length >= 1 && nextCursor.length <= 1024 &&
        !cursors.has(nextCursor),
      `${label} returned an invalid or repeated cursor`
    );
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`${label} exceeded the ${maxPages}-page pagination limit`);
}

function exactIdentity(actual, expected, label) {
  requireValue(actual === expected, `${label} does not match the reviewed target identity`);
}

function exactEmptyObject(value, label) {
  requireValue(
    isRecord(value) && Object.keys(value).length === 0,
    `${label} must return an exact empty result object`
  );
}

function cloudflareDeleteResult(response, label) {
  requireValue(response.status !== 204, `${label} must return the documented JSON success envelope`);
  return responseResult(response, label);
}

function exactCloudflareDeleteId(response, expectedId, label) {
  const result = cloudflareDeleteResult(response, label);
  exactIdentity(result?.id, expectedId, `${label} result id`);
}

function exactCloudflareDeleteKey(response, expectedKey, label) {
  const result = cloudflareDeleteResult(response, label);
  exactIdentity(result?.key, expectedKey, `${label} result key`);
}

function exactCloudflareAbsence(response, expectedCode, label) {
  requireValue(response.status === 404, `${label} must return HTTP 404`);
  const envelope = response.value;
  requireValue(
    isRecord(envelope) && envelope.success === false && envelope.result === null &&
      Array.isArray(envelope.errors) && envelope.errors.length === 1 &&
      isRecord(envelope.errors[0]) && envelope.errors[0].code === expectedCode &&
      typeof envelope.errors[0].message === "string" &&
      envelope.errors[0].message.length >= 1 && envelope.errors[0].message.length <= 512,
    `${label} did not return the exact documented Cloudflare absence envelope`
  );
}

function certificateFacts(result, target, logicalName) {
  const projection = projectedCertificatePack(
    result,
    `${logicalName} certificate pack projection`
  );
  exactIdentity(projection.id, target.certificatePackId, `${logicalName} certificate pack id`);
  exactIdentity(projection.type, "advanced", `${logicalName} certificate pack type`);
  requireValue(
    JSON.stringify(projection.hosts) === JSON.stringify(target.certificateHosts),
    `${logicalName} certificate pack is not dedicated to the reviewed hostname`
  );
  requireValue(
    serializeCanonicalEvidence(projection) ===
      serializeCanonicalEvidence(target.certificatePack) &&
      projectionSha256(projection) === target.certificatePackSha256,
    `${logicalName} complete certificate pack changed after review`
  );
  if (target.workerDomainCertId !== null) {
    const matches = projection.certificates.filter(
      (certificate) => certificate.id === target.workerDomainCertId
    );
    requireValue(
      matches.length === 1,
      `${logicalName} certificate pack does not contain the reviewed Worker-domain certificate`
    );
    requireValue(
      JSON.stringify(matches[0].hosts) === JSON.stringify(target.certificateHosts),
      `${logicalName} Worker-domain certificate hosts do not exactly match the reviewed hostname`
    );
  }
  return projection;
}

function terminalCertificateFacts(result, target, logicalName) {
  const projection = projectedCertificatePack(
    result,
    `${logicalName} terminal certificate pack projection`
  );
  exactIdentity(projection.id, target.certificatePackId, `${logicalName} certificate pack id`);
  exactIdentity(projection.type, "advanced", `${logicalName} certificate pack type`);
  requireValue(
    JSON.stringify(projection.hosts) === JSON.stringify(target.certificateHosts),
    `${logicalName} terminal certificate pack hosts changed`
  );
  requireValue(
    projection.status === "pending_deletion" || projection.status === "deleted",
    `${logicalName} certificate deletion returned a non-terminal unexpected status`
  );
  return projection;
}

function parseBindingName(binding) {
  return isRecord(binding) && typeof binding.name === "string" ? binding.name : null;
}

function createRawNamer() {
  let index = 0;
  return (provider, logicalName, phase) => {
    index += 1;
    const stem = logicalName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").slice(0, 50);
    return `${String(index).padStart(3, "0")}.${provider}.${stem}.${phase}.json`;
  };
}

/**
 * Build the Cloudflare half of the composite adapter. Each API surface gets a
 * separate client so a token for R2 cannot delete Workers, and a Worker token
 * cannot revoke credentials.
 */
export function createCloudflareStagingTeardownAdapter({
  manifest,
  credentials,
  sessionId,
  fetchImpl,
  persistRaw,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  apiBaseUrl = "https://api.cloudflare.com"
}) {
  const cf = manifest.cloudflare;
  const rawName = createRawNamer();
  const requestLedgers = Object.freeze({
    compute: createProviderRequestLedger({
      label: "Cloudflare compute token",
      requestLimit: STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.cloudflareComputeToken
    }),
    dns: createProviderRequestLedger({
      label: "Cloudflare DNS token",
      requestLimit: STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.cloudflareDnsToken
    }),
    r2: createProviderRequestLedger({
      label: "Cloudflare R2 token",
      requestLimit: STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.cloudflareR2Token
    }),
    tokenAdmin: createProviderRequestLedger({
      label: "Cloudflare token-administration token",
      requestLimit: STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.cloudflareTokenAdminToken
    }),
    observation: createProviderRequestLedger({
      label: "Cloudflare read-only observation token",
      requestLimit: STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.cloudflareObservationToken
    })
  });
  const client = (token, requestLedger, requestLimit) => createBoundedProviderClient({
    provider: "cloudflare",
    baseUrl: apiBaseUrl,
    token,
    fetchImpl,
    persistRaw,
    requestLedger,
    requestLimit
  });
  const clients = {
    compute: client(
      credentials.cloudflareComputeToken,
      requestLedgers.compute,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareCompute
    ),
    dns: client(
      credentials.cloudflareDnsToken,
      requestLedgers.dns,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareDns
    ),
    r2: client(
      credentials.cloudflareR2Token,
      requestLedgers.r2,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2
    ),
    r2Inventory: client(
      credentials.cloudflareR2Token,
      requestLedgers.r2,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2Inventory
    ),
    r2Configuration: client(
      credentials.cloudflareR2Token,
      requestLedgers.r2,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2Configuration
    ),
    tokenAdmin: client(
      credentials.cloudflareTokenAdminToken,
      requestLedgers.tokenAdmin,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareTokenAdmin
    ),
    emailAndRouteObservation: client(
      credentials.cloudflareObservationToken,
      requestLedgers.observation,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareEmailAndRouteObservation
    ),
    workerProjectionObservation: client(
      credentials.cloudflareObservationToken,
      requestLedgers.observation,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareWorkerProjectionObservation
    ),
    catalogObservation: client(
      credentials.cloudflareObservationToken,
      requestLedgers.observation,
      STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareCatalogObservation
    )
  };
  const accountBucketInventoryCache = new Map();
  const byName = new Map([
    ...cf.workers.map((target) => [target.logicalName, { type: "worker", target }]),
    ...cf.dns.map((target) => [target.logicalName, { type: "dns", target }]),
    ...cf.containers.map((target) => [target.logicalName, { type: "container", target }]),
    ...cf.buckets.map((target) => [target.logicalName, { type: "bucket", target }]),
    ...cf.credentialSets.map((target) => [target.logicalName, { type: "credential", target }]),
    [cf.faultHook.logicalName, { type: "fault", target: cf.faultHook }]
  ]);
  const containerByWorker = new Map(
    cf.containers.map((target) => [target.workerName, target])
  );
  const removedWorkers = new Set();

  requireValue(typeof sleepImpl === "function", "Cloudflare convergence sleep implementation is required");

  async function durableObjectNamespaces(logicalName, phase) {
    const namespaces = await listCloudflareNumberedPages({
      client: clients.compute,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "durable_objects", "namespaces"
      ),
      label: `${logicalName} Durable Object namespaces`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-durable-object-${page}`),
      select(response, label) {
        return selectedCloudflareArray(response, label);
      }
    });
    const ids = new Set();
    for (const [index, namespace] of namespaces.entries()) {
      const label = `${logicalName} Durable Object namespace ${index}`;
      requireValue(isRecord(namespace), `${label} must be an object`);
      requireValue(
        typeof namespace.id === "string" && PROVIDER_ID.test(namespace.id) &&
          !ids.has(namespace.id),
        `${label} must expose one unique bounded id`
      );
      ids.add(namespace.id);
      requireValue(
        typeof namespace.script === "string" && PROVIDER_ID.test(namespace.script),
        `${label} has ambiguous ownership because its script identity is absent`
      );
      if (WORKER_NAMES.includes(namespace.script)) {
        requireValue(
          (namespace.class ?? namespace.class_name) === WORKER_DURABLE_OBJECT_CLASS_NAME,
          `${label} for a protected Worker must expose the exact reviewed class`
        );
      }
    }
    return namespaces;
  }

  async function workerSealedProjection(
    target,
    logicalName,
    phase,
    versionSettings,
    identity
  ) {
    exactIdentity(identity.created_on, target.createdOn, `${logicalName} immutable Worker creation time`);
    exactIdentity(identity.modified_on, target.modifiedOn, `${logicalName} immutable Worker modification time`);

    const scriptsResponse = await clients.workerProjectionObservation.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts"),
      label: `${logicalName} complete Worker script list`,
      rawName: rawName("cloudflare", logicalName, `${phase}-scripts`)
    });
    const scripts = selectedCloudflareArray(
      scriptsResponse,
      `${logicalName} complete Worker script list`
    );
    requireValue(
      scripts.length <= STAGING_TEARDOWN_WORKER_SCRIPT_LIST_MAX_COUNT,
      `${logicalName} Worker script list exceeds the bounded item limit`
    );
    const scriptNames = new Set();
    let scriptMatch = null;
    for (const [index, script] of scripts.entries()) {
      const label = `${logicalName} Worker script list item ${index}`;
      requireValue(isRecord(script), `${label} must be an object`);
      requireValue(
        typeof script.id === "string" && PROVIDER_ID.test(script.id) &&
          !scriptNames.has(script.id),
        `${label}.id must be one unique bounded script name`
      );
      scriptNames.add(script.id);
      if (script.id === target.scriptName) scriptMatch = script;
    }
    requireValue(scriptMatch !== null, `${logicalName} Worker script list omitted the reviewed script`);
    exactIdentity(scriptMatch.id, target.scriptName, `${logicalName} script-list name`);
    exactIdentity(scriptMatch.etag, target.latestScriptEtag, `${logicalName} script-list ETag`);
    exactIdentity(scriptMatch.created_on, target.createdOn, `${logicalName} script-list creation time`);
    exactIdentity(scriptMatch.modified_on, target.modifiedOn, `${logicalName} script-list modification time`);
    providerTimestamp(scriptMatch.created_on, `${logicalName} script-list creation time`);
    providerTimestamp(scriptMatch.modified_on, `${logicalName} script-list modification time`);

    const normalizedSettings = normalizedVersionSettings(
      versionSettings,
      `${logicalName} version settings`
    );
    exactIdentity(
      projectionSha256(normalizedSettings),
      target.versionSettingsSha256,
      `${logicalName} version settings digest`
    );

    const scriptSettingsResponse = await clients.workerProjectionObservation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "script-settings"
      ),
      label: `${logicalName} script-level settings`,
      rawName: rawName("cloudflare", logicalName, `${phase}-script-settings`)
    });
    const scriptSettings = normalizedScriptSettings(
      responseResult(scriptSettingsResponse, `${logicalName} script-level settings`),
      `${logicalName} script-level settings`
    );
    exactIdentity(
      projectionSha256(scriptSettings),
      target.scriptSettingsSha256,
      `${logicalName} script-level settings digest`
    );

    const secretsResponse = await clients.workerProjectionObservation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "secrets"
      ),
      label: `${logicalName} script secret names`,
      rawName: rawName("cloudflare", logicalName, `${phase}-secrets`)
    });
    const rawSecrets = selectedCloudflareArray(
      secretsResponse,
      `${logicalName} script secret names`
    );
    requireValue(
      rawSecrets.length <= STAGING_TEARDOWN_WORKER_SECRET_MAX_COUNT,
      `${logicalName} script secret list exceeds the bounded item limit`
    );
    const secretNames = rawSecrets.map((secret, index) =>
      parseWorkerSecret(secret, `${logicalName} script secret ${index}`)
    ).sort(compareStagingTeardownCodeUnits);
    requireValue(
      new Set(secretNames).size === secretNames.length &&
        serializeCanonicalEvidence(secretNames) ===
          serializeCanonicalEvidence(target.secretNames),
      `${logicalName} script secret-name set does not match the reviewed projection`
    );

    const versions = await listCloudflareStrictNumberedPages({
      client: clients.workerProjectionObservation,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "versions"
      ),
      label: `${logicalName} Worker versions`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-versions-${page}`),
      selectItems(response, label) {
        const result = responseResult(response, label);
        requireValue(
          isRecord(result) && Array.isArray(result.items),
          `${label} result must contain an items array`
        );
        return result.items;
      },
      parseItem: parseWorkerVersionListItem,
      identity: (version) => version.id,
      perPage: 10,
      maxPages: STAGING_TEARDOWN_WORKER_VERSION_LIST_MAX_PAGES,
      maxItems: STAGING_TEARDOWN_WORKER_VERSION_MAX_COUNT
    });
    requireValue(versions.length >= 1, `${logicalName} present Worker has no enumerated version`);
    const versionState = [];
    for (const [index, version] of versions.entries()) {
      const detailResponse = await clients.workerProjectionObservation.request({
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "workers", "scripts",
          target.scriptName, "versions", version.id
        ),
        label: `${logicalName} Worker version ${index} detail`,
        rawName: rawName("cloudflare", logicalName, `${phase}-version-${index}`)
      });
      const detail = responseResult(
        detailResponse,
        `${logicalName} Worker version ${index} detail`
      );
      requireValue(isRecord(detail), `${logicalName} Worker version ${index} detail must be an object`);
      exactIdentity(detail.id, version.id, `${logicalName} Worker version ${index} detail id`);
      exactIdentity(detail.number, version.number, `${logicalName} Worker version ${index} detail number`);
      requireValue(
        isRecord(detail.metadata),
        `${logicalName} Worker version ${index} detail metadata must be an object`
      );
      const resources = normalizedVersionResources(
        detail.resources,
        `${logicalName} Worker version ${index} resources`
      );
      versionState.push({
        id: version.id,
        number: version.number,
        metadataSha256: projectionSha256(canonicalProjection(
          detail.metadata,
          `${logicalName} Worker version ${index} metadata`
        )),
        resourcesSha256: projectionSha256(resources),
        scriptEtag: resources.script.etag
      });
    }
    requireValue(
      serializeCanonicalEvidence(versionState) ===
        serializeCanonicalEvidence(target.versionState),
      `${logicalName} complete Worker version state does not match the reviewed projection`
    );
    const deploymentsResponse = await clients.workerProjectionObservation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "deployments"
      ),
      label: `${logicalName} Worker deployments`,
      rawName: rawName("cloudflare", logicalName, `${phase}-deployments`)
    });
    const deployments = normalizedDeployments(
      responseResult(deploymentsResponse, `${logicalName} Worker deployments`),
      new Set(versionState.map((version) => version.id)),
      `${logicalName} Worker deployments`
    );
    exactIdentity(
      projectionSha256(deployments),
      target.deploymentsSha256,
      `${logicalName} Worker deployments digest`
    );

    return {
      workerScriptMatchCount: 1,
      workerVersionCount: versionState.length,
      workerSecretNameCount: secretNames.length,
      workerDeploymentCount: deployments.deployments.length,
      sealedWorkerProjectionMatches: true
    };
  }

  async function workerBuildExecutionObservation(target, logicalName, phase) {
    const workerBuilds = await listCloudflareStrictNumberedPages({
      client: clients.emailAndRouteObservation,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "builds", "workers",
        target.workerId, "builds"
      ),
      label: `${logicalName} Worker Builds executions`,
      rawName: (page) => rawName(
        "cloudflare", logicalName, `${phase}-build-executions-${page}`
      ),
      parseItem: projectedStoppedWorkerBuild,
      identity: (build) => build.id,
      perPage: 200,
      maximumPerPage: 200,
      maxPages: STAGING_TEARDOWN_WORKER_BUILD_LIST_MAX_PAGES,
      maxItems: STAGING_TEARDOWN_WORKER_BUILD_MAX_COUNT
    });
    requireValue(
      workerBuilds.every((build) => build.status === "stopped"),
      `${logicalName} has a queued, initializing, or running Worker Build; refusing deletion`
    );
    const normalized = workerBuilds.sort((left, right) =>
      compareStagingTeardownCodeUnits(left.id, right.id)
    );
    exactIdentity(
      projectionSha256(normalized),
      target.stoppedBuildsSha256,
      `${logicalName} complete stopped Worker Builds digest`
    );
    return normalized;
  }

  async function workerIngressObservation(target, logicalName, phase) {
    requireValue(
      target.workerId !== null,
      `${logicalName} present Worker must have an immutable identity before ingress inventory`
    );
    const buildSurfaces = [
      {
        name: "trigger",
        identityField: "trigger_uuid",
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "builds", "workers",
          target.workerId, "triggers"
        )
      },
      {
        name: "deploy-hook",
        identityField: "deploy_hook_uuid",
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "builds", "workers",
          target.scriptName, "deploy_hooks"
        )
      }
    ];
    const buildCounts = {};
    for (const surface of buildSurfaces) {
      const response = await clients.emailAndRouteObservation.request({
        path: surface.path,
        label: `${logicalName} Worker Builds ${surface.name}s`,
        rawName: rawName("cloudflare", logicalName, `${phase}-build-${surface.name}`)
      });
      const rawAttachments = selectedCloudflareArray(
        response,
        `${logicalName} Worker Builds ${surface.name}s`
      );
      const buildInfo = response.value?.result_info;
      if (buildInfo !== undefined) {
        requireValue(
          isRecord(buildInfo) && ["count", "total_count", "total_pages"].every((field) =>
            buildInfo[field] === undefined || buildInfo[field] === 0
          ),
          `${logicalName} Worker Builds ${surface.name} result_info must describe an empty result`
        );
      }
      requireValue(
        rawAttachments.length <= STAGING_TEARDOWN_WORKER_BUILD_ATTACHMENT_MAX_COUNT,
        `${logicalName} Worker Builds ${surface.name} inventory exceeds its bounded item limit`
      );
      const attachmentIds = new Set();
      const attachments = rawAttachments.map((item, index) => {
        const attachment = parseWorkerBuildAttachment(
          item,
          surface.identityField,
          `${logicalName} Worker Builds ${surface.name} ${index}`
        );
        requireValue(
          !attachmentIds.has(attachment.id),
          `${logicalName} Worker Builds ${surface.name} inventory contains a repeated identity`
        );
        attachmentIds.add(attachment.id);
        return attachment;
      });
      requireValue(
        attachments.length === 0,
        `${logicalName} has a Worker Builds ${surface.name}; refusing deletion`
      );
      buildCounts[surface.name] = attachments.length;
    }

    const workerBuilds = await workerBuildExecutionObservation(target, logicalName, phase);

    const eventSubscriptions = await listCloudflareStrictNumberedPages({
      client: clients.emailAndRouteObservation,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId,
        "event_subscriptions", "subscriptions"
      ),
      label: `${logicalName} account Event Subscriptions`,
      rawName: (page) => rawName(
        "cloudflare", logicalName, `${phase}-event-subscriptions-${page}`
      ),
      parseItem: parseEventSubscription,
      identity: (subscription) => subscription.id,
      perPage: 100,
      maxPages: STAGING_TEARDOWN_EVENT_SUBSCRIPTION_LIST_MAX_PAGES,
      maxItems: STAGING_TEARDOWN_EVENT_SUBSCRIPTION_MAX_COUNT
    });
    requireValue(
      eventSubscriptions.every((subscription) =>
        subscription.workerName === null ||
          !WORKER_NAMES.includes(subscription.workerName)
      ),
      `${logicalName} account Event Subscription targets a protected staging Worker; refusing deletion`
    );

    const zones = await listCloudflareStrictNumberedPages({
      client: clients.emailAndRouteObservation,
      basePath: cloudflarePath("client", "v4", "zones"),
      label: `${logicalName} all-type account zones`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-zones-${page}`),
      parseItem: (zone, label) => parseAccountZone(zone, cf.accountId, label),
      identity: (zone) => zone.id,
      perPage: 5,
      maxPages: STAGING_TEARDOWN_EMAIL_ZONE_LIST_MAX_PAGES,
      maxItems: STAGING_TEARDOWN_EMAIL_ZONE_MAX_COUNT,
      queryEntries: [["account.id", cf.accountId]]
    });
    requireValue(
      zones.some((zone) => zone.id === cf.zoneId),
      `${logicalName} all-type Zone inventory omitted the reviewed account Zone`
    );

    let emailRuleCount = 0;
    let catchAllCount = 0;
    let classicRouteCount = 0;
    for (const [zoneIndex, zone] of zones.entries()) {
      const rules = await listCloudflareStrictNumberedPages({
        client: clients.emailAndRouteObservation,
        basePath: cloudflarePath(
          "client", "v4", "zones", zone.id, "email", "routing", "rules"
        ),
        label: `${logicalName} Zone ${zoneIndex} Email Routing rules`,
        rawName: (page) => rawName(
          "cloudflare", logicalName, `${phase}-email-${zoneIndex}-${page}`
        ),
        parseItem: (rule, label) => parseEmailRoutingRule(rule, label),
        identity: (rule) => rule.id,
        perPage: 50,
        maxPages: STAGING_TEARDOWN_EMAIL_RULE_LIST_MAX_PAGES,
        maxItems: STAGING_TEARDOWN_EMAIL_RULE_MAX_COUNT_PER_ZONE
      });
      requireValue(
        rules.every((rule) =>
          rule.workerNames.every((workerName) => !WORKER_NAMES.includes(workerName))
        ),
        `${logicalName} Email Routing rule targets a protected staging Worker; refusing deletion`
      );
      emailRuleCount += rules.length;

      const catchAllResponse = await clients.emailAndRouteObservation.request({
        path: cloudflarePath(
          "client", "v4", "zones", zone.id, "email", "routing", "rules", "catch_all"
        ),
        label: `${logicalName} Zone ${zoneIndex} Email Routing catch-all`,
        rawName: rawName("cloudflare", logicalName, `${phase}-catch-${zoneIndex}`)
      });
      const catchAll = parseEmailRoutingRule(
        responseResult(
          catchAllResponse,
          `${logicalName} Zone ${zoneIndex} Email Routing catch-all`
        ),
        `${logicalName} Zone ${zoneIndex} Email Routing catch-all`,
        { catchAll: true }
      );
      requireValue(
        catchAll.workerNames.every((workerName) => !WORKER_NAMES.includes(workerName)),
        `${logicalName} Email Routing catch-all targets a protected staging Worker; refusing deletion`
      );
      catchAllCount += 1;

      const routesResponse = await clients.emailAndRouteObservation.request({
        path: cloudflarePath("client", "v4", "zones", zone.id, "workers", "routes"),
        label: `${logicalName} Zone ${zoneIndex} classic Worker routes`,
        rawName: rawName("cloudflare", logicalName, `${phase}-routes-${zoneIndex}`)
      });
      const rawRoutes = selectedCloudflareArray(
        routesResponse,
        `${logicalName} Zone ${zoneIndex} classic Worker routes`
      );
      requireValue(
        rawRoutes.length <= STAGING_TEARDOWN_WORKER_ROUTE_MAX_COUNT_PER_ZONE,
        `${logicalName} classic Worker route inventory exceeds the bounded item limit`
      );
      const routeIds = new Set();
      for (const [routeIndex, rawRoute] of rawRoutes.entries()) {
        const route = parseClassicWorkerRoute(
          rawRoute,
          `${logicalName} Zone ${zoneIndex} classic Worker route ${routeIndex}`
        );
        requireValue(
          !routeIds.has(route.id),
          `${logicalName} classic Worker route inventory contains a repeated identity`
        );
        routeIds.add(route.id);
        requireValue(
          route.script !== target.scriptName,
          `${logicalName} still has an attached classic route`
        );
      }
      classicRouteCount += rawRoutes.length;
    }

    return {
      accountZoneCount: zones.length,
      emailRuleCount,
      emailCatchAllCount: catchAllCount,
      classicRouteCount,
      workerBuildTriggerCount: buildCounts.trigger,
      workerBuildDeployHookCount: buildCounts["deploy-hook"],
      workerBuildExecutionCount: workerBuilds.length,
      activeWorkerBuildExecutionCount: 0,
      eventSubscriptionCount: eventSubscriptions.length
    };
  }

  async function workerObservation(target, logicalName, phase, { preDelete = false } = {}) {
    const observationPhase = preDelete ? "predelete" : phase;
    const path = `${cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts", target.scriptName, "settings")}`;
    const response = await clients.workerProjectionObservation.request({
      path,
      label: `${logicalName} Worker settings`,
      rawName: rawName("cloudflare", logicalName, `${observationPhase}-worker`),
      acceptedStatuses: [200, 404]
    });
    const state = response.status === 404 ? "absent" : "present";
    let workerIdentityMatches = 0;
    let workerIdentity = null;
    if (target.workerId !== null) {
      const identityResponse = await clients.workerProjectionObservation.request({
        path: queryPath(
          cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts-search"),
          [["id", target.workerId], ["per_page", "100"], ["page", "1"]]
        ),
        label: `${logicalName} immutable Worker identity`,
        rawName: rawName("cloudflare", logicalName, `${observationPhase}-worker-identity`)
      });
      const identityMatches = selectedCloudflareArray(
        identityResponse,
        `${logicalName} immutable Worker identity`
      );
      requireValue(identityMatches.length <= 1, `${logicalName} immutable Worker id matched more than once`);
      workerIdentityMatches = identityMatches.length;
      if (workerIdentityMatches === 1) {
        workerIdentity = identityMatches[0];
        exactIdentity(identityMatches[0]?.id, target.workerId, `${logicalName} immutable Worker id`);
        exactIdentity(identityMatches[0]?.script_name, target.scriptName, `${logicalName} immutable Worker script name`);
      }
      requireValue(
        (state === "present" && workerIdentityMatches === 1) ||
          (state === "absent" && workerIdentityMatches === 0),
        `${logicalName} mutable script name and immutable Worker identity disagree`
      );
    }
    const namespaces = await durableObjectNamespaces(logicalName, observationPhase);
    const namespaceMatches = namespaces.filter((namespace) =>
      isRecord(namespace) &&
        (namespace.id === target.durableObjectNamespaceId ||
          namespace.script === target.scriptName)
    );
    let settingsResult = null;
    if (state === "present") {
      const result = responseResult(response, `${logicalName} Worker settings`);
      settingsResult = result;
      requireValue(isRecord(result), `${logicalName} Worker settings result must be an object`);
      const bindings = Array.isArray(result.bindings) ? result.bindings : [];
      const durableBindings = bindings.filter((binding) => binding?.type === "durable_object_namespace");
      requireValue(
        bindings.every((binding) =>
          isRecord(binding) &&
            ["durable_object_namespace", "plain_text", "secret_text"].includes(binding.type)
        ),
        `${logicalName} has an unreviewed provider-resource binding`
      );
      requireValue(
        durableBindings.length === 1,
        `${logicalName} must have exactly one reviewed Durable Object namespace binding`
      );
      const binding = durableBindings[0];
      exactIdentity(binding.name, target.durableObjectBindingName, `${logicalName} Durable Object binding name`);
      exactIdentity(binding.class_name, target.durableObjectClassName, `${logicalName} Durable Object class`);
      exactIdentity(binding.namespace_id, target.durableObjectNamespaceId, `${logicalName} Durable Object namespace id`);
      requireValue(
        binding.script_name === undefined || binding.script_name === target.scriptName,
        `${logicalName} Durable Object binding points at an external Worker`
      );
      requireValue(namespaceMatches.length === 1, `${logicalName} Durable Object namespace inventory is not exact`);
      exactIdentity(namespaceMatches[0].id, target.durableObjectNamespaceId, `${logicalName} namespace inventory id`);
      exactIdentity(
        namespaceMatches[0].class ?? namespaceMatches[0].class_name,
        target.durableObjectClassName,
        `${logicalName} namespace inventory class`
      );
      exactIdentity(namespaceMatches[0].script, target.scriptName, `${logicalName} namespace inventory script`);
    } else {
      requireValue(
        namespaceMatches.length === 0,
        `${logicalName} Worker is absent but its exact Durable Object namespace remains`
      );
    }
    const requiresDestructivePreflight = phase === "before" && state === "present";
    const ingress = requiresDestructivePreflight
      ? await workerIngressObservation(target, logicalName, observationPhase)
      : {
          accountZoneCount: 0,
          emailRuleCount: 0,
          emailCatchAllCount: 0,
          classicRouteCount: 0,
          workerBuildTriggerCount: 0,
          workerBuildDeployHookCount: 0,
          workerBuildExecutionCount: 0,
          activeWorkerBuildExecutionCount: 0,
          eventSubscriptionCount: 0
        };
    // Observe all builds quiescent before taking the final sealed code/settings
    // projection. This prevents a build that was already running from deploying
    // between projection and the later status read while still appearing safe.
    const sealedProjection = requiresDestructivePreflight
      ? await workerSealedProjection(
          target,
          logicalName,
          observationPhase,
          settingsResult,
          workerIdentity
        )
      : {
          workerScriptMatchCount: 0,
          workerVersionCount: 0,
          workerSecretNameCount: 0,
          workerDeploymentCount: 0,
          sealedWorkerProjectionMatches: false
        };
    let finalWorkerBuildQuiescence = false;
    if (requiresDestructivePreflight) {
      await workerDependencyPreflight(target, logicalName, observationPhase, {
        allowReviewedDomains: !preDelete
      });
      // Bracket the final sealed projection and dependency proof with the same
      // complete, target-pinned stopped-build inventory. A newly queued or
      // completed execution changes either status or the canonical UUID set.
      await workerBuildExecutionObservation(
        target,
        logicalName,
        `${observationPhase}-final`
      );
      finalWorkerBuildQuiescence = true;
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present"
      ? [
          `durable-object-namespace:${target.durableObjectNamespaceId}`,
          `worker-id:${target.workerId}`,
          `worker:${target.scriptName}`
        ]
      : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: {
          durableObjectNamespaceMatches: namespaceMatches.length,
          workerIdentityMatches,
          ingressInventoryComplete: phase === "before" && state === "present",
          dependencyInventoryComplete: phase === "before" && state === "present",
          finalWorkerBuildQuiescence,
          ...sealedProjection,
          ...ingress,
          paginationComplete: true
        }
      })
    };
  }

  async function workerDependencyPreflight(
    target,
    logicalName,
    rawPhase,
    { allowReviewedDomains }
  ) {
    const reviewedDomains = cf.dns.filter((domain) =>
      domain.workerName === target.scriptName && domain.workerDomainExpectedPresent
    );
    const isReviewedDomainReference = (reference) =>
      isRecord(reference) && reviewedDomains.some((domain) =>
        (reference.id ?? reference.domain_id) === domain.workerDomainId &&
          (reference.hostname === undefined || reference.hostname === domain.hostname) &&
          (reference.zone_id === undefined || reference.zone_id === cf.zoneId)
      );
    const workerResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "workers",
        target.workerId
      ),
      label: `${logicalName} complete Worker attachment graph`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-worker-graph`)
    });
    const worker = responseResult(workerResponse, `${logicalName} complete Worker attachment graph`);
    requireValue(isRecord(worker), `${logicalName} Worker attachment graph must be an object`);
    exactIdentity(worker.id, target.workerId, `${logicalName} attachment-graph Worker id`);
    exactIdentity(worker.name, target.scriptName, `${logicalName} attachment-graph Worker name`);
    requireValue(isRecord(worker.references), `${logicalName} Worker references graph must be an object`);
    for (const field of ["dispatch_namespace_outbounds", "domains", "durable_objects", "queues", "workers"]) {
      requireValue(
        Array.isArray(worker.references[field]),
        `${logicalName} Worker references graph must explicitly enumerate ${field}`
      );
    }
    requireValue(
      worker.references.dispatch_namespace_outbounds.length === 0 &&
        worker.references.queues.length === 0 &&
        worker.references.workers.length === 0,
      `${logicalName} has an attached domain, queue, Worker, or dispatch-namespace reference`
    );
    requireValue(
      allowReviewedDomains
        ? worker.references.domains.every(isReviewedDomainReference)
        : worker.references.domains.length === 0,
      `${logicalName} has an attached domain, queue, Worker, or dispatch-namespace reference`
    );
    requireValue(
      worker.references.durable_objects.length <= 1 &&
        worker.references.durable_objects.every((reference) =>
          isRecord(reference) && reference.worker_id === target.workerId &&
            reference.worker_name === target.scriptName &&
            reference.namespace_id === target.durableObjectNamespaceId &&
            typeof reference.namespace_name === "string" &&
            reference.namespace_name.length >= 1 && reference.namespace_name.length <= 256 &&
            !/[\u0000-\u001f\u007f]/.test(reference.namespace_name) &&
            !Object.hasOwn(reference, "class_name") &&
            !Object.hasOwn(reference, "class")
        ),
      `${logicalName} complete attachment graph must contain only its exact reviewed Durable Object namespace`
    );
    requireValue(
      Array.isArray(worker.tail_consumers) && worker.tail_consumers.length === 0,
      `${logicalName} has a Tail Worker consumer in its attachment graph`
    );
    requireValue(
      isRecord(worker.subdomain) && worker.subdomain.enabled !== true &&
        worker.subdomain.previews_enabled !== true,
      `${logicalName} attachment graph still exposes workers.dev or preview ingress`
    );

    const referencesResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts", target.scriptName,
        "references"
      ),
      label: `${logicalName} Worker dependent references`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-references`)
    });
    const references = responseResult(referencesResponse, `${logicalName} Worker dependent references`);
    requireValue(isRecord(references), `${logicalName} Worker references result must be an object`);
    const services = references.services === undefined ? {} : references.services;
    requireValue(isRecord(services), `${logicalName} service references must be an object`);
    const incoming = services.incoming ?? [];
    requireValue(
      Array.isArray(incoming) && incoming.length === 0 &&
        (services.pages_function === undefined || services.pages_function === false),
      `${logicalName} has an external Worker or Pages service binding; refusing deletion`
    );
    const durableReferences = references.durable_objects ?? [];
    requireValue(Array.isArray(durableReferences), `${logicalName} Durable Object references must be an array`);
    requireValue(
      durableReferences.every((reference) =>
        isRecord(reference) && reference.service === target.scriptName &&
          (reference.durable_object_namespace_name === undefined ||
            reference.durable_object_namespace_name === target.durableObjectClassName)
      ),
      `${logicalName} Durable Object namespace is referenced by an external Worker`
    );
    const dispatchOutbounds = references.dispatch_outbounds ?? [];
    requireValue(
      Array.isArray(dispatchOutbounds) && dispatchOutbounds.length === 0,
      `${logicalName} is a dispatch outbound for another Worker`
    );
    const domains = references.domains ?? [];
    requireValue(
      Array.isArray(domains) && (allowReviewedDomains
        ? domains.every(isReviewedDomainReference)
        : domains.length === 0),
      `${logicalName} still has an attached domain reference`
    );
    const referencedQueues = references.queues ?? [];
    requireValue(
      Array.isArray(referencedQueues) && referencedQueues.length === 0,
      `${logicalName} still has a queue consumer reference`
    );

    const tailsResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "tails", "by-consumer",
        target.scriptName
      ),
      label: `${logicalName} Tail Worker producers`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-tail-producers`)
    });
    const tailProducers = responseResult(tailsResponse, `${logicalName} Tail Worker producers`);
    requireValue(
      Array.isArray(tailProducers) && tailProducers.length === 0,
      `${logicalName} is still used as a Tail Worker`
    );

    const domainsResponse = await clients.compute.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "domains"),
      label: `${logicalName} account Worker domains`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-worker-domains`)
    });
    const attachedDomains = selectedCloudflareArray(
      domainsResponse,
      `${logicalName} account Worker domains`
    ).map((domain, index) => projectedWorkerDomain(
      domain,
      `${logicalName} account Worker domain ${index}`
    )).filter((domain) => domain.service === target.scriptName);
    if (allowReviewedDomains) {
      requireValue(
        attachedDomains.every((domain) => reviewedDomains.some((reviewed) => {
          return domain.id === reviewed.workerDomainId &&
            domain.hostname === reviewed.hostname && domain.service === reviewed.workerName &&
            domain.certId === reviewed.workerDomainCertId && domain.zoneId === cf.zoneId;
        })),
        `${logicalName} has an unreviewed attached custom domain`
      );
    } else {
      requireValue(
        attachedDomains.length === 0,
        `${logicalName} still has an attached custom domain`
      );
    }

    const schedulesResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "schedules"
      ),
      label: `${logicalName} Worker cron schedules`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-schedules`)
    });
    const schedules = responseResult(
      schedulesResponse,
      `${logicalName} Worker cron schedules`
    );
    requireValue(
      isRecord(schedules) && Array.isArray(schedules.schedules) &&
        schedules.schedules.length === 0,
      `${logicalName} still has an attached cron schedule`
    );

    const subdomainResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "subdomain"
      ),
      label: `${logicalName} workers.dev subdomain state`,
      rawName: rawName("cloudflare", logicalName, `${rawPhase}-subdomain`)
    });
    const subdomain = responseResult(subdomainResponse, `${logicalName} workers.dev subdomain state`);
    requireValue(
      isRecord(subdomain) && subdomain.enabled === false &&
        (subdomain.previews_enabled === undefined || subdomain.previews_enabled === false),
      `${logicalName} still has workers.dev or preview ingress enabled`
    );
  }

  async function dnsObservation(target, logicalName, phase) {
    const domainsPath = cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "domains");
    // Cloudflare documents this as a SinglePage endpoint. Request the complete
    // account result once without invented page/per_page parameters.
    const domainsResponse = await clients.compute.request({
      path: domainsPath,
      label: `${logicalName} Worker domains`,
      rawName: rawName("cloudflare", logicalName, `${phase}-domains`)
    });
    const domains = selectedCloudflareArray(
      domainsResponse,
      `${logicalName} Worker domains`
    ).map((domain, index) => projectedWorkerDomain(
      domain,
      `${logicalName} Worker domain ${index}`
    ));
    const domainMatches = domains.filter((entry) => entry.hostname === target.hostname);
    requireValue(domainMatches.length <= 1, `${logicalName} matched more than one Worker custom domain`);

    const dnsBase = cloudflarePath("client", "v4", "zones", cf.zoneId, "dns_records");
    const dnsRecords = await listCloudflareNumberedPages({
      client: clients.dns,
      basePath: dnsBase,
      label: `${logicalName} DNS records`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-dns-${page}`),
      select(response, label) {
        return selectedCloudflareArray(response, label);
      }
    });
    const recordMatches = dnsRecords.filter((entry) => isRecord(entry) && entry.name === target.hostname);
    const domainPresent = domainMatches.length === 1;
    if (domainPresent) {
      const domain = domainMatches[0];
      exactIdentity(domain.id, target.workerDomainId, `${logicalName} Worker domain id`);
      exactIdentity(domain.certId, target.workerDomainCertId, `${logicalName} Worker domain certificate id`);
      exactIdentity(domain.zoneId, cf.zoneId, `${logicalName} Worker domain zone id`);
      exactIdentity(domain.service, target.workerName, `${logicalName} Worker domain service`);
    }
    if (phase === "before") {
      requireValue(
        domainPresent === target.workerDomainExpectedPresent,
        `${logicalName} Worker domain component does not match its reviewed presence`
      );
    }
    const records = recordMatches.map(dnsRecordProjection).sort((left, right) =>
      compareStagingTeardownCodeUnits(left.id, right.id)
    );
    if (phase === "before") {
      requireValue(
        serializeCanonicalEvidence(records) === serializeCanonicalEvidence(target.dnsRecords),
        `${logicalName} DNS records do not match the exact reviewed stable provider state`
      );
    } else {
      const expectedById = new Map(target.dnsRecords.map((record) => [record.id, record]));
      requireValue(
        records.every((record) =>
          expectedById.has(record.id) &&
            serializeCanonicalEvidence(record) === serializeCanonicalEvidence(expectedById.get(record.id))
        ),
        `${logicalName} has an unreviewed or changed DNS record after teardown`
      );
    }

    let certificatePresent = false;
    if (target.certificatePackId !== null) {
      const cert = await clients.dns.request({
        path: cloudflarePath("client", "v4", "zones", cf.zoneId, "ssl", "certificate_packs", target.certificatePackId),
        label: `${logicalName} certificate pack`,
        rawName: rawName("cloudflare", logicalName, `${phase}-certificate`),
        acceptedStatuses: [200, 404]
      });
      if (cert.status === 200) {
        const terminalRecovery = phase === "after" ||
          (phase === "remove-check" &&
            target.certificatePack?.status === "pending_deletion");
        const result = terminalRecovery
          ? terminalCertificateFacts(
              responseResult(cert, `${logicalName} certificate pack`),
              target,
              logicalName
            )
          : certificateFacts(
              responseResult(cert, `${logicalName} certificate pack`),
              target,
              logicalName
            );
        certificatePresent = result.status !== "deleted";
      }
      if (phase === "before") {
        requireValue(
          certificatePresent,
          `${logicalName} dedicated certificate pack is missing or already terminally deleted`
        );
      }
    }
    const state = domainPresent || recordMatches.length > 0 || certificatePresent
      ? "present"
      : "absent";
    assertExpected(target, state, logicalName, phase);
    const externalIds = [
      ...(domainPresent
        ? [
            `worker-domain:${target.workerDomainId}`,
            `worker-domain-certificate:${target.workerDomainCertId}`
          ]
        : []),
      ...records.map((record) => `dns-record:${record.id}`),
      ...(certificatePresent ? [`certificate-pack:${target.certificatePackId}`] : [])
    ].sort(compareStagingTeardownCodeUnits);
    return {
      state,
      externalIds,
      components: {
        certificatePresent,
        dnsRecords: records,
        domainPresent
      },
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: {
          certificateMatches: certificatePresent ? 1 : 0,
          domainMatches: domainMatches.length,
          dnsRecordMatches: recordMatches.length,
          paginationComplete: true
        }
      })
    };
  }

  async function containerList(logicalName, phase) {
    const basePath = cloudflarePath("client", "v4", "accounts", cf.accountId, "containers", "dash", "applications");
    const results = [];
    const ids = new Set();
    const tokens = new Set();
    let pageToken = null;
    for (let page = 1; page <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES; page += 1) {
      const entries = [["per_page", "100"]];
      if (pageToken !== null) entries.push(["page_token", pageToken]);
      const response = await clients.compute.request({
        path: queryPath(basePath, entries),
        label: `${logicalName} container applications page ${page}`,
        rawName: rawName("cloudflare", logicalName, `${phase}-container-${page}`)
      });
      const pageItems = selectedCloudflareArray(response, `${logicalName} container applications page ${page}`);
      requireValue(
        pageItems.length <= 100,
        `${logicalName} container application page exceeds its item bound`
      );
      for (const [index, item] of pageItems.entries()) {
        requireValue(
          isRecord(item) && typeof item.id === "string" && PROVIDER_ID.test(item.id) &&
            typeof item.name === "string" && PROVIDER_ID.test(item.name),
          `${logicalName} container application page ${page} item ${index} has an invalid identity`
        );
        requireValue(
          !ids.has(item.id),
          `${logicalName} container application pagination repeated an id`
        );
        ids.add(item.id);
      }
      results.push(...pageItems);
      const info = response.value?.result_info;
      requireValue(
        isRecord(info) && Object.keys(info).length === 1 &&
          Object.hasOwn(info, "next_page_token"),
        `${logicalName} container application pagination returned unsupported result_info`
      );
      const next = info.next_page_token;
      requireValue(
        next === null ||
          (typeof next === "string" && next.length >= 1 && next.length <= 1_024 &&
            !/[\u0000-\u001f\u007f]/.test(next)),
        `${logicalName} container pagination returned an invalid page token`
      );
      if (next === null) {
        requireValue(
          pageItems.length < 100,
          `${logicalName} full container application page omitted a continuation token`
        );
        return results;
      }
      requireValue(
        pageItems.length === 100 && !tokens.has(next),
        `${logicalName} container pagination returned an invalid or repeated page token`
      );
      tokens.add(next);
      pageToken = next;
    }
    throw new Error(`${logicalName} container pagination exceeded ${STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES} pages`);
  }

  function containerApplicationFacts(application, target, logicalName) {
    const normalized = normalizedContainerApplication(
      application,
      `${logicalName} complete container application projection`
    );
    exactIdentity(normalized.applicationId, target.applicationId, `${logicalName} application id`);
    exactIdentity(normalized.applicationName, target.applicationName, `${logicalName} application name`);
    exactIdentity(normalized.accountId, cf.accountId, `${logicalName} application account id`);
    exactIdentity(
      normalized.durableObjectNamespaceId,
      target.durableObjectNamespaceId,
      `${logicalName} container Durable Object namespace id`
    );
    requireValue(
      normalized.resolvedImageDigest === target.resolvedImageDigest,
      `${logicalName} container application must use the reviewed resolved image digest`
    );
    requireValue(
      projectionSha256(normalized.projection) === target.applicationSha256,
      `${logicalName} complete container application projection changed after review`
    );
    return application;
  }

  async function exactContainerDeployments(target, logicalName, phase) {
    const response = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "containers", "applications",
        target.applicationId, "deployments"
      ),
      label: `${logicalName} container deployments`,
      rawName: rawName("cloudflare", logicalName, `${phase}-container-deployments`)
    });
    const deployments = normalizedContainerCollection(
      responseResult(response, `${logicalName} container deployments`),
      "deployments",
      `${logicalName} container deployments`,
      STAGING_TEARDOWN_CONTAINER_DEPLOYMENT_MAX_COUNT
    );
    for (const [index, deployment] of deployments.entries()) {
      exactIdentity(
        deployment.account_id,
        cf.accountId,
        `${logicalName} container deployment ${index} account id`
      );
      if (Object.hasOwn(deployment, "app_id")) {
        exactIdentity(
          deployment.app_id,
          target.applicationId,
          `${logicalName} container deployment ${index} application id`
        );
      }
    }
    requireValue(
      projectionSha256(deployments) === target.deploymentsSha256,
      `${logicalName} complete container deployment set changed after review`
    );
    return deployments;
  }

  async function exactContainerRollouts(target, logicalName, phase) {
    const basePath = cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "containers", "applications",
      target.applicationId, "rollouts"
    );
    const rollouts = [];
    const ids = new Set();
    let last = null;
    for (let page = 1; page <= STAGING_TEARDOWN_CONTAINER_ROLLOUT_MAX_PAGES; page += 1) {
      const query = [["limit", String(STAGING_TEARDOWN_CONTAINER_ROLLOUT_PAGE_SIZE)]];
      if (last !== null) query.push(["last", last]);
      const response = await clients.compute.request({
        path: queryPath(basePath, query),
        label: `${logicalName} container rollouts page ${page}`,
        rawName: rawName("cloudflare", logicalName, `${phase}-container-rollouts-${page}`)
      });
      const rawPage = responseResult(
        response,
        `${logicalName} container rollouts page ${page}`
      );
      const rawPageItems = rawPage;
      requireValue(
        Array.isArray(rawPageItems),
        `${logicalName} container rollouts page ${page} must be an array`
      );
      // Cloudchamber's `last` cursor is the provider page's final row, not the
      // lexical maximum after canonical projection sorting.
      const providerFinalId = rawPageItems.at(-1)?.id ?? null;
      const pageItems = normalizedContainerCollection(
        rawPage,
        "rollouts",
        `${logicalName} container rollouts page ${page}`,
        STAGING_TEARDOWN_CONTAINER_ROLLOUT_PAGE_SIZE
      );
      for (const item of pageItems) {
        requireValue(!ids.has(item.id), `${logicalName} container rollout pagination repeated an id`);
        ids.add(item.id);
        rollouts.push(item);
      }
      if (pageItems.length < STAGING_TEARDOWN_CONTAINER_ROLLOUT_PAGE_SIZE) {
        const normalized = rollouts.sort((left, right) =>
          compareStagingTeardownCodeUnits(left.id, right.id)
        );
        requireValue(
          projectionSha256(normalized) === target.rolloutsSha256,
          `${logicalName} complete container rollout set changed after review`
        );
        return normalized;
      }
      requireValue(
        typeof providerFinalId === "string" && PROVIDER_ID.test(providerFinalId),
        `${logicalName} full container rollout page has no valid provider-final cursor`
      );
      last = providerFinalId;
    }
    throw new Error(
      `${logicalName} container rollout pagination exceeded ${STAGING_TEARDOWN_CONTAINER_ROLLOUT_MAX_PAGES} pages`
    );
  }

  async function exactContainerInstances(target, logicalName, phase) {
    const basePath = cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "containers", "dash",
      "applications", target.applicationId, "instances"
    );
    const pageTokens = new Set();
    const durableObjectIds = new Set();
    const inactiveDurableObjects = [];
    let pageToken = null;
    for (
      let page = 1;
      page <= STAGING_TEARDOWN_CONTAINER_INSTANCE_MAX_PAGES;
      page += 1
    ) {
      const query = [["per_page", String(STAGING_TEARDOWN_CONTAINER_INSTANCE_PAGE_SIZE)]];
      if (pageToken !== null) query.push(["page_token", pageToken]);
      const response = await clients.compute.request({
        path: queryPath(basePath, query),
        label: `${logicalName} container instances page ${page}`,
        rawName: rawName("cloudflare", logicalName, `${phase}-container-instances-${page}`)
      });
      const result = responseResult(response, `${logicalName} container instances page ${page}`);
      requireValue(
        isRecord(result) &&
          Object.keys(result).every((key) => ["instances", "durable_objects"].includes(key)) &&
          Object.hasOwn(result, "instances") &&
          Array.isArray(result.instances) &&
          result.instances.length <= STAGING_TEARDOWN_CONTAINER_INSTANCE_PAGE_SIZE &&
          result.instances.every(isRecord),
        `${logicalName} container instance page has an invalid bounded provider shape`
      );
      requireValue(
        result.instances.length === 0,
        `${logicalName} still has a live or nonterminal container placement; durable jobs are not quiescent`
      );
      const durableObjects = Object.hasOwn(result, "durable_objects")
        ? result.durable_objects
        : [];
      requireValue(
        Array.isArray(durableObjects) &&
          durableObjects.length <= STAGING_TEARDOWN_CONTAINER_INSTANCE_PAGE_SIZE,
        `${logicalName} container Durable Object page exceeds the bounded provider shape`
      );
      for (const [index, value] of durableObjects.entries()) {
        const normalized = normalizedInactiveContainerDurableObject(
          value,
          `${logicalName} container Durable Object page ${page} item ${index}`
        );
        requireValue(
          !durableObjectIds.has(normalized.id),
          `${logicalName} container instance pagination repeated a Durable Object id`
        );
        durableObjectIds.add(normalized.id);
        inactiveDurableObjects.push(normalized);
      }
      const resultInfo = response.value?.result_info;
      requireValue(
        isRecord(resultInfo) && Object.keys(resultInfo).length === 1 &&
          Object.hasOwn(resultInfo, "next_page_token"),
        `${logicalName} container instance pagination returned unsupported result_info`
      );
      const next = resultInfo.next_page_token;
      requireValue(
        next === null ||
          (typeof next === "string" && next.length >= 1 && next.length <= 1_024 &&
            !/[\u0000-\u001f\u007f]/.test(next)),
        `${logicalName} container instance pagination returned an invalid page token`
      );
      if (next === null) {
        requireValue(
          durableObjects.length < STAGING_TEARDOWN_CONTAINER_INSTANCE_PAGE_SIZE,
          `${logicalName} full container instance page omitted a continuation token`
        );
        const normalized = inactiveDurableObjects.sort((left, right) =>
          compareStagingTeardownCodeUnits(left.id, right.id)
        );
        requireValue(
          projectionSha256(normalized) === target.inactiveDurableObjectsSha256,
          `${logicalName} inactive container Durable Object set changed after review`
        );
        return normalized;
      }
      requireValue(
        !pageTokens.has(next),
        `${logicalName} container instance pagination returned an invalid or repeated page token`
      );
      pageTokens.add(next);
      pageToken = next;
    }
    throw new Error(
      `${logicalName} container instance pagination exceeded ${STAGING_TEARDOWN_CONTAINER_INSTANCE_MAX_PAGES} pages`
    );
  }

  async function exactContainerAttachedState(target, logicalName, phase) {
    const [deployments, rollouts, inactiveDurableObjects] = await Promise.all([
      exactContainerDeployments(target, logicalName, phase),
      exactContainerRollouts(target, logicalName, phase),
      exactContainerInstances(target, logicalName, phase)
    ]);
    return { deployments, rollouts, inactiveDurableObjects };
  }

  async function exactContainerApplication(
    target,
    logicalName,
    phase,
    { includeAttachedState = true } = {}
  ) {
    const response = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "containers", "applications",
        target.applicationId
      ),
      label: `${logicalName} exact container application`,
      rawName: rawName("cloudflare", logicalName, `${phase}-container-exact`),
      acceptedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    const application = containerApplicationFacts(
      responseResult(response, `${logicalName} exact container application`),
      target,
      logicalName
    );
    if (includeAttachedState) {
      await exactContainerAttachedState(target, logicalName, phase);
    }
    return application;
  }

  async function containerObservation(target, logicalName, phase) {
    const applications = await containerList(logicalName, phase);
    const matches = applications.filter((entry) => isRecord(entry) && entry.name === target.applicationName);
    requireValue(matches.length <= 1, `${logicalName} matched more than one container application`);
    const state = matches.length === 1 ? "present" : "absent";
    if (state === "present") {
      const exact = await exactContainerApplication(target, logicalName, phase);
      requireValue(exact !== null, `${logicalName} disappeared during exact container inventory`);
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present" ? [`container:${target.applicationId}`] : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: { matchCount: matches.length, paginationComplete: true }
      })
    };
  }

  async function bucketObjects(target, logicalName, phase) {
    const basePath = cloudflarePath("client", "v4", "accounts", cf.accountId, "r2", "buckets", target.bucketName, "objects");
    const objects = await listCloudflareCursorPages({
      client: clients.r2,
      basePath,
      label: `${logicalName} R2 objects`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-objects-${page}`),
      maxPages: 2,
      cloudflareR2Jurisdiction: "default",
      extract(response, label) {
        const result = responseResult(response, label);
        requireValue(Array.isArray(result), `${label} result must be the documented object array`);
        const info = response.value?.result_info;
        requireValue(isRecord(info), `${label} result_info must be an object`);
        return {
          items: result,
          nextCursor: info.cursor ?? null,
          isTruncated: info.is_truncated
        };
      }
    });
    requireValue(
      objects.length <= STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT,
      `${logicalName} R2 object inventory exceeds the reviewed global deletion ceiling`
    );
    return objects;
  }

  async function accountBuckets(logicalName, phase) {
    const cacheable = phase === "before" || phase === "after";
    if (cacheable && accountBucketInventoryCache.has(phase)) {
      return accountBucketInventoryCache.get(phase);
    }
    const results = [];
    const jurisdictionNames = new Set();
    const basePath = cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "r2", "buckets"
    );
    for (const jurisdiction of R2_JURISDICTIONS) {
      const cursors = new Set();
      let cursor = null;
      let complete = false;
      for (let page = 1; page <= 4; page += 1) {
        const query = [["per_page", "1000"]];
        if (cursor !== null) query.push(["cursor", cursor]);
        const label =
          `${logicalName} complete ${jurisdiction} R2 bucket inventory page ${page}`;
        const response = await clients.r2Inventory.request({
          path: queryPath(basePath, query),
          label,
          rawName: rawName(
            "cloudflare",
            logicalName,
            `${phase}-${jurisdiction}-bucket-list-${page}`
          ),
          cloudflareR2Jurisdiction: jurisdiction
        });
        const result = responseResult(response, label);
        const info = response.value?.result_info;
        requireValue(
          isRecord(result) && Array.isArray(result.buckets) && isRecord(info),
          `${logicalName} R2 bucket inventory must include buckets and cursor metadata`
        );
        requireValue(
          result.buckets.length <= 1000 &&
            (info.per_page === undefined ||
              (Number.isSafeInteger(info.per_page) &&
                info.per_page >= 1 && info.per_page <= 1000)),
          `${logicalName} R2 bucket inventory returned an unexpected page size`
        );
        for (const bucket of result.buckets) {
          requireValue(
            isRecord(bucket) && Object.keys(bucket).every((key) =>
              ["creation_date", "jurisdiction", "location", "name", "storage_class"].includes(key)
            ) && Object.hasOwn(bucket, "creation_date") && Object.hasOwn(bucket, "name"),
            `${logicalName} R2 bucket inventory entry has an unsupported or incomplete shape`
          );
          if (Object.hasOwn(bucket, "jurisdiction")) {
            requireValue(
              bucket.jurisdiction === jurisdiction,
              `${logicalName} R2 bucket inventory jurisdiction does not match its request scope`
            );
          }
          const projection = {
            ...r2BucketProjection(bucket),
            jurisdiction
          };
          requireValue(
            typeof projection.name === "string" && projection.name.length >= 3 &&
              projection.name.length <= 64 &&
              typeof projection.creationDate === "string" &&
              Number.isFinite(Date.parse(projection.creationDate)) &&
              (projection.location === null ||
                ["apac", "eeur", "enam", "weur", "wnam", "oc"].includes(projection.location)) &&
              ["Standard", "InfrequentAccess"].includes(projection.storageClass),
            `${logicalName} R2 bucket inventory contains an invalid identity`
          );
          const jurisdictionName = `${jurisdiction}:${projection.name}`;
          requireValue(
            !jurisdictionNames.has(jurisdictionName),
            `${logicalName} R2 bucket inventory contains a duplicate jurisdiction/name identity`
          );
          jurisdictionNames.add(jurisdictionName);
          results.push(projection);
        }
        const nextCursor = info.cursor ?? null;
        if (nextCursor === null || nextCursor === "") {
          complete = true;
          break;
        }
        requireValue(
          typeof nextCursor === "string" && nextCursor.length <= 1024 &&
            !cursors.has(nextCursor),
          `${logicalName} R2 bucket inventory returned an invalid or repeated cursor`
        );
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      requireValue(
        complete,
        `${logicalName} ${jurisdiction} R2 bucket inventory exceeded the 4-page account bound`
      );
    }
    if (cacheable) accountBucketInventoryCache.set(phase, results);
    return results;
  }

  async function bucketConfigurationObservation(target, logicalName, phase) {
    const bucketPath = cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "r2", "buckets",
      target.bucketName
    );
    const readConfiguration = async (suffix, label, acceptedStatuses = [200]) =>
      clients.r2Configuration.request({
        path: `${bucketPath}/${suffix}`,
        label: `${logicalName} ${label}`,
        rawName: rawName("cloudflare", logicalName, `${phase}-${suffix.replaceAll("/", "-")}`),
        acceptedStatuses,
        cloudflareR2Jurisdiction: "default"
      });

    const lifecycleResponse = await readConfiguration(
      "lifecycle",
      "R2 lifecycle configuration"
    );
    const lifecycle = responseResult(
      lifecycleResponse,
      `${logicalName} R2 lifecycle configuration`
    );
    requireValue(
      isRecord(lifecycle) && Array.isArray(lifecycle.rules),
      `${logicalName} R2 lifecycle configuration must expose rules`
    );
    validateRequiredStagingLifecycleRules(
      lifecycle.rules,
      true,
      `${logicalName} provider R2 lifecycle rules`
    );
    requireValue(
      serializeCanonicalEvidence(normalizeLifecycleRules(
        lifecycle.rules,
        `${logicalName} provider R2 lifecycle rules`
      )) ===
        serializeCanonicalEvidence(normalizeLifecycleRules(
          target.expectedLifecycleRules,
          `${logicalName} reviewed R2 lifecycle rules`
        )),
      `${logicalName} R2 lifecycle rules do not exactly match the reviewed one-day cleanup rule`
    );

    for (const [suffix, label] of [
      ["cors", "R2 CORS policy"],
      ["lock", "R2 object-lock rules"]
    ]) {
      const response = await readConfiguration(suffix, label);
      const result = responseResult(response, `${logicalName} ${label}`);
      requireValue(
        isRecord(result) && Array.isArray(result.rules) && result.rules.length === 0,
        `${logicalName} has an unreviewed ${label}`
      );
    }

    const notificationsResponse = await clients.r2Configuration.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "event_notifications", "r2",
        target.bucketName, "configuration"
      ),
      label: `${logicalName} R2 event notifications`,
      rawName: rawName("cloudflare", logicalName, `${phase}-event-notifications`),
      acceptedStatuses: [200, 404],
      cloudflareR2Jurisdiction: "default"
    });
    if (notificationsResponse.status === 404) {
      exactCloudflareAbsence(
        notificationsResponse,
        11015,
        `${logicalName} R2 event notifications`
      );
    } else {
      const notifications = responseResult(
        notificationsResponse,
        `${logicalName} R2 event notifications`
      );
      exactKeys(
        notifications,
        ["bucketName", "queues"],
        `${logicalName} R2 event notifications`
      );
      requireValue(
        notifications.bucketName === target.bucketName &&
          Array.isArray(notifications.queues) && notifications.queues.length === 0,
        `${logicalName} has an unreviewed R2 event notification or mismatched notification identity`
      );
    }

    const customDomainsResponse = await readConfiguration(
      "domains/custom",
      "R2 custom domains"
    );
    const customDomains = responseResult(
      customDomainsResponse,
      `${logicalName} R2 custom domains`
    );
    requireValue(
      isRecord(customDomains) && Array.isArray(customDomains.domains) &&
        customDomains.domains.length === 0,
      `${logicalName} has an attached R2 custom domain`
    );

    const managedDomainResponse = await readConfiguration(
      "domains/managed",
      "R2 managed domain"
    );
    const managedDomain = responseResult(
      managedDomainResponse,
      `${logicalName} R2 managed domain`
    );
    exactKeys(
      managedDomain,
      ["bucketId", "domain", "enabled"],
      `${logicalName} R2 managed domain`
    );
    requireValue(
      isRecord(managedDomain) && managedDomain.enabled === false &&
        managedDomain.bucketId === target.managedDomainBucketId &&
        managedDomain.domain === target.managedDomainDomain,
      `${logicalName} R2 managed r2.dev domain must be the exact reviewed disabled identity`
    );

    const sippyResponse = await readConfiguration(
      "sippy",
      "R2 Sippy configuration",
      [200, 404]
    );
    if (sippyResponse.status === 200) {
      const sippy = responseResult(
        sippyResponse,
        `${logicalName} R2 Sippy configuration`
      );
      exactKeys(sippy, ["enabled"], `${logicalName} disabled R2 Sippy configuration`);
      requireValue(sippy.enabled === false, `${logicalName} R2 Sippy must be disabled`);
    } else {
      exactCloudflareAbsence(
        sippyResponse,
        10007,
        `${logicalName} R2 Sippy configuration`
      );
    }

    const catalogResponse = await clients.catalogObservation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "r2-catalog"
      ),
      label: `${logicalName} complete R2 Data Catalog inventory`,
      rawName: rawName("cloudflare", logicalName, `${phase}-data-catalog`),
      acceptedStatuses: [200]
    });
    const catalog = responseResult(
      catalogResponse,
      `${logicalName} complete R2 Data Catalog inventory`
    );
    exactKeys(catalog, ["warehouses"], `${logicalName} complete R2 Data Catalog inventory`);
    requireValue(
      Array.isArray(catalog.warehouses) && catalog.warehouses.every((warehouse) => {
        if (!isRecord(warehouse)) return false;
        const allowed = new Set([
          "id", "bucket", "name", "status", "credential_status", "maintenance_config"
        ]);
        return Object.keys(warehouse).every((key) => allowed.has(key)) &&
          typeof warehouse.id === "string" && warehouse.id.length >= 1 &&
          warehouse.id.length <= 128 && typeof warehouse.bucket === "string" &&
          typeof warehouse.name === "string" && warehouse.name.length >= 1 &&
          warehouse.name.length <= 256 && ["active", "inactive"].includes(warehouse.status);
      }) && !catalog.warehouses.some((warehouse) => warehouse.bucket === target.bucketName),
      `${logicalName} has an R2 Data Catalog configuration; refusing object or bucket deletion`
    );
    return {
      lifecycleRuleCount: lifecycle.rules.length,
      unreviewedConfigurationCount: 0
    };
  }

  async function bucketObservation(target, logicalName, phase) {
    const listedBuckets = await accountBuckets(logicalName, phase);
    const nameMatches = listedBuckets.filter((bucket) => bucket.name === target.bucketName);
    requireValue(
      nameMatches.every((bucket) => bucket.jurisdiction === "default"),
      `${logicalName} canonical staging R2 bucket name exists in a non-default jurisdiction`
    );
    const matches = nameMatches.filter((bucket) => bucket.jurisdiction === "default");
    requireValue(matches.length <= 1, `${logicalName} matched more than one default R2 bucket`);
    const state = matches.length === 1 ? "present" : "absent";
    let objectCount = 0;
    let lifecycleRuleCount = 0;
    if (state === "present") {
      const expectedIdentity = {
        name: target.bucketName,
        creationDate: target.expectedCreationDate,
        jurisdiction: target.expectedJurisdiction,
        location: target.expectedLocation,
        storageClass: target.expectedStorageClass
      };
      requireValue(
        serializeCanonicalEvidence(matches[0]) === serializeCanonicalEvidence(expectedIdentity),
        `${logicalName} listed R2 bucket identity does not match the reviewed target`
      );
      const directResponse = await clients.r2.request({
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "r2", "buckets",
          target.bucketName
        ),
        label: `${logicalName} exact R2 bucket identity`,
        rawName: rawName("cloudflare", logicalName, `${phase}-bucket-exact`),
        cloudflareR2Jurisdiction: "default"
      });
      const directResult = responseResult(
        directResponse,
        `${logicalName} exact R2 bucket identity`
      );
      requireValue(
        isRecord(directResult) && Object.keys(directResult).every((key) =>
          ["creation_date", "jurisdiction", "location", "name", "storage_class"].includes(key)
        ) && Object.hasOwn(directResult, "creation_date") && Object.hasOwn(directResult, "name"),
        `${logicalName} exact R2 bucket identity has an unsupported or incomplete shape`
      );
      requireValue(
        serializeCanonicalEvidence(r2BucketProjection(directResult)) ===
          serializeCanonicalEvidence(expectedIdentity),
        `${logicalName} exact R2 bucket identity changed after account inventory`
      );
      const configuration = await bucketConfigurationObservation(
        target,
        logicalName,
        phase
      );
      lifecycleRuleCount = configuration.lifecycleRuleCount;
      const objects = (await bucketObjects(target, logicalName, phase))
        .map(r2ObjectProjection)
        .sort((left, right) =>
          compareStagingTeardownCodeUnits(String(left.key), String(right.key))
        );
      requireValue(
        serializeCanonicalEvidence(objects) === serializeCanonicalEvidence(target.objects),
        `${logicalName} R2 object identities differ from the exact reviewed deletion allowlist`
      );
      objectCount = objects.length;
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present" ? [`r2-bucket:${target.bucketName}`] : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: { lifecycleRuleCount, objectCount, paginationComplete: true }
      })
    };
  }

  async function credentialObservation(target, logicalName, phase) {
    const listPath = cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens");
    const tokens = await listCloudflareNumberedPages({
      client: clients.tokenAdmin,
      basePath: listPath,
      label: `${logicalName} account-owned token inventory`,
      rawName: (page) => rawName("cloudflare", logicalName, `${phase}-token-list-${page}`),
      perPage: 50,
      queryEntries: [["include_expired", "true"]],
      select(response, label) {
        return selectedCloudflareArray(response, label);
      }
    });
    const matches = tokens.filter(
      (token) => isRecord(token) &&
        (token.name === target.tokenName ||
          (target.tokenId !== null && token.id === target.tokenId))
    );
    requireValue(matches.length <= 1, `${logicalName} matched more than one account-owned token`);
    const state = matches.length === 1 ? "present" : "absent";
    if (state === "present") {
      const listed = matches[0];
      exactIdentity(listed.id, target.tokenId, `${logicalName} listed token id`);
      exactIdentity(listed.name, target.tokenName, `${logicalName} listed token name`);
      const response = await clients.tokenAdmin.request({
        path: cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens", target.tokenId),
        label: `${logicalName} account-owned token detail`,
        rawName: rawName("cloudflare", logicalName, `${phase}-token-detail`)
      });
      const result = responseResult(response, `${logicalName} account-owned token detail`);
      exactIdentity(result?.id, target.tokenId, `${logicalName} token id`);
      exactIdentity(result?.name, target.tokenName, `${logicalName} token name`);
      requireValue(
        isRecord(result) && Array.isArray(result.policies),
        `${logicalName} token detail must expose an explicit bounded policy array`
      );
      assertStagingTeardownProjectionNfc(
        result.policies,
        `${logicalName} live token policies`
      );
      validateExactR2CredentialPolicies(
        result.policies,
        `${logicalName} live token policies`,
        cf.accountId,
        target.allowedBucketName
      );
      requireValue(
        serializeCanonicalEvidence(result.policies) === serializeCanonicalEvidence(target.expectedPolicies) &&
          sha256Bytes(serializeCanonicalEvidence(result.policies)) === target.expectedPolicySha256,
        `${logicalName} token policies do not exactly match the reviewed staging-only policy`
      );
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present" ? [`account-token:${target.tokenId}`] : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: {
          matchCount: matches.length,
          policySha256: state === "present" ? target.expectedPolicySha256 : null,
          paginationComplete: true
        }
      })
    };
  }

  // This is intentionally a separate bounded client even though it uses the
  // observation token. Three exhaustive W_MAX=20 Worker passes can consume
  // 183 requests without sharing the request counter used by other read-only
  // observation surfaces.
  const workerWriterInventoryClient = client(
    credentials.cloudflareObservationToken,
    requestLedgers.observation,
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2WriterWorkerObservation
  );
  const pipelineWriterInventoryClient = client(
    credentials.cloudflareObservationToken,
    requestLedgers.observation,
    STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.cloudflareR2WriterPipelineObservation
  );
  let initialExternalWriterProofPromise;

  function exactWriterIdentity(value, label) {
    requireValue(
      typeof value === "string" && PROVIDER_ID.test(value),
      `${label} must be a bounded provider identifier`
    );
    return value;
  }

  async function activeWorkerR2BindingProof(bucketNames, phase) {
    const workerMax = 20;
    const response = await workerWriterInventoryClient.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts"),
      label: "account Worker inventory for R2 writer proof",
      rawName: rawName("cloudflare", "r2-external-writers", `${phase}-worker-list`)
    });
    const scripts = selectedCloudflareArray(response, "account Worker inventory for R2 writer proof");
    requireValue(
      scripts.length <= workerMax,
      `account Worker inventory exceeds the ${workerMax}-script proof bound`
    );
    const scriptIds = scripts.map((script, index) => {
      requireValue(isRecord(script), `account Worker inventory entry ${index} must be an object`);
      return exactWriterIdentity(script.id, `account Worker inventory entry ${index} id`);
    });
    requireValue(
      new Set(scriptIds).size === scriptIds.length,
      "account Worker inventory contains duplicate script ids"
    );

    const selectedBuckets = new Set(bucketNames);
    const activeVersionIds = [];
    const directBindingIdentities = [];
    const selectedBindingIdentities = [];
    for (const scriptId of [...scriptIds].sort(compareStagingTeardownCodeUnits)) {
      const deploymentsResponse = await workerWriterInventoryClient.request({
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "workers", "scripts", scriptId,
          "deployments"
        ),
        label: "Worker active deployment inventory for R2 writer proof",
        rawName: rawName("cloudflare", "r2-external-writers", `${phase}-worker-deployments`)
      });
      const deploymentResult = responseResult(
        deploymentsResponse,
        "Worker active deployment inventory for R2 writer proof"
      );
      requireValue(
        isRecord(deploymentResult) && Array.isArray(deploymentResult.deployments),
        "Worker deployment inventory must explicitly return a deployments array"
      );
      if (deploymentResult.deployments.length === 0) continue;

      const activeDeployment = deploymentResult.deployments[0];
      requireValue(
        isRecord(activeDeployment) && activeDeployment.strategy === "percentage" &&
          Array.isArray(activeDeployment.versions) &&
          activeDeployment.versions.length >= 1 && activeDeployment.versions.length <= 2,
        "active Worker deployment must contain one or two percentage-routed versions"
      );
      const versions = activeDeployment.versions.map((version, index) => {
        requireValue(
          isRecord(version) && Number.isFinite(version.percentage) &&
            version.percentage >= 0.01 && version.percentage <= 100,
          `active Worker deployment version ${index} has an invalid traffic percentage`
        );
        return {
          percentage: version.percentage,
          versionId: exactWriterIdentity(
            version.version_id,
            `active Worker deployment version ${index} id`
          )
        };
      });
      requireValue(
        new Set(versions.map((version) => version.versionId)).size === versions.length,
        "active Worker deployment contains duplicate version ids"
      );
      requireValue(
        Math.abs(versions.reduce((total, version) => total + version.percentage, 0) - 100) < 1e-9,
        "active Worker deployment traffic percentages must total exactly 100"
      );

      for (const { versionId } of versions) {
        const versionResponse = await workerWriterInventoryClient.request({
          path: cloudflarePath(
            "client", "v4", "accounts", cf.accountId, "workers", "scripts", scriptId,
            "versions", versionId
          ),
          label: "active Worker version resources for R2 writer proof",
          rawName: rawName("cloudflare", "r2-external-writers", `${phase}-worker-version`)
        });
        const version = responseResult(
          versionResponse,
          "active Worker version resources for R2 writer proof"
        );
        requireValue(isRecord(version), "active Worker version result must be an object");
        exactIdentity(version.id, versionId, "active Worker version id");
        requireValue(
          isRecord(version.resources) && Array.isArray(version.resources.bindings),
          "active Worker version must explicitly enumerate resource bindings"
        );
        activeVersionIds.push(`${scriptId}:${versionId}`);
        for (const [index, binding] of version.resources.bindings.entries()) {
          if (!isRecord(binding) || binding.type !== "r2_bucket") continue;
          const bindingName = exactWriterIdentity(
            binding.name,
            `active Worker R2 binding ${index} name`
          );
          requireValue(
            typeof binding.bucket_name === "string" &&
              binding.bucket_name.length >= 1 && binding.bucket_name.length <= 63,
            `active Worker R2 binding ${index} bucket_name is invalid`
          );
          const identity = `${scriptId}:${versionId}:${bindingName}:${binding.bucket_name}`;
          directBindingIdentities.push(identity);
          if (selectedBuckets.has(binding.bucket_name)) selectedBindingIdentities.push(identity);
        }
      }
    }
    requireValue(
      new Set(activeVersionIds).size === activeVersionIds.length,
      "active Worker version inventory contains duplicate script/version identities"
    );
    requireValue(
      selectedBindingIdentities.length === 0,
      "an active Worker version has a direct R2 binding to a reviewed staging bucket"
    );
    return {
      workerScriptCount: scriptIds.length,
      activeWorkerVersionCount: activeVersionIds.length,
      directR2BindingCount: directBindingIdentities.length,
      directR2BindingIdsSha256: sha256Bytes(
        serializeCanonicalEvidence(
          [...directBindingIdentities].sort(compareStagingTeardownCodeUnits)
        )
      )
    };
  }

  async function pipelineR2SinkProof(bucketNames, phase) {
    const perPage = 100;
    const basePath = cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "pipelines", "v1", "sinks"
    );
    const sinks = [];
    let expectedTotal;
    for (let page = 1; page <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES; page += 1) {
      const response = await pipelineWriterInventoryClient.request({
        path: queryPath(basePath, [["per_page", String(perPage)], ["page", String(page)]]),
        label: `Pipeline R2 sink inventory page ${page}`,
        rawName: rawName("cloudflare", "r2-external-writers", `${phase}-pipeline-sinks-${page}`)
      });
      const pageSinks = selectedCloudflareArray(response, `Pipeline R2 sink inventory page ${page}`);
      const info = response.value?.result_info;
      requireValue(
        isRecord(info) && info.page === page && info.per_page === perPage &&
          info.count === pageSinks.length && Number.isSafeInteger(info.total_count) &&
          info.total_count >= 0 && info.total_count <=
            perPage * STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
        "Pipeline R2 sink inventory returned invalid pagination metadata"
      );
      if (expectedTotal === undefined) expectedTotal = info.total_count;
      requireValue(
        info.total_count === expectedTotal,
        "Pipeline R2 sink total_count changed while paginating"
      );
      sinks.push(...pageSinks);
      requireValue(
        sinks.length <= expectedTotal,
        "Pipeline R2 sink inventory exceeded its declared total_count"
      );
      if (sinks.length === expectedTotal) break;
      requireValue(
        pageSinks.length > 0 && page < STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
        "Pipeline R2 sink inventory did not reach its declared total_count within the page bound"
      );
    }
    requireValue(
      expectedTotal !== undefined && sinks.length === expectedTotal,
      "Pipeline R2 sink inventory is incomplete"
    );

    const selectedBuckets = new Set(bucketNames);
    const sinkIds = [];
    const sinkIdentities = [];
    const selectedSinkIds = [];
    for (const [index, sink] of sinks.entries()) {
      requireValue(isRecord(sink), `Pipeline R2 sink ${index} must be an object`);
      const sinkId = exactWriterIdentity(sink.id, `Pipeline R2 sink ${index} id`);
      const sinkType = exactWriterIdentity(sink.type, `Pipeline sink ${index} type`);
      sinkIds.push(sinkId);
      sinkIdentities.push(`${sinkId}:${sinkType}`);
      if (sinkType !== "r2" && sinkType !== "r2_data_catalog") continue;
      requireValue(
        isRecord(sink.config) && ACCOUNT_ID.test(sink.config.account_id) &&
          typeof sink.config.bucket === "string" &&
          sink.config.bucket.length >= 1 && sink.config.bucket.length <= 63,
        `Pipeline R2 sink ${index} has an invalid destination identity`
      );
      if (
        sink.config.account_id === cf.accountId && selectedBuckets.has(sink.config.bucket)
      ) {
        selectedSinkIds.push(sinkId);
      }
    }
    requireValue(new Set(sinkIds).size === sinkIds.length, "Pipeline R2 sink inventory contains duplicate ids");
    requireValue(
      selectedSinkIds.length === 0,
      "an account Pipeline sink writes to a reviewed staging R2 bucket"
    );
    return {
      pipelineSinkCount: sinkIds.length,
      pipelineSinkIdsSha256: sha256Bytes(serializeCanonicalEvidence(
        [...sinkIdentities].sort(compareStagingTeardownCodeUnits)
      )),
      selectedPipelineSinkCount: 0
    };
  }

  async function superSlurperR2JobProof(bucketNames, phase) {
    const limit = 50;
    const basePath = cloudflarePath("client", "v4", "accounts", cf.accountId, "slurper", "jobs");
    const jobs = [];
    let complete = false;
    for (let page = 0; page < STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES; page += 1) {
      const response = await clients.r2Configuration.request({
        path: queryPath(basePath, [["limit", String(limit)], ["offset", String(page * limit)]]),
        label: `Super Slurper R2 job inventory page ${page + 1}`,
        rawName: rawName("cloudflare", "r2-external-writers", `${phase}-slurper-jobs-${page + 1}`)
      });
      const pageJobs = selectedCloudflareArray(
        response,
        `Super Slurper R2 job inventory page ${page + 1}`
      );
      requireValue(pageJobs.length <= limit, "Super Slurper returned more jobs than the requested limit");
      jobs.push(...pageJobs);
      if (pageJobs.length < limit) {
        complete = true;
        break;
      }
    }
    requireValue(
      complete,
      `Super Slurper job inventory exceeded the ${STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES}-page limit`
    );

    const selectedBuckets = new Set(bucketNames);
    const jobIds = [];
    const activeJobIds = [];
    const selectedActiveJobIds = [];
    for (const [index, job] of jobs.entries()) {
      requireValue(isRecord(job), `Super Slurper job ${index} must be an object`);
      const jobId = exactWriterIdentity(job.id, `Super Slurper job ${index} id`);
      requireValue(
        ["running", "paused", "aborted", "completed"].includes(job.status),
        `Super Slurper job ${index} has an invalid or missing status`
      );
      const active = job.status === "running" || job.status === "paused";
      if (active) {
        requireValue(
          isRecord(job.target) && job.target.vendor === "r2" &&
            typeof job.target.bucket === "string" &&
            job.target.bucket.length >= 1 && job.target.bucket.length <= 63 &&
            (job.target.jurisdiction === undefined ||
              ["default", "eu", "fedramp"].includes(job.target.jurisdiction)),
          `active Super Slurper job ${index} must expose one exact R2 target`
        );
        requireValue(
          isRecord(job.source) && ["s3", "gcs", "r2"].includes(job.source.vendor) &&
            (job.source.vendor !== "r2" ||
              (typeof job.source.bucket === "string" &&
                job.source.bucket.length >= 1 && job.source.bucket.length <= 63 &&
                (job.source.jurisdiction === undefined ||
                  ["default", "eu", "fedramp"].includes(job.source.jurisdiction)))),
          `active Super Slurper job ${index} has an invalid source identity`
        );
      }
      const targetBucket = isRecord(job.target) && typeof job.target.bucket === "string"
        ? job.target.bucket
        : null;
      const sourceBucket = isRecord(job.source) && typeof job.source.bucket === "string"
        ? job.source.bucket
        : null;
      const sourceVendor = isRecord(job.source) ? job.source.vendor : null;
      const sourceCanBeR2 = sourceVendor === "r2";
      jobIds.push(jobId);
      if (active) activeJobIds.push(jobId);
      if (
        active &&
        (selectedBuckets.has(targetBucket) ||
          (sourceCanBeR2 && selectedBuckets.has(sourceBucket)))
      ) {
        selectedActiveJobIds.push(jobId);
      }
    }
    requireValue(new Set(jobIds).size === jobIds.length, "Super Slurper job inventory contains duplicate ids");
    requireValue(
      selectedActiveJobIds.length === 0,
      "an active Super Slurper job has a reviewed staging R2 source or target"
    );
    return {
      superSlurperJobCount: jobIds.length,
      activeSuperSlurperJobCount: activeJobIds.length,
      superSlurperJobIdsSha256: sha256Bytes(serializeCanonicalEvidence(
        [...jobIds].sort(compareStagingTeardownCodeUnits)
      )),
      selectedActiveSuperSlurperJobCount: 0
    };
  }

  async function accountR2WriterPermissionGroups(phase) {
    const response = await clients.tokenAdmin.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "tokens", "permission_groups"
      ),
      label: "account token permission-group directory",
      rawName: rawName(
        "cloudflare",
        "r2-external-writers",
        `${phase}-permission-groups`
      )
    });
    const groups = selectedCloudflareArray(
      response,
      "account token permission-group directory"
    );
    requireValue(
      groups.length <= 1_000,
      "account token permission-group directory exceeds the bounded item limit"
    );
    const allIds = new Set();
    const byName = new Map();
    const discoveredR2Writers = new Map();
    for (const [index, group] of groups.entries()) {
      const label = `account token permission group ${index}`;
      requireValue(isRecord(group), `${label} must be an object`);
      requireValue(
        Object.keys(group).every((key) => ["id", "category", "name", "scopes"].includes(key)),
        `${label} contains an unsupported provider field`
      );
      if (group.id !== undefined) {
        requireValue(
          typeof group.id === "string" && ACCOUNT_ID.test(group.id) && !allIds.has(group.id),
          `${label}.id must be one unique 32-hex permission identity`
        );
        allIds.add(group.id);
      }
      if (group.name !== undefined) {
        boundedProviderText(group.name, 128, `${label}.name`);
      }
      if (group.category !== undefined) {
        boundedProviderText(group.category, 64, `${label}.category`);
      }
      if (group.scopes !== undefined) {
        requireValue(
          Array.isArray(group.scopes) && group.scopes.length >= 1 &&
            group.scopes.length <= 4 &&
            group.scopes.every((scope) => [
              "com.cloudflare.api.account",
              "com.cloudflare.api.account.zone",
              "com.cloudflare.api.user",
              "com.cloudflare.edge.r2.bucket"
            ].includes(scope)) &&
            new Set(group.scopes).size === group.scopes.length,
          `${label}.scopes must be a bounded provider scope set`
        );
      }
      if (typeof group.name === "string") {
        requireValue(!byName.has(group.name), `${label}.name is duplicated`);
        byName.set(group.name, group);
      }
      if (/^Workers R2 .+ Write$/.test(group.name ?? "")) {
        requireValue(
          typeof group.id === "string" && Array.isArray(group.scopes) &&
            group.scopes.some((scope) =>
              scope === "com.cloudflare.api.account" ||
              scope === "com.cloudflare.edge.r2.bucket"
            ),
          `${label} R2 writer identity or resource scope is incomplete`
        );
        discoveredR2Writers.set(group.id, group.name);
      }
    }
    for (const required of REQUIRED_R2_WRITER_PERMISSION_GROUPS) {
      const group = byName.get(required.name);
      requireValue(
        isRecord(group) && typeof group.id === "string" &&
          Array.isArray(group.scopes) && group.scopes.length === 1 &&
          group.scopes[0] === required.scope &&
          (required.pinnedId === null || group.id === required.pinnedId),
        `account permission-group directory omitted or changed ${required.name}`
      );
      discoveredR2Writers.set(group.id, required.name);
    }
    return discoveredR2Writers;
  }

  function r2WriterPolicyCoversBuckets(
    policy,
    bucketNames,
    writerPermissionGroups,
    label
  ) {
    requireValue(
      isRecord(policy) && (policy.effect === "allow" || policy.effect === "deny") &&
        Array.isArray(policy.permission_groups) && isRecord(policy.resources),
      `${label} has an invalid policy shape`
    );
    const writerPermission = policy.permission_groups.some((group, index) => {
      requireValue(
        isRecord(group) && typeof group.id === "string" && ACCOUNT_ID.test(group.id),
        `${label} permission group ${index} must expose one exact 32-hex id`
      );
      const resolvedName = writerPermissionGroups.get(group.id);
      if (group.name !== undefined) {
        boundedProviderText(group.name, 128, `${label} permission group ${index} name`);
        requireValue(
          resolvedName === undefined || group.name === resolvedName,
          `${label} permission group ${index} name disagrees with the provider directory`
        );
        requireValue(
          !/^Workers R2 .+ Write$/.test(group.name) || resolvedName !== undefined,
          `${label} permission group ${index} uses an unresolved R2 writer identity`
        );
      }
      return resolvedName !== undefined;
    });
    if (policy.effect !== "allow" || !writerPermission) return false;

    const directResources = new Set(bucketNames.flatMap((bucketName) =>
      ["default", "eu", "fedramp"].map((jurisdiction) =>
        `com.cloudflare.edge.r2.bucket.${cf.accountId}_${jurisdiction}_${bucketName}`
      )
    ));
    const accountResource = `com.cloudflare.api.account.${cf.accountId}`;
    for (const [resource, access] of Object.entries(policy.resources)) {
      requireValue(
        typeof resource === "string" && resource.length >= 1 && resource.length <= 512 &&
          (typeof access === "string" || isRecord(access)),
        `${label} contains an invalid resource selector`
      );
      if (directResources.has(resource) && access === "*") return true;
      if (resource !== accountResource) continue;
      if (access === "*") return true;
      for (const [nestedResource, nestedAccess] of Object.entries(access)) {
        requireValue(
          typeof nestedResource === "string" && nestedResource.length >= 1 &&
            nestedResource.length <= 512 && typeof nestedAccess === "string",
          `${label} contains an invalid nested resource selector`
        );
        if (
          nestedAccess === "*" &&
          (nestedResource === "com.cloudflare.edge.r2.bucket.*" ||
            directResources.has(nestedResource))
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async function accountTokenR2WriterProof(bucketNames, phase, allowManifestCredentials) {
    const writerPermissionGroups = await accountR2WriterPermissionGroups(phase);
    const verifyResponse = await clients.r2Configuration.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens", "verify"),
      label: "protected R2 operator token identity",
      rawName: rawName("cloudflare", "r2-external-writers", `${phase}-r2-operator-verify`)
    });
    const verifiedOperator = responseResult(verifyResponse, "protected R2 operator token identity");
    requireValue(
      isRecord(verifiedOperator) && ACCOUNT_ID.test(verifiedOperator.id) &&
        verifiedOperator.status === "active",
      "protected R2 operator must be one exact active account-owned token"
    );
    const manifestTokenIds = cf.credentialSets
      .filter((target) => target.expectedPresent)
      .map((target) => target.tokenId);
    requireValue(
      !manifestTokenIds.includes(verifiedOperator.id),
      "protected R2 operator token must be isolated from every manifest credential target"
    );

    const tokens = await listCloudflareNumberedPages({
      client: clients.tokenAdmin,
      basePath: cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens"),
      label: "account-owned R2 writer token inventory",
      rawName: (page) => rawName(
        "cloudflare",
        "r2-external-writers",
        `${phase}-account-token-list-${page}`
      ),
      perPage: 50,
      queryEntries: [["include_expired", "true"]],
      select(response, label) {
        return selectedCloudflareArray(response, label);
      }
    });

    const tokenIds = [];
    const activeWriterTokenIds = [];
    for (const [index, token] of tokens.entries()) {
      requireValue(
        isRecord(token) && ACCOUNT_ID.test(token.id) &&
          ["active", "disabled", "expired"].includes(token.status) &&
          Array.isArray(token.policies),
        `account-owned token ${index} has an invalid identity, status, or policy list`
      );
      tokenIds.push(token.id);
      const writesSelectedBucket = token.policies.some((policy, policyIndex) =>
        r2WriterPolicyCoversBuckets(
          policy,
          bucketNames,
          writerPermissionGroups,
          `account-owned token ${index} policy ${policyIndex}`
        )
      );
      if (token.status === "active" && writesSelectedBucket) {
        activeWriterTokenIds.push(token.id);
      }
    }
    requireValue(new Set(tokenIds).size === tokenIds.length, "account-owned token inventory contains duplicate ids");
    requireValue(
      tokenIds.filter((tokenId) => tokenId === verifiedOperator.id).length === 1,
      "protected R2 operator token is absent or duplicated in account-owned token inventory"
    );
    if (!allowManifestCredentials) {
      requireValue(
        manifestTokenIds.every((tokenId) => !tokenIds.includes(tokenId)),
        "a manifest staging R2 credential reappeared before bucket deletion"
      );
    }
    const allowedWriterTokenIds = new Set([
      verifiedOperator.id,
      ...(allowManifestCredentials ? manifestTokenIds : [])
    ]);
    const noncanonicalWriterTokenIds = activeWriterTokenIds.filter(
      (tokenId) => !allowedWriterTokenIds.has(tokenId)
    );
    requireValue(
      noncanonicalWriterTokenIds.length === 0,
      "an active noncanonical account-owned token can write a reviewed staging R2 bucket"
    );
    return {
      accountTokenCount: tokenIds.length,
      activeR2WriterTokenCount: activeWriterTokenIds.length,
      activeR2WriterTokenIdsSha256: sha256Bytes(
        serializeCanonicalEvidence(
          [...activeWriterTokenIds].sort(compareStagingTeardownCodeUnits)
        )
      ),
      noncanonicalActiveR2WriterTokenCount: 0,
      protectedR2OperatorTokenIdSha256: sha256Bytes(verifiedOperator.id)
    };
  }

  async function externalR2WriterProof(bucketNames, phase, { allowManifestCredentials }) {
    requireValue(
      Array.isArray(bucketNames) && bucketNames.length >= 1 &&
        bucketNames.length <= BUCKET_NAMES.length &&
        new Set(bucketNames).size === bucketNames.length &&
        bucketNames.every((bucketName) => BUCKET_NAMES.includes(bucketName)),
      "external R2 writer proof bucket set is invalid"
    );
    // These inventories are independent and read-only. Start them together,
    // then require the complete joined proof before any caller may mutate.
    const [workerFacts, pipelineFacts, slurperFacts, tokenFacts] = await Promise.all([
      activeWorkerR2BindingProof(bucketNames, phase),
      pipelineR2SinkProof(bucketNames, phase),
      superSlurperR2JobProof(bucketNames, phase),
      accountTokenR2WriterProof(bucketNames, phase, allowManifestCredentials)
    ]);
    return Object.freeze({
      bucketCount: bucketNames.length,
      bucketNamesSha256: sha256Bytes(serializeCanonicalEvidence(
        [...bucketNames].sort(compareStagingTeardownCodeUnits)
      )),
      ...workerFacts,
      ...pipelineFacts,
      ...slurperFacts,
      ...tokenFacts,
      paginationComplete: true
    });
  }

  function initialExternalR2WriterProof() {
    if (initialExternalWriterProofPromise === undefined) {
      initialExternalWriterProofPromise = externalR2WriterProof(
        cf.buckets.map((target) => target.bucketName),
        "initial-before",
        { allowManifestCredentials: true }
      );
    }
    return initialExternalWriterProofPromise;
  }

  function bindObservationToExternalWriterProof(observation, logicalName, phase, writerProof) {
    return {
      ...observation,
      evidence: evidence({
        kind: "provider-inventory-response",
        sessionId,
        provider: "cloudflare",
        logicalName,
        phase,
        state: observation.state,
        externalIds: observation.externalIds,
        details: {
          inventoryEvidenceSha256: sha256Bytes(observation.evidence.bytes),
          externalR2WriterProof: writerProof
        }
      })
    };
  }

  async function faultObservation(target, logicalName, phase) {
    const response = await clients.workerProjectionObservation.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts", target.workerName, "settings"),
      label: `${logicalName} Worker settings`,
      rawName: rawName("cloudflare", logicalName, `${phase}-fault`),
      acceptedStatuses: [200, 404]
    });
    let state = "absent";
    if (response.status === 200) {
      const result = responseResult(response, `${logicalName} Worker settings`);
      const bindings = Array.isArray(result?.bindings) ? result.bindings : [];
      const bindingNames = bindings.map(parseBindingName).filter(Boolean);
      const hasActivation = bindingNames.includes(target.activationBindingName);
      const hasSecret = bindingNames.includes(target.secretBindingName);
      requireValue(hasActivation === hasSecret, `${logicalName} fault bindings are only partially installed`);
      if (hasActivation) {
        const activation = bindings.find((binding) => binding?.name === target.activationBindingName);
        const secret = bindings.find((binding) => binding?.name === target.secretBindingName);
        requireValue(
          activation?.type === "plain_text" && activation?.text === "1",
          `${logicalName} activation binding must be the exact enabled value`
        );
        requireValue(
          secret?.type === "secret_text",
          `${logicalName} fault token binding must be an opaque Worker secret`
        );
      }
      state = hasActivation && hasSecret ? "present" : "absent";
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present" ? [`fault-hook:${target.workerName}:${target.activationBindingName}`] : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "cloudflare",
        logicalName, phase, state, externalIds,
        details: { exactBindings: state === "present", paginationComplete: true }
      })
    };
  }

  async function observe(logicalName, { phase }) {
    const entry = byName.get(logicalName);
    requireValue(entry !== undefined, `Cloudflare adapter does not own ${logicalName}`);
    const writerProof = phase === "before"
      ? await initialExternalR2WriterProof()
      : null;
    let observation;
    if (entry.type === "worker") observation = await workerObservation(entry.target, logicalName, phase);
    else if (entry.type === "dns") observation = await dnsObservation(entry.target, logicalName, phase);
    else if (entry.type === "container") observation = await containerObservation(entry.target, logicalName, phase);
    else if (entry.type === "bucket") observation = await bucketObservation(entry.target, logicalName, phase);
    else if (entry.type === "credential") observation = await credentialObservation(entry.target, logicalName, phase);
    else observation = await faultObservation(entry.target, logicalName, phase);
    return writerProof === null
      ? observation
      : bindObservationToExternalWriterProof(observation, logicalName, phase, writerProof);
  }

  async function remove(logicalName, externalIds) {
    const entry = byName.get(logicalName);
    requireValue(entry !== undefined, `Cloudflare adapter does not own ${logicalName}`);
    const { target, type } = entry;
    let deletionCount = 0;
    let cascaded = false;
    let externalWriterProof = null;
    if (type === "worker") {
      // Re-bind the exact Worker/namespace immediately before mutation, then
      // prove the absence of every external reference Wrangler itself treats
      // as requiring force. Same-script Durable Object references are the only
      // permitted references; force deletion is never used.
      await workerObservation(target, logicalName, "before", { preDelete: true });
      const pairedContainer = containerByWorker.get(target.scriptName);
      requireValue(pairedContainer !== undefined, `${logicalName} has no canonical container target`);
      if (pairedContainer.expectedPresent) {
        requireValue(
          await exactContainerApplication(pairedContainer, pairedContainer.logicalName, "worker-remove-check") !== null,
          `${logicalName} paired container disappeared before Worker deletion`
        );
      }
      const response = await clients.compute.request({
        method: "DELETE",
        path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts", target.scriptName),
        label: `${logicalName} Worker deletion`,
        rawName: rawName("cloudflare", logicalName, "remove-worker"),
        acceptedStatuses: [200, 204],
        emptyResponseStatuses: [200]
      });
      if (response.value !== null) {
        exactEmptyObject(
          cloudflareDeleteResult(response, `${logicalName} Worker deletion`),
          `${logicalName} Worker deletion result`
        );
      }
      removedWorkers.add(target.scriptName);
      deletionCount = 1;
    } else if (type === "dns") {
      // The complete before inventory may be minutes old. Rebind every still-
      // expected component immediately before the first destructive request.
      const freshDns = await dnsObservation(target, logicalName, "remove-check");
      let domainRemovedByThisSession = false;
      if (freshDns.components.domainPresent) {
        const domainResponse = await clients.compute.request({
          method: "DELETE",
          path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "domains", target.workerDomainId),
          label: `${logicalName} Worker domain deletion`,
          rawName: rawName("cloudflare", logicalName, "remove-domain"),
          acceptedStatuses: [200, 404]
        });
        if (domainResponse.status === 200) {
          const domainEnvelope = domainResponse.value;
          responseResult(domainResponse, `${logicalName} Worker domain deletion`);
          requireValue(
            isRecord(domainEnvelope) && !Object.hasOwn(domainEnvelope, "result"),
            `${logicalName} Worker domain deletion must return the documented result-free success envelope`
          );
          domainRemovedByThisSession = true;
          deletionCount += 1;
        }
        const domainAbsence = await clients.compute.request({
          path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "domains"),
          label: `${logicalName} post-delete Worker domains`,
          rawName: rawName("cloudflare", logicalName, "remove-domain-absence")
        });
        requireValue(
          selectedCloudflareArray(domainAbsence, `${logicalName} post-delete Worker domains`)
            .every((domain) => !isRecord(domain) || domain.hostname !== target.hostname),
          `${logicalName} Worker domain is not exactly absent after its deletion response`
        );
      }
      const dnsRecords = await listCloudflareNumberedPages({
        client: clients.dns,
        basePath: cloudflarePath("client", "v4", "zones", cf.zoneId, "dns_records"),
        label: `${logicalName} post-domain DNS records`,
        rawName: (page) => rawName("cloudflare", logicalName, `remove-dns-inventory-${page}`),
        select(response, label) {
          return selectedCloudflareArray(response, label);
        }
      });
      const remainingMatches = dnsRecords.filter(
        (record) => isRecord(record) && record.name === target.hostname
      );
      const expectedById = new Map(target.dnsRecords.map((record) => [record.id, record]));
      requireValue(
        remainingMatches.every((record) =>
          expectedById.has(record.id) &&
            serializeCanonicalEvidence(dnsRecordProjection(record)) ===
              serializeCanonicalEvidence(expectedById.get(record.id))
        ),
        `${logicalName} acquired an unreviewed or changed DNS record before deletion`
      );
      if (!domainRemovedByThisSession) {
        requireValue(
          serializeCanonicalEvidence(
            remainingMatches.map(dnsRecordProjection).sort((left, right) =>
              compareStagingTeardownCodeUnits(left.id, right.id)
            )
          ) === serializeCanonicalEvidence(freshDns.components.dnsRecords),
          `${logicalName} DNS records changed after the fresh component rebind`
        );
      }
      for (const record of remainingMatches) {
        const expectedRecord = expectedById.get(record.id);
        const recordPath = cloudflarePath(
          "client", "v4", "zones", cf.zoneId, "dns_records", record.id
        );
        const exactRecordResponse = await clients.dns.request({
          path: recordPath,
          label: `${logicalName} DNS record immediate pre-delete identity`,
          rawName: rawName("cloudflare", logicalName, "remove-dns-record-check"),
          acceptedStatuses: [200, 404]
        });
        requireValue(
          exactRecordResponse.status === 200 &&
            serializeCanonicalEvidence(dnsRecordProjection(responseResult(
              exactRecordResponse,
              `${logicalName} DNS record immediate pre-delete identity`
            ))) === serializeCanonicalEvidence(expectedRecord),
          `${logicalName} DNS record changed or disappeared immediately before deletion`
        );
        const recordResponse = await clients.dns.request({
          method: "DELETE",
          path: recordPath,
          label: `${logicalName} DNS record deletion`,
          rawName: rawName("cloudflare", logicalName, "remove-dns-record"),
          acceptedStatuses: [200, 404]
        });
        if (recordResponse.status === 200) {
          exactCloudflareDeleteId(recordResponse, record.id, `${logicalName} DNS record deletion`);
          deletionCount += 1;
        } else {
          const recordAbsence = await clients.dns.request({
            path: cloudflarePath("client", "v4", "zones", cf.zoneId, "dns_records", record.id),
            label: `${logicalName} DNS record race absence proof`,
            rawName: rawName("cloudflare", logicalName, "remove-dns-record-absence"),
            acceptedStatuses: [200, 404]
          });
          requireValue(
            recordAbsence.status === 404,
            `${logicalName} DNS record DELETE returned 404 but the exact reviewed record remains`
          );
        }
      }
      if (target.certificatePackId !== null) {
        // Re-read the exact pack after domain/DNS mutation so a different or
        // asynchronously changing pack cannot be selected by id alone.
        const certificatePath = cloudflarePath(
          "client", "v4", "zones", cf.zoneId, "ssl", "certificate_packs",
          target.certificatePackId
        );
        const certificateBeforeDelete = await clients.dns.request({
          path: certificatePath,
          label: `${logicalName} dedicated certificate pre-delete check`,
          rawName: rawName("cloudflare", logicalName, "remove-certificate-check"),
          acceptedStatuses: [200, 404]
        });
        let certificateDeleted = certificateBeforeDelete.status === 404;
        let certificatePending = false;
        if (certificateBeforeDelete.status === 200) {
          const certificate = target.certificatePack?.status === "pending_deletion"
            ? terminalCertificateFacts(
                responseResult(certificateBeforeDelete, `${logicalName} dedicated certificate pre-delete check`),
                target,
                logicalName
              )
            : certificateFacts(
                responseResult(certificateBeforeDelete, `${logicalName} dedicated certificate pre-delete check`),
                target,
                logicalName
              );
          certificateDeleted = certificate.status === "deleted";
          certificatePending = certificate.status === "pending_deletion";
          if (!certificateDeleted && !certificatePending) {
            const certificateResponse = await clients.dns.request({
              method: "DELETE",
              path: certificatePath,
              label: `${logicalName} dedicated certificate deletion`,
              rawName: rawName("cloudflare", logicalName, "remove-certificate"),
              acceptedStatuses: [200]
            });
            exactCloudflareDeleteId(
              certificateResponse,
              target.certificatePackId,
              `${logicalName} dedicated certificate deletion`
            );
            certificatePending = true;
            deletionCount += 1;
          }
        }
        for (
          let attempt = 1;
          !certificateDeleted && certificatePending &&
            attempt <= STAGING_TEARDOWN_PROVIDER_CONVERGENCE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          const convergence = await clients.dns.request({
            path: certificatePath,
            label: `${logicalName} certificate deletion convergence attempt ${attempt}`,
            rawName: rawName("cloudflare", logicalName, `remove-certificate-convergence-${attempt}`),
            acceptedStatuses: [200, 404]
          });
          if (convergence.status === 404) {
            certificateDeleted = true;
            break;
          }
          const result = terminalCertificateFacts(
            responseResult(convergence, `${logicalName} certificate deletion convergence`),
            target,
            logicalName
          );
          if (result.status === "deleted") {
            certificateDeleted = true;
            break;
          }
          requireValue(
            result.status === "pending_deletion",
            `${logicalName} certificate deletion returned a non-terminal unexpected status`
          );
          if (attempt < STAGING_TEARDOWN_PROVIDER_CONVERGENCE_MAX_ATTEMPTS) {
            await sleepImpl(1_000);
          }
        }
        requireValue(certificateDeleted, `${logicalName} certificate deletion timed out`);
      }
    } else if (type === "container") {
      const match = await exactContainerApplication(target, logicalName, "remove-check");
      if (match === null) {
        requireValue(
          removedWorkers.has(target.workerName),
          `${logicalName} disappeared before deletion without deletion of its exact associated Worker in this session`
        );
        cascaded = true;
      } else {
        const containerResponse = await clients.compute.request({
          method: "DELETE",
          path: cloudflarePath("client", "v4", "accounts", cf.accountId, "containers", "applications", target.applicationId),
          label: `${logicalName} container deletion`,
          rawName: rawName("cloudflare", logicalName, "remove-container"),
          acceptedStatuses: [200, 202]
        });
        exactEmptyObject(
          cloudflareDeleteResult(containerResponse, `${logicalName} container deletion`),
          `${logicalName} container deletion result`
        );
        let containerDeleted = false;
        for (
          let attempt = 1;
          attempt <= STAGING_TEARDOWN_PROVIDER_CONVERGENCE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          const convergence = await clients.compute.request({
            path: cloudflarePath(
              "client", "v4", "accounts", cf.accountId, "containers", "applications",
              target.applicationId
            ),
            label: `${logicalName} container deletion convergence attempt ${attempt}`,
            rawName: rawName("cloudflare", logicalName, `remove-container-convergence-${attempt}`),
            acceptedStatuses: [200, 404]
          });
          if (convergence.status === 404) {
            containerDeleted = true;
            break;
          }
          const application = responseResult(convergence, `${logicalName} container deletion convergence`);
          exactIdentity(application?.id, target.applicationId, `${logicalName} converging application id`);
          exactIdentity(application?.name, target.applicationName, `${logicalName} converging application name`);
          if (attempt < STAGING_TEARDOWN_PROVIDER_CONVERGENCE_MAX_ATTEMPTS) {
            await sleepImpl(1_000);
          }
        }
        requireValue(containerDeleted, `${logicalName} container deletion timed out`);
        deletionCount = 1;
      }
    } else if (type === "bucket") {
      // The before inventory proved that the provider key set exactly equals
      // this allowlist. Re-GET the bucket identity and then re-list immediately
      // to close both name-reuse and object-write time-of-check gaps.
      const freshBucket = await bucketObservation(target, logicalName, "remove-check");
      requireValue(
        freshBucket.state === "present",
        `${logicalName} R2 bucket disappeared before its reviewed deletion`
      );
      externalWriterProof = await externalR2WriterProof(
        [target.bucketName],
        `bucket-${cf.buckets.indexOf(target) + 1}-remove`,
        { allowManifestCredentials: false }
      );
      const keys = target.objects.map((object) => object.key);
      for (const key of keys) {
        const objectResponse = await clients.r2.request({
          method: "DELETE",
          path: `${cloudflarePath(
            "client", "v4", "accounts", cf.accountId, "r2", "buckets", target.bucketName, "objects"
          )}/${encodeCloudflareR2ObjectKeyPath(key)}`,
          label: `${logicalName} allowlisted R2 object deletion`,
          rawName: rawName("cloudflare", logicalName, "remove-object"),
          acceptedStatuses: [200],
          cloudflareR2Jurisdiction: "default"
        });
        exactCloudflareDeleteKey(
          objectResponse,
          key,
          `${logicalName} allowlisted R2 object deletion`
        );
        deletionCount += 1;
      }
      const remaining = await bucketObjects(target, logicalName, "empty-check");
      requireValue(remaining.length === 0, `${logicalName} R2 bucket is not empty after allowlisted deletions`);
      const bucketResponse = await clients.r2.request({
        method: "DELETE",
        path: cloudflarePath("client", "v4", "accounts", cf.accountId, "r2", "buckets", target.bucketName),
        label: `${logicalName} R2 bucket deletion`,
        rawName: rawName("cloudflare", logicalName, "remove-bucket"),
        acceptedStatuses: [200],
        cloudflareR2Jurisdiction: "default"
      });
      exactEmptyObject(
        cloudflareDeleteResult(bucketResponse, `${logicalName} R2 bucket deletion`),
        `${logicalName} R2 bucket deletion result`
      );
      deletionCount += 1;
    } else if (type === "credential") {
      // A fresh GET repeats the exact id/name/policy check immediately before
      // exercising the account-wide token-revocation authority.
      await credentialObservation(target, logicalName, "before");
      const tokenResponse = await clients.tokenAdmin.request({
        method: "DELETE",
        path: cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens", target.tokenId),
        label: `${logicalName} account-owned token revocation`,
        rawName: rawName("cloudflare", logicalName, "revoke-token"),
        acceptedStatuses: [200]
      });
      exactCloudflareDeleteId(
        tokenResponse,
        target.tokenId,
        `${logicalName} account-owned token revocation`
      );
      deletionCount = 1;
    } else {
      requireValue(
        removedWorkers.has(target.workerName),
        `${logicalName} may only be disabled by deletion of its exact Worker in this session`
      );
      cascaded = true;
    }
    return {
      evidence: evidence({
        kind: "provider-removal-response", sessionId, provider: "cloudflare",
        logicalName, phase: "remove", state: "accepted", externalIds,
        details: {
          deletionCount,
          cascaded,
          ...(externalWriterProof === null ? {} : { externalR2WriterProof: externalWriterProof })
        }
      })
    };
  }

  return Object.freeze({
    kind: "cloudflare-exact-v1",
    owns: (name) => byName.has(name),
    observe,
    remove,
    requestBudgetSnapshot: () => Object.freeze(Object.fromEntries(
      Object.entries(requestLedgers).map(([name, ledger]) => [name, ledger.snapshot()])
    ))
  });
}

export function createGithubStagingTeardownAdapter({
  manifest,
  credentials,
  sessionId,
  fetchImpl,
  persistRaw,
  apiBaseUrl = "https://api.github.com"
}) {
  const rawName = createRawNamer();
  const requestLedger = createProviderRequestLedger({
    label: "GitHub runner-administration installation token",
    requestLimit:
      STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF.githubRunnerInstallationToken
  });
  const client = createBoundedProviderClient({
    provider: "github",
    baseUrl: apiBaseUrl,
    ...(credentials.githubRunnerAdminToken === undefined
      ? { tokenProvider: credentials.githubRunnerAdminTokenProvider }
      : { token: credentials.githubRunnerAdminToken }),
    fetchImpl,
    persistRaw,
    requestLimit: STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF.githubRunnerAdmin,
    requestLedger
  });
  const [owner, repository] = manifest.github.repository.split("/");
  const target = manifest.github.runner;

  async function listRunners(phase) {
    const runners = [];
    const runnerIds = new Set();
    const runnerNames = new Set();
    let totalCount;
    for (let page = 1; page <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES; page += 1) {
      const response = await client.request({
        path: queryPath(
          cloudflarePath("repos", owner, repository, "actions", "runners"),
          [["per_page", "100"], ["page", String(page)]]
        ),
        label: `GitHub staging runner inventory page ${page}`,
        rawName: rawName("github", target.logicalName, `${phase}-runner-${page}`)
      });
      requireValue(isRecord(response.value), "GitHub runner inventory must be an object");
      requireValue(
        Number.isSafeInteger(response.value.total_count) && response.value.total_count >= 0 &&
          response.value.total_count <= 100 * STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES &&
          Array.isArray(response.value.runners) && response.value.runners.length <= 100,
        "GitHub runner inventory has invalid pagination metadata"
      );
      if (totalCount === undefined) totalCount = response.value.total_count;
      requireValue(totalCount === response.value.total_count, "GitHub runner total_count changed while paginating");
      for (const [index, runner] of response.value.runners.entries()) {
        const label = `GitHub runner inventory page ${page} item ${index}`;
        requireValue(isRecord(runner), `${label} must be an object`);
        requireValue(
          Number.isSafeInteger(runner.id) && runner.id >= 1 && !runnerIds.has(runner.id),
          `${label}.id must be one unique positive safe integer`
        );
        boundedProviderText(runner.name, 100, `${label}.name`);
        requireValue(!runnerNames.has(runner.name), `${label}.name must be unique`);
        requireValue(
          runner.status === "online" || runner.status === "offline",
          `${label}.status must be online or offline`
        );
        requireValue(typeof runner.busy === "boolean", `${label}.busy must be boolean`);
        requireValue(
          Array.isArray(runner.labels) && runner.labels.length <= 100,
          `${label}.labels must be a bounded array`
        );
        const labelNames = new Set();
        for (const [labelIndex, runnerLabel] of runner.labels.entries()) {
          const runnerLabelName = `${label}.labels[${labelIndex}]`;
          requireValue(
            isRecord(runnerLabel) && Object.keys(runnerLabel).every((key) =>
              ["id", "name", "type"].includes(key)
            ),
            `${runnerLabelName} has an unsupported shape`
          );
          boundedProviderText(runnerLabel.name, 100, `${runnerLabelName}.name`);
          requireValue(
            !labelNames.has(runnerLabel.name),
            `${runnerLabelName}.name is duplicated`
          );
          labelNames.add(runnerLabel.name);
          if (Object.hasOwn(runnerLabel, "id")) {
            requireValue(
              Number.isSafeInteger(runnerLabel.id) && runnerLabel.id >= 1,
              `${runnerLabelName}.id must be one positive safe integer when present`
            );
          }
          if (Object.hasOwn(runnerLabel, "type")) {
            requireValue(
              runnerLabel.type === "read-only" || runnerLabel.type === "custom",
              `${runnerLabelName}.type is invalid`
            );
          }
        }
        runnerIds.add(runner.id);
        runnerNames.add(runner.name);
        runners.push(runner);
      }
      requireValue(
        runners.length <= totalCount,
        "GitHub runner inventory exceeded its declared total_count"
      );
      if (runners.length === totalCount) return runners;
      requireValue(response.value.runners.length === 100 && runners.length < totalCount, "GitHub runner pagination ended before total_count");
    }
    throw new Error(`GitHub runner inventory exceeded ${STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES} pages`);
  }

  async function observe(logicalName, { phase }) {
    requireValue(logicalName === RUNNER_LOGICAL_NAME, `GitHub adapter does not own ${logicalName}`);
    const runners = await listRunners(phase);
    const matches = runners.filter((runner) => runner?.id === target.id || runner?.name === target.name);
    requireValue(matches.length <= 1, "GitHub staging runner identity matched more than one registration");
    const state = matches.length === 1 ? "present" : "absent";
    if (state === "present") {
      const runner = matches[0];
      exactIdentity(runner.name, target.name, "GitHub staging runner name");
      if (target.expectedPresent) {
        exactIdentity(runner.id, target.id, "GitHub staging runner id");
        requireValue(runner.busy === false, "GitHub staging runner is busy; refusing to unregister it");
        requireValue(
          runner.status === "offline",
          "GitHub staging runner service must be offline before it can be unregistered"
        );
        const labels = (runner.labels ?? []).map((label) => label?.name)
          .sort(compareStagingTeardownCodeUnits);
        requireValue(
          JSON.stringify(labels) === JSON.stringify(target.labels),
          "GitHub staging runner labels do not exactly match the reviewed target identity"
        );
      }
    }
    assertExpected(target, state, logicalName, phase);
    const externalIds = state === "present" ? [`github-runner:${target.id}`] : [];
    return {
      state,
      externalIds,
      evidence: evidence({
        kind: "provider-inventory-response", sessionId, provider: "github",
        logicalName, phase, state, externalIds,
        details: { matchCount: matches.length, paginationComplete: true }
      })
    };
  }

  async function remove(logicalName, externalIds) {
    requireValue(logicalName === RUNNER_LOGICAL_NAME, `GitHub adapter does not own ${logicalName}`);
    // Close the list/delete race and re-check busy/labels immediately before
    // applying repository Administration write authority.
    await observe(logicalName, { phase: "before" });
    await client.request({
      method: "DELETE",
      path: cloudflarePath("repos", owner, repository, "actions", "runners", target.id),
      label: "GitHub staging runner unregistration",
      rawName: rawName("github", logicalName, "remove-runner"),
      acceptedStatuses: [204]
    });
    return {
      evidence: evidence({
        kind: "provider-removal-response", sessionId, provider: "github",
        logicalName, phase: "remove", state: "accepted", externalIds,
        details: { deletionCount: 1 }
      })
    };
  }

  return Object.freeze({
    kind: "github-exact-runner-v1",
    owns: (name) => name === RUNNER_LOGICAL_NAME,
    observe,
    remove,
    requestBudgetSnapshot: () => requestLedger.snapshot()
  });
}

/** Create the single orchestration-facing adapter from two provider clients. */
export function createCompositeStagingTeardownProviderAdapter({
  targetManifest,
  trustedCommit,
  trustedCloudflareAccountId,
  trustedCloudflareZoneId,
  credentials,
  sessionId,
  fetchImpl = globalThis.fetch,
  persistRaw = async () => undefined,
  cloudflareApiBaseUrl,
  githubApiBaseUrl
}) {
  const manifest = validateStagingTeardownTargetManifest(targetManifest, trustedCommit);
  requireValue(
    typeof trustedCloudflareAccountId === "string" && ACCOUNT_ID.test(trustedCloudflareAccountId) &&
      manifest.cloudflare.accountId === trustedCloudflareAccountId,
    "target-manifest Cloudflare accountId must equal protected CLOUDFLARE_ACCOUNT_ID"
  );
  requireValue(
    typeof trustedCloudflareZoneId === "string" && ZONE_ID.test(trustedCloudflareZoneId) &&
      manifest.cloudflare.zoneId === trustedCloudflareZoneId,
    "target-manifest Cloudflare zoneId must equal protected STAGING_TEARDOWN_CF_ZONE_ID"
  );
  const exactCredentials = requireCredentials(credentials);
  requireValue(
    typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId),
    "composite staging teardown adapter requires a canonical lowercase UUIDv4 session id"
  );
  requireValue(typeof fetchImpl === "function", "composite staging teardown adapter requires fetch");
  requireValue(typeof persistRaw === "function", "composite staging teardown adapter requires a private raw sink");
  const cloudflare = createCloudflareStagingTeardownAdapter({
    manifest,
    credentials: exactCredentials,
    sessionId,
    fetchImpl,
    persistRaw,
    ...(cloudflareApiBaseUrl === undefined ? {} : { apiBaseUrl: cloudflareApiBaseUrl })
  });
  const github = createGithubStagingTeardownAdapter({
    manifest,
    credentials: exactCredentials,
    sessionId,
    fetchImpl,
    persistRaw,
    ...(githubApiBaseUrl === undefined ? {} : { apiBaseUrl: githubApiBaseUrl })
  });

  function provider(logicalName) {
    if (cloudflare.owns(logicalName)) return cloudflare;
    if (github.owns(logicalName)) return github;
    throw new Error(`no provider owns canonical teardown resource ${logicalName}`);
  }

  return Object.freeze({
    kind: STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND,
    removalOrder: STAGING_TEARDOWN_REMOVAL_ORDER,
    async observe(logicalName, context) {
      return provider(logicalName).observe(logicalName, context);
    },
    async remove(logicalName, externalIds, context) {
      return provider(logicalName).remove(logicalName, externalIds, context);
    }
  });
}

export function parseStagingTeardownTargetManifest(bytes, trustedCommit) {
  const byteLength = typeof bytes === "string"
    ? new TextEncoder().encode(bytes).byteLength
    : -1;
  requireValue(
    typeof bytes === "string" && byteLength >= 2 &&
      byteLength <= STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES,
    `STAGING_TEARDOWN_TARGETS_JSON must contain 2 through ${STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES} UTF-8 bytes`
  );
  let value;
  try {
    value = parseStrictJson(bytes, STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES);
  } catch {
    throw new Error("STAGING_TEARDOWN_TARGETS_JSON must be bounded strict JSON without duplicate keys or excessive nesting");
  }
  return validateStagingTeardownTargetManifest(value, trustedCommit);
}

/** Generate the only supported starting shape for an operator target file. */
export function stagingTeardownTargetManifestTemplate({
  stagingSourceCommit,
  accountId,
  zoneId
}) {
  const manifest = {
    schemaVersion: STAGING_TEARDOWN_TARGET_MANIFEST_SCHEMA_VERSION,
    artifactKind: STAGING_TEARDOWN_TARGET_MANIFEST_KIND,
    stagingSourceCommit,
    cloudflare: {
      accountId,
      zoneId,
      workers: WORKER_NAMES.map((logicalName, index) => ({
        logicalName,
        scriptName: logicalName,
        workerId: null,
        expectedPresent: false,
        durableObjectBindingName: WORKER_DURABLE_OBJECT_BINDING_NAME,
        durableObjectClassName: WORKER_DURABLE_OBJECT_CLASS_NAME,
        durableObjectNamespaceId: null,
        containerApplicationName: CONTAINER_NAMES[index],
        createdOn: null,
        modifiedOn: null,
        latestScriptEtag: null,
        versionSettingsSha256: null,
        scriptSettingsSha256: null,
        deploymentsSha256: null,
        stoppedBuildsSha256: null,
        versionState: [],
        secretNames: []
      })),
      dns: DNS_TARGETS.map((target) => ({
        logicalName: target.logicalName,
        hostname: target.hostname,
        workerName: target.workerName,
        expectedPresent: false,
        workerDomainExpectedPresent: false,
        workerDomainId: null,
        workerDomainCertId: null,
        dnsRecords: [],
        certificatePackId: null,
        certificateHosts: [],
        certificatePack: null,
        certificatePackSha256: null
      })),
      containers: CONTAINER_NAMES.map((logicalName, index) => ({
        logicalName,
        applicationName: logicalName,
        applicationId: null,
        workerName: WORKER_NAMES[index],
        durableObjectNamespaceId: null,
        expectedPresent: false,
        resolvedImageDigest: null,
        applicationSha256: null,
        deploymentsSha256: null,
        rolloutsSha256: null,
        inactiveDurableObjectsSha256: null
      })),
      buckets: BUCKET_NAMES.map((logicalName) => ({
        logicalName,
        bucketName: logicalName,
        expectedPresent: false,
        expectedCreationDate: null,
        expectedJurisdiction: null,
        expectedLocation: null,
        expectedStorageClass: null,
        expectedLifecycleRules: [],
        managedDomainBucketId: null,
        managedDomainDomain: null,
        objects: []
      })),
      credentialSets: CREDENTIAL_NAMES.map((logicalName, index) => ({
        logicalName,
        expectedPresent: false,
        tokenId: null,
        tokenName: logicalName,
        allowedBucketName: BUCKET_NAMES[index],
        expectedPolicies: [],
        expectedPolicySha256: null
      })),
      faultHook: {
        logicalName: FAULT_HOOK_NAME,
        workerName: WORKER_NAMES[0],
        expectedPresent: false,
        activationBindingName: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS",
        secretBindingName: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"
      }
    },
    github: {
      repository: REPOSITORY,
      runner: {
        logicalName: RUNNER_LOGICAL_NAME,
        expectedPresent: false,
        id: null,
        name: "site-behavior-lab-durable-replay-staging",
        labels: [...STAGING_TEARDOWN_RUNNER_LABELS]
      }
    }
  };
  return validateStagingTeardownTargetManifest(manifest, stagingSourceCommit);
}

export function canonicalStagingTeardownResources() {
  return STAGING_RESOURCE_CONTRACT.map((resource) => ({ ...resource }));
}
