import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createCloudflareStagingTeardownAdapter,
  createCompositeStagingTeardownProviderAdapter,
  createGithubStagingTeardownAdapter,
  encodeCloudflareR2ObjectKeyPath,
  parseStagingTeardownTargetManifest,
  STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND,
  STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF,
  STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF,
  STAGING_TEARDOWN_PROVIDER_WORST_CASE_MILLISECONDS,
  STAGING_TEARDOWN_WORKFLOW_NON_PROVIDER_RESERVE_MILLISECONDS,
  STAGING_TEARDOWN_REMOVAL_ORDER,
  STAGING_TEARDOWN_TARGET_MANIFEST_KIND,
  validateStagingTeardownTargetManifest
} from "./staging-teardown-provider-adapters.mjs";
import { runStagingTeardown } from "./staging-teardown-provider-adapter.mjs";
import {
  buildStagingTeardownEvidence,
  STAGING_RESOURCE_CONTRACT
} from "./staging-teardown-evidence-lib.mjs";
import { serializeCanonicalEvidence, sha256Bytes } from "./operator-evidence-common.mjs";
import {
  STAGING_TEARDOWN_GITHUB_APP_TOKEN_MINIMUM_LIFETIME_MS,
  STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT,
  STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS
} from "./staging-teardown-github-app-token.mjs";
import { STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS } from "./staging-teardown-provider-http.mjs";
import { readResponseJsonWithinLimit } from "./http-response.mjs";
import {
  captureStagingTeardownTargetManifest,
  STAGING_TEARDOWN_TARGET_CAPTURE_MAX_PROVIDER_MILLISECONDS,
  STAGING_TEARDOWN_TARGET_CAPTURE_REQUEST_LIMITS
} from "./staging-teardown-target-capture-lib.mjs";
import {
  compareStagingTeardownCodeUnits,
  normalizeStagingTeardownWorkerBindings,
  normalizeStagingTeardownWorkerScriptSettings,
  projectStagingTeardownCertificatePack,
  projectStagingTeardownR2Object,
  stagingTeardownProjectionSha256
} from "./staging-teardown-target-projections.mjs";

const COMMIT = "c".repeat(40);
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const R2_OPERATOR_TOKEN_ID = "f".repeat(32);
const R2_STORAGE_WRITE_PERMISSION_GROUP_ID = "1".repeat(32);
const R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID =
  "2efd5506f9c8494dacb1fa10a3e7d5b6";
const R2_DATA_CATALOG_WRITE_PERMISSION_GROUP_ID =
  "d229766a2f7f4d299f20eaa8c9b1fde9";
const SESSION_ID = "6f1d9c2a-7b3e-4d5f-8a1b-2c3d4e5f6a7b";
const FIXTURE_RESPONSE_MAX_BYTES = 1024 * 1024;
const TOKENS = Object.freeze({
  compute: "compute_" + "c".repeat(32),
  dns: "dns_" + "d".repeat(32),
  r2: "r2_" + "r".repeat(32),
  admin: "admin_" + "a".repeat(32),
  observation: "observation_" + "o".repeat(32),
  github: "github_" + "g".repeat(32)
});

async function fixtureResponseJson(response) {
  return readResponseJsonWithinLimit(response, {
    maxBytes: FIXTURE_RESPONSE_MAX_BYTES,
    label: "staging teardown fixture response"
  });
}

function policy(bucket, suffix) {
  return [{
    effect: "allow",
    permission_groups: [{
      id: R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID,
      name: "Workers R2 Storage Bucket Item Write",
      meta: { key: "fixture", value: suffix }
    }],
    resources: { [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_${bucket}`]: "*" }
  }];
}

function r2WriterPermissionGroups() {
  return [
    {
      id: R2_STORAGE_WRITE_PERMISSION_GROUP_ID,
      category: "developer_platform",
      name: "Workers R2 Storage Write",
      scopes: ["com.cloudflare.api.account"]
    },
    {
      id: R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID,
      category: "developer_platform",
      name: "Workers R2 Storage Bucket Item Write",
      scopes: ["com.cloudflare.edge.r2.bucket"]
    },
    {
      id: R2_DATA_CATALOG_WRITE_PERMISSION_GROUP_ID,
      category: "developer_platform",
      name: "Workers R2 Data Catalog Write",
      scopes: ["com.cloudflare.api.account"]
    }
  ];
}

function credential(logicalName, bucket, tokenId, suffix) {
  const expectedPolicies = policy(bucket, suffix);
  return {
    logicalName,
    expectedPresent: true,
    tokenId,
    tokenName: logicalName,
    allowedBucketName: bucket,
    expectedPolicies,
    expectedPolicySha256: sha256Bytes(serializeCanonicalEvidence(expectedPolicies))
  };
}

function certificatePackFixture({
  id,
  hostname,
  certificateId,
  status = "active",
  certificates = certificateId === null
    ? []
    : [{ id: certificateId, hosts: [hostname], status: "active" }]
}) {
  return {
    id,
    type: "advanced",
    hosts: [hostname],
    certificates: structuredClone(certificates),
    status
  };
}

function certificatePackSha256(value) {
  return stagingTeardownProjectionSha256(projectStagingTeardownCertificatePack(
    value,
    "fixture certificate pack"
  ));
}

function stagingLifecycleRules() {
  return [{
    id: "durable-replay-staging-cleanup",
    conditions: { prefix: "" },
    enabled: true,
    abortMultipartUploadsTransition: {
      condition: { maxAge: 86_400, type: "Age" }
    },
    deleteObjectsTransition: {
      condition: { maxAge: 86_400, type: "Age" }
    },
    storageClassTransitions: []
  }];
}

function stagingObject(key, index) {
  return {
    key,
    etag: `etag-${index}`,
    size: 100 + index,
    lastModified: "2026-08-01T00:00:00.000Z",
    ssec: false,
    storageClass: "Standard",
    customMetadata: {},
    httpMetadata: {}
  };
}

function providerObject(object) {
  return {
    key: object.key,
    etag: object.etag,
    size: object.size,
    last_modified: object.lastModified,
    ssec: object.ssec,
    storage_class: object.storageClass,
    custom_metadata: structuredClone(object.customMetadata),
    http_metadata: structuredClone(object.httpMetadata)
  };
}

function stagingDnsRecord({ id, name, content, minute }) {
  return {
    id,
    type: "CNAME",
    name,
    content,
    proxied: true,
    ttl: 1,
    priority: null,
    comment: "staging teardown exact target",
    commentModifiedOn: `2026-08-01T00:${minute}:00.000Z`,
    data: null,
    meta: {
      auto_added: false,
      managed_by_apps: false,
      managed_by_argo_tunnel: false
    },
    proxiable: true,
    tags: ["durable-replay-staging"],
    settings: {},
    tagsModifiedOn: `2026-08-01T00:${minute}:00.000Z`,
    createdOn: `2026-08-01T00:${minute}:00.000Z`,
    modifiedOn: `2026-08-01T00:${minute}:00.000Z`,
    zoneId: ZONE,
    zoneName: "sitebehavior.org"
  };
}

function providerDnsRecord(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
    priority: record.priority,
    comment: record.comment,
    comment_modified_on: record.commentModifiedOn,
    ...(record.data === null ? {} : { data: structuredClone(record.data) }),
    meta: structuredClone(record.meta),
    proxiable: record.proxiable,
    tags: [...record.tags],
    settings: structuredClone(record.settings),
    tags_modified_on: record.tagsModifiedOn,
    created_on: record.createdOn,
    modified_on: record.modifiedOn,
    zone_id: record.zoneId,
    zone_name: record.zoneName
  };
}

function normalizedInactiveContainerDurableObjects(entries) {
  return entries.map((entry) => ({
    assignedAt: entry.assigned_at,
    id: entry.id,
    name: entry.name ?? null
  })).sort((left, right) => compareStagingTeardownCodeUnits(left.id, right.id));
}

function containerRolloutFixture({ id, applicationId, index }) {
  const timestamp = `2026-08-01T00:${String(index % 60).padStart(2, "0")}:40.000Z`;
  return {
    description: `Completed staging rollout ${index}`,
    id,
    created_at: timestamp,
    last_updated_at: timestamp,
    kind: "full_auto",
    strategy: "rolling",
    current_version: 1,
    target_version: 1,
    current_configuration: { image: `reviewed-current-${applicationId}` },
    target_configuration: { image: `reviewed-target-${applicationId}` },
    status: "completed",
    health: {
      instances: { active: 0, healthy: 0, failed: 0, starting: 0, scheduling: 0 }
    },
    steps: [{
      id: 1,
      step_size: { percentage: 100 },
      description: "Complete the reviewed rollout",
      status: "completed",
      started_at: timestamp,
      completed_at: timestamp
    }],
    progress: { total_steps: 1, current_step: 1, updated_instances: 0, total_instances: 0 }
  };
}

function containerFixtureFacts({ applicationId, applicationName, namespaceId, index }) {
  const resolvedImageDigest = `sha256:${String(index + 3).repeat(64)}`;
  const application = {
    id: applicationId,
    name: applicationName,
    created_at: `2026-08-01T00:0${index}:00.000Z`,
    account_id: ACCOUNT,
    version: 1,
    configuration: {
      image: `registry.cloudflare.com/${ACCOUNT}/${applicationName}@${resolvedImageDigest}`,
      instance_type: "lite",
      observability: { logs: { enabled: false } }
    },
    max_instances: 1,
    instances: 0,
    constraints: { tier: 1 },
    affinities: {},
    scheduling_policy: "default",
    rollout_active_grace_period: 0,
    durable_objects: { namespace_id: namespaceId }
  };
  const deployments = [{
    id: `container-deployment-${index}`,
    created_at: `2026-08-01T00:0${index}:30.000Z`,
    account_id: ACCOUNT,
    version: 0,
    type: "default",
    image: application.configuration.image,
    location: { name: "staging-west", enabled: true, region: "us-west" },
    placements_ref: `/deployments/container-deployment-${index}/placements`,
    vcpu: 0.25,
    memory: "256 MiB",
    memory_mib: 256,
    node_group: "cloudchamber",
    network: { mode: "private" },
    app_id: applicationId,
    app_version: 1
  }];
  const rollouts = [containerRolloutFixture({
    id: `container-rollout-${index}`,
    applicationId,
    index
  })];
  const inactiveDurableObjects = [{
    id: `container-durable-object-${index}`,
    assigned_at: `2026-08-01T00:0${index}:50.000Z`,
    name: `completed-replay-${index}`
  }];
  return {
    resolvedImageDigest,
    application,
    deployments,
    rollouts,
    inactiveDurableObjects,
    applicationSha256: sha256Bytes(serializeCanonicalEvidence({ ...application, jobs: false })),
    deploymentsSha256: sha256Bytes(serializeCanonicalEvidence(deployments)),
    rolloutsSha256: sha256Bytes(serializeCanonicalEvidence(rollouts)),
    inactiveDurableObjectsSha256: sha256Bytes(
      serializeCanonicalEvidence(normalizedInactiveContainerDurableObjects(inactiveDurableObjects))
    )
  };
}

function fixtureWorkerBindings(worker, index) {
  return [
    {
      type: "durable_object_namespace",
      name: worker.durableObjectBindingName,
      class_name: worker.durableObjectClassName,
      namespace_id: worker.durableObjectNamespaceId,
      script_name: worker.scriptName
    },
    ...(index === 0
      ? [
          {
            type: "plain_text",
            name: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS",
            text: "1"
          },
          {
            type: "secret_text",
            name: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"
          }
        ]
      : [])
  ];
}

function fixtureWorkerVersionSettings(worker, index) {
  return {
    bindings: fixtureWorkerBindings(worker, index),
    cache_options: { enabled: false, cross_version_cache: false },
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    limits: { cpu_ms: 30_000, subrequests: 50 },
    placement: { mode: "smart" },
    usage_model: "standard"
  };
}

function fixtureWorkerScriptSettings(index) {
  return {
    logpush: false,
    observability: { enabled: false },
    tags: [`durable-replay-staging-${index}`],
    tail_consumers: []
  };
}

function fixtureWorkerVersions(worker, index) {
  const latestEtag = (index === 0 ? "e" : "f").repeat(64);
  const priorEtag = (index === 0 ? "8" : "9").repeat(64);
  return [
    {
      id: `version-${index}-2`,
      number: 2,
      metadata: {
        created_on: `2026-08-01T00:0${index}:00.000Z`,
        modified_on: `2026-08-01T00:0${index}:00.000Z`,
        source: "wrangler"
      },
      resources: {
        bindings: fixtureWorkerBindings(worker, index),
        script: {
          etag: latestEtag,
          handlers: ["fetch"],
          last_deployed_from: "wrangler",
          named_handlers: [{ name: "ScannerContainer", handlers: [] }]
        },
        script_runtime: {
          compatibility_date: "2025-04-01",
          compatibility_flags: ["nodejs_compat"],
          placement: { mode: "smart" },
          usage_model: "standard"
        }
      }
    },
    {
      id: `version-${index}-1`,
      number: 1,
      metadata: {
        created_on: `2026-07-31T00:0${index}:00.000Z`,
        modified_on: `2026-07-31T00:0${index}:00.000Z`,
        source: "wrangler"
      },
      resources: {
        bindings: fixtureWorkerBindings(worker, index),
        script: {
          etag: priorEtag,
          handlers: ["fetch"],
          last_deployed_from: "wrangler",
          named_handlers: [{ name: "ScannerContainer", handlers: [] }]
        },
        script_runtime: {
          compatibility_date: "2025-04-01",
          compatibility_flags: ["nodejs_compat"],
          placement: { mode: "smart" },
          usage_model: "standard"
        }
      }
    }
  ];
}

function fixtureWorkerDeployments(index) {
  return {
    deployments: [{
      id: `deployment-${index}`,
      created_on: `2026-08-01T00:0${index}:30.000Z`,
      source: "wrangler",
      strategy: "percentage",
      versions: [
        { version_id: `version-${index}-2`, percentage: 75 },
        { version_id: `version-${index}-1`, percentage: 25 }
      ],
      annotations: { "workers/triggered_by": "wrangler" }
    }]
  };
}

function fixtureNormalizedBindings(bindings) {
  return structuredClone(bindings).map((binding) =>
    binding.type === "secret_text" || binding.type === "secret_key"
      ? { name: binding.name, type: binding.type }
      : binding
  ).sort((left, right) => compareStagingTeardownCodeUnits(
    serializeCanonicalEvidence(left),
    serializeCanonicalEvidence(right)
  ));
}

function fixtureNormalizedVersionSettings(worker, index) {
  const settings = fixtureWorkerVersionSettings(worker, index);
  return {
    ...settings,
    bindings: fixtureNormalizedBindings(settings.bindings)
  };
}

function fixtureNormalizedVersionResources(resources) {
  return {
    ...structuredClone(resources),
    bindings: fixtureNormalizedBindings(resources.bindings ?? [])
  };
}

function fixtureWorkerProjection(worker, index) {
  const versions = fixtureWorkerVersions(worker, index);
  return {
    createdOn: `2026-07-31T00:0${index}:00.000Z`,
    modifiedOn: `2026-08-01T00:0${index}:00.000Z`,
    latestScriptEtag: (index === 0 ? "a" : "b").repeat(32),
    versionSettingsSha256: sha256Bytes(serializeCanonicalEvidence(
      fixtureNormalizedVersionSettings(worker, index)
    )),
    scriptSettingsSha256: sha256Bytes(serializeCanonicalEvidence(
      fixtureWorkerScriptSettings(index)
    )),
    deploymentsSha256: sha256Bytes(serializeCanonicalEvidence(
      fixtureWorkerDeployments(index)
    )),
    stoppedBuildsSha256: sha256Bytes(serializeCanonicalEvidence([])),
    versionState: versions.map((version) => ({
      id: version.id,
      number: version.number,
      metadataSha256: sha256Bytes(serializeCanonicalEvidence(version.metadata)),
      resourcesSha256: sha256Bytes(serializeCanonicalEvidence(
        fixtureNormalizedVersionResources(version.resources)
      )),
      scriptEtag: version.resources.script.etag
    })),
    secretNames: index === 0
      ? ["SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"]
      : []
  };
}

function markWorkerTargetAbsent(worker) {
  worker.expectedPresent = false;
  worker.workerId = null;
  worker.durableObjectNamespaceId = null;
  worker.createdOn = null;
  worker.modifiedOn = null;
  worker.latestScriptEtag = null;
  worker.versionSettingsSha256 = null;
  worker.scriptSettingsSha256 = null;
  worker.deploymentsSha256 = null;
  worker.stoppedBuildsSha256 = null;
  worker.versionState = [];
  worker.secretNames = [];
}

function targetManifest() {
  const workers = [
    {
      logicalName: "site-behavior-lab-scanner-staging",
      scriptName: "site-behavior-lab-scanner-staging",
      workerId: "worker-scanner-id",
      expectedPresent: true,
      durableObjectBindingName: "SCANNER",
      durableObjectClassName: "ScannerContainer",
      durableObjectNamespaceId: "do-scanner",
      containerApplicationName: "site-behavior-lab-scanner-staging-container"
    },
    {
      logicalName: "site-behavior-lab-watch-staging",
      scriptName: "site-behavior-lab-watch-staging",
      workerId: "worker-watch-id",
      expectedPresent: true,
      durableObjectBindingName: "SCANNER",
      durableObjectClassName: "ScannerContainer",
      durableObjectNamespaceId: "do-watch",
      containerApplicationName: "site-behavior-lab-watch-staging-container"
    }
  ];
  workers.forEach((worker, index) => Object.assign(
    worker,
    fixtureWorkerProjection(worker, index)
  ));
  return {
    schemaVersion: 1,
    artifactKind: STAGING_TEARDOWN_TARGET_MANIFEST_KIND,
    stagingSourceCommit: COMMIT,
    cloudflare: {
      accountId: ACCOUNT,
      zoneId: ZONE,
      workers,
      dns: [
        {
          logicalName: "scan-staging.sitebehavior.org",
          hostname: "scan-staging.sitebehavior.org",
          workerName: "site-behavior-lab-scanner-staging",
          expectedPresent: true,
          workerDomainExpectedPresent: true,
          workerDomainId: "domain-scanner",
          workerDomainCertId: "domain-cert-scanner",
          dnsRecords: [stagingDnsRecord({
            id: "dns-scanner",
            name: "scan-staging.sitebehavior.org",
            content: "site-behavior-lab-scanner-staging.workers.dev",
            minute: "00"
          })],
          certificatePackId: "cert-pack-scanner",
          certificateHosts: ["scan-staging.sitebehavior.org"],
          certificatePack: projectStagingTeardownCertificatePack(certificatePackFixture({
            id: "cert-pack-scanner",
            hostname: "scan-staging.sitebehavior.org",
            certificateId: "domain-cert-scanner"
          }), "scanner fixture certificate pack"),
          certificatePackSha256: certificatePackSha256(certificatePackFixture({
            id: "cert-pack-scanner",
            hostname: "scan-staging.sitebehavior.org",
            certificateId: "domain-cert-scanner"
          }))
        },
        {
          logicalName: "scan-watch-staging.sitebehavior.org",
          hostname: "scan-watch-staging.sitebehavior.org",
          workerName: "site-behavior-lab-watch-staging",
          expectedPresent: true,
          workerDomainExpectedPresent: true,
          workerDomainId: "domain-watch",
          workerDomainCertId: "domain-cert-watch",
          dnsRecords: [stagingDnsRecord({
            id: "dns-watch",
            name: "scan-watch-staging.sitebehavior.org",
            content: "site-behavior-lab-watch-staging.workers.dev",
            minute: "01"
          })],
          certificatePackId: "cert-pack-watch",
          certificateHosts: ["scan-watch-staging.sitebehavior.org"],
          certificatePack: projectStagingTeardownCertificatePack(certificatePackFixture({
            id: "cert-pack-watch",
            hostname: "scan-watch-staging.sitebehavior.org",
            certificateId: "domain-cert-watch"
          }), "watch fixture certificate pack"),
          certificatePackSha256: certificatePackSha256(certificatePackFixture({
            id: "cert-pack-watch",
            hostname: "scan-watch-staging.sitebehavior.org",
            certificateId: "domain-cert-watch"
          }))
        }
      ],
      containers: [
        (() => {
          const fixture = containerFixtureFacts({
            applicationId: "container-scanner",
            applicationName: "site-behavior-lab-scanner-staging-container",
            namespaceId: "do-scanner",
            index: 0
          });
          return {
          logicalName: "site-behavior-lab-scanner-staging-container",
          applicationName: "site-behavior-lab-scanner-staging-container",
          applicationId: "container-scanner",
          workerName: "site-behavior-lab-scanner-staging",
          durableObjectNamespaceId: "do-scanner",
          expectedPresent: true,
          resolvedImageDigest: fixture.resolvedImageDigest,
          applicationSha256: fixture.applicationSha256,
          deploymentsSha256: fixture.deploymentsSha256,
          rolloutsSha256: fixture.rolloutsSha256,
          inactiveDurableObjectsSha256: fixture.inactiveDurableObjectsSha256
          };
        })(),
        (() => {
          const fixture = containerFixtureFacts({
            applicationId: "container-watch",
            applicationName: "site-behavior-lab-watch-staging-container",
            namespaceId: "do-watch",
            index: 1
          });
          return {
          logicalName: "site-behavior-lab-watch-staging-container",
          applicationName: "site-behavior-lab-watch-staging-container",
          applicationId: "container-watch",
          workerName: "site-behavior-lab-watch-staging",
          durableObjectNamespaceId: "do-watch",
          expectedPresent: true,
          resolvedImageDigest: fixture.resolvedImageDigest,
          applicationSha256: fixture.applicationSha256,
          deploymentsSha256: fixture.deploymentsSha256,
          rolloutsSha256: fixture.rolloutsSha256,
          inactiveDurableObjectsSha256: fixture.inactiveDurableObjectsSha256
          };
        })()
      ],
      buckets: [
        {
          logicalName: "site-behavior-lab-reports-staging",
          bucketName: "site-behavior-lab-reports-staging",
          expectedPresent: true,
          expectedCreationDate: "2026-08-01T00:00:00.000Z",
          expectedJurisdiction: "default",
          expectedLocation: "enam",
          expectedStorageClass: "Standard",
          expectedLifecycleRules: stagingLifecycleRules(),
          managedDomainBucketId: "reports-staging-bucket-id",
          managedDomainDomain: "reports-staging.r2.dev",
          objects: [
            stagingObject("reports/a b%.json", 1),
            stagingObject("reports/資料?#.json", 2)
          ].sort((left, right) => compareStagingTeardownCodeUnits(left.key, right.key))
        },
        {
          logicalName: "site-behavior-lab-reports-watch-staging",
          bucketName: "site-behavior-lab-reports-watch-staging",
          expectedPresent: true,
          expectedCreationDate: "2026-08-01T00:01:00.000Z",
          expectedJurisdiction: "default",
          expectedLocation: "enam",
          expectedStorageClass: "Standard",
          expectedLifecycleRules: stagingLifecycleRules(),
          managedDomainBucketId: "reports-watch-staging-bucket-id",
          managedDomainDomain: "reports-watch-staging.r2.dev",
          objects: [stagingObject("reports/%2e%2e/literal?#", 3)]
        }
      ],
      credentialSets: [
        credential(
          "durable-replay-staging-only-authority",
          "site-behavior-lab-reports-staging",
          "1".repeat(32),
          "scanner"
        ),
        credential(
          "encrypted-watch-staging-only-authority",
          "site-behavior-lab-reports-watch-staging",
          "2".repeat(32),
          "watch"
        )
      ],
      faultHook: {
        logicalName: "durable-replay-staging-fault-hook",
        workerName: "site-behavior-lab-scanner-staging",
        expectedPresent: true,
        activationBindingName: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS",
        secretBindingName: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"
      }
    },
    github: {
      repository: "iAnonymous3000/site-behavior-lab",
      runner: {
        logicalName: "durable-replay-staging-runner-registration",
        expectedPresent: true,
        id: 42,
        name: "site-behavior-lab-durable-replay-staging",
        labels: ["Linux", "X64", "durable-replay-staging", "self-hosted"]
      }
    }
  };
}

function exactCredentials() {
  return {
    cloudflareComputeToken: TOKENS.compute,
    cloudflareDnsToken: TOKENS.dns,
    cloudflareR2Token: TOKENS.r2,
    cloudflareTokenAdminToken: TOKENS.admin,
    cloudflareObservationToken: TOKENS.observation,
    githubRunnerAdminToken: TOKENS.github
  };
}

function exactCaptureCredentials() {
  return {
    cloudflareComputeReadToken: TOKENS.compute,
    cloudflareDnsReadToken: TOKENS.dns,
    cloudflareR2ReadToken: TOKENS.r2,
    cloudflareTokenReadToken: TOKENS.admin,
    cloudflareObservationReadToken: TOKENS.observation,
    githubRunnerReadToken: TOKENS.github
  };
}

async function captureFixtureTarget(target = targetManifest(), provider = fixtureProvider(target)) {
  const rawNames = [];
  const captured = await captureStagingTeardownTargetManifest({
    stagingSourceCommit: COMMIT,
    accountId: ACCOUNT,
    zoneId: ZONE,
    credentials: exactCaptureCredentials(),
    fetchImpl: provider.fetch,
    persistRaw: async (name, bytes) => {
      assert.ok(bytes instanceof Uint8Array && bytes.byteLength >= 1);
      rawNames.push(name);
    },
    cloudflareApiBaseUrl: "https://api.cloudflare.test",
    githubApiBaseUrl: "https://api.github.test"
  });
  return { captured, provider, rawNames };
}

test("GET-only capture reproduces the exact canonical target across every paginated provider surface", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.additionalAccountTokens.push({
    id: "e".repeat(32),
    name: "Unrelated Capture Token With Spaces",
    policies: [],
    status: "active"
  });
  provider.state.durableObjects.set("unrelated-namespace", {
    id: "unrelated-namespace",
    script: "unrelated-worker",
    class: "Unrelated$UnicodeClass"
  });
  const { captured, rawNames } = await captureFixtureTarget(target, provider);
  assert.deepEqual(captured.manifest, target);
  assert.ok(rawNames.length > 30);
  rawNames.forEach((name, index) => {
    assert.match(name, new RegExp(`^${String(index + 1).padStart(3, "0")}\\.`));
  });
  assert.ok(provider.calls.every((call) => call.method === "GET"));
  assert.ok(provider.calls.some((call) =>
    new URL(call.url).hostname === "api.github.test" &&
      new URL(call.url).searchParams.get("page") === "2"
  ));
  assert.ok(provider.calls.some((call) =>
    new URL(call.url).searchParams.get("page_token") === "second-page"
  ));
  assert.ok(provider.calls.some((call) =>
    new URL(call.url).searchParams.has("cursor")
  ));
  assert.ok(provider.calls.some((call) =>
    new URL(call.url).pathname.endsWith("/tokens") &&
      new URL(call.url).searchParams.get("include_expired") === "true"
  ));
  const r2BucketCalls = provider.calls.filter((call) =>
    new URL(call.url).pathname.includes("/r2/buckets")
  );
  assert.ok(r2BucketCalls.length >= 1);
  const jurisdictionListCalls = r2BucketCalls.filter((call) =>
    new URL(call.url).pathname.endsWith("/r2/buckets")
  );
  assert.deepEqual(
    jurisdictionListCalls.map((call) => call.headers["cf-r2-jurisdiction"]).sort(),
    ["default", "eu", "fedramp"]
  );
  assert.ok(r2BucketCalls.every((call) =>
    new URL(call.url).pathname.endsWith("/r2/buckets") ||
      call.headers["cf-r2-jurisdiction"] === "default"
  ));
  assert.match(captured.manifest.cloudflare.workers[0].stoppedBuildsSha256, /^[0-9a-f]{64}$/);
  assert.match(
    captured.manifest.cloudflare.containers[0].inactiveDurableObjectsSha256,
    /^[0-9a-f]{64}$/
  );
});

test("target capture refuses wrong identities, present jobs config, and unknown instance shapes", async () => {
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.domains.values().next().value.zone_id = "0".repeat(32);
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /wrong zone or service identity/
    );
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.durableObjects.set("ambiguous-orphan-namespace", {
      id: "ambiguous-orphan-namespace",
      class: target.cloudflare.workers[0].durableObjectClassName
    });
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /Durable Object namespace inventory.*\.script/
    );
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.domains.set("malformed-unrelated-domain", {
      id: "malformed-unrelated-domain",
      cert_id: "malformed-unrelated-certificate",
      service: "unrelated-worker",
      zone_id: ZONE,
      zone_name: "sitebehavior.org"
    });
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /Worker domain .*\.hostname/
    );
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.domains.values().next().value.environment = null;
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /Worker domain .*\.environment/
    );
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.containers.values().next().value.jobs = true;
    await assert.rejects(captureFixtureTarget(target, provider), /jobs must be absent or false/);
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.containerInstances.values().next().value.durableObjects[0].unknown = true;
    await assert.rejects(captureFixtureTarget(target, provider), /unsupported provider field/);
  }
});

test("target capture inherits the bounded response ceiling and never follows with mutation", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  let calls = 0;
  await assert.rejects(
    captureStagingTeardownTargetManifest({
      stagingSourceCommit: COMMIT,
      accountId: ACCOUNT,
      zoneId: ZONE,
      credentials: exactCaptureCredentials(),
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(init.method, "GET");
        if (calls === 1) {
          return new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String((1024 * 1024) + 1)
            }
          });
        }
        return provider.fetch(input, init);
      },
      persistRaw: async () => undefined,
      cloudflareApiBaseUrl: "https://api.cloudflare.test",
      githubApiBaseUrl: "https://api.github.test"
    }),
    /1048576-byte response limit/
  );
  assert.equal(calls, 1);
});

test("target capture request ceilings exactly cover every bounded endpoint and fit one App-token hour", () => {
  assert.deepEqual(STAGING_TEARDOWN_TARGET_CAPTURE_REQUEST_LIMITS, {
    cloudflareCompute: 33,
    cloudflareDns: 8,
    cloudflareR2: 22,
    cloudflareToken: 12,
    cloudflareObservation: 75,
    githubRunner: 10
  });
  assert.equal(
    STAGING_TEARDOWN_TARGET_CAPTURE_MAX_PROVIDER_MILLISECONDS,
    160 * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS
  );
  assert.ok(STAGING_TEARDOWN_TARGET_CAPTURE_MAX_PROVIDER_MILLISECONDS < 60 * 60_000);
});

test("duplicate exact-host certificate packs refuse before any detail request", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const dnsTarget = target.cloudflare.dns[0];
  provider.state.certificates.set("duplicate-pack-scanner", {
    id: "duplicate-pack-scanner",
    type: "advanced",
    hosts: [dnsTarget.hostname],
    certificates: [{
      id: "duplicate-cert-scanner",
      hosts: [dnsTarget.hostname],
      status: "active"
    }],
    status: "active",
    pollsRemaining: 0
  });
  await assert.rejects(
    captureFixtureTarget(target, provider),
    /more than one live dedicated Advanced Certificate pack/
  );
  assert.equal(
    provider.calls.filter((call) =>
      /\/certificate_packs\/[^/]+$/.test(new URL(call.url).pathname)
    ).length,
    0
  );
  const listCall = provider.calls.find((call) =>
    new URL(call.url).pathname.endsWith("/certificate_packs")
  );
  assert.equal(new URL(listCall.url).searchParams.get("per_page"), "50");
});

test("capture exposes the complete certificate pack and supports a domain-absent pending pack", async () => {
  {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const pendingPack = certificatePackFixture({
      id: dnsTarget.certificatePackId,
      hostname: dnsTarget.hostname,
      certificateId: null,
      status: "pending_validation"
    });
    dnsTarget.workerDomainExpectedPresent = false;
    dnsTarget.workerDomainId = null;
    dnsTarget.workerDomainCertId = null;
    dnsTarget.certificatePack = projectStagingTeardownCertificatePack(
      pendingPack,
      "pending recovery fixture certificate pack"
    );
    dnsTarget.certificatePackSha256 = certificatePackSha256(pendingPack);
    const provider = fixtureProvider(target);
    provider.state.certificates.set(dnsTarget.certificatePackId, {
      ...structuredClone(pendingPack),
      pollsRemaining: 0
    });
    const { captured } = await captureFixtureTarget(target, provider);
    assert.deepEqual(captured.manifest, target);
    assert.equal(captured.manifest.cloudflare.dns[0].workerDomainCertId, null);
    assert.deepEqual(captured.manifest.cloudflare.dns[0].certificatePack.certificates, []);
  }
  {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const completePack = certificatePackFixture({
      id: dnsTarget.certificatePackId,
      hostname: dnsTarget.hostname,
      certificateId: dnsTarget.workerDomainCertId,
      certificates: [
        { id: dnsTarget.workerDomainCertId, hosts: [dnsTarget.hostname], status: "active" },
        { id: "same-host-renewal-certificate", hosts: [dnsTarget.hostname], status: "pending_issuance" }
      ]
    });
    dnsTarget.certificatePack = projectStagingTeardownCertificatePack(
      completePack,
      "complete multi-child fixture certificate pack"
    );
    dnsTarget.certificatePackSha256 = certificatePackSha256(completePack);
    const provider = fixtureProvider(target);
    provider.state.certificates.set(dnsTarget.certificatePackId, {
      ...structuredClone(completePack),
      pollsRemaining: 0
    });
    const { captured } = await captureFixtureTarget(target, provider);
    assert.deepEqual(captured.manifest, target);
    assert.equal(captured.manifest.cloudflare.dns[0].certificatePack.certificates.length, 2);
  }
  {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const provider = fixtureProvider(target);
    provider.state.certificates.get(dnsTarget.certificatePackId).certificates.push({
      id: "off-host-certificate",
      hosts: ["production.sitebehavior.org"],
      status: "active"
    });
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /off-target certificate/
    );
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
});

test("capture accepts omitted R2 bucket defaults and refuses an undocumented object wrapper", async () => {
  {
    const target = targetManifest();
    for (const bucket of target.cloudflare.buckets) bucket.expectedLocation = null;
    const provider = fixtureProvider(target);
    for (const bucket of provider.state.buckets.values()) {
      delete bucket.jurisdiction;
      delete bucket.location;
      delete bucket.storage_class;
    }
    const { captured } = await captureFixtureTarget(target, provider);
    assert.deepEqual(captured.manifest, target);
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const bucketTarget = target.cloudflare.buckets[0];
    provider.state.nonDefaultBuckets.eu.push({
      name: bucketTarget.bucketName,
      creation_date: bucketTarget.expectedCreationDate,
      location: bucketTarget.expectedLocation,
      storage_class: bucketTarget.expectedStorageClass
    });
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /same-name bucket outside the default R2 jurisdiction/
    );
    assert.ok(provider.calls.every((call) => call.method === "GET"));
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    await assert.rejects(
      captureStagingTeardownTargetManifest({
        stagingSourceCommit: COMMIT,
        accountId: ACCOUNT,
        zoneId: ZONE,
        credentials: exactCaptureCredentials(),
        fetchImpl: async (input, init) => {
          const url = input instanceof URL ? input : new URL(input);
          const response = await provider.fetch(input, init);
          if (!/\/r2\/buckets\/[^/]+\/objects$/.test(url.pathname)) return response;
          const body = await fixtureResponseJson(response);
          body.result = { objects: body.result };
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" }
          });
        },
        persistRaw: async () => undefined,
        cloudflareApiBaseUrl: "https://api.cloudflare.test",
        githubApiBaseUrl: "https://api.github.test"
      }),
      /R2 object inventory.*unsupported provider shape/
    );
  }
});

test("capture refuses incomplete container application and instance pagination", async () => {
  for (const nextPageToken of [undefined, "", null]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    await assert.rejects(
      captureStagingTeardownTargetManifest({
        stagingSourceCommit: COMMIT,
        accountId: ACCOUNT,
        zoneId: ZONE,
        credentials: exactCaptureCredentials(),
        fetchImpl: async (input, init) => {
          const url = input instanceof URL ? input : new URL(input);
          const response = await provider.fetch(input, init);
          if (!url.pathname.endsWith("/containers/dash/applications") ||
              url.searchParams.has("page_token")) return response;
          const body = await fixtureResponseJson(response);
          if (nextPageToken === undefined) delete body.result_info;
          else body.result_info.next_page_token = nextPageToken;
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" }
          });
        },
        persistRaw: async () => undefined,
        cloudflareApiBaseUrl: "https://api.cloudflare.test",
        githubApiBaseUrl: "https://api.github.test"
      }),
      /container application pagination|full container application page/
    );
  }

  const target = targetManifest();
  const provider = fixtureProvider(target);
  const container = target.cloudflare.containers[0];
  provider.state.containerInstances.get(container.applicationId).durableObjects =
    Array.from({ length: 100 }, (_, index) => ({
      id: `inactive-terminal-${String(index).padStart(3, "0")}`,
      assigned_at: "2026-08-01T00:00:50.000Z",
      name: `inactive-terminal-${index}`
    }));
  await assert.rejects(
    captureFixtureTarget(target, provider),
    /full container instance page omitted a continuation token/
  );
});

test("capture derives account-token pages without total_pages and refuses malformed or truncated pages", async () => {
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.credentials.values().next().value.status = "expired";
    const { captured } = await captureFixtureTarget(target, provider);
    assert.equal(captured.manifest.cloudflare.credentialSets[0].expectedPresent, true);
  }
  for (const mutation of [
    (body) => { body.result_info.count += 1; },
    (body) => { body.result_info.total_count = 51; }
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    await assert.rejects(
      captureStagingTeardownTargetManifest({
        stagingSourceCommit: COMMIT,
        accountId: ACCOUNT,
        zoneId: ZONE,
        credentials: exactCaptureCredentials(),
        fetchImpl: async (input, init) => {
          const url = input instanceof URL ? input : new URL(input);
          const response = await provider.fetch(input, init);
          if (!url.pathname.endsWith("/tokens")) return response;
          const body = await fixtureResponseJson(response);
          mutation(body);
          return new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" }
          });
        },
        persistRaw: async () => undefined,
        cloudflareApiBaseUrl: "https://api.cloudflare.test",
        githubApiBaseUrl: "https://api.github.test"
      }),
      /pagination|page is incomplete/
    );
  }
});

test("capture uses the raw provider-final rollout cursor and refuses progressing rollouts", async () => {
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const applicationId = target.cloudflare.containers[0].applicationId;
    const rollouts = [
      containerRolloutFixture({ id: "z-rollout-first", applicationId, index: 0 }),
      ...Array.from({ length: 99 }, (_, index) => containerRolloutFixture({
        id: `rollout-${String(index + 1).padStart(3, "0")}`,
        applicationId,
        index: index + 1
      })),
      containerRolloutFixture({ id: "rollout-tail", applicationId, index: 100 })
    ];
    provider.state.containerRollouts.set(applicationId, rollouts);
    await captureFixtureTarget(target, provider);
    const secondPage = provider.calls.find((call) => {
      const url = new URL(call.url);
      return url.pathname.endsWith(`/${applicationId}/rollouts`) &&
        url.searchParams.has("last");
    });
    assert.equal(new URL(secondPage.url).searchParams.get("last"), "rollout-099");
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    provider.state.containerRollouts.values().next().value[0].status = "progressing";
    await assert.rejects(captureFixtureTarget(target, provider), /terminal container rollout/);
  }
});

test("capture refuses Worker Build drift and non-NFC nested provider metadata", async () => {
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const workerId = target.cloudflare.workers[0].workerId;
    let matchingBuildReads = 0;
    await assert.rejects(
      captureStagingTeardownTargetManifest({
        stagingSourceCommit: COMMIT,
        accountId: ACCOUNT,
        zoneId: ZONE,
        credentials: exactCaptureCredentials(),
        fetchImpl: async (input, init) => {
          const url = input instanceof URL ? input : new URL(input);
          if (url.pathname.endsWith(`/builds/workers/${workerId}/builds`)) {
            matchingBuildReads += 1;
            if (matchingBuildReads === 2) {
              provider.state.workerBuildExecutions.set(workerId, [{
                build_uuid: "123e4567-e89b-42d3-a456-426614174111",
                build_outcome: "success",
                status: "stopped"
              }]);
            }
          }
          return provider.fetch(input, init);
        },
        persistRaw: async () => undefined,
        cloudflareApiBaseUrl: "https://api.cloudflare.test",
        githubApiBaseUrl: "https://api.github.test"
      }),
      /Worker Builds changed while sealing/
    );
  }
  {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const firstBucket = provider.state.buckets.values().next().value;
    firstBucket.objects.values().next().value.custom_metadata = {
      "é": "first",
      "e\u0301": "second"
    };
    await assert.rejects(
      captureFixtureTarget(target, provider),
      /bounded canonical JSON|NFC|bounded, strict UTF-8 JSON/
    );
  }
});

test("R2 object-key encoding preserves slashes, encodes reserved/Unicode bytes, and refuses dot traversal", () => {
  assert.equal(
    encodeCloudflareR2ObjectKeyPath("reports/a b%?#.json"),
    "reports/a%20b%25%3F%23.json"
  );
  assert.equal(
    encodeCloudflareR2ObjectKeyPath("資料/é!()*'.json"),
    "%E8%B3%87%E6%96%99/%C3%A9%21%28%29%2A%27.json"
  );
  assert.equal(
    encodeCloudflareR2ObjectKeyPath("reports/%2e%2e/literal"),
    "reports/%252e%252e/literal"
  );
  for (const key of ["../x", "a/./b", "a/../../b"]) {
    assert.throws(
      () => encodeCloudflareR2ObjectKeyPath(key),
      /must not contain traversal-like dot path segments/
    );
  }
});

test("target projection ordering uses deterministic code units for non-ASCII R2 keys", () => {
  assert.equal(
    sha256Bytes(serializeCanonicalEvidence("reports/e\u0301.json")),
    sha256Bytes(serializeCanonicalEvidence("reports/é.json")),
    "canon-v1 intentionally normalizes strings, so exact teardown admission must refuse NFD"
  );
  assert.throws(
    () => projectStagingTeardownR2Object({
      key: "reports/e\u0301.json",
      etag: "etag",
      size: 1,
      last_modified: "2026-08-01T00:00:00.000Z",
      ssec: false,
      storage_class: "Standard",
      custom_metadata: {},
      http_metadata: {}
    }),
    /R2 object key must already be NFC/
  );
  const objects = ["reports/é.json", "reports/資料.json", "reports/z.json", "reports/ä.json"]
    .map((key, index) => projectStagingTeardownR2Object({
      key,
      etag: `etag-${index}`,
      size: index + 1,
      last_modified: `2026-08-01T00:00:0${index}.000Z`,
      ssec: false,
      storage_class: "Standard",
      custom_metadata: {},
      http_metadata: {}
    }))
    .sort((left, right) => compareStagingTeardownCodeUnits(left.key, right.key));
  assert.deepEqual(
    objects.map((object) => object.key),
    ["reports/z.json", "reports/ä.json", "reports/é.json", "reports/資料.json"]
  );
  assert.equal(
    stagingTeardownProjectionSha256(objects),
    "09a3f027c2ba6db62b48fbed3229ee7de82e81653d532fce64a20173e522cd7a"
  );
});

test("target manifests reject duplicate keys, excessive depth, Unicode byte overflow, and production policy", () => {
  const valid = targetManifest();
  assert.equal(validateStagingTeardownTargetManifest(valid, COMMIT), valid);

  const wire = JSON.stringify(valid);
  assert.throws(
    () => parseStagingTeardownTargetManifest(
      wire.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1'),
      COMMIT
    ),
    /bounded strict JSON without duplicate keys/
  );

  const decomposedR2Key = targetManifest();
  decomposedR2Key.cloudflare.buckets[0].objects[1].key = "reports/e\u0301.json";
  assert.throws(
    () => validateStagingTeardownTargetManifest(decomposedR2Key, COMMIT),
    /must already be NFC/
  );
  assert.throws(
    () => parseStagingTeardownTargetManifest(`${"[".repeat(129)}0${"]".repeat(129)}`, COMMIT),
    /bounded strict JSON without duplicate keys/
  );
  assert.throws(
    () => parseStagingTeardownTargetManifest(`"${"é".repeat(300_000)}"`, COMMIT),
    /2 through 49152 UTF-8 bytes/
  );

  const production = structuredClone(valid);
  production.cloudflare.credentialSets[0].expectedPolicies[0].resources = {
    [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_site-behavior-lab-reports`]: "*"
  };
  production.cloudflare.credentialSets[0].expectedPolicySha256 = sha256Bytes(
    serializeCanonicalEvidence(production.cloudflare.credentialSets[0].expectedPolicies)
  );
  assert.throws(
    () => validateStagingTeardownTargetManifest(production, COMMIT),
    /must select only the exact default-jurisdiction staging bucket/
  );

  const wildcard = structuredClone(valid);
  wildcard.cloudflare.credentialSets[0].expectedPolicies[0].resources[
    `com.cloudflare.api.account.${ACCOUNT}`
  ] = "*";
  wildcard.cloudflare.credentialSets[0].expectedPolicySha256 = sha256Bytes(
    serializeCanonicalEvidence(wildcard.cloudflare.credentialSets[0].expectedPolicies)
  );
  assert.throws(
    () => validateStagingTeardownTargetManifest(wildcard, COMMIT),
    /must select only the exact default-jurisdiction staging bucket/
  );

  const secretOverflow = structuredClone(valid);
  secretOverflow.cloudflare.buckets[0].objects = Array.from(
    { length: 180 },
    (_, index) => stagingObject(
      `reports/${String(index).padStart(3, "0")}-${"x".repeat(280)}.json`,
      index
    )
  );
  secretOverflow.cloudflare.buckets[1].objects = [];
  assert.throws(
    () => validateStagingTeardownTargetManifest(secretOverflow, COMMIT),
    /exceeds the 49152-byte GitHub Actions secret limit/
  );

  const missingGeneratedCertificate = targetManifest();
  missingGeneratedCertificate.cloudflare.dns[0].certificatePackId = null;
  missingGeneratedCertificate.cloudflare.dns[0].certificateHosts = [];
  missingGeneratedCertificate.cloudflare.dns[0].certificatePack = null;
  missingGeneratedCertificate.cloudflare.dns[0].certificatePackSha256 = null;
  assert.throws(
    () => validateStagingTeardownTargetManifest(missingGeneratedCertificate, COMMIT),
    /must pin the Advanced Certificate generated for every present Worker custom domain/
  );
});

test("protected account and zone identities must match before any provider request", () => {
  let fetched = false;
  const common = {
    targetManifest: targetManifest(),
    trustedCommit: COMMIT,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); }
  };
  assert.throws(
    () => createCompositeStagingTeardownProviderAdapter({
      ...common,
      trustedCloudflareAccountId: "0".repeat(32),
      trustedCloudflareZoneId: ZONE
    }),
    /must equal protected CLOUDFLARE_ACCOUNT_ID/
  );
  assert.throws(
    () => createCompositeStagingTeardownProviderAdapter({
      ...common,
      trustedCloudflareAccountId: ACCOUNT,
      trustedCloudflareZoneId: "0".repeat(32)
    }),
    /must equal protected STAGING_TEARDOWN_CF_ZONE_ID/
  );
  const dynamicCredentials = exactCredentials();
  delete dynamicCredentials.githubRunnerAdminToken;
  dynamicCredentials.githubRunnerAdminTokenProvider = async () => TOKENS.github;
  assert.doesNotThrow(() => createCompositeStagingTeardownProviderAdapter({
    ...common,
    credentials: dynamicCredentials,
    trustedCloudflareAccountId: ACCOUNT,
    trustedCloudflareZoneId: ZONE
  }));
  assert.throws(
    () => createCompositeStagingTeardownProviderAdapter({
      ...common,
      credentials: {
        ...exactCredentials(),
        githubRunnerAdminTokenProvider: async () => TOKENS.github
      },
      trustedCloudflareAccountId: ACCOUNT,
      trustedCloudflareZoneId: ZONE
    }),
    /exactly one GitHub runner token or token provider/
  );
  assert.equal(fetched, false);
});

test("non-NFC live provider state is refused before any destructive request", async () => {
  for (const surface of ["r2-key", "dns-settings-key", "worker-plaintext-value"]) {
    const target = targetManifest();
    if (surface === "r2-key") {
      target.cloudflare.buckets[0].objects[1].key = "reports/é.json";
    }
    const provider = fixtureProvider(target);
    let logicalName;
    if (surface === "r2-key") {
      const bucketTarget = target.cloudflare.buckets[0];
      const bucket = provider.state.buckets.get(bucketTarget.bucketName);
      const composed = bucket.objects.get("reports/é.json");
      bucket.objects.delete("reports/é.json");
      bucket.objects.set("reports/e\u0301.json", {
        ...composed,
        key: "reports/e\u0301.json"
      });
      logicalName = bucketTarget.logicalName;
    } else if (surface === "dns-settings-key") {
      const dnsTarget = target.cloudflare.dns[0];
      provider.state.dnsRecords.get(dnsTarget.dnsRecords[0].id).settings = {
        ["e\u0301"]: "changed"
      };
      logicalName = dnsTarget.logicalName;
    } else {
      const worker = target.cloudflare.workers[0];
      const binding = provider.state.workerVersionSettings.get(worker.scriptName)
        .bindings.find((entry) => entry.type === "plain_text");
      binding.text = "e\u0301";
      logicalName = worker.logicalName;
    }
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(logicalName, { phase: "before" }),
      /did not return bounded, strict UTF-8 JSON/
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${surface} must fail before mutation`
    );
  }
});

test("explicit malformed optional state and lossy wrappers refuse before mutation", async () => {
  const cases = [
    {
      name: "dns-tags-null",
      resource: "dns",
      mutate(target, state) {
        state.dnsRecords.get(target.cloudflare.dns[0].dnsRecords[0].id).tags = null;
      }
    },
    {
      name: "dns-settings-null",
      resource: "dns",
      mutate(target, state) {
        state.dnsRecords.get(target.cloudflare.dns[0].dnsRecords[0].id).settings = null;
      }
    },
    {
      name: "dns-comment-modified-null",
      resource: "dns",
      mutate(target, state) {
        state.dnsRecords.get(target.cloudflare.dns[0].dnsRecords[0].id)
          .comment_modified_on = null;
      }
    },
    {
      name: "dns-tags-modified-null",
      resource: "dns",
      mutate(target, state) {
        state.dnsRecords.get(target.cloudflare.dns[0].dnsRecords[0].id)
          .tags_modified_on = null;
      }
    },
    {
      name: "r2-custom-metadata-null",
      resource: "bucket",
      mutate(target, state) {
        state.buckets.get(target.cloudflare.buckets[0].bucketName)
          .objects.values().next().value.custom_metadata = null;
      }
    },
    {
      name: "r2-http-metadata-null",
      resource: "bucket",
      mutate(target, state) {
        state.buckets.get(target.cloudflare.buckets[0].bucketName)
          .objects.values().next().value.http_metadata = null;
      }
    },
    {
      name: "lifecycle-transitions-null",
      resource: "bucket",
      mutate(target, state) {
        state.buckets.get(target.cloudflare.buckets[0].bucketName)
          .lifecycleRules[0].storageClassTransitions = null;
      }
    },
    {
      name: "worker-settings-bindings-null",
      resource: "worker",
      mutate(target, state) {
        state.workerVersionSettings.get(target.cloudflare.workers[0].scriptName).bindings = null;
      }
    },
    {
      name: "worker-version-bindings-null",
      resource: "worker",
      mutate(target, state) {
        state.workerVersions.get(target.cloudflare.workers[0].scriptName)[0]
          .resources.bindings = null;
      }
    },
    {
      name: "worker-deployment-wrapper-sibling",
      resource: "worker",
      mutate(target, state) {
        state.workerDeployments.get(target.cloudflare.workers[0].scriptName).has_more = true;
      }
    },
    {
      name: "container-deployment-wrapper-sibling",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerDeployments.set(container.applicationId, {
          deployments: state.containerDeployments.get(container.applicationId),
          has_more: true
        });
      }
    },
    {
      name: "container-deployment-wrapper",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerDeployments.set(container.applicationId, {
          deployments: state.containerDeployments.get(container.applicationId)
        });
      }
    },
    {
      name: "container-rollout-wrapper",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerRollouts.set(container.applicationId, {
          rollouts: state.containerRollouts.get(container.applicationId)
        });
      }
    },
    {
      name: "container-deployment-missing-required-field",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        delete state.containerDeployments.get(container.applicationId)[0].placements_ref;
      }
    },
    {
      name: "container-deployment-null-optional-field",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerDeployments.get(container.applicationId)[0].current_placement = null;
      }
    },
    {
      name: "container-application-undocumented-updated-at",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containers.get(container.applicationId).updated_at =
          "2026-08-01T00:00:00.000Z";
      }
    },
    {
      name: "container-application-desired-instance",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containers.get(container.applicationId).instances = 1;
      }
    },
    {
      name: "container-application-active-rollout",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containers.get(container.applicationId).active_rollout_id = null;
      }
    },
    {
      name: "container-application-active-health",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containers.get(container.applicationId).health = {
          instances: { active: 1, healthy: 0, failed: 0, starting: 0, scheduling: 0 }
        };
      }
    },
    {
      name: "container-rollout-missing-required-field",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        delete state.containerRollouts.get(container.applicationId)[0].health;
      }
    },
    {
      name: "container-rollout-null-optional-field",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerRollouts.get(container.applicationId)[0].started_at = null;
      }
    },
    {
      name: "container-rollout-zero-step-id",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerRollouts.get(container.applicationId)[0].steps[0].id = 0;
      }
    },
    {
      name: "container-rollout-step-below-minimum",
      resource: "container",
      mutate(target, state) {
        const container = target.cloudflare.containers[0];
        state.containerRollouts.get(container.applicationId)[0]
          .steps[0].step_size.percentage = 9;
      }
    }
  ];
  for (const testCase of cases) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    testCase.mutate(target, provider.state);
    const logicalName = testCase.resource === "dns"
      ? target.cloudflare.dns[0].logicalName
      : testCase.resource === "bucket"
        ? target.cloudflare.buckets[0].logicalName
        : testCase.resource === "worker"
          ? target.cloudflare.workers[0].logicalName
          : target.cloudflare.containers[0].logicalName;
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(logicalName, { phase: "before" })
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${testCase.name} must fail before mutation`
    );
  }
});

test("runner label expansion and an over-budget R2 allowlist are refused pre-mutation", () => {
  const extraLabel = targetManifest();
  extraLabel.github.runner.labels = [
    "Linux",
    "X64",
    "durable-replay-staging",
    "extra",
    "self-hosted"
  ];
  assert.throws(
    () => validateStagingTeardownTargetManifest(extraLabel, COMMIT),
    /GitHub runner labels must be exactly/
  );

  const tooMany = targetManifest();
  tooMany.cloudflare.buckets[0].objects = Array.from(
    { length: 201 },
    (_, index) => stagingObject(`reports/${String(index).padStart(3, "0")}.json`, index)
  );
  tooMany.cloudflare.buckets[1].objects = [];
  assert.throws(
    () => validateStagingTeardownTargetManifest(tooMany, COMMIT),
    /may delete at most 180 objects across both buckets/
  );

  const tooManyDns = targetManifest();
  tooManyDns.cloudflare.dns[0].dnsRecords = Array.from({ length: 21 }, (_, index) =>
    stagingDnsRecord({
      id: `dns-${String(index).padStart(2, "0")}`,
      name: "scan-staging.sitebehavior.org",
      content: "site-behavior-lab-scanner-staging.workers.dev",
      minute: "00"
    })
  );
  tooManyDns.cloudflare.dns[1].dnsRecords = [];
  assert.throws(
    () => validateStagingTeardownTargetManifest(tooManyDns, COMMIT),
    /may delete at most 20 exact records/
  );
});

test("every provider authority reserves enough requests for its worst-case post-mutation proof", () => {
  assert.deepEqual(STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF, {
    cloudflareCompute: 202,
    cloudflareDns: 156,
    cloudflareR2: 224,
    cloudflareR2Inventory: 48,
    cloudflareR2Configuration: 61,
    cloudflareTokenAdmin: 99,
    cloudflareEmailAndRouteObservation: 208,
    cloudflareWorkerProjectionObservation: 118,
    cloudflareR2WriterWorkerObservation: 183,
    cloudflareR2WriterPipelineObservation: 30,
    cloudflareCatalogObservation: 4,
    githubAppCredential: 24,
    githubRunnerAdmin: 31
  });
  for (const requests of Object.values(STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF)) {
    assert.ok(requests <= 250, "no bounded helper client may reach its local request cap after mutation");
  }
  assert.deepEqual(STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF, {
    cloudflareComputeToken: 202,
    cloudflareDnsToken: 156,
    cloudflareR2Token: 333,
    cloudflareTokenAdminToken: 99,
    cloudflareObservationToken: 543,
    githubAppCredential: 24,
    githubRunnerInstallationToken: 31
  });
  assert.equal(
    Object.values(STAGING_TEARDOWN_PROVIDER_AUTHORITY_BUDGET_PROOF)
      .reduce((total, requests) => total + requests, 0),
    Object.values(STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF)
      .reduce((total, requests) => total + requests, 0),
    "per-token ledgers must account for every bounded helper-client request exactly once"
  );

  const target = targetManifest();
  const cloudflare = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: async () => { throw new Error("budget snapshot must not perform HTTP"); },
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const snapshots = cloudflare.requestBudgetSnapshot();
  assert.deepEqual(
    Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, snapshot.requestLimit])),
    { compute: 202, dns: 156, r2: 333, tokenAdmin: 99, observation: 543 }
  );
  for (const snapshot of Object.values(snapshots)) {
    assert.equal(snapshot.requestCount, 0);
    assert.equal(
      snapshot.deadlineBudgetMilliseconds,
      snapshot.requestLimit * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
      "each shared token ledger reserves exactly one timeout window per proven request"
    );
  }
  const github = createGithubStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: async () => { throw new Error("budget snapshot must not perform HTTP"); },
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.github.test"
  });
  assert.equal(github.requestBudgetSnapshot().requestLimit, 31);
  const workflow = readFileSync(".github/workflows/staging-teardown-evidence.yml", "utf8");
  const timeoutMinutes = Number(workflow.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert.ok(
    timeoutMinutes * 60_000 >=
      STAGING_TEARDOWN_PROVIDER_WORST_CASE_MILLISECONDS +
        STAGING_TEARDOWN_WORKFLOW_NON_PROVIDER_RESERVE_MILLISECONDS,
    "hosted timeout must cover every provider timeout plus bootstrap and finalization reserve"
  );
  assert.ok(
    STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT *
      (STAGING_TEARDOWN_GITHUB_APP_TOKEN_MINIMUM_LIFETIME_MS -
        STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS) >=
      STAGING_TEARDOWN_PROVIDER_WORST_CASE_MILLISECONDS,
    "bounded just-in-time App refreshes must cover the complete provider worst case"
  );
});

test("staging R2 writers are revoked before container and bucket deletion", () => {
  for (const credential of [
    "durable-replay-staging-only-authority",
    "encrypted-watch-staging-only-authority"
  ]) {
    const credentialIndex = STAGING_TEARDOWN_REMOVAL_ORDER.indexOf(credential);
    for (const later of [
      "site-behavior-lab-scanner-staging-container",
      "site-behavior-lab-watch-staging-container",
      "site-behavior-lab-reports-staging",
      "site-behavior-lab-reports-watch-staging"
    ]) {
      assert.ok(credentialIndex < STAGING_TEARDOWN_REMOVAL_ORDER.indexOf(later));
    }
  }
});

function harmlessPipelineSinks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `pipeline-sink-${String(index).padStart(3, "0")}`,
    type: index % 2 === 0 ? "r2" : "r2_data_catalog",
    config: {
      account_id: ACCOUNT,
      bucket: `unrelated-pipeline-bucket-${String(index).padStart(3, "0")}`
    }
  }));
}

function harmlessSlurperJobs(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `slurper-job-${String(index).padStart(3, "0")}`,
    status: "completed",
    source: { bucket: `source-${index}`, vendor: "s3" },
    target: { bucket: `unrelated-target-${index}`, vendor: "r2" }
  }));
}

function harmlessAccountTokens(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: (index + 256).toString(16).padStart(32, "0"),
    name: `harmless-account-token-${index}`,
    policies: [],
    status: "active"
  }));
}

function cloudflareFixtureAdapter(target, provider) {
  return createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
}

test("recently expired canonical credentials remain visible and are revoked", async () => {
  const target = targetManifest();
  const credential = target.cloudflare.credentialSets[0];
  const provider = fixtureProvider(target);
  provider.state.credentials.get(credential.tokenId).status = "expired";
  const adapter = cloudflareFixtureAdapter(target, provider);
  const before = await adapter.observe(credential.logicalName, { phase: "before" });
  assert.equal(before.state, "present");
  await adapter.remove(credential.logicalName, before.externalIds);
  assert.equal(provider.state.credentials.has(credential.tokenId), false);
  assert.ok(
    provider.calls.filter((call) =>
      call.method === "GET" && new URL(call.url).pathname.endsWith("/tokens")
    ).every((call) => new URL(call.url).searchParams.get("include_expired") === "true")
  );
});

test("account-wide R2 writer inventory refuses every live writer before mutation", async () => {
  const cases = [
    {
      name: "second active Worker version",
      expected: /active Worker version has a direct R2 binding/,
      mutate(state, target) {
        const scriptName = "unrelated-r2-writer";
        state.workerScripts.set(scriptName, { id: scriptName });
        state.workerDeployments.set(scriptName, { deployments: [{
            id: "unrelated-active-deployment",
            strategy: "percentage",
            versions: [
              { percentage: 90, version_id: "unrelated-safe-version" },
              { percentage: 10, version_id: "unrelated-writer-version" }
            ]
        }] });
        state.workerVersions.set(scriptName, [
          {
            id: "unrelated-safe-version",
            resources: { bindings: [] }
          },
          {
            id: "unrelated-writer-version",
            resources: { bindings: [{
              type: "r2_bucket",
              name: "REPORTS",
              bucket_name: target.cloudflare.buckets[0].bucketName
            }] }
          }
        ]);
      }
    },
    ...["r2", "r2_data_catalog"].map((type) => ({
      name: `page-two ${type} Pipeline sink`,
      expected: /Pipeline sink writes to a reviewed staging R2 bucket/,
      mutate(state, target) {
        state.pipelineSinks.push(
          ...harmlessPipelineSinks(100),
          {
            id: `selected-${type}-sink`,
            type,
            config: {
              account_id: ACCOUNT,
              bucket: target.cloudflare.buckets[0].bucketName
            }
          }
        );
      }
    })),
    {
      name: "offset-page running Super Slurper target",
      expected: /active Super Slurper job has a reviewed staging R2 source or target/,
      mutate(state, target) {
        state.slurperJobs.push(
          ...harmlessSlurperJobs(50),
          {
            id: "selected-running-slurper-target",
            status: "running",
            source: { bucket: "external-source", vendor: "s3" },
            target: { bucket: target.cloudflare.buckets[0].bucketName, vendor: "r2" }
          }
        );
      }
    },
    {
      name: "offset-page paused Super Slurper R2 source",
      expected: /active Super Slurper job has a reviewed staging R2 source or target/,
      mutate(state, target) {
        state.slurperJobs.push(
          ...harmlessSlurperJobs(50),
          {
            id: "selected-paused-slurper-source",
            status: "paused",
            source: { bucket: target.cloudflare.buckets[0].bucketName, vendor: "r2" },
            target: { bucket: "unrelated-target", vendor: "r2" }
          }
        );
      }
    },
    {
      name: "malformed active Super Slurper job without target",
      expected: /must expose one exact R2 target/,
      mutate(state) {
        state.slurperJobs.push({
          id: "malformed-active-slurper-job",
          status: "running",
          source: { bucket: "external-source", vendor: "s3" }
        });
      }
    },
    {
      name: "page-two exact-bucket account token",
      expected: /active noncanonical account-owned token/,
      mutate(state, target) {
        state.additionalAccountTokens.push(
          ...harmlessAccountTokens(47),
          {
            id: "e".repeat(32),
            name: "unapproved-exact-bucket-writer",
            policies: policy(target.cloudflare.buckets[0].bucketName, "unapproved"),
            status: "active"
          }
        );
      }
    },
    {
      name: "page-two account-wide R2 token",
      expected: /active noncanonical account-owned token/,
      mutate(state) {
        state.additionalAccountTokens.push(
          ...harmlessAccountTokens(47),
          {
            id: "e".repeat(32),
            name: "unapproved-account-wide-writer",
            policies: [{
              effect: "allow",
              permission_groups: [{
                id: R2_STORAGE_WRITE_PERMISSION_GROUP_ID
              }],
              resources: {
                [`com.cloudflare.api.account.${ACCOUNT}`]: {
                  "com.cloudflare.edge.r2.bucket.*": "*"
                }
              }
            }],
            status: "active"
          }
        );
      }
    }
  ];

  for (const testCase of cases) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    testCase.mutate(provider.state, target);
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(target.cloudflare.buckets[0].logicalName, { phase: "before" }),
      testCase.expected,
      testCase.name
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${testCase.name} must refuse before every mutation`
    );
  }
});

test("R2 writer classification is bound to the provider permission-group directory", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.permissionGroups = provider.state.permissionGroups.filter(
    (group) => group.name !== "Workers R2 Data Catalog Write"
  );
  const adapter = cloudflareFixtureAdapter(target, provider);

  await assert.rejects(
    adapter.observe(target.cloudflare.buckets[0].logicalName, { phase: "before" }),
    /permission-group directory omitted or changed Workers R2 Data Catalog Write/
  );
  assert.equal(
    provider.calls.some((call) => call.method === "DELETE"),
    false,
    "an incomplete provider permission directory must refuse before mutation"
  );
});

test("external R2 writer inventory ignores inert, historical, and foreign associations", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const scriptName = "historical-r2-binding-worker";
  provider.state.workerScripts.set(scriptName, { id: scriptName });
  provider.state.workerDeployments.set(scriptName, { deployments: [
    {
      id: "current-safe-deployment",
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: "current-safe-version" }]
    },
    {
      id: "historical-writer-deployment",
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: "historical-writer-version" }]
    }
  ] });
  provider.state.workerVersions.set(scriptName, [
    {
      id: "current-safe-version",
      resources: { bindings: [] }
    },
    {
      id: "historical-writer-version",
      resources: { bindings: [{
        type: "r2_bucket",
        name: "OLD_REPORTS",
        bucket_name: target.cloudflare.buckets[0].bucketName
      }] }
    }
  ]);
  provider.state.pipelineSinks.push({
    id: "foreign-account-same-name",
    type: "r2",
    config: {
      account_id: "0".repeat(32),
      bucket: target.cloudflare.buckets[0].bucketName
    }
  }, {
    id: "future-non-r2-sink",
    type: "http",
    config: { endpoint: "https://example.invalid/sink" }
  });
  provider.state.slurperJobs.push(
    {
      id: "completed-target",
      status: "completed",
      source: { bucket: "external", vendor: "s3" },
      target: { bucket: target.cloudflare.buckets[0].bucketName, vendor: "r2" }
    },
    {
      id: "aborted-source",
      status: "aborted",
      source: { bucket: target.cloudflare.buckets[0].bucketName, vendor: "r2" },
      target: { bucket: "unrelated", vendor: "r2" }
    },
    {
      id: "active-s3-same-name",
      status: "running",
      source: { bucket: target.cloudflare.buckets[0].bucketName, vendor: "s3" },
      target: { bucket: "unrelated", vendor: "r2" }
    }
  );
  provider.state.additionalAccountTokens.push(
    {
      id: "d".repeat(32),
      name: "disabled-exact-bucket-writer",
      policies: policy(target.cloudflare.buckets[0].bucketName, "disabled"),
      status: "disabled"
    },
    {
      id: "c".repeat(32),
      name: "expired-account-wide-writer",
      policies: [{
        effect: "allow",
        permission_groups: [{ id: R2_STORAGE_WRITE_PERMISSION_GROUP_ID }],
        resources: {
          [`com.cloudflare.api.account.${ACCOUNT}`]: {
            "com.cloudflare.edge.r2.bucket.*": "*"
          }
        }
      }],
      status: "expired"
    }
  );

  const adapter = cloudflareFixtureAdapter(target, provider);
  const observation = await adapter.observe(
    target.cloudflare.buckets[0].logicalName,
    { phase: "before" }
  );
  assert.equal(observation.state, "present");
  assert.equal(
    provider.calls.some((call) =>
      new URL(call.url).pathname.endsWith("/versions/historical-writer-version")
    ),
    false,
    "historical deployments must not be mistaken for active writers"
  );
});

test("each bucket gets a fresh external-writer proof immediately before object deletion", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const adapter = cloudflareFixtureAdapter(target, provider);
  const before = [];
  for (const bucket of target.cloudflare.buckets) {
    before.push(await adapter.observe(bucket.logicalName, { phase: "before" }));
  }

  // Removal order already revokes these canonical writer paths before either
  // bucket. Model that point in the ceremony without exercising unrelated
  // Worker/container teardown behavior in this focused TOCTOU regression.
  provider.state.workerScripts.clear();
  provider.state.workerDeployments.clear();
  provider.state.workerVersions.clear();
  provider.state.credentials.clear();

  await adapter.remove(target.cloudflare.buckets[0].logicalName, before[0].externalIds);
  provider.state.pipelineSinks.push({
    id: "writer-created-between-bucket-deletes",
    type: "r2",
    config: {
      account_id: ACCOUNT,
      bucket: target.cloudflare.buckets[1].bucketName
    }
  });
  const secondBucketObjectDeletePrefix =
    `/r2/buckets/${target.cloudflare.buckets[1].bucketName}/objects/`;
  await assert.rejects(
    adapter.remove(target.cloudflare.buckets[1].logicalName, before[1].externalIds),
    /Pipeline sink writes to a reviewed staging R2 bucket/
  );
  assert.equal(
    provider.calls.some((call) =>
      call.method === "DELETE" && new URL(call.url).pathname.includes(secondBucketObjectDeletePrefix)
    ),
    false,
    "the fresh bucket-two proof must run before its first object DELETE"
  );
  assert.equal(
    provider.calls.filter((call) =>
      call.method === "GET" && new URL(call.url).pathname.endsWith("/workers/scripts")
    ).length,
    3,
    "one shared initial proof and one fresh proof per bucket are required"
  );
});

test("Worker deletion is non-force and refuses external dependents before mutation", async () => {
  for (const timing of ["initial", "pre-delete"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const logicalName = target.cloudflare.workers[0].logicalName;
    let before;
    if (timing === "pre-delete") {
      before = await adapter.observe(logicalName, { phase: "before" });
    }
    provider.state.externalWorkerReferences.push({ service: "unreviewed-production-worker" });
    if (timing === "initial") {
      await assert.rejects(
        adapter.observe(logicalName, { phase: "before" }),
        /external Worker or Pages service binding/
      );
    } else {
      await assert.rejects(
        adapter.remove(logicalName, before.externalIds),
        /external Worker or Pages service binding/
      );
    }
    assert.equal(
      provider.calls.some((call) =>
        call.method === "DELETE" && new URL(call.url).pathname.includes("/workers/scripts/")
      ),
      false
    );
  }
});

test("an additional same-script Durable Object class is refused in the initial inventory without mutation", async () => {
  for (const surface of ["namespace-list", "attachment-graph"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const worker = target.cloudflare.workers[0];
    if (surface === "namespace-list") {
      provider.state.durableObjects.set("do-unreviewed-class", {
        id: "do-unreviewed-class",
        class: "UnreviewedContainer",
        script: worker.scriptName
      });
    } else {
      provider.state.workerGraphs.get(worker.workerId).references.durable_objects.push({
        worker_id: worker.workerId,
        worker_name: worker.scriptName,
        namespace_id: "do-unreviewed-class",
        namespace_name: "UnreviewedContainer"
      });
    }
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    await assert.rejects(
      adapter.observe(worker.logicalName, { phase: "before" }),
      surface === "namespace-list"
        ? /Durable Object namespace inventory is not exact|must expose the exact reviewed class/
        : /only its exact reviewed Durable Object namespace/
    );
    assert.equal(
      provider.calls.some((call) => call.method !== "GET"),
      false,
      `${surface} must fail with a read-only transcript`
    );
  }
});

test("the Worker Beta graph refuses legacy Durable Object aliases without mutation", async () => {
  for (const alias of ["class_name", "namespace-id-alias"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const worker = target.cloudflare.workers[0];
    const reference = provider.state.workerGraphs
      .get(worker.workerId).references.durable_objects[0];
    if (alias === "class_name") {
      reference.class_name = reference.namespace_name;
      delete reference.namespace_name;
    } else {
      reference.id = reference.namespace_id;
      delete reference.namespace_id;
    }
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(worker.logicalName, { phase: "before" }),
      /only its exact reviewed Durable Object namespace/
    );
    assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
  }
});

test("the Worker Beta graph may omit a self Durable Object edge when the namespace inventory is exact", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const worker = target.cloudflare.workers[0];
  provider.state.workerGraphs.get(worker.workerId).references.durable_objects = [];
  assert.equal(
    (await cloudflareFixtureAdapter(target, provider)
      .observe(worker.logicalName, { phase: "before" })).state,
    "present"
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);

  const attachedTarget = targetManifest();
  const attachedWorker = attachedTarget.cloudflare.workers[0];
  const attachedProvider = fixtureProvider(attachedTarget);
  attachedProvider.state.workerScriptSettings.get(attachedWorker.scriptName)
    .tail_consumers = [{ service: "downstream-tail-consumer" }];
  await assert.rejects(
    cloudflareFixtureAdapter(attachedTarget, attachedProvider)
      .observe(attachedWorker.logicalName, { phase: "before" }),
    /tail_consumers must be null, omitted, or empty before Worker deletion/
  );
  assert.equal(attachedProvider.calls.some((call) => call.method !== "GET"), false);
});

test("secret Worker bindings accept exact documented shapes and refuse hidden fields before mutation", async () => {
  assert.deepEqual(
    normalizeStagingTeardownWorkerBindings([
      { name: "EXACT_SECRET_TEXT", type: "secret_text" },
      { name: "EXACT_SECRET_KEY", type: "secret_key" }
    ], "exact secret bindings"),
    [
      { name: "EXACT_SECRET_KEY", type: "secret_key" },
      { name: "EXACT_SECRET_TEXT", type: "secret_text" }
    ]
  );

  const target = targetManifest();
  const provider = fixtureProvider(target);
  const worker = target.cloudflare.workers[0];
  provider.state.workerVersionSettings.get(worker.scriptName).bindings
    .find((binding) => binding.type === "secret_text").text = "unreviewed-provider-field";
  const adapter = cloudflareFixtureAdapter(target, provider);
  await assert.rejects(
    adapter.observe(worker.logicalName, { phase: "before" }),
    /secret_text binding must contain exactly name and type/
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);

  const dependentTarget = targetManifest();
  const dependentWorker = dependentTarget.cloudflare.workers[0];
  const dependentProvider = fixtureProvider(dependentTarget);
  dependentProvider.state.workerScriptSettings.get(dependentWorker.scriptName)
    .tail_consumers = [{ service: "external-consumer", environment: "production" }];
  await assert.rejects(
    cloudflareFixtureAdapter(dependentTarget, dependentProvider)
      .observe(dependentWorker.logicalName, { phase: "before" }),
    /tail_consumers must be null, omitted, or empty/
  );
  assert.equal(dependentProvider.calls.some((call) => call.method !== "GET"), false);
});

test("documented null Worker script-setting collections normalize to sealed empty defaults", async () => {
  assert.deepEqual(
    normalizeStagingTeardownWorkerScriptSettings({
      tags: null,
      tail_consumers: null
    }, "null Worker script settings"),
    { logpush: false, tags: [], tail_consumers: [] }
  );

  const target = targetManifest();
  const worker = target.cloudflare.workers[0];
  const provider = fixtureProvider(target);
  const scriptSettings = provider.state.workerScriptSettings.get(worker.scriptName);
  delete scriptSettings.logpush;
  scriptSettings.tags = null;
  scriptSettings.tail_consumers = null;
  worker.scriptSettingsSha256 = sha256Bytes(serializeCanonicalEvidence({
    logpush: false,
    observability: structuredClone(scriptSettings.observability),
    tags: [],
    tail_consumers: []
  }));
  assert.equal(
    (await cloudflareFixtureAdapter(target, provider)
      .observe(worker.logicalName, { phase: "before" })).state,
    "present"
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("Worker ingress inventory covers internal Zones, Email Routing, routes, and Builds with the observation token", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const worker = target.cloudflare.workers[0];
  const observation = await adapter.observe(worker.logicalName, { phase: "before" });
  assert.equal(
    observation.evidence.bytes.includes("SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"),
    false,
    "public evidence must contain only a digest of the selected projection facts"
  );

  const internalZoneId = "d".repeat(32);
  const getPaths = provider.calls
    .filter((call) => call.method === "GET")
    .map((call) => new URL(call.url).pathname);
  assert.ok(getPaths.includes("/client/v4/zones"));
  assert.ok(getPaths.includes(`/client/v4/zones/${internalZoneId}/email/routing/rules`));
  assert.ok(getPaths.includes(`/client/v4/zones/${internalZoneId}/email/routing/rules/catch_all`));
  assert.ok(getPaths.includes(`/client/v4/zones/${internalZoneId}/workers/routes`));
  assert.ok(getPaths.includes(
    `/client/v4/accounts/${ACCOUNT}/builds/workers/${worker.workerId}/triggers`
  ));
  assert.ok(getPaths.includes(
    `/client/v4/accounts/${ACCOUNT}/builds/workers/${worker.scriptName}/deploy_hooks`
  ));
  assert.equal(
    getPaths.some((path) => path.includes(`/accounts/${ACCOUNT}/email/routing/rules`)),
    false,
    "Email Routing proof must use documented per-Zone bearer-token endpoints"
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("the sealed Worker projection is compared again immediately before deletion", async () => {
  for (const [surface, mutate, pattern] of [
    [
      "script-list",
      (state, worker) => {
        state.workerScripts.get(worker.scriptName).etag = "1".repeat(64);
      },
      /script-list ETag does not match/
    ],
    [
      "version-settings",
      (state, worker) => {
        state.workerVersionSettings.get(worker.scriptName)
          .bindings.find((binding) => binding.type === "plain_text").text = "0";
      },
      /version settings digest does not match/
    ],
    [
      "script-settings",
      (state, worker) => {
        state.workerScriptSettings.get(worker.scriptName).observability.enabled = true;
      },
      /script-level settings digest does not match/
    ],
    [
      "secret-name",
      (state, worker) => {
        state.workerSecrets.get(worker.scriptName).push({
          name: "UNREVIEWED_SECRET",
          type: "secret_text"
        });
      },
      /secret-name set does not match/
    ],
    [
      "version-resource",
      (state, worker) => {
        state.workerVersions.get(worker.scriptName)[0].resources.script.etag = "2".repeat(64);
      },
      /complete Worker version state does not match/
    ],
    [
      "deployment",
      (state, worker) => {
        const versions = state.workerDeployments.get(worker.scriptName).deployments[0].versions;
        versions[0].percentage = 50;
        versions[1].percentage = 50;
      },
      /Worker deployments digest does not match/
    ]
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const worker = target.cloudflare.workers[0];
    const before = await adapter.observe(worker.logicalName, { phase: "before" });
    mutate(provider.state, worker);
    await assert.rejects(adapter.remove(worker.logicalName, before.externalIds), pattern);
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${surface} drift must refuse before every destructive request`
    );
  }
});

test("ordinary Email Routing rules and catch-alls targeting either staging Worker refuse the initial inventory without mutation", async () => {
  for (const [surface, mutate, pattern] of [
    [
      "ordinary-rule",
      (state, manifest) => state.emailRulesByZone.get(manifest.cloudflare.zoneId).push({
        id: "worker-email-rule",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "staging@example.test" }],
        actions: [{ type: "worker", value: [manifest.cloudflare.workers[1].scriptName] }],
        source: "api"
      }),
      /Email Routing rule targets a protected staging Worker/
    ],
    [
      "catch-all",
      (state, manifest) => {
        state.emailCatchAllByZone.get("d".repeat(32)).actions = [{
          type: "worker",
          value: [manifest.cloudflare.workers[0].scriptName]
        }];
      },
      /Email Routing catch-all targets a protected staging Worker/
    ]
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    mutate(provider.state, target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    await assert.rejects(
      adapter.observe(target.cloudflare.workers[0].logicalName, { phase: "before" }),
      pattern
    );
    assert.equal(
      provider.calls.some((call) => call.method !== "GET"),
      false,
      `${surface} must refuse with a read-only transcript`
    );
  }
});

test("Email Routing rules and catch-alls are re-enumerated immediately before Worker deletion", async () => {
  for (const [surface, mutate, pattern] of [
    [
      "ordinary-rule",
      (state, manifest) => state.emailRulesByZone.get(manifest.cloudflare.zoneId).push({
        id: "late-worker-email-rule",
        enabled: false,
        matchers: [{ type: "literal", field: "to", value: "late@example.test" }],
        actions: [{ type: "worker", value: [manifest.cloudflare.workers[0].scriptName] }],
        source: "wrangler"
      }),
      /Email Routing rule targets a protected staging Worker/
    ],
    [
      "catch-all",
      (state, manifest) => {
        state.emailCatchAllByZone.get("d".repeat(32)).actions = [{
          type: "worker",
          value: [manifest.cloudflare.workers[1].scriptName]
        }];
      },
      /Email Routing catch-all targets a protected staging Worker/
    ]
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const worker = target.cloudflare.workers[0];
    const before = await adapter.observe(worker.logicalName, { phase: "before" });
    mutate(provider.state, target);
    await assert.rejects(adapter.remove(worker.logicalName, before.externalIds), pattern);
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${surface} drift must be caught before every destructive request`
    );
  }
});

test("Worker Builds triggers and deploy hooks refuse both initial and immediate pre-delete inventories", async () => {
  for (const [surface, stateKey, identityField, pattern] of [
    ["trigger", "workerBuildTriggers", "trigger_uuid", /Worker Builds trigger/],
    ["deploy-hook", "workerBuildDeployHooks", "deploy_hook_uuid", /Worker Builds deploy-hook/]
  ]) {
    for (const timing of ["initial", "pre-delete"]) {
      const target = targetManifest();
      const provider = fixtureProvider(target);
      const adapter = createCloudflareStagingTeardownAdapter({
        manifest: target,
        credentials: exactCredentials(),
        sessionId: SESSION_ID,
        fetchImpl: provider.fetch,
        persistRaw: async () => undefined,
        apiBaseUrl: "https://api.cloudflare.test"
      });
      const worker = target.cloudflare.workers[0];
      let before;
      if (timing === "pre-delete") {
        before = await adapter.observe(worker.logicalName, { phase: "before" });
      }
      provider.state[stateKey].push({ [identityField]: `unexpected-${surface}` });
      if (timing === "initial") {
        await assert.rejects(adapter.observe(worker.logicalName, { phase: "before" }), pattern);
      } else {
        await assert.rejects(adapter.remove(worker.logicalName, before.externalIds), pattern);
      }
      assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
    }
  }
});

test("queued and running Worker Builds refuse initial and immediate pre-delete inventories", async () => {
  for (const [timing, status] of [["initial", "queued"], ["pre-delete", "running"]]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const adapter = cloudflareFixtureAdapter(target, provider);
    const worker = target.cloudflare.workers[0];
    let before;
    if (timing === "pre-delete") {
      before = await adapter.observe(worker.logicalName, { phase: "before" });
    }
    provider.state.workerBuildExecutions.get(worker.workerId).push({
      build_uuid: timing === "initial"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
      status
    });
    if (timing === "initial") {
      await assert.rejects(
        adapter.observe(worker.logicalName, { phase: "before" }),
        /queued, initializing, or running Worker Build/
      );
    } else {
      await assert.rejects(
        adapter.remove(worker.logicalName, before.externalIds),
        /queued, initializing, or running Worker Build/
      );
    }
    assert.equal(
      provider.calls.some((call) => call.method !== "GET"),
      false,
      `${timing} Worker Build refusal must remain read-only`
    );
  }
});

test("Worker Builds execution inventory is strictly shaped and completely paginated", async () => {
  for (const mode of ["second-page", "invalid-status"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const worker = target.cloudflare.workers[0];
    const executions = provider.state.workerBuildExecutions.get(worker.workerId);
    executions.push(...Array.from({ length: mode === "second-page" ? 201 : 1 }, (_, index) => ({
      build_uuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      status: mode === "invalid-status" ? "unknown" : "stopped"
    })));
    if (mode === "second-page") {
      worker.stoppedBuildsSha256 = sha256Bytes(serializeCanonicalEvidence(
        executions.map((build) => ({
          buildOutcome: build.build_outcome ?? null,
          id: build.build_uuid,
          status: build.status
        })).sort((left, right) => compareStagingTeardownCodeUnits(left.id, right.id))
      ));
    }
    const adapter = cloudflareFixtureAdapter(target, provider);
    if (mode === "second-page") {
      const observation = await adapter.observe(worker.logicalName, { phase: "before" });
      assert.equal(observation.state, "present");
      assert.equal(
        provider.calls.some((call) => {
          const url = new URL(call.url);
          return url.pathname.endsWith(`/builds/workers/${worker.workerId}/builds`) &&
            url.searchParams.get("page") === "2";
        }),
        true
      );
    } else {
      await assert.rejects(
        adapter.observe(worker.logicalName, { phase: "before" }),
        /must be one documented Worker Builds status/
      );
      assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
    }
  }
});

test("a build deployment between quiescence and projection is refused before mutation", async () => {
  const target = targetManifest();
  const worker = target.cloudflare.workers[0];
  const provider = fixtureProvider(target);
  let buildReads = 0;
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: async (input, init) => {
      const response = await provider.fetch(input, init);
      const url = input instanceof URL ? input : new URL(input);
      if (
        url.pathname.endsWith(`/builds/workers/${worker.workerId}/builds`) &&
        ++buildReads === 1
      ) {
        provider.state.workerScripts.get(worker.scriptName).etag = "9".repeat(64);
      }
      return response;
    },
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });

  await assert.rejects(
    adapter.observe(worker.logicalName, { phase: "before" }),
    /script-list ETag does not match/
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("Worker-build Event Subscriptions refuse initial and immediate pre-delete inventories without mutation", async () => {
  for (const timing of ["initial", "pre-delete"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const worker = target.cloudflare.workers[0];
    let before;
    if (timing === "pre-delete") {
      before = await adapter.observe(worker.logicalName, { phase: "before" });
    }
    provider.state.eventSubscriptions.push({
      id: timing === "initial" ? "protected-initial" : "protected-predelete",
      source: {
        type: "workersBuilds.worker",
        worker_name: target.cloudflare.workers[1].scriptName
      }
    });
    if (timing === "initial") {
      await assert.rejects(
        adapter.observe(worker.logicalName, { phase: "before" }),
        /Event Subscription targets a protected staging Worker/
      );
    } else {
      await assert.rejects(
        adapter.remove(worker.logicalName, before.externalIds),
        /Event Subscription targets a protected staging Worker/
      );
    }
    assert.equal(
      provider.calls.some((call) => call.method !== "GET"),
      false,
      `${timing} Event Subscription refusal must remain read-only`
    );
  }
});

test("Event Subscription inventory retrieves its complete bounded second page", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.eventSubscriptions.push(...Array.from({ length: 101 }, (_, index) => ({
    id: `unrelated-${index}`,
    source: { type: "images" }
  })));
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  await adapter.observe(target.cloudflare.workers[0].logicalName, { phase: "before" });
  assert.equal(
    provider.calls.filter((call) =>
      call.method === "GET" &&
        new URL(call.url).pathname.endsWith("/event_subscriptions/subscriptions")
    ).length,
    2
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("current unrelated Event Subscription source shapes do not block Worker teardown proof", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.eventSubscriptions.push(
    { id: "source-access", source: { type: "access" } },
    { id: "source-artifacts", source: { type: "artifacts" } },
    {
      id: "source-artifacts-repo",
      source: { type: "artifacts.repo", namespace: "example", repo_name: "repo" }
    },
    {
      id: "source-email",
      source: { type: "email.sending", zone_id: ZONE, domain: "example.org" }
    },
    {
      id: "source-slurper-job",
      source: { type: "superSlurper.job", job_id: "migration-job" }
    }
  );
  const observation = await cloudflareFixtureAdapter(target, provider).observe(
    target.cloudflare.workers[0].logicalName,
    { phase: "before" }
  );
  assert.equal(observation.state, "present");
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);

  provider.state.eventSubscriptions.push({
    id: "source-unknown",
    source: { type: "future.unknown" }
  });
  await assert.rejects(
    cloudflareFixtureAdapter(target, provider).observe(
      target.cloudflare.workers[0].logicalName,
      { phase: "before" }
    ),
    /source.type is unsupported/
  );
});

test("multi-target Email Routing Worker actions inspect every bounded target before mutation", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.emailRulesByZone.get(target.cloudflare.zoneId).push({
    id: "ambiguous-worker-email-rule",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: "ambiguous@example.test" }],
    actions: [{
      type: "worker",
      value: ["unrelated-worker", target.cloudflare.workers[0].scriptName]
    }],
    source: "api"
  });
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  await assert.rejects(
    adapter.observe(target.cloudflare.workers[0].logicalName, { phase: "before" }),
    /Email Routing rule targets a protected staging Worker/
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("Worker deletion refuses attached domains, queues, classic routes, cron, and workers.dev ingress", async () => {
  for (const [surface, mutate, pattern] of [
    [
      "domain",
      (state, manifest) => {
        const worker = manifest.cloudflare.workers[0];
        state.domains.set("unexpected-domain", {
          id: "unexpected-domain",
          hostname: "unexpected.example",
          service: worker.scriptName,
          cert_id: "unexpected-domain-cert",
          zone_id: manifest.cloudflare.zoneId,
          zone_name: "example"
        });
      },
      /attached custom domain/
    ],
    [
      "queue",
      (state, manifest) => {
        const worker = manifest.cloudflare.workers[0];
        state.workerGraphs.get(worker.workerId).references.queues.push({
          queue_consumer_id: "unexpected-consumer",
          queue_id: "unexpected-queue",
          queue_name: "unexpected-queue"
        });
      },
      /attached domain, queue, Worker, or dispatch-namespace reference/
    ],
    [
      "route",
      (state, manifest) => state.classicWorkerRoutes.push({
        id: "unexpected-route",
        pattern: "unexpected.example/*",
        script: manifest.cloudflare.workers[0].scriptName
      }),
      /attached classic route/
    ],
    [
      "schedule",
      (state) => state.cronSchedules.push({ cron: "*/5 * * * *" }),
      /attached cron schedule/
    ],
    [
      "workers-dev",
      (state) => { state.workersDevEnabled = true; },
      /workers.dev or preview ingress enabled/
    ]
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const worker = target.cloudflare.workers[0];
    for (const [domainId, domain] of provider.state.domains) {
      if (domain.service === worker.scriptName) provider.state.domains.delete(domainId);
    }
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const before = await adapter.observe(worker.logicalName, { phase: "before" });
    mutate(provider.state, target);
    await assert.rejects(adapter.remove(worker.logicalName, before.externalIds), pattern);
    assert.equal(
      provider.calls.some((call) =>
        call.method === "DELETE" && new URL(call.url).pathname.includes("/workers/scripts/")
      ),
      false,
      `${surface} must refuse before Worker DELETE`
    );
  }
});

test("every Worker-domain row is strictly projected before filtering", async () => {
  for (const missingField of ["hostname", "service"]) {
    const target = targetManifest();
    const worker = target.cloudflare.workers[0];
    const provider = fixtureProvider(target);
    const malformed = {
      id: `malformed-domain-${missingField}`,
      cert_id: `malformed-cert-${missingField}`,
      hostname: `unrelated-${missingField}.example.org`,
      service: "unrelated-worker",
      zone_id: ZONE,
      zone_name: "example.org"
    };
    delete malformed[missingField];
    provider.state.domains.set(malformed.id, malformed);
    await assert.rejects(
      cloudflareFixtureAdapter(target, provider).observe(worker.logicalName, { phase: "before" }),
      new RegExp(`account Worker domain .*\\.${missingField}`)
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("maximum allowed GitHub pagination still completes post-delete absence proof", async () => {
  const target = targetManifest();
  const unrelated = Array.from({ length: 999 }, (_, index) => ({
    id: 10_000 + index,
    name: `unrelated-${index}`,
    busy: false,
    status: "offline",
    labels: []
  }));
  let runner = {
    id: target.github.runner.id,
    name: target.github.runner.name,
    busy: false,
    status: "offline",
    labels: target.github.runner.labels.map((name) => ({ name }))
  };
  let requests = 0;
  const adapter = createGithubStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    apiBaseUrl: "https://api.github.test",
    persistRaw: async () => undefined,
    fetchImpl: async (input, init) => {
      requests += 1;
      const url = input instanceof URL ? input : new URL(input);
      if (init.method === "DELETE") {
        runner = null;
        return new Response(null, { status: 204 });
      }
      const values = runner === null ? unrelated : [...unrelated, runner];
      const page = Number(url.searchParams.get("page"));
      return new Response(JSON.stringify({
        total_count: values.length,
        runners: values.slice((page - 1) * 100, page * 100)
      }), { headers: { "content-type": "application/json" } });
    }
  });
  const before = await adapter.observe(target.github.runner.logicalName, { phase: "before" });
  await adapter.remove(target.github.runner.logicalName, before.externalIds);
  const after = await adapter.observe(target.github.runner.logicalName, { phase: "after" });
  assert.equal(after.state, "absent");
  assert.equal(requests, 31);
});

test("absent-target GitHub runner pagination refuses duplicate and malformed rows without mutation", async () => {
  const validRunner = (id, name) => ({
    id,
    name,
    status: "offline",
    busy: false,
    labels: [{ id: id + 1_000, name: "self-hosted", type: "read-only" }]
  });
  for (const mode of [
    "duplicate-id", "duplicate-name", "missing-id", "malformed-label", "over-total"
  ]) {
    const target = targetManifest();
    target.github.runner.expectedPresent = false;
    target.github.runner.id = null;
    validateStagingTeardownTargetManifest(target, COMMIT);
    let runners;
    let totalCount;
    if (mode === "duplicate-id") {
      runners = [validRunner(101, "unrelated-a"), validRunner(101, "unrelated-b")];
      totalCount = 2;
    } else if (mode === "duplicate-name") {
      runners = [validRunner(101, "unrelated-a"), validRunner(102, "unrelated-a")];
      totalCount = 2;
    } else if (mode === "missing-id") {
      runners = [validRunner(101, "unrelated-a")];
      delete runners[0].id;
      totalCount = 1;
    } else if (mode === "malformed-label") {
      runners = [validRunner(101, "unrelated-a")];
      runners[0].labels[0].name = null;
      totalCount = 1;
    } else {
      runners = [validRunner(101, "unrelated-a"), validRunner(102, "unrelated-b")];
      totalCount = 1;
    }
    const methods = [];
    const adapter = createGithubStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      apiBaseUrl: "https://api.github.test",
      persistRaw: async () => undefined,
      fetchImpl: async (_input, init) => {
        methods.push(init.method);
        return new Response(JSON.stringify({ total_count: totalCount, runners }), {
          headers: { "content-type": "application/json" }
        });
      }
    });
    await assert.rejects(
      adapter.observe(target.github.runner.logicalName, { phase: "before" }),
      mode === "duplicate-id"
        ? /id must be one unique/
        : mode === "duplicate-name"
          ? /name must be unique/
          : mode === "missing-id"
            ? /id must be one unique/
            : mode === "malformed-label"
              ? /labels\[0\]\.name must be bounded/
              : /exceeded its declared total_count/
    );
    assert.deepEqual(methods, ["GET"]);
  }
});

test("an online idle staging runner is refused before unconditional unregister", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  provider.state.runner.status = "online";
  const adapter = createGithubStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.github.test"
  });
  await assert.rejects(
    adapter.observe(target.github.runner.logicalName, { phase: "before" }),
    /runner service must be offline/
  );
  assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
});

test("R2 pagination requires explicit is_truncated and a fresh cursor", async () => {
  for (const mode of ["missing-truncated", "repeated-cursor"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    let objectPage = 0;
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      apiBaseUrl: "https://api.cloudflare.test",
      persistRaw: async () => undefined,
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input : new URL(input);
        const body = (result, resultInfo) => new Response(JSON.stringify({
          success: true,
          errors: [],
          result,
          ...(resultInfo === undefined ? {} : { result_info: resultInfo })
        }), { headers: { "content-type": "application/json" } });
        if (!url.pathname.endsWith("/objects")) {
          return provider.fetch(input, init);
        }
        objectPage += 1;
        if (mode === "missing-truncated") {
          return body([], { cursor: "cursor-without-flag" });
        }
        return body(
          [providerObject(target.cloudflare.buckets[0].objects[0])],
          { is_truncated: true, cursor: "same-cursor" }
        );
      }
    });
    await assert.rejects(
      adapter.observe("site-behavior-lab-reports-staging", { phase: "before" }),
      mode === "missing-truncated"
        ? /must declare boolean result_info.is_truncated/
        : /invalid or repeated cursor/
    );
    assert.equal(objectPage, mode === "missing-truncated" ? 1 : 2);
  }
});

test("R2 removal rechecks the exact bucket creation identity before deleting objects", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const logicalName = "site-behavior-lab-reports-staging";
  const before = await adapter.observe(logicalName, { phase: "before" });
  provider.state.buckets.get(logicalName).creation_date = "2026-08-09T00:00:00.000Z";
  await assert.rejects(
    adapter.remove(logicalName, before.externalIds),
    /listed R2 bucket identity does not match/
  );
  assert.equal(
    provider.calls.some((call) =>
      call.method === "DELETE" && new URL(call.url).pathname.includes("/objects/")
    ),
    false
  );
});

test("R2 inventories enumerate every jurisdiction and refuse canonical non-default names", async () => {
  for (const retainDefault of [false, true]) {
    const target = targetManifest();
    const bucketTarget = target.cloudflare.buckets[0];
    const provider = fixtureProvider(target);
    provider.state.nonDefaultBuckets.eu.push({
      name: bucketTarget.bucketName,
      creation_date: bucketTarget.expectedCreationDate,
      location: bucketTarget.expectedLocation,
      storage_class: bucketTarget.expectedStorageClass
    });
    if (!retainDefault) provider.state.buckets.delete(bucketTarget.bucketName);
    await assert.rejects(
      cloudflareFixtureAdapter(target, provider).observe(
        bucketTarget.logicalName,
        { phase: "before" }
      ),
      /canonical staging R2 bucket name exists in a non-default jurisdiction/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }

  const target = targetManifest();
  const bucketTarget = target.cloudflare.buckets[0];
  const provider = fixtureProvider(target);
  assert.equal(
    (await cloudflareFixtureAdapter(target, provider).observe(
      bucketTarget.logicalName,
      { phase: "before" }
    )).state,
    "present"
  );
  const accountLists = provider.calls.filter((call) =>
    new URL(call.url).pathname.endsWith("/r2/buckets")
  );
  assert.deepEqual(
    accountLists.map((call) => call.headers["cf-r2-jurisdiction"]).sort(),
    ["default", "eu", "fedramp"]
  );
  assert.ok(provider.calls.every((call) => {
    const pathname = new URL(call.url).pathname;
    if (
      !pathname.includes("/r2/buckets/") &&
      !pathname.includes("/event_notifications/r2/")
    ) return true;
    return call.headers["cf-r2-jurisdiction"] === "default";
  }));

  const failingTarget = targetManifest();
  const failingProvider = fixtureProvider(failingTarget);
  const failingBucket = failingTarget.cloudflare.buckets[0];
  const failingAdapter = createCloudflareStagingTeardownAdapter({
    manifest: failingTarget,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test",
    fetchImpl: async (input, init) => {
      const url = input instanceof URL ? input : new URL(input);
      if (
        url.pathname.endsWith("/r2/buckets") &&
        init.headers["cf-r2-jurisdiction"] === "eu"
      ) {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "jurisdiction inventory unavailable" }],
          result: null
        }), {
          status: 403,
          headers: { "content-type": "application/json" }
        });
      }
      return failingProvider.fetch(input, init);
    }
  });
  await assert.rejects(
    failingAdapter.observe(failingBucket.logicalName, { phase: "before" }),
    /returned HTTP 403/
  );
  assert.equal(failingProvider.calls.some((call) => call.method === "DELETE"), false);
});

test("R2 bucket configuration inventory refuses every unreviewed delete cascade before mutation", async () => {
  for (const [surface, mutate, pattern] of [
    ["lifecycle", (bucket) => bucket.lifecycleRules[0].enabled = false, /canonical staging cleanup rule/],
    ["CORS", (bucket) => bucket.corsRules.push({ origins: ["https:\/\/example.test"] }), /unreviewed R2 CORS policy/],
    ["lock", (bucket) => bucket.lockRules.push({ id: "lock-rule" }), /unreviewed R2 object-lock rules/],
    ["event", (bucket) => bucket.eventQueues.push({ queueId: "queue-id" }), /unreviewed R2 event notification/],
    ["custom-domain", (bucket) => bucket.customDomains.push({ domain: "bucket.example" }), /attached R2 custom domain/],
    ["managed-domain", (bucket) => bucket.managedDomain.enabled = true, /exact reviewed disabled identity/],
    ["Sippy", (bucket) => bucket.sippy.enabled = true, /R2 Sippy must be disabled/],
    ["catalog", (bucket) => bucket.catalog = true, /R2 Data Catalog configuration/]
  ]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    mutate(provider.state.buckets.get(target.cloudflare.buckets[0].bucketName));
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    await assert.rejects(
      adapter.observe(target.cloudflare.buckets[0].logicalName, { phase: "before" }),
      pattern,
      surface
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${surface} must fail the complete initial inventory before mutation`
    );
  }
});

test("R2 configuration absence accepts only exact codes and normalizes omitted empty lifecycle transitions", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const bucket = provider.state.buckets.get(target.cloudflare.buckets[0].bucketName);
  delete bucket.lifecycleRules[0].storageClassTransitions;
  bucket.eventQueues = null;
  bucket.sippy = null;
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  assert.equal(
    (await adapter.observe(target.cloudflare.buckets[0].logicalName, { phase: "before" })).state,
    "present"
  );

  for (const suffix of ["/sippy", "/event_notifications/r2/"]) {
    const wrong = fixtureProvider(target);
    const wrongAdapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test",
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input : new URL(input);
        if (url.pathname.includes(suffix)) {
          return new Response(JSON.stringify({
            success: false,
            errors: [{ code: 99999, message: "different provider error" }],
            messages: [],
            result: null
          }), { status: 404, headers: { "content-type": "application/json" } });
        }
        return wrong.fetch(input, init);
      }
    });
    await assert.rejects(
      wrongAdapter.observe(target.cloudflare.buckets[0].logicalName, { phase: "before" }),
      /exact documented Cloudflare absence envelope/
    );
    assert.equal(wrong.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("R2 object and configuration drift are refused by the immediate pre-delete recheck", async () => {
  for (const mode of ["object-overwrite", "configuration-drift"]) {
    const target = targetManifest();
    const provider = fixtureProvider(target);
    const logicalName = target.cloudflare.buckets[0].logicalName;
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const before = await adapter.observe(logicalName, { phase: "before" });
    const bucket = provider.state.buckets.get(logicalName);
    if (mode === "object-overwrite") {
      const object = bucket.objects.get(target.cloudflare.buckets[0].objects[0].key);
      object.etag = "overwritten-etag";
      object.last_modified = "2026-08-09T00:00:00.000Z";
    } else {
      bucket.corsRules.push({ origins: ["https://example.test"] });
    }
    await assert.rejects(
      adapter.remove(logicalName, before.externalIds),
      mode === "object-overwrite"
        ? /object identities differ/
        : /unreviewed R2 CORS policy/
    );
    assert.equal(
      provider.calls.some((call) =>
        call.method === "DELETE" && new URL(call.url).pathname.includes("/objects/")
      ),
      false
    );
  }
});

test("documented omitted R2 defaults normalize exactly while null and missing identity refuse", async () => {
  {
    const target = targetManifest();
    const bucketTarget = target.cloudflare.buckets[0];
    bucketTarget.expectedLocation = null;
    const provider = fixtureProvider(target);
    const bucket = provider.state.buckets.get(bucketTarget.bucketName);
    bucket.jurisdiction = undefined;
    bucket.location = undefined;
    bucket.storage_class = undefined;
    for (const object of bucket.objects.values()) {
      object.ssec = undefined;
      object.storage_class = undefined;
    }
    const observation = await cloudflareFixtureAdapter(target, provider).observe(
      bucketTarget.logicalName,
      { phase: "before" }
    );
    assert.equal(observation.state, "present");
  }

  for (const mutate of [
    (bucket) => { bucket.location = null; },
    (bucket) => { bucket.objects.values().next().value.ssec = null; },
    (bucket) => { delete bucket.objects.values().next().value.etag; },
    (bucket) => { bucket.location = "enam"; }
  ]) {
    const target = targetManifest();
    const bucketTarget = target.cloudflare.buckets[0];
    bucketTarget.expectedLocation = null;
    const provider = fixtureProvider(target);
    const bucket = provider.state.buckets.get(bucketTarget.bucketName);
    bucket.location = undefined;
    mutate(bucket);
    await assert.rejects(
      cloudflareFixtureAdapter(target, provider).observe(bucketTarget.logicalName, { phase: "before" }),
      /R2 bucket|R2 object|R2 ssec|R2 storage_class|identity|reviewed target/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("custom-domain deletion accepts the exact pinned DNS record cascading absent", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target, { cascadeDns: true });
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const logicalName = "scan-staging.sitebehavior.org";
  const before = await adapter.observe(logicalName, { phase: "before" });
  assert.equal(before.state, "present");
  await adapter.remove(logicalName, before.externalIds);
  const after = await adapter.observe(logicalName, { phase: "after" });
  assert.equal(after.state, "absent");
  assert.equal(
    provider.calls.some((call) =>
      call.method === "DELETE" && new URL(call.url).pathname.includes("/dns_records/")
    ),
    false,
    "a provider-cascaded exact record must not receive a blind second DELETE"
  );
});

test("Cloudflare mutation envelopes and returned identities are authoritative", async () => {
  const target = targetManifest();
  const logicalName = target.cloudflare.dns[0].logicalName;
  for (const mode of ["failure-envelope", "wrong-record-id"]) {
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test",
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input : new URL(input);
        if (mode === "failure-envelope" && init.method === "DELETE" && url.pathname.includes("/workers/domains/")) {
          return new Response(JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: "private provider detail" }]
          }), { headers: { "content-type": "application/json" } });
        }
        if (mode === "wrong-record-id" && init.method === "DELETE" && url.pathname.includes("/dns_records/")) {
          return new Response(JSON.stringify({
            success: true,
            errors: [],
            result: { id: "different-reviewed-id" }
          }), { headers: { "content-type": "application/json" } });
        }
        return provider.fetch(input, init);
      }
    });
    const before = await adapter.observe(logicalName, { phase: "before" });
    await assert.rejects(
      adapter.remove(logicalName, before.externalIds),
      mode === "failure-envelope" ? /did not report success/ : /result id does not match/
    );
  }
});

test("certificate deletion binds the Worker-domain cert to one advanced pack and converges", async () => {
  const target = targetManifest();
  const dnsTarget = target.cloudflare.dns[0];
  dnsTarget.certificatePackId = "cert-pack-scanner";
  dnsTarget.certificateHosts = [dnsTarget.hostname];
  const provider = fixtureProvider(target, { certificatePollsBeforeDeleted: 1 });
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    sleepImpl: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const before = await adapter.observe(dnsTarget.logicalName, { phase: "before" });
  await adapter.remove(dnsTarget.logicalName, before.externalIds);
  const after = await adapter.observe(dnsTarget.logicalName, { phase: "after" });
  assert.equal(after.state, "absent");
  assert.equal(provider.state.certificates.get(dnsTarget.certificatePackId).status, "deleted");

  const mismatchedProvider = fixtureProvider(target);
  mismatchedProvider.state.domains.get(dnsTarget.workerDomainId).cert_id = "other-cert";
  const mismatched = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: mismatchedProvider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  await assert.rejects(
    mismatched.observe(dnsTarget.logicalName, { phase: "before" }),
    /Worker domain certificate id does not match/
  );
});

test("the complete certificate pack and every child status are sealed before mutation", async () => {
  for (const drift of ["extra-child", "child-status"]) {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const provider = fixtureProvider(target);
    const pack = provider.state.certificates.get(dnsTarget.certificatePackId);
    if (drift === "extra-child") {
      pack.certificates.push({
        id: "unreviewed-certificate-child",
        hosts: [dnsTarget.hostname],
        status: "active"
      });
    } else {
      pack.certificates[0].status = "pending_validation";
    }
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(dnsTarget.logicalName, { phase: "before" }),
      /complete certificate pack changed after review/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("omitted optional DNS modification timestamps normalize to explicit target sentinels", async () => {
  const target = targetManifest();
  const dnsTarget = target.cloudflare.dns[0];
  const expectedRecord = dnsTarget.dnsRecords[0];
  expectedRecord.commentModifiedOn = null;
  expectedRecord.tagsModifiedOn = null;
  const provider = fixtureProvider(target);
  const providerRecord = provider.state.dnsRecords.get(expectedRecord.id);
  delete providerRecord.comment_modified_on;
  delete providerRecord.tags_modified_on;
  const observation = await cloudflareFixtureAdapter(target, provider).observe(
    dnsTarget.logicalName,
    { phase: "before" }
  );
  assert.equal(observation.state, "present");
});

test("DNS provider metadata and modification timestamps are part of the exact deletion identity", async () => {
  for (const mutate of [
    (record) => { record.meta = { ...record.meta, auto_added: true }; },
    (record) => { record.tags_modified_on = "2026-08-02T00:00:00.000Z"; }
  ]) {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const provider = fixtureProvider(target);
    mutate(provider.state.dnsRecords.get(dnsTarget.dnsRecords[0].id));
    await assert.rejects(
      cloudflareFixtureAdapter(target, provider).observe(dnsTarget.logicalName, { phase: "before" }),
      /DNS records do not match the exact reviewed stable provider state/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("compound DNS teardown resumes from exact domain, record, and certificate cut points", async () => {
  for (const survivor of ["records-and-certificate", "certificate-only", "records-only"]) {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    dnsTarget.workerDomainExpectedPresent = false;
    dnsTarget.workerDomainId = null;
    dnsTarget.workerDomainCertId = null;
    if (survivor !== "records-only") {
      dnsTarget.certificatePackId = "cert-pack-scanner";
      dnsTarget.certificateHosts = [dnsTarget.hostname];
      dnsTarget.certificatePack = projectStagingTeardownCertificatePack(certificatePackFixture({
        id: dnsTarget.certificatePackId,
        hostname: dnsTarget.hostname,
        certificateId: null
      }), `${survivor} recovery certificate pack`);
      dnsTarget.certificatePackSha256 = stagingTeardownProjectionSha256(
        dnsTarget.certificatePack
      );
    } else {
      dnsTarget.certificatePackId = null;
      dnsTarget.certificateHosts = [];
      dnsTarget.certificatePack = null;
      dnsTarget.certificatePackSha256 = null;
    }
    if (survivor === "certificate-only") dnsTarget.dnsRecords = [];
    dnsTarget.expectedPresent =
      dnsTarget.dnsRecords.length > 0 || dnsTarget.certificatePackId !== null;
    validateStagingTeardownTargetManifest(target, COMMIT);

    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      sleepImpl: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const before = await adapter.observe(dnsTarget.logicalName, { phase: "before" });
    assert.equal(before.state, "present");
    await adapter.remove(dnsTarget.logicalName, before.externalIds);
    const after = await adapter.observe(dnsTarget.logicalName, { phase: "after" });
    assert.equal(after.state, "absent");
    assert.equal(
      provider.calls.some((call) =>
        call.method === "DELETE" && new URL(call.url).pathname.includes("/workers/domains/")
      ),
      false,
      `${survivor} recovery must not synthesize a missing parent-domain DELETE`
    );
  }
});

test("DNS target drift is refused by the immediate pre-mutation component rebind", async () => {
  for (const drift of ["service", "zone", "record-metadata"]) {
    const target = targetManifest();
    const dnsTarget = target.cloudflare.dns[0];
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const before = await adapter.observe(dnsTarget.logicalName, { phase: "before" });
    if (drift === "service") {
      provider.state.domains.get(dnsTarget.workerDomainId).service = "unreviewed-production-worker";
    } else if (drift === "zone") {
      provider.state.domains.get(dnsTarget.workerDomainId).zone_id = "0".repeat(32);
    } else {
      provider.state.dnsRecords.get(dnsTarget.dnsRecords[0].id).tags.push("changed-after-review");
    }
    await assert.rejects(
      adapter.remove(dnsTarget.logicalName, before.externalIds),
      drift === "service"
        ? /Worker domain service does not match/
        : drift === "zone"
          ? /Worker domain zone id does not match/
          : /unreviewed or changed DNS record/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("each DNS record is rebound by id immediately before its own DELETE", async () => {
  const target = targetManifest();
  const dnsTarget = target.cloudflare.dns[0];
  const second = stagingDnsRecord({
    id: "dns-scanner-second",
    name: dnsTarget.hostname,
    content: "site-behavior-lab-scanner-staging.workers.dev",
    minute: "02"
  });
  dnsTarget.dnsRecords.push(second);
  dnsTarget.dnsRecords.sort((left, right) =>
    compareStagingTeardownCodeUnits(left.id, right.id)
  );
  const provider = fixtureProvider(target);
  const firstId = dnsTarget.dnsRecords[0].id;
  const secondId = dnsTarget.dnsRecords[1].id;
  const fetchImpl = async (url, init) => {
    const response = await provider.fetch(url, init);
    if (
      init.method === "DELETE" &&
      new URL(url).pathname.endsWith(`/dns_records/${firstId}`)
    ) {
      provider.state.dnsRecords.get(secondId).comment = "changed between record deletes";
    }
    return response;
  };
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const before = await adapter.observe(dnsTarget.logicalName, { phase: "before" });
  await assert.rejects(
    adapter.remove(dnsTarget.logicalName, before.externalIds),
    /DNS record changed or disappeared immediately before deletion/
  );
  assert.equal(provider.state.dnsRecords.has(firstId), false);
  assert.equal(provider.state.dnsRecords.has(secondId), true);
  assert.equal(
    provider.calls.some((call) =>
      call.method === "DELETE" &&
      new URL(call.url).pathname.endsWith(`/dns_records/${secondId}`)
    ),
    false
  );
});

test("container application inventory refuses malformed identities and pagination before mutation", async () => {
  for (const mode of [
    "missing-name", "duplicate-id", "missing-result-info", "empty-token", "full-final-page"
  ]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: async (input, init) => {
        const response = await provider.fetch(input, init);
        const url = input instanceof URL ? input : new URL(input);
        if (!url.pathname.endsWith("/containers/dash/applications") ||
          url.searchParams.has("page_token")) return response;
        const body = await fixtureResponseJson(response);
        if (mode === "missing-name") delete body.result[0].name;
        if (mode === "duplicate-id") body.result[1].id = body.result[0].id;
        if (mode === "missing-result-info") delete body.result_info;
        if (mode === "empty-token") body.result_info.next_page_token = "";
        if (mode === "full-final-page") body.result_info.next_page_token = null;
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { "content-type": "application/json" }
        });
      },
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    await assert.rejects(
      adapter.observe(container.logicalName, { phase: "before" }),
      mode === "missing-name"
        ? /invalid identity/
        : mode === "duplicate-id"
          ? /repeated an id/
          : mode === "missing-result-info"
            ? /unsupported result_info/
            : mode === "empty-token"
              ? /invalid page token/
              : /full container application page omitted a continuation token/
    );
    assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
  }
});

test("container jobs omission and false are equivalent while job mode is refused before mutation", async () => {
  {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    provider.state.containers.get(container.applicationId).jobs = false;
    assert.equal(
      (await cloudflareFixtureAdapter(target, provider)
        .observe(container.logicalName, { phase: "before" })).state,
      "present"
    );
    assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
  }
  for (const jobs of [true, null, "false"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    provider.state.containers.get(container.applicationId).jobs = jobs;
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(container.logicalName, { phase: "before" }),
      /jobs must be absent or false; job-mode applications cannot be proven drained/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("container application, deployment, rollout, and placement state is re-sealed immediately before deletion", async () => {
  for (const surface of ["application", "deployment", "rollout", "instance"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl: provider.fetch,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    const before = await adapter.observe(container.logicalName, { phase: "before" });
    if (surface === "application") {
      provider.state.containers.get(container.applicationId).configuration.image =
        `registry.cloudflare.com/${ACCOUNT}/changed@sha256:${"9".repeat(64)}`;
    } else if (surface === "deployment") {
      provider.state.containerDeployments.get(container.applicationId)[0]
        .location.region = "unreviewed";
    } else if (surface === "rollout") {
      provider.state.containerRollouts.get(container.applicationId)[0].status = "pending";
    } else {
      provider.state.containerInstances.get(container.applicationId).instances.push({
        id: "still-running-placement"
      });
    }
    await assert.rejects(
      adapter.remove(container.logicalName, before.externalIds),
      surface === "application"
        ? /reviewed resolved image digest/
        : surface === "deployment"
          ? /complete container deployment set changed after review/
          : surface === "rollout"
          ? /must be one terminal container rollout status/
            : /durable jobs are not quiescent/
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${surface} drift must be refused before any container mutation`
    );
  }
});

test("progressing container rollouts refuse the initial inventory without mutation", async () => {
  const target = targetManifest();
  const container = target.cloudflare.containers[0];
  const provider = fixtureProvider(target);
  provider.state.containerRollouts.get(container.applicationId)[0].status = "progressing";
  const adapter = cloudflareFixtureAdapter(target, provider);
  await assert.rejects(
    adapter.observe(container.logicalName, { phase: "before" }),
    /must be one terminal container rollout status/
  );
  assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
});

test("container rollout pagination uses the provider-final cursor before canonical sorting", async () => {
  const target = targetManifest();
  const container = target.cloudflare.containers[0];
  const ids = [
    "container-rollout-999",
    ...Array.from({ length: 99 }, (_, index) =>
      `container-rollout-${String(index).padStart(3, "0")}`
    ),
    "container-rollout-100"
  ];
  const rollouts = ids.map((id, index) => containerRolloutFixture({
    id,
    applicationId: container.applicationId,
    index
  }));
  target.cloudflare.containers[0].rolloutsSha256 = sha256Bytes(
    serializeCanonicalEvidence([...rollouts].sort((left, right) =>
      compareStagingTeardownCodeUnits(left.id, right.id)
    ))
  );
  const provider = fixtureProvider(target);
  provider.state.containerRollouts.set(container.applicationId, rollouts);
  const adapter = cloudflareFixtureAdapter(target, provider);
  const observation = await adapter.observe(container.logicalName, { phase: "before" });
  assert.equal(observation.state, "present");
  const rolloutCalls = provider.calls.filter((call) =>
    new URL(call.url).pathname.endsWith(`/${container.applicationId}/rollouts`)
  );
  assert.equal(rolloutCalls.length, 2);
  assert.equal(
    new URL(rolloutCalls[1].url).searchParams.get("last"),
    rollouts[99].id,
    "the second page must start after the provider page's final row"
  );
});

test("live container placements refuse initial inventory and the immediate pre-Worker check", async () => {
  for (const phase of ["initial", "pre-worker-delete"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const worker = target.cloudflare.workers[0];
    const provider = fixtureProvider(target);
    const adapter = cloudflareFixtureAdapter(target, provider);
    if (phase === "pre-worker-delete") {
      const before = await adapter.observe(worker.logicalName, { phase: "before" });
      provider.state.domains.clear();
      provider.state.containerInstances.get(container.applicationId).instances.push({
        id: "late-running-placement"
      });
      await assert.rejects(
        adapter.remove(worker.logicalName, before.externalIds),
        /durable jobs are not quiescent/
      );
    } else {
      provider.state.containerInstances.get(container.applicationId).instances.push({
        id: "already-running-placement"
      });
      await assert.rejects(
        adapter.observe(container.logicalName, { phase: "before" }),
        /durable jobs are not quiescent/
      );
    }
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${phase} live placement must refuse before mutation`
    );
  }
});

test("deployment placement quiescence rejects running, ready, connected, and live container state", async () => {
  for (const mode of ["running", "ready", "connected", "container-running"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    const deployment = provider.state.containerDeployments.get(container.applicationId)[0];
    deployment.current_placement = {
      id: `${mode}-placement`,
      created_at: "2026-08-01T00:20:00.000Z",
      deployment_id: deployment.id,
      deployment_version: deployment.version,
      terminate: mode !== "running",
      status: {
        health: mode === "running" ? "running" : "stopped",
        ready: mode === "ready",
        durable_object: mode === "connected" ? "connected" : "disconnected",
        container_status: mode === "container-running" ? "running" : "stopped"
      }
    };
    const adapter = cloudflareFixtureAdapter(target, provider);
    await assert.rejects(
      adapter.observe(container.logicalName, { phase: "before" }),
      mode === "running"
        ? /current_placement is not terminal; durable container work is not quiescent/
        : mode === "ready"
          ? /status.ready must be false before destructive drain/
          : mode === "connected"
            ? /durable object must be disconnected before destructive drain/
            : /status.container_status must be terminal/
    );
    assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
  }
});

test("a stopped, terminating, disconnected deployment placement is accepted", async () => {
  for (const containerStatus of [undefined, "stopped"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    const deployment = provider.state.containerDeployments.get(container.applicationId)[0];
    deployment.current_placement = {
      id: `stopped-placement-${containerStatus ?? "omitted"}`,
      created_at: "2026-08-01T00:20:00.000Z",
      deployment_id: deployment.id,
      deployment_version: deployment.version,
      terminate: true,
      status: {
        health: "stopped",
        ready: false,
        durable_object: "disconnected",
        ...(containerStatus === undefined ? {} : { container_status: containerStatus })
      }
    };
    container.deploymentsSha256 = sha256Bytes(serializeCanonicalEvidence(
      provider.state.containerDeployments.get(container.applicationId)
    ));
    assert.equal(
      (await cloudflareFixtureAdapter(target, provider)
        .observe(container.logicalName, { phase: "before" })).state,
      "present"
    );
    assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
  }
});

test("container instance pagination is complete, bounded, and repetition-safe", async () => {
  for (const mode of ["complete-second-page", "repeated-token", "overflow"]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const itemCount = mode === "overflow" ? 201 : 101;
    const durableObjects = Array.from({ length: itemCount }, (_, index) => ({
      id: `inactive-container-do-${String(index).padStart(3, "0")}`,
      assigned_at: "2026-08-01T00:10:00.000Z",
      name: `completed-replay-${String(index).padStart(3, "0")}`
    }));
    container.inactiveDurableObjectsSha256 = sha256Bytes(serializeCanonicalEvidence(
      normalizedInactiveContainerDurableObjects(durableObjects)
    ));
    const provider = fixtureProvider(target);
    provider.state.containerInstances.get(container.applicationId).durableObjects = durableObjects;
    if (mode === "repeated-token") {
      provider.state.containerInstanceNextTokenOverride = "instances-100";
    }
    const adapter = cloudflareFixtureAdapter(target, provider);
    if (mode === "complete-second-page") {
      const observation = await adapter.observe(container.logicalName, { phase: "before" });
      assert.equal(observation.state, "present");
      assert.equal(
        provider.calls.some((call) =>
          new URL(call.url).searchParams.get("page_token") === "instances-100"
        ),
        true
      );
    } else {
      await assert.rejects(
        adapter.observe(container.logicalName, { phase: "before" }),
        mode === "repeated-token"
          ? /invalid or repeated page token/
          : /instance pagination exceeded 2 pages/
      );
      assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
    }
  }
});

test("container instance pages require explicit arrays and exact pagination metadata before mutation", async () => {
  for (const mode of [
    "null-durable-objects",
    "wrong-durable-objects",
    "missing-result-info",
    "missing-next-page-token",
    "empty-next-page-token",
    "null-name",
    "null-deployment",
    "string-placement",
    "full-final-page"
  ]) {
    const target = targetManifest();
    const container = target.cloudflare.containers[0];
    const provider = fixtureProvider(target);
    if (mode === "full-final-page") {
      provider.state.containerInstances.get(container.applicationId).durableObjects =
        Array.from({ length: 100 }, (_, index) => ({
          id: `full-final-page-${String(index).padStart(3, "0")}`,
          assigned_at: "2026-08-01T00:10:00.000Z",
          name: `inactive-${String(index).padStart(3, "0")}`
        }));
    }
    const inactive = provider.state.containerInstances
      .get(container.applicationId).durableObjects[0];
    if (mode === "null-name") inactive.name = null;
    if (mode === "null-deployment") inactive.deployment_id = null;
    if (mode === "string-placement") inactive.placement_id = "live-placement";
    const fetchImpl = [
      "full-final-page", "null-name", "null-deployment", "string-placement"
    ].includes(mode)
      ? provider.fetch
      : async (input, init) => {
          const response = await provider.fetch(input, init);
          const url = input instanceof URL ? input : new URL(input);
          if (!url.pathname.endsWith(`/${container.applicationId}/instances`)) return response;
          const body = await fixtureResponseJson(response);
          if (mode === "null-durable-objects") body.result.durable_objects = null;
          if (mode === "wrong-durable-objects") body.result.durable_objects = {};
          if (mode === "missing-result-info") delete body.result_info;
          if (mode === "missing-next-page-token") body.result_info = {};
          if (mode === "empty-next-page-token") body.result_info.next_page_token = "";
          return new Response(JSON.stringify(body), {
            status: response.status,
            headers: { "content-type": "application/json" }
          });
        };
    const adapter = createCloudflareStagingTeardownAdapter({
      manifest: target,
      credentials: exactCredentials(),
      sessionId: SESSION_ID,
      fetchImpl,
      persistRaw: async () => undefined,
      apiBaseUrl: "https://api.cloudflare.test"
    });
    await assert.rejects(
      adapter.observe(container.logicalName, { phase: "before" }),
      mode === "null-durable-objects" || mode === "wrong-durable-objects"
        ? /Durable Object page exceeds the bounded provider shape/
        : mode === "missing-result-info" || mode === "missing-next-page-token"
          ? /unsupported result_info/
          : mode === "empty-next-page-token"
            ? /invalid page token/
            : mode === "null-name"
              ? /name must be absent or bounded provider text/
              : mode === "null-deployment"
                ? /still attached to a live container deployment/
                : mode === "string-placement"
                  ? /still attached to a live container placement/
            : /full container instance page omitted a continuation token/
    );
    assert.equal(
      provider.calls.some((call) => call.method === "DELETE"),
      false,
      `${mode} must fail before mutation`
    );
  }
});

test("an omitted optional container durable_objects array canonicalizes to empty", async () => {
  const target = targetManifest();
  const container = target.cloudflare.containers[0];
  container.inactiveDurableObjectsSha256 = sha256Bytes(serializeCanonicalEvidence([]));
  const provider = fixtureProvider(target);
  provider.state.containerInstances.get(container.applicationId).durableObjects = [];
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: async (input, init) => {
      const response = await provider.fetch(input, init);
      const url = input instanceof URL ? input : new URL(input);
      if (!url.pathname.endsWith(`/${container.applicationId}/instances`)) return response;
      const body = await fixtureResponseJson(response);
      delete body.result.durable_objects;
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { "content-type": "application/json" }
      });
    },
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  assert.equal(
    (await adapter.observe(container.logicalName, { phase: "before" })).state,
    "present"
  );
  assert.equal(provider.calls.some((call) => call.method !== "GET"), false);
});

test("a pending exact certificate resumes convergence without a second DELETE", async () => {
  const target = targetManifest();
  const dnsTarget = target.cloudflare.dns[0];
  dnsTarget.workerDomainExpectedPresent = false;
  dnsTarget.workerDomainId = null;
  dnsTarget.workerDomainCertId = null;
  dnsTarget.dnsRecords = [];
  dnsTarget.expectedPresent = true;
  dnsTarget.certificatePack = projectStagingTeardownCertificatePack(certificatePackFixture({
    id: dnsTarget.certificatePackId,
    hostname: dnsTarget.hostname,
    certificateId: null,
    status: "pending_deletion"
  }), "pending recovery certificate pack");
  dnsTarget.certificatePackSha256 = stagingTeardownProjectionSha256(
    dnsTarget.certificatePack
  );
  validateStagingTeardownTargetManifest(target, COMMIT);
  const provider = fixtureProvider(target, { certificatePollsBeforeDeleted: 1 });
  provider.state.certificates.get(dnsTarget.certificatePackId).status = "pending_deletion";
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    sleepImpl: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const before = await adapter.observe(dnsTarget.logicalName, { phase: "before" });
  await adapter.remove(dnsTarget.logicalName, before.externalIds);
  assert.equal((await adapter.observe(dnsTarget.logicalName, { phase: "after" })).state, "absent");
  assert.equal(
    provider.calls.some((call) =>
      call.method === "DELETE" && new URL(call.url).pathname.includes("/certificate_packs/")
    ),
    false
  );
});

test("a surviving container remains exact and removable after its Worker is absent", async () => {
  const target = targetManifest();
  const worker = target.cloudflare.workers[0];
  markWorkerTargetAbsent(worker);
  const container = target.cloudflare.containers[0];
  validateStagingTeardownTargetManifest(target, COMMIT);
  const provider = fixtureProvider(target);
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  const before = await adapter.observe(container.logicalName, { phase: "before" });
  await adapter.remove(container.logicalName, before.externalIds);
  assert.equal((await adapter.observe(container.logicalName, { phase: "after" })).state, "absent");

  const mismatchedTarget = targetManifest();
  const mismatchedProvider = fixtureProvider(mismatchedTarget);
  mismatchedProvider.state.containers.get(container.applicationId).durable_objects.namespace_id = "other-namespace";
  const mismatched = createCloudflareStagingTeardownAdapter({
    manifest: mismatchedTarget,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: mismatchedProvider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  await assert.rejects(
    mismatched.observe(container.logicalName, { phase: "before" }),
    /container Durable Object namespace id does not match/
  );
});

test("an orphan Durable Object namespace fails closed for manual tombstone escalation", async () => {
  const target = targetManifest();
  const worker = target.cloudflare.workers[0];
  markWorkerTargetAbsent(worker);
  validateStagingTeardownTargetManifest(target, COMMIT);
  const provider = fixtureProvider(target);
  provider.state.durableObjects.set("orphan-scanner-namespace", {
    id: "orphan-scanner-namespace",
    class: worker.durableObjectClassName,
    script: worker.scriptName
  });
  const adapter = createCloudflareStagingTeardownAdapter({
    manifest: target,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async () => undefined,
    apiBaseUrl: "https://api.cloudflare.test"
  });
  await assert.rejects(
    adapter.observe(worker.logicalName, { phase: "before" }),
    /Worker is absent but its exact Durable Object namespace remains/
  );
  assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
});

test("a scriptless Durable Object namespace is ambiguous and refuses absent-Worker proof", async () => {
  const target = targetManifest();
  const worker = target.cloudflare.workers[0];
  markWorkerTargetAbsent(worker);
  validateStagingTeardownTargetManifest(target, COMMIT);
  const provider = fixtureProvider(target);
  provider.state.durableObjects.set("ambiguous-scriptless-namespace", {
    id: "ambiguous-scriptless-namespace",
    class: worker.durableObjectClassName
  });
  const adapter = cloudflareFixtureAdapter(target, provider);
  await assert.rejects(
    adapter.observe(worker.logicalName, { phase: "before" }),
    /ambiguous ownership because its script identity is absent/
  );
  assert.equal(provider.calls.some((call) => call.method === "DELETE"), false);
});

test("the exact composite adapter tears down all twelve resources with bounded pagination", async () => {
  const target = targetManifest();
  const provider = fixtureProvider(target);
  const rawNames = new Set();
  const adapter = createCompositeStagingTeardownProviderAdapter({
    targetManifest: target,
    trustedCommit: COMMIT,
    trustedCloudflareAccountId: ACCOUNT,
    trustedCloudflareZoneId: ZONE,
    credentials: exactCredentials(),
    sessionId: SESSION_ID,
    fetchImpl: provider.fetch,
    persistRaw: async (name, bytes) => {
      assert.equal(rawNames.has(name), false, `private raw response name repeated: ${name}`);
      assert.ok(bytes instanceof Uint8Array && bytes.byteLength >= 0);
      rawNames.add(name);
    },
    cloudflareApiBaseUrl: "https://api.cloudflare.test",
    githubApiBaseUrl: "https://api.github.test"
  });
  assert.equal(adapter.kind, STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND);

  // Snapshot the non-target universe before anything destructive happens.
  const nonTargetBefore = {
    r2OperatorTokenId: provider.state.r2OperatorToken?.id,
    additionalAccountTokens: provider.state.additionalAccountTokens.length,
    r2OperatorTokenName: provider.state.r2OperatorToken?.name
  };
  assert.ok(
    nonTargetBefore.r2OperatorTokenId !== undefined,
    "the fixture must contain non-target resources for this assertion to mean anything"
  );

  let tick = 0;
  const transcript = await runStagingTeardown({
    adapter,
    resources: STAGING_RESOURCE_CONTRACT,
    session: { id: SESSION_ID },
    stagingSourceCommit: COMMIT,
    now: () => new Date(Date.parse("2026-08-01T12:00:00.000Z") + tick++).toISOString()
  });
  assert.ok(transcript.inventory.before.every((entry) => entry.state === "present"));
  assert.ok(transcript.inventory.after.every((entry) => entry.state === "absent"));
  assert.equal(transcript.inventory.actions.length, 12);
  assert.ok(rawNames.size > 60, "every paginated/read/delete provider response should reach the private sink");
  assert.equal(provider.state.workers.size, 0);
  assert.equal(provider.state.domains.size, 0);
  assert.equal(provider.state.dnsRecords.size, 0);
  assert.equal(provider.state.containers.size, 0);
  assert.equal(provider.state.buckets.size, 0);
  assert.equal(provider.state.credentials.size, 0);

  // The target maps emptying says the manifest was torn down. It says nothing
  // about what ELSE was touched, and "deletes only what the manifest names" is
  // the property this lane exists to guarantee. Compare the non-target universe
  // against what existed before, independently of the fixture's 404s: if those
  // are ever relaxed, a stray delete still fails here.
  assert.equal(
    provider.state.r2OperatorToken?.id,
    nonTargetBefore.r2OperatorTokenId,
    "the protected R2 operator token must survive the teardown"
  );
  assert.equal(
    provider.state.r2OperatorToken?.name,
    nonTargetBefore.r2OperatorTokenName,
    "the protected R2 operator token must survive intact, not merely by id"
  );
  assert.equal(provider.state.runner, null);

  const deletePaths = provider.calls
    .filter((call) => call.method === "DELETE")
    .map((call) => new URL(call.url).pathname);
  assert.ok(deletePaths.some((value) => value.endsWith("/dns_records/dns-scanner")));
  assert.ok(deletePaths.some((value) => value.endsWith("/dns_records/dns-watch")));
  assert.ok(deletePaths.some((value) => value.endsWith("/objects/reports/a%20b%25.json")));
  assert.ok(deletePaths.some((value) => value.endsWith("/objects/reports/%E8%B3%87%E6%96%99%3F%23.json")));
  assert.ok(deletePaths.some((value) => value.endsWith("/objects/reports/%252e%252e/literal%3F%23")));
  const bucketInventoryCalls = provider.calls.filter((call) =>
    new URL(call.url).pathname.endsWith("/r2/buckets")
  );
  assert.equal(bucketInventoryCalls.length, 12);
  for (const jurisdiction of ["default", "eu", "fedramp"]) {
    assert.equal(
      bucketInventoryCalls.filter((call) =>
        call.headers["cf-r2-jurisdiction"] === jurisdiction
      ).length,
      4,
      `${jurisdiction} must be inventoried once before, twice at remove-check, and once after`
    );
  }

  const receipt = buildStagingTeardownEvidence({
    sourceBytes: Buffer.from(serializeCanonicalEvidence({
      ...transcript,
      targetManifestSha256: sha256Bytes(serializeCanonicalEvidence(target))
    }), "utf8")
  });
  assert.equal(receipt.stagingSourceCommit, COMMIT);
  assert.equal(
    receipt.targetManifestSha256,
    sha256Bytes(serializeCanonicalEvidence(target))
  );
});

function fixtureProvider(target, { cascadeDns = false, certificatePollsBeforeDeleted = 0 } = {}) {
  const accountZones = [
    {
      id: target.cloudflare.zoneId,
      name: "sitebehavior.org",
      type: "full",
      account: { id: target.cloudflare.accountId, name: "fixture account" }
    },
    {
      id: "d".repeat(32),
      name: "staging.internal",
      type: "internal",
      account: { id: target.cloudflare.accountId, name: "fixture account" }
    }
  ];
  const state = {
    workers: new Set(
      target.cloudflare.workers.filter((entry) => entry.expectedPresent).map((entry) => entry.scriptName)
    ),
    pipelineSinks: [],
    slurperJobs: [],
    additionalAccountTokens: [],
    permissionGroups: r2WriterPermissionGroups(),
    workerGraphs: new Map(target.cloudflare.workers.flatMap((entry) =>
      entry.expectedPresent
        ? [[entry.workerId, {
            id: entry.workerId,
            name: entry.scriptName,
            references: {
              dispatch_namespace_outbounds: [],
              domains: [],
              durable_objects: [{
                worker_id: entry.workerId,
                worker_name: entry.scriptName,
                namespace_id: entry.durableObjectNamespaceId,
                namespace_name: `${entry.scriptName}-namespace`
              }],
              queues: [],
              workers: []
            },
            tail_consumers: [],
            subdomain: { enabled: false, previews_enabled: false }
          }]]
        : []
    )),
    workerScripts: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, {
            id: entry.scriptName,
            etag: entry.latestScriptEtag,
            created_on: entry.createdOn,
            modified_on: entry.modifiedOn,
            migration_tag: `durable-replay-${index}`
          }]]
        : []
    )),
    workerVersionSettings: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, fixtureWorkerVersionSettings(entry, index)]]
        : []
    )),
    workerScriptSettings: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, fixtureWorkerScriptSettings(index)]]
        : []
    )),
    workerSecrets: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, index === 0
            ? [{ name: "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN", type: "secret_text" }]
            : []]]
        : []
    )),
    workerVersions: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, fixtureWorkerVersions(entry, index)]]
        : []
    )),
    workerDeployments: new Map(target.cloudflare.workers.flatMap((entry, index) =>
      entry.expectedPresent
        ? [[entry.scriptName, fixtureWorkerDeployments(index)]]
        : []
    )),
    externalWorkerReferences: [],
    classicWorkerRoutes: [],
    accountZones,
    emailRulesByZone: new Map(accountZones.map((zone) => [zone.id, []])),
    emailCatchAllByZone: new Map(accountZones.map((zone, index) => [zone.id, {
      id: `catch-all-${index}`,
      enabled: false,
      matchers: [index === 0
        ? { type: "all" }
        : { type: "all", field: null, value: "" }],
      actions: [index === 0
        ? { type: "drop", value: [] }
        : { type: "drop" }],
      source: "api"
    }])),
    workerBuildTriggers: [],
    workerBuildDeployHooks: [],
    workerBuildExecutions: new Map(target.cloudflare.workers.flatMap((entry) =>
      entry.expectedPresent ? [[entry.workerId, []]] : []
    )),
    eventSubscriptions: [],
    cronSchedules: [],
    tailProducers: [],
    workersDevEnabled: false,
    durableObjects: new Map(target.cloudflare.workers.flatMap((entry) =>
      entry.expectedPresent
        ? [[entry.durableObjectNamespaceId, {
            id: entry.durableObjectNamespaceId,
            class: entry.durableObjectClassName,
            script: entry.scriptName
          }]]
        : []
    )),
    domains: new Map(target.cloudflare.dns.flatMap((entry) =>
      entry.workerDomainExpectedPresent
        ? [[entry.workerDomainId, {
            id: entry.workerDomainId,
            hostname: entry.hostname,
            service: entry.workerName,
            cert_id: entry.workerDomainCertId,
            zone_id: target.cloudflare.zoneId,
            zone_name: "sitebehavior.org"
          }]]
        : []
    )),
    dnsRecords: new Map(target.cloudflare.dns.flatMap((entry) =>
      entry.dnsRecords.map((record) => [record.id, providerDnsRecord(record)])
    )),
    certificates: new Map(target.cloudflare.dns.flatMap((entry) =>
      entry.certificatePackId === null
        ? []
        : [[entry.certificatePackId, {
            ...certificatePackFixture({
              id: entry.certificatePackId,
              hostname: entry.hostname,
              certificateId: entry.workerDomainCertId
            }),
            pollsRemaining: certificatePollsBeforeDeleted
          }]]
    )),
    containers: new Map(target.cloudflare.containers.flatMap((entry, index) => {
      if (!entry.expectedPresent) return [];
      const fixture = containerFixtureFacts({
        applicationId: entry.applicationId,
        applicationName: entry.applicationName,
        namespaceId: entry.durableObjectNamespaceId,
        index
      });
      return [[entry.applicationId, fixture.application]];
    })),
    containerDeployments: new Map(target.cloudflare.containers.flatMap((entry, index) => {
      if (!entry.expectedPresent) return [];
      const fixture = containerFixtureFacts({
        applicationId: entry.applicationId,
        applicationName: entry.applicationName,
        namespaceId: entry.durableObjectNamespaceId,
        index
      });
      return [[entry.applicationId, fixture.deployments]];
    })),
    containerRollouts: new Map(target.cloudflare.containers.flatMap((entry, index) => {
      if (!entry.expectedPresent) return [];
      const fixture = containerFixtureFacts({
        applicationId: entry.applicationId,
        applicationName: entry.applicationName,
        namespaceId: entry.durableObjectNamespaceId,
        index
      });
      return [[entry.applicationId, fixture.rollouts]];
    })),
    containerInstances: new Map(target.cloudflare.containers.flatMap((entry, index) => {
      if (!entry.expectedPresent) return [];
      const fixture = containerFixtureFacts({
        applicationId: entry.applicationId,
        applicationName: entry.applicationName,
        namespaceId: entry.durableObjectNamespaceId,
        index
      });
      return [[entry.applicationId, {
        instances: [],
        durableObjects: fixture.inactiveDurableObjects
      }]];
    })),
    containerInstanceNextTokenOverride: null,
    nonDefaultBuckets: { eu: [], fedramp: [] },
    buckets: new Map(target.cloudflare.buckets.flatMap((entry) =>
      entry.expectedPresent
        ? [[entry.bucketName, {
            name: entry.bucketName,
            creation_date: entry.expectedCreationDate,
            jurisdiction: entry.expectedJurisdiction,
            location: entry.expectedLocation,
            storage_class: entry.expectedStorageClass,
            lifecycleRules: structuredClone(entry.expectedLifecycleRules),
            corsRules: [],
            lockRules: [],
            eventQueues: [],
            customDomains: [],
            managedDomain: {
              bucketId: entry.managedDomainBucketId,
              domain: entry.managedDomainDomain,
              enabled: false
            },
            sippy: { enabled: false },
            catalog: false,
            objects: new Map(entry.objects.map((object) => [object.key, providerObject(object)]))
          }]]
        : []
    )),
    credentials: new Map(target.cloudflare.credentialSets.flatMap((entry) =>
      entry.expectedPresent
        ? [[entry.tokenId, {
            id: entry.tokenId,
            name: entry.tokenName,
            policies: entry.expectedPolicies,
            status: "active"
          }]]
        : []
    )),
    r2OperatorToken: {
      id: R2_OPERATOR_TOKEN_ID,
      name: "protected-staging-teardown-r2-operator",
      policies: [{
        effect: "allow",
        permission_groups: [{
          id: R2_STORAGE_WRITE_PERMISSION_GROUP_ID,
          name: "Workers R2 Storage Write"
        }],
        resources: {
          [`com.cloudflare.api.account.${ACCOUNT}`]: {
            "com.cloudflare.edge.r2.bucket.*": "*"
          }
        }
      }],
      status: "active"
    },
    runner: target.github.runner.expectedPresent
      ? {
          id: target.github.runner.id,
          name: target.github.runner.name,
          busy: false,
          status: "offline",
          labels: target.github.runner.labels.map((name) => ({ name }))
        }
      : null
  };
  const calls = [];

  function cf(result, resultInfo = undefined, status = 200) {
    return new Response(
      JSON.stringify({
        success: status < 400,
        errors: status < 400 ? [] : [{ code: 1000 }],
        result,
        ...(resultInfo === undefined ? {} : { result_info: resultInfo })
      }),
      { status, headers: { "content-type": "application/json" } }
    );
  }
  function cfNoResult(status = 200) {
    return new Response(
      JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 1000 }] }),
      { status, headers: { "content-type": "application/json" } }
    );
  }
  function cfError(code, message, status = 404) {
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null
      }),
      { status, headers: { "content-type": "application/json" } }
    );
  }
  function noContent() {
    return new Response(null, { status: 204 });
  }
  function expectedToken(pathname, host, method) {
    if (host === "api.github.test") return TOKENS.github;
    if (
      pathname.endsWith("/workers/scripts") ||
      /\/workers\/scripts\/[^/]+\/deployments$/.test(pathname) ||
      /\/workers\/scripts\/[^/]+\/versions\/[^/]+$/.test(pathname) ||
      pathname.includes("/pipelines/v1/sinks")
    ) {
      return TOKENS.observation;
    }
    if (
      method === "GET" &&
      (
        pathname.endsWith("/workers/scripts-search") ||
        pathname.endsWith("/workers/scripts") ||
        /\/workers\/scripts\/[^/]+\/(?:settings|script-settings|secrets|deployments)$/.test(pathname) ||
        /\/workers\/scripts\/[^/]+\/versions(?:\/[^/]+)?$/.test(pathname)
      )
    ) return TOKENS.observation;
    if (pathname.endsWith("/tokens/verify") || pathname.includes("/slurper/jobs")) {
      return TOKENS.r2;
    }
    if (
      pathname.includes("/r2-catalog") ||
      pathname === "/client/v4/zones" ||
      pathname.includes("/email/routing/") ||
      pathname.includes("/event_subscriptions/subscriptions") ||
      /\/zones\/[^/]+\/workers\/routes$/.test(pathname) ||
      pathname.includes("/builds/workers/")
    ) {
      return TOKENS.observation;
    }
    if (pathname.includes("/r2/")) return TOKENS.r2;
    if (pathname.includes("/tokens")) return TOKENS.admin;
    if (pathname.includes("/dns_records") || pathname.includes("/certificate_packs")) return TOKENS.dns;
    return TOKENS.compute;
  }

  async function fetch(input, init) {
    const url = input instanceof URL ? input : new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ url: url.href, method, headers: { ...init.headers } });
    assert.equal(init.headers.authorization, `Bearer ${expectedToken(url.pathname, url.host, method)}`);
    if (url.pathname.includes("/r2/buckets")) {
      assert.ok(
        ["default", "eu", "fedramp"].includes(init.headers["cf-r2-jurisdiction"]),
        "every R2 bucket request must select one documented jurisdiction explicitly"
      );
    }

    if (url.host === "api.github.test") {
      if (method === "DELETE") {
        assert.equal(url.pathname, "/repos/iAnonymous3000/site-behavior-lab/actions/runners/42");
        state.runner = null;
        return noContent();
      }
      const dummies = Array.from({ length: 100 }, (_, index) => ({
        id: 1000 + index,
        name: `unrelated-${index}`,
        busy: false,
        status: "offline",
        labels: []
      }));
      const all = state.runner === null ? dummies : [...dummies, state.runner];
      const page = Number(url.searchParams.get("page"));
      return new Response(JSON.stringify({
        total_count: all.length,
        runners: page === 1 ? all.slice(0, 100) : all.slice(100)
      }), { headers: { "content-type": "application/json" } });
    }

    const pathname = url.pathname;
    if (
      pathname.includes("/r2/buckets") ||
      pathname.includes("/event_notifications/r2/")
    ) {
      const jurisdiction = init.headers["cf-r2-jurisdiction"];
      if (pathname.endsWith("/r2/buckets")) {
        assert.ok(
          ["default", "eu", "fedramp"].includes(jurisdiction),
          "complete account R2 inventories must select an explicit jurisdiction"
        );
      } else {
        assert.equal(
          jurisdiction,
          "default",
          "every target-scoped R2 request must remain in the sealed default jurisdiction"
        );
      }
    }
    if (
      method === "GET" &&
      pathname.endsWith(`/accounts/${ACCOUNT}/event_subscriptions/subscriptions`)
    ) {
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page"));
      const pageValues = state.eventSubscriptions.slice((page - 1) * 100, page * 100);
      return cf(structuredClone(pageValues), {
        count: pageValues.length,
        page,
        per_page: 100,
        total_count: state.eventSubscriptions.length,
        total_pages: state.eventSubscriptions.length === 0
          ? 0
          : Math.ceil(state.eventSubscriptions.length / 100)
      });
    }
    if (method === "GET" && pathname.endsWith("/pipelines/v1/sinks")) {
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page"));
      const pageSinks = state.pipelineSinks.slice((page - 1) * 100, page * 100);
      return cf(structuredClone(pageSinks), {
        count: pageSinks.length,
        page,
        per_page: 100,
        total_count: state.pipelineSinks.length
      });
    }
    if (method === "GET" && pathname.endsWith("/slurper/jobs")) {
      assert.equal(url.searchParams.get("limit"), "50");
      const offset = Number(url.searchParams.get("offset"));
      return cf(structuredClone(state.slurperJobs.slice(offset, offset + 50)));
    }
    if (method === "GET" && pathname.endsWith("/tokens/verify")) {
      return cf({ id: state.r2OperatorToken.id, status: state.r2OperatorToken.status });
    }
    const workerBuildList = pathname.match(
      /\/builds\/workers\/([^/]+)\/(triggers|deploy_hooks)$/
    );
    if (method === "GET" && workerBuildList) {
      assert.equal(url.search, "", "Worker Builds attachment endpoints are unpaginated");
      const values = workerBuildList[2] === "triggers"
        ? state.workerBuildTriggers
        : state.workerBuildDeployHooks;
      return cf(values, values.length === 0
        ? { count: 0, total_count: 0, total_pages: 0 }
        : undefined);
    }
    const workerBuildExecutions = pathname.match(
      /\/builds\/workers\/([^/]+)\/builds$/
    );
    if (method === "GET" && workerBuildExecutions) {
      assert.equal(url.searchParams.get("per_page"), "200");
      const page = Number(url.searchParams.get("page"));
      const workerId = decodeURIComponent(workerBuildExecutions[1]);
      const values = state.workerBuildExecutions.get(workerId);
      assert.ok(values, "Worker Builds execution inventory requires a present immutable Worker");
      const pageValues = values.slice((page - 1) * 200, page * 200);
      return cf(structuredClone(pageValues), {
        count: pageValues.length,
        page,
        per_page: 200,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : Math.ceil(values.length / 200)
      });
    }
    if (method === "GET" && pathname === "/client/v4/zones") {
      assert.equal(url.searchParams.get("account.id"), target.cloudflare.accountId);
      assert.equal(url.searchParams.get("per_page"), "5");
      assert.equal(url.searchParams.has("type"), false, "internal Zones must not be filtered out");
      assert.equal(url.searchParams.has("status"), false, "inactive account Zones must not be filtered out");
      const page = Number(url.searchParams.get("page"));
      const pageValues = state.accountZones.slice((page - 1) * 5, page * 5);
      return cf(pageValues, {
        count: pageValues.length,
        page,
        per_page: 5,
        total_count: state.accountZones.length,
        total_pages: state.accountZones.length === 0
          ? 0
          : Math.ceil(state.accountZones.length / 5)
      });
    }
    const emailCatchAll = pathname.match(
      /\/zones\/([^/]+)\/email\/routing\/rules\/catch_all$/
    );
    if (method === "GET" && emailCatchAll) {
      const zoneId = decodeURIComponent(emailCatchAll[1]);
      const value = state.emailCatchAllByZone.get(zoneId);
      assert.ok(value, "catch-all inventory requires a known account Zone");
      return cf(value);
    }
    const emailRules = pathname.match(
      /\/zones\/([^/]+)\/email\/routing\/rules$/
    );
    if (method === "GET" && emailRules) {
      assert.equal(url.searchParams.get("per_page"), "50");
      const zoneId = decodeURIComponent(emailRules[1]);
      const values = state.emailRulesByZone.get(zoneId);
      assert.ok(values, "Email Routing inventory requires a known account Zone");
      const page = Number(url.searchParams.get("page"));
      const pageValues = values.slice((page - 1) * 50, page * 50);
      return cf(pageValues, {
        count: pageValues.length,
        page,
        per_page: 50,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : Math.ceil(values.length / 50)
      });
    }
    const zoneWorkerRoutes = pathname.match(/\/zones\/([^/]+)\/workers\/routes$/);
    if (method === "GET" && zoneWorkerRoutes) {
      const zoneId = decodeURIComponent(zoneWorkerRoutes[1]);
      assert.ok(
        state.accountZones.some((zone) => zone.id === zoneId),
        "classic Worker routes inventory requires a known account Zone"
      );
      return cf(state.classicWorkerRoutes.filter((route) =>
        route.zoneId === undefined || route.zoneId === zoneId
      ));
    }
    if (method === "GET" && pathname.endsWith("/workers/durable_objects/namespaces")) {
      const values = [...state.durableObjects.values()];
      return cf(values, {
        count: values.length,
        page: 1,
        per_page: 100,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : 1
      });
    }
    if (method === "GET" && pathname.endsWith("/workers/scripts-search")) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("page"), "1");
      const id = url.searchParams.get("id");
      const selected = id === null
        ? [...state.workerGraphs.values()]
        : [state.workerGraphs.get(id)].filter(Boolean);
      const values = selected.map((worker) => {
        const workerTarget = target.cloudflare.workers.find((entry) =>
          entry.workerId === worker.id
        );
        return {
          id: worker.id,
          script_name: worker.name,
          created_on: workerTarget.createdOn,
          modified_on: workerTarget.modifiedOn,
          environment_is_default: true,
          environment_name: "production"
        };
      });
      return cf(values, {
        count: values.length,
        page: 1,
        per_page: 100,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : 1
      });
    }
    const workerGraph = pathname.match(/\/workers\/workers\/([^/]+)$/);
    if (method === "GET" && workerGraph) {
      const value = state.workerGraphs.get(decodeURIComponent(workerGraph[1]));
      return value === undefined ? cf(null, undefined, 404) : cf(value);
    }
    const workerSettings = pathname.match(/\/workers\/scripts\/([^/]+)\/settings$/);
    if (method === "GET" && workerSettings) {
      const name = decodeURIComponent(workerSettings[1]);
      if (!state.workers.has(name)) return cf(null, undefined, 404);
      return cf(structuredClone(state.workerVersionSettings.get(name)));
    }
    if (method === "GET" && pathname.endsWith("/workers/scripts")) {
      assert.equal(url.search, "", "Worker script list is a documented SinglePage endpoint");
      return cf([...state.workerScripts.values()].map((script) => structuredClone(script)));
    }
    const scriptSettings = pathname.match(/\/workers\/scripts\/([^/]+)\/script-settings$/);
    if (method === "GET" && scriptSettings) {
      assert.equal(url.search, "");
      const name = decodeURIComponent(scriptSettings[1]);
      const value = state.workerScriptSettings.get(name);
      return value === undefined ? cf(null, undefined, 404) : cf(structuredClone(value));
    }
    const scriptSecrets = pathname.match(/\/workers\/scripts\/([^/]+)\/secrets$/);
    if (method === "GET" && scriptSecrets) {
      assert.equal(url.search, "", "Worker secret list is a documented SinglePage endpoint");
      const name = decodeURIComponent(scriptSecrets[1]);
      const value = state.workerSecrets.get(name);
      return value === undefined ? cf(null, undefined, 404) : cf(structuredClone(value));
    }
    const versionDetail = pathname.match(
      /\/workers\/scripts\/([^/]+)\/versions\/([^/]+)$/
    );
    if (method === "GET" && versionDetail) {
      assert.equal(url.search, "");
      const name = decodeURIComponent(versionDetail[1]);
      const versionId = decodeURIComponent(versionDetail[2]);
      const value = state.workerVersions.get(name)?.find((version) => version.id === versionId);
      return value === undefined ? cf(null, undefined, 404) : cf(structuredClone(value));
    }
    const versionList = pathname.match(/\/workers\/scripts\/([^/]+)\/versions$/);
    if (method === "GET" && versionList) {
      assert.equal(url.searchParams.get("per_page"), "10");
      const name = decodeURIComponent(versionList[1]);
      const values = state.workerVersions.get(name);
      if (values === undefined) return cf(null, undefined, 404);
      const page = Number(url.searchParams.get("page"));
      const pageValues = values.slice((page - 1) * 10, page * 10).map((version) => ({
        id: version.id,
        number: version.number,
        metadata: structuredClone(version.metadata)
      }));
      return cf({ items: pageValues }, {
        count: pageValues.length,
        page,
        per_page: 10,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : Math.ceil(values.length / 10)
      });
    }
    const deployments = pathname.match(/\/workers\/scripts\/([^/]+)\/deployments$/);
    if (method === "GET" && deployments) {
      assert.equal(url.search, "");
      const name = decodeURIComponent(deployments[1]);
      const value = state.workerDeployments.get(name);
      return value === undefined ? cf(null, undefined, 404) : cf(structuredClone(value));
    }
    const references = pathname.match(/\/workers\/scripts\/([^/]+)\/references$/);
    if (method === "GET" && references) {
      const name = decodeURIComponent(references[1]);
      return cf({
        services: { incoming: [...state.externalWorkerReferences], pages_function: false },
        durable_objects: [{
          service: name,
          durable_object_namespace_name: "ScannerContainer"
        }],
        dispatch_outbounds: []
      });
    }
    if (method === "GET" && pathname.includes("/workers/tails/by-consumer/")) {
      return cf([...state.tailProducers]);
    }
    if (method === "GET" && pathname.endsWith("/schedules")) {
      return cf({ schedules: [...state.cronSchedules] });
    }
    if (method === "GET" && pathname.endsWith("/subdomain")) {
      return cf({ enabled: state.workersDevEnabled, previews_enabled: false });
    }
    const workerDelete = pathname.match(/\/workers\/scripts\/([^/]+)$/);
    if (method === "DELETE" && workerDelete) {
      assert.equal(url.searchParams.has("force"), false);
      const name = decodeURIComponent(workerDelete[1]);
      state.workers.delete(name);
      state.workerScripts.delete(name);
      state.workerVersionSettings.delete(name);
      state.workerScriptSettings.delete(name);
      state.workerSecrets.delete(name);
      state.workerVersions.delete(name);
      state.workerDeployments.delete(name);
      const workerTarget = target.cloudflare.workers.find((entry) => entry.scriptName === name);
      state.workerGraphs.delete(workerTarget.workerId);
      state.durableObjects.delete(workerTarget.durableObjectNamespaceId);
      return noContent();
    }

    if (method === "GET" && pathname.endsWith("/workers/domains")) {
      assert.equal(url.search, "", "Worker domains is a documented SinglePage endpoint");
      const values = [...state.domains.values()];
      return cf(values, { total_count: values.length, total_pages: 1 });
    }
    const domainDelete = pathname.match(/\/workers\/domains\/([^/]+)$/);
    if (method === "DELETE" && domainDelete) {
      const id = decodeURIComponent(domainDelete[1]);
      const domain = state.domains.get(id);
      // A real provider 404s an unknown id. Returning success made a delete of
      // something the adapter never observed indistinguishable from a correct
      // one, so the suite could not detect out-of-manifest deletion at all.
      if (domain === undefined) return cf(null, undefined, 404);
      state.domains.delete(id);
      if (cascadeDns && domain !== undefined) {
        for (const [recordId, record] of state.dnsRecords) {
          if (record.name === domain.hostname) state.dnsRecords.delete(recordId);
        }
      }
      return cfNoResult();
    }
    if (method === "GET" && pathname.endsWith("/dns_records")) {
      const requestedName = url.searchParams.get("name");
      const allValues = [...state.dnsRecords.values()].filter((record) =>
        requestedName === null || record.name === requestedName
      );
      const perPage = Number(url.searchParams.get("per_page") ?? 100);
      const page = Number(url.searchParams.get("page") ?? 1);
      const values = allValues.slice((page - 1) * perPage, page * perPage);
      return cf(values, {
        count: values.length,
        page,
        per_page: perPage,
        total_count: allValues.length,
        total_pages: allValues.length === 0 ? 0 : Math.ceil(allValues.length / perPage)
      });
    }
    const dnsRecordRoute = pathname.match(/\/dns_records\/([^/]+)$/);
    if (method === "GET" && dnsRecordRoute) {
      const id = decodeURIComponent(dnsRecordRoute[1]);
      const value = state.dnsRecords.get(id);
      return value === undefined ? cf(null, undefined, 404) : cf(structuredClone(value));
    }
    if (method === "DELETE" && dnsRecordRoute) {
      const id = decodeURIComponent(dnsRecordRoute[1]);
      state.dnsRecords.delete(id);
      return cf({ id });
    }
    if (method === "GET" && pathname.endsWith("/certificate_packs")) {
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page"));
      const values = [...state.certificates.values()];
      const pageValues = values.slice((page - 1) * perPage, page * perPage);
      return cf(structuredClone(pageValues), {
        count: pageValues.length,
        page,
        per_page: perPage,
        total_count: values.length,
        total_pages: values.length === 0 ? 0 : Math.ceil(values.length / perPage)
      });
    }
    const certificateRoute = pathname.match(/\/certificate_packs\/([^/]+)$/);
    if (certificateRoute) {
      const id = decodeURIComponent(certificateRoute[1]);
      const certificate = state.certificates.get(id);
      if (method === "DELETE") {
        assert.ok(certificate, `unknown certificate pack delete ${id}`);
        certificate.status = "pending_deletion";
        return cf({ id });
      }
      if (certificate === undefined) return cf(null, undefined, 404);
      if (certificate.status === "pending_deletion" && certificate.pollsRemaining > 0) {
        certificate.pollsRemaining -= 1;
      } else if (certificate.status === "pending_deletion") {
        certificate.status = "deleted";
      }
      const { pollsRemaining: _pollsRemaining, ...result } = certificate;
      return cf(result);
    }

    if (method === "GET" && pathname.endsWith("/containers/dash/applications")) {
      const pageToken = url.searchParams.get("page_token");
      if (pageToken === null) {
        return cf(
          Array.from({ length: 100 }, (_, index) => ({ id: `unrelated-${index}`, name: `unrelated-${index}` })),
          { next_page_token: "second-page" }
        );
      }
      assert.equal(pageToken, "second-page");
      return cf([...state.containers.values()], { next_page_token: null });
    }
    const containerInstances = pathname.match(
      /\/containers\/dash\/applications\/([^/]+)\/instances$/
    );
    if (method === "GET" && containerInstances) {
      assert.equal(url.searchParams.get("per_page"), "100");
      const applicationId = decodeURIComponent(containerInstances[1]);
      const instanceState = state.containerInstances.get(applicationId);
      assert.ok(instanceState, "container instances require a present exact application");
      const pageToken = url.searchParams.get("page_token");
      const offset = pageToken === null ? 0 : Number(pageToken.slice("instances-".length));
      if (pageToken !== null) assert.equal(pageToken, `instances-${offset}`);
      const durableObjects = instanceState.durableObjects.slice(offset, offset + 100);
      const nextOffset = offset + durableObjects.length;
      const generatedNextPageToken = nextOffset < instanceState.durableObjects.length
        ? `instances-${nextOffset}`
        : null;
      return cf({
        instances: structuredClone(instanceState.instances.slice(offset, offset + 100)),
        durable_objects: structuredClone(durableObjects)
      }, {
        next_page_token: state.containerInstanceNextTokenOverride ?? generatedNextPageToken
      });
    }
    const containerDeployments = pathname.match(
      /\/containers\/applications\/([^/]+)\/deployments$/
    );
    if (method === "GET" && containerDeployments) {
      assert.equal(url.search, "", "container deployment inventory is a bounded SinglePage endpoint");
      const applicationId = decodeURIComponent(containerDeployments[1]);
      const deployments = state.containerDeployments.get(applicationId);
      assert.ok(deployments, "container deployments require a present exact application");
      return cf(structuredClone(deployments));
    }
    const containerRollouts = pathname.match(
      /\/containers\/applications\/([^/]+)\/rollouts$/
    );
    if (method === "GET" && containerRollouts) {
      assert.equal(url.searchParams.get("limit"), "100");
      const applicationId = decodeURIComponent(containerRollouts[1]);
      const rollouts = state.containerRollouts.get(applicationId);
      assert.ok(rollouts, "container rollouts require a present exact application");
      const last = url.searchParams.get("last");
      const offset = last === null
        ? 0
        : rollouts.findIndex((entry) => entry.id === last) + 1;
      return cf(structuredClone(rollouts.slice(offset, offset + 100)));
    }
    const containerDelete = pathname.match(/\/containers\/applications\/([^/]+)$/);
    if (method === "DELETE" && containerDelete) {
      const applicationId = decodeURIComponent(containerDelete[1]);
      if (!state.containers.has(applicationId)) return cf(null, undefined, 404);
      state.containers.delete(applicationId);
      state.containerDeployments.delete(applicationId);
      state.containerRollouts.delete(applicationId);
      state.containerInstances.delete(applicationId);
      return cf({});
    }
    const containerGet = pathname.match(/\/containers\/applications\/([^/]+)$/);
    if (method === "GET" && containerGet) {
      const application = state.containers.get(decodeURIComponent(containerGet[1]));
      return application === undefined ? cf(null, undefined, 404) : cf(application);
    }

    if (method === "GET" && pathname.endsWith("/r2-catalog")) {
      const warehouses = [...state.buckets.values()].flatMap((bucket) =>
        bucket.catalog === false
          ? []
          : [{
              id: `${bucket.name}-catalog-id`,
              bucket: bucket.name,
              name: `${ACCOUNT}_${bucket.name}`,
              status: "active"
            }]
      );
      return cf({ warehouses });
    }
    const eventNotificationGet = pathname.match(
      /\/event_notifications\/r2\/([^/]+)\/configuration$/
    );
    if (method === "GET" && eventNotificationGet) {
      const bucket = state.buckets.get(decodeURIComponent(eventNotificationGet[1]));
      assert.ok(bucket, "event notification inventory requires a present bucket");
      if (bucket.eventQueues === null) {
        return cfError(11015, "workers.api.error.no_configs_found_for_bucket");
      }
      return cf({ bucketName: bucket.name, queues: bucket.eventQueues });
    }
    const bucketConfigurationGet = pathname.match(
      /\/r2\/buckets\/([^/]+)\/(lifecycle|cors|lock|sippy|domains\/custom|domains\/managed)$/
    );
    if (method === "GET" && bucketConfigurationGet) {
      const bucket = state.buckets.get(decodeURIComponent(bucketConfigurationGet[1]));
      assert.ok(bucket, "configuration inventory requires a present bucket");
      switch (bucketConfigurationGet[2]) {
        case "lifecycle": return cf({ rules: bucket.lifecycleRules });
        case "cors": return cf({ rules: bucket.corsRules });
        case "lock": return cf({ rules: bucket.lockRules });
        case "sippy": return bucket.sippy === null
          ? cfError(10007, "No Sippy configuration found")
          : cf(bucket.sippy);
        case "domains/custom": return cf({ domains: bucket.customDomains });
        case "domains/managed": return cf(bucket.managedDomain);
        default: throw new Error("unreachable bucket configuration fixture");
      }
    }

    const objectPrefix = "/objects/";
    const objectIndex = pathname.indexOf(objectPrefix);
    if (method === "DELETE" && objectIndex !== -1) {
      const bucketMatch = pathname.match(/\/r2\/buckets\/([^/]+)\/objects\//);
      const bucket = state.buckets.get(decodeURIComponent(bucketMatch[1]));
      const encoded = pathname.slice(objectIndex + objectPrefix.length);
      const key = encoded.split("/").map((segment) => decodeURIComponent(segment)).join("/");
      assert.equal(bucket.objects.delete(key), true, `unknown R2 object delete ${key}`);
      return cf({ key });
    }
    const objectList = pathname.match(/\/r2\/buckets\/([^/]+)\/objects$/);
    if (method === "GET" && objectList) {
      const bucket = state.buckets.get(decodeURIComponent(objectList[1]));
      const objects = [...bucket.objects.values()]
        .sort((left, right) => compareStagingTeardownCodeUnits(left.key, right.key));
      const cursor = url.searchParams.get("cursor");
      if (cursor === null && objects.length > 1) {
        return cf([objects[0]], { is_truncated: true, cursor: `cursor-${bucket.name}` });
      }
      if (cursor !== null) assert.equal(cursor, `cursor-${bucket.name}`);
      return cf(objects.slice(cursor === null ? 0 : 1), {
        is_truncated: false
      });
    }
    if (method === "GET" && pathname.endsWith("/r2/buckets")) {
      assert.equal(url.searchParams.get("per_page"), "1000");
      const jurisdiction = init.headers["cf-r2-jurisdiction"];
      const jurisdictionBuckets = jurisdiction === "default"
        ? [...state.buckets.values()]
        : state.nonDefaultBuckets[jurisdiction];
      const buckets = jurisdictionBuckets.map((bucket) => ({
        creation_date: bucket.creation_date,
        jurisdiction,
        location: bucket.location,
        name: bucket.name,
        storage_class: bucket.storage_class
      }));
      return cf({ buckets }, { cursor: null, per_page: 1000 });
    }
    const bucketRoute = pathname.match(/\/r2\/buckets\/([^/]+)$/);
    if (bucketRoute) {
      const bucketName = decodeURIComponent(bucketRoute[1]);
      if (method === "DELETE") {
        const bucket = state.buckets.get(bucketName);
        assert.equal(bucket.objects.size, 0);
        state.buckets.delete(bucketName);
        return cf({});
      }
      const bucket = state.buckets.get(bucketName);
      return bucket === undefined ? cf(null, undefined, 404) : cf({
        name: bucket.name,
        creation_date: bucket.creation_date,
        jurisdiction: bucket.jurisdiction,
        location: bucket.location,
        storage_class: bucket.storage_class
      });
    }

    if (method === "GET" && pathname.endsWith("/tokens/permission_groups")) {
      assert.equal(url.search, "");
      return cf(structuredClone(state.permissionGroups));
    }
    if (method === "GET" && pathname.endsWith("/tokens")) {
      assert.equal(url.searchParams.get("per_page"), "50");
      assert.equal(
        url.searchParams.get("include_expired"),
        "true",
        "complete account-token inventories must retain recently expired resources"
      );
      const page = Number(url.searchParams.get("page"));
      const values = [
        state.r2OperatorToken,
        ...state.credentials.values(),
        ...state.additionalAccountTokens
      ];
      const pageValues = values.slice((page - 1) * 50, page * 50);
      return cf(structuredClone(pageValues), {
        count: pageValues.length,
        page,
        per_page: 50,
        total_count: values.length
      });
    }
    const tokenRoute = pathname.match(/\/tokens\/([^/]+)$/);
    if (tokenRoute) {
      const id = decodeURIComponent(tokenRoute[1]);
      if (method === "DELETE") {
        if (!state.credentials.has(id)) return cf(null, undefined, 404);
        state.credentials.delete(id);
        return cf({ id });
      }
      const value = state.credentials.get(id);
      return value === undefined ? cf(null, undefined, 404) : cf(value);
    }

    throw new Error(`unexpected fixture provider request ${method} ${url.href}`);
  }

  return { state, calls, fetch };
}
