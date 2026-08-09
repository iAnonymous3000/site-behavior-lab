import { isRecord, serializeCanonicalEvidence } from "./operator-evidence-common.mjs";
import {
  createBoundedProviderClient,
  createProviderRequestLedger,
  STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
  unwrapCloudflareResponse
} from "./staging-teardown-provider-http.mjs";
import {
  STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT,
  STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
  STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT,
  STAGING_TEARDOWN_RUNNER_LABELS,
  stagingTeardownTargetManifestTemplate,
  validateStagingTeardownTargetManifest
} from "./staging-teardown-provider-adapters.mjs";
import {
  canonicalStagingTeardownProjection,
  boundedStagingTeardownProviderText,
  compareStagingTeardownCodeUnits,
  normalizeStagingTeardownContainerApplication,
  normalizeStagingTeardownContainerCollection,
  normalizeStagingTeardownInactiveContainerDurableObject,
  normalizeStagingTeardownR2LifecycleRules,
  normalizeStagingTeardownWorkerDeployments,
  normalizeStagingTeardownWorkerScriptSettings,
  normalizeStagingTeardownWorkerVersionResources,
  normalizeStagingTeardownWorkerVersionSettings,
  projectStagingTeardownCertificatePack,
  projectStagingTeardownDnsRecord,
  projectStagingTeardownR2Bucket,
  projectStagingTeardownR2Object,
  projectStagingTeardownStoppedWorkerBuild,
  projectStagingTeardownWorkerDomain,
  projectStagingTeardownWorkerSecretName,
  projectStagingTeardownWorkerVersionListItem,
  stagingTeardownProjectionSha256,
  stagingTeardownProviderTimestamp
} from "./staging-teardown-target-projections.mjs";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ZONE_ID = /^[0-9a-f]{32}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const WORKER_SEARCH_MAX_COUNT = 1_000;
const WORKER_SCRIPT_MAX_COUNT = 1_000;
const WORKER_VERSION_MAX_COUNT = 20;
const WORKER_BUILD_MAX_COUNT = 400;
const CONTAINER_APPLICATION_MAX_COUNT = 1_000;
const CONTAINER_DEPLOYMENT_MAX_COUNT = 100;
const CONTAINER_PAGE_SIZE = 100;
const CONTAINER_ROLLOUT_MAX_PAGES = 2;
const CONTAINER_INSTANCE_MAX_PAGES = 2;
const CERTIFICATE_PACK_MAX_COUNT = 200;
const TARGET_COUNT = 2;
const CERTIFICATE_PACK_PAGE_SIZE = 50;
const DNS_RECORD_PAGE_SIZE = 100;
const R2_BUCKET_LIST_MAX_PAGES = 4;
const R2_OBJECT_LIST_MAX_PAGES = 2;
const R2_TARGET_JURISDICTION = "default";
const R2_JURISDICTIONS = Object.freeze(["default", "eu", "fedramp"]);
const TOKEN_LIST_PAGE_SIZE = 50;
const TOKEN_LIST_MAX_COUNT = 500;

const CAPTURE_REQUEST_LIMITS = Object.freeze({
  cloudflareCompute:
    STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES + // Durable Object namespaces
    1 + // Worker custom domains
    STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES + // container applications
    (TARGET_COUNT * (
      1 + // exact application
      1 + // deployments
      CONTAINER_ROLLOUT_MAX_PAGES +
      CONTAINER_INSTANCE_MAX_PAGES
    )),
  cloudflareDns:
    Math.ceil(CERTIFICATE_PACK_MAX_COUNT / CERTIFICATE_PACK_PAGE_SIZE) +
    TARGET_COUNT + // global ceiling 20 fits one 100-record page for each queried hostname
    TARGET_COUNT, // at most one exact-host certificate detail per target
  cloudflareR2:
    (R2_JURISDICTIONS.length * R2_BUCKET_LIST_MAX_PAGES) +
    (TARGET_COUNT * (1 + 1 + 1 + R2_OBJECT_LIST_MAX_PAGES)),
  cloudflareToken:
    Math.ceil(TOKEN_LIST_MAX_COUNT / TOKEN_LIST_PAGE_SIZE) + TARGET_COUNT,
  cloudflareObservation:
    STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES + // immutable identities
    1 + // initial script list
    (TARGET_COUNT * (
      1 + // presence settings
      2 + // initial stopped-build pages
      1 + // sealed settings
      1 + // sealed script list
      1 + // script settings
      1 + // secrets
      2 + // version pages
      WORKER_VERSION_MAX_COUNT + // exact version details
      1 + // deployments
      2 // final stopped-build pages
    )),
  githubRunner: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES
});

export const STAGING_TEARDOWN_TARGET_CAPTURE_MAX_PROVIDER_MILLISECONDS =
  Object.values(CAPTURE_REQUEST_LIMITS).reduce((sum, count) => sum + count, 0) *
  STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS;

export const STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES = Object.freeze({
  cloudflareComputeReadToken: "STAGING_TEARDOWN_CAPTURE_CF_COMPUTE_READ_TOKEN",
  cloudflareDnsReadToken: "STAGING_TEARDOWN_CAPTURE_CF_DNS_READ_TOKEN",
  cloudflareR2ReadToken: "STAGING_TEARDOWN_CAPTURE_CF_R2_READ_TOKEN",
  cloudflareTokenReadToken: "STAGING_TEARDOWN_CAPTURE_CF_TOKEN_READ_TOKEN",
  cloudflareObservationReadToken: "STAGING_TEARDOWN_CAPTURE_CF_OBSERVATION_READ_TOKEN",
  githubRunnerReadToken: "STAGING_TEARDOWN_CAPTURE_GITHUB_APP_READ_TOKEN"
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(compareStagingTeardownCodeUnits);
  const expected = [...keys].sort(compareStagingTeardownCodeUnits);
  requireValue(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${label} has an unsupported provider shape`
  );
}

function cloudflarePath(...parts) {
  return `/${parts.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

function queryPath(basePath, entries) {
  return `${basePath}?${new URLSearchParams(entries).toString()}`;
}

function responseResult(response, label) {
  return unwrapCloudflareResponse(response.value, label);
}

function selectedArray(response, label) {
  const result = responseResult(response, label);
  requireValue(Array.isArray(result), `${label} result must be an array`);
  return result;
}

function providerIdentity(value, label) {
  requireValue(
    typeof value === "string" && PROVIDER_ID.test(value),
    `${label} must be one bounded provider identity`
  );
  return value;
}

function indexedRawNamer() {
  let index = 0;
  return (provider, logicalName, phase) => {
    index += 1;
    const stem = `${logicalName}-${phase}`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72);
    return `${String(index).padStart(3, "0")}.${provider}.${stem}.json`;
  };
}

async function listStrictNumberedPages({
  client,
  basePath,
  label,
  rawName,
  parseItem = (item) => item,
  identity,
  selectItems = selectedArray,
  perPage,
  maxPages,
  maxItems,
  queryEntries = [],
  allowOmittedTotalPages = false
}) {
  requireValue(
    Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= 200,
    `${label} page size is invalid`
  );
  requireValue(
    Number.isSafeInteger(maxPages) && maxPages >= 1 &&
      maxPages <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    `${label} page limit is invalid`
  );
  const results = [];
  const identities = new Set();
  let totalCount;
  let totalPages;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request({
      path: queryPath(basePath, [
        ...queryEntries,
        ["per_page", String(perPage)],
        ["page", String(page)]
      ]),
      label: `${label} page ${page}`,
      rawName: rawName(page)
    });
    const items = selectItems(response, `${label} page ${page}`, page);
    requireValue(Array.isArray(items), `${label} page ${page} must be an array`);
    const info = response.value?.result_info;
    requireValue(isRecord(info), `${label} must return pagination metadata`);
    requireValue(
      info.page === page && info.per_page === perPage &&
        info.count === items.length && Number.isSafeInteger(info.total_count) &&
        info.total_count >= 0 && info.total_count <= maxItems,
      `${label} returned inconsistent bounded pagination metadata`
    );
    const calculatedPages = info.total_count === 0
      ? 0
      : Math.ceil(info.total_count / perPage);
    requireValue(
      (allowOmittedTotalPages && info.total_pages === undefined) ||
        (Number.isSafeInteger(info.total_pages) && info.total_pages === calculatedPages &&
          info.total_pages >= 0 && info.total_pages <= maxPages),
      `${label} pagination totals are inconsistent`
    );
    const effectiveTotalPages = info.total_pages ?? calculatedPages;
    requireValue(
      effectiveTotalPages <= maxPages,
      `${label} total_count exceeds the bounded page limit`
    );
    if (totalCount === undefined) {
      totalCount = info.total_count;
      totalPages = effectiveTotalPages;
    }
    requireValue(
      totalCount === info.total_count && totalPages === effectiveTotalPages,
      `${label} pagination totals changed during capture`
    );
    if (totalPages === 0) {
      requireValue(page === 1 && items.length === 0, `${label} empty pagination is invalid`);
      return results;
    }
    const expectedPageLength = page < totalPages
      ? perPage
      : totalCount - ((page - 1) * perPage);
    requireValue(items.length === expectedPageLength, `${label} page is incomplete`);
    for (const [index, item] of items.entries()) {
      const parsed = parseItem(item, `${label} page ${page} item ${index}`);
      const itemIdentity = identity(parsed);
      requireValue(
        (typeof itemIdentity === "string" || Number.isSafeInteger(itemIdentity)) &&
          !identities.has(itemIdentity),
        `${label} returned a repeated or invalid identity`
      );
      identities.add(itemIdentity);
      results.push(parsed);
    }
    if (page === totalPages) {
      requireValue(results.length === totalCount, `${label} did not reach total_count`);
      return results;
    }
  }
  throw new Error(`${label} exceeded its bounded page limit`);
}

async function listCloudflareCursorPages({
  client,
  basePath,
  label,
  rawName,
  maxPages,
  pageSize,
  requestOptions = {},
  extract
}) {
  const results = [];
  const cursors = new Set();
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = [["per_page", String(pageSize)]];
    if (cursor !== null) query.push(["cursor", cursor]);
    const response = await client.request({
      ...requestOptions,
      path: queryPath(basePath, query),
      label: `${label} page ${page}`,
      rawName: rawName(page)
    });
    const extracted = extract(response, `${label} page ${page}`);
    requireValue(
      isRecord(extracted) && Array.isArray(extracted.items) &&
        extracted.items.length <= pageSize && typeof extracted.isTruncated === "boolean",
      `${label} returned an invalid cursor page`
    );
    results.push(...extracted.items);
    if (!extracted.isTruncated) {
      requireValue(
        extracted.nextCursor === null || extracted.nextCursor === "",
        `${label} returned a terminal cursor on an untruncated page`
      );
      return results;
    }
    requireValue(
      typeof extracted.nextCursor === "string" &&
        extracted.nextCursor.length >= 1 && extracted.nextCursor.length <= 1_024 &&
        !cursors.has(extracted.nextCursor),
      `${label} returned an invalid or repeated cursor`
    );
    cursors.add(extracted.nextCursor);
    cursor = extracted.nextCursor;
  }
  throw new Error(`${label} exceeded its bounded cursor page limit`);
}

function captureClients({ credentials, fetchImpl, persistRaw, cloudflareApiBaseUrl, githubApiBaseUrl }) {
  const readTokenNames = Object.keys(STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES);
  requireValue(
    isRecord(credentials) &&
      readTokenNames.every((name) =>
        typeof credentials[name] === "string" && credentials[name].length >= 20
      ),
    "staging teardown target capture requires every separately scoped read credential"
  );
  requireValue(
    new Set(readTokenNames.map((name) => credentials[name])).size === readTokenNames.length,
    "staging teardown target capture read credentials must be pairwise distinct"
  );
  const client = (provider, baseUrl, token, label, requestLimit) => {
    const ledger = createProviderRequestLedger({ label, requestLimit });
    return createBoundedProviderClient({
      provider,
      baseUrl,
      token,
      allowedMethods: ["GET"],
      fetchImpl,
      persistRaw,
      requestLimit,
      requestLedger: ledger
    });
  };
  return Object.freeze({
    compute: client(
      "cloudflare", cloudflareApiBaseUrl, credentials.cloudflareComputeReadToken,
      "Cloudflare compute read authority", CAPTURE_REQUEST_LIMITS.cloudflareCompute
    ),
    dns: client(
      "cloudflare", cloudflareApiBaseUrl, credentials.cloudflareDnsReadToken,
      "Cloudflare DNS read authority", CAPTURE_REQUEST_LIMITS.cloudflareDns
    ),
    r2: client(
      "cloudflare", cloudflareApiBaseUrl, credentials.cloudflareR2ReadToken,
      "Cloudflare R2 read authority", CAPTURE_REQUEST_LIMITS.cloudflareR2
    ),
    token: client(
      "cloudflare", cloudflareApiBaseUrl, credentials.cloudflareTokenReadToken,
      "Cloudflare account-token read authority", CAPTURE_REQUEST_LIMITS.cloudflareToken
    ),
    observation: client(
      "cloudflare", cloudflareApiBaseUrl, credentials.cloudflareObservationReadToken,
      "Cloudflare observation read authority", CAPTURE_REQUEST_LIMITS.cloudflareObservation
    ),
    github: client(
      "github", githubApiBaseUrl, credentials.githubRunnerReadToken,
      "GitHub App runner read authority", CAPTURE_REQUEST_LIMITS.githubRunner
    )
  });
}

function snapshotRequestCounts(clients) {
  return Object.freeze(Object.fromEntries(
    Object.entries(clients).map(([name, client]) => [name, client.requestCount()])
  ));
}

async function captureStoppedWorkerBuilds({ clients, rawName, accountId, logicalName, workerId, phase }) {
  const builds = await listStrictNumberedPages({
    client: clients.observation,
    basePath: cloudflarePath(
      "client", "v4", "accounts", accountId, "builds", "workers", workerId, "builds"
    ),
    label: `${logicalName} Worker Builds executions ${phase}`,
    rawName: (page) => rawName("cloudflare", logicalName, `${phase}-builds-${page}`),
    parseItem: projectStagingTeardownStoppedWorkerBuild,
    identity: (build) => build.id,
    perPage: 200,
    maxPages: 2,
    maxItems: WORKER_BUILD_MAX_COUNT
  });
  requireValue(
    builds.every((build) => build.status === "stopped"),
    `${logicalName} has a queued, initializing, or running Worker Build`
  );
  return builds.sort((left, right) =>
    compareStagingTeardownCodeUnits(left.id, right.id)
  );
}

async function captureWorkers({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const workerNames = cf.workers.map((worker) => worker.scriptName);
  const identities = await listStrictNumberedPages({
    client: clients.observation,
    basePath: cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "workers", "scripts-search"
    ),
    label: "complete immutable Worker identity inventory",
    rawName: (page) => rawName("cloudflare", "workers", `identity-${page}`),
    parseItem(item, label) {
      requireValue(isRecord(item), `${label} must be an object`);
      providerIdentity(item.id, `${label}.id`);
      providerIdentity(item.script_name, `${label}.script_name`);
      stagingTeardownProviderTimestamp(item.created_on, `${label}.created_on`);
      stagingTeardownProviderTimestamp(item.modified_on, `${label}.modified_on`);
      return item;
    },
    identity: (item) => item.id,
    perPage: 100,
    maxPages: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    maxItems: WORKER_SEARCH_MAX_COUNT
  });
  const scriptListResponse = await clients.observation.request({
    path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts"),
    label: "complete Worker script inventory",
    rawName: rawName("cloudflare", "workers", "scripts")
  });
  const scripts = selectedArray(scriptListResponse, "complete Worker script inventory");
  requireValue(
    scripts.length <= WORKER_SCRIPT_MAX_COUNT,
    "complete Worker script inventory exceeds the bounded item limit"
  );
  const scriptIds = new Set();
  for (const [index, script] of scripts.entries()) {
    requireValue(isRecord(script), `Worker script inventory item ${index} must be an object`);
    providerIdentity(script.id, `Worker script inventory item ${index}.id`);
    requireValue(
      !scriptIds.has(script.id),
      "complete Worker script inventory contains a repeated script name"
    );
    scriptIds.add(script.id);
  }
  const namespaces = await listStrictNumberedPages({
    client: clients.compute,
    basePath: cloudflarePath(
      "client", "v4", "accounts", cf.accountId, "workers", "durable_objects", "namespaces"
    ),
    label: "complete Durable Object namespace inventory",
    rawName: (page) => rawName("cloudflare", "workers", `namespaces-${page}`),
    parseItem(item, label) {
      requireValue(isRecord(item), `${label} must be an object`);
      providerIdentity(item.id, `${label}.id`);
      // The provider schema permits an orphan row to omit its owning script,
      // but such a row cannot be conclusively excluded from either canonical
      // target. Refuse that ambiguity instead of sealing an absent Worker.
      providerIdentity(item.script, `${label}.script`);
      const className = item.class ?? item.class_name;
      if (className !== undefined && className !== null) {
        requireValue(
          typeof className === "string" && className.length >= 1 && className.length <= 256 &&
            !/[\u0000-\u001f\u007f]/.test(className),
          `${label}.class must be bounded provider text when present`
        );
      }
      return item;
    },
    identity: (item) => item.id,
    perPage: 100,
    maxPages: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    maxItems: 1_000
  });
  const captureState = new Map();

  for (const [workerIndex, target] of cf.workers.entries()) {
    const logicalName = target.logicalName;
    const settingsResponse = await clients.observation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "settings"
      ),
      label: `${logicalName} Worker settings`,
      rawName: rawName("cloudflare", logicalName, "settings"),
      acceptedStatuses: [200, 404]
    });
    const identityMatches = identities.filter((entry) => entry.script_name === target.scriptName);
    const scriptMatches = scripts.filter((entry) => entry.id === target.scriptName);
    const namespaceMatches = namespaces.filter((entry) => entry.script === target.scriptName);
    requireValue(
      identityMatches.length <= 1 && scriptMatches.length <= 1,
      `${logicalName} matched more than one Worker identity`
    );
    const present = settingsResponse.status === 200;
    requireValue(
      present
        ? identityMatches.length === 1 && scriptMatches.length === 1
        : identityMatches.length === 0 && scriptMatches.length === 0,
      `${logicalName} mutable and immutable Worker inventories disagree`
    );
    if (!present) {
      requireValue(
        namespaceMatches.length === 0,
        `${logicalName} is absent but retains a Durable Object namespace`
      );
      captureState.set(target.scriptName, { present: false, settings: null });
      continue;
    }

    const identity = identityMatches[0];
    const initialStoppedBuilds = await captureStoppedWorkerBuilds({
      clients,
      rawName,
      accountId: cf.accountId,
      logicalName,
      workerId: identity.id,
      phase: "initial"
    });
    // Re-read every mutable projection only after the initial build inventory.
    // A second identical complete build inventory below closes the capture
    // window so a deployment cannot silently mix old settings with new code.
    const sealedSettingsResponse = await clients.observation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "settings"
      ),
      label: `${logicalName} sealed Worker settings`,
      rawName: rawName("cloudflare", logicalName, "sealed-settings")
    });
    const settings = responseResult(
      sealedSettingsResponse,
      `${logicalName} sealed Worker settings`
    );
    requireValue(isRecord(settings), `${logicalName} Worker settings must be an object`);
    const sealedScriptListResponse = await clients.observation.request({
      path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "scripts"),
      label: `${logicalName} sealed Worker script inventory`,
      rawName: rawName("cloudflare", logicalName, "sealed-scripts")
    });
    const sealedScripts = selectedArray(
      sealedScriptListResponse,
      `${logicalName} sealed Worker script inventory`
    );
    requireValue(
      sealedScripts.length <= WORKER_SCRIPT_MAX_COUNT,
      `${logicalName} sealed Worker script inventory exceeds its item limit`
    );
    const sealedScriptMatches = sealedScripts.filter((entry) =>
      isRecord(entry) && entry.id === target.scriptName
    );
    requireValue(
      sealedScriptMatches.length === 1,
      `${logicalName} sealed Worker script inventory is not exact`
    );
    const script = sealedScriptMatches[0];
    const bindings = settings.bindings ?? [];
    requireValue(
      Array.isArray(bindings) && bindings.every((binding) =>
        isRecord(binding) &&
          ["durable_object_namespace", "plain_text", "secret_text"].includes(binding.type)
      ),
      `${logicalName} has an unreviewed provider-resource binding`
    );
    const durableBindings = bindings.filter((binding) =>
      binding.type === "durable_object_namespace"
    );
    requireValue(
      durableBindings.length === 1,
      `${logicalName} must expose exactly one Durable Object namespace binding`
    );
    const durableBinding = durableBindings[0];
    requireValue(
      durableBinding.name === target.durableObjectBindingName &&
        durableBinding.class_name === target.durableObjectClassName &&
        (durableBinding.script_name === undefined ||
          durableBinding.script_name === target.scriptName),
      `${logicalName} Durable Object binding does not match the canonical target`
    );
    providerIdentity(
      durableBinding.namespace_id,
      `${logicalName} Durable Object namespace id`
    );
    const relevantNamespaces = namespaces.filter((namespace) =>
      namespace.script === target.scriptName || namespace.id === durableBinding.namespace_id
    );
    const exactNamespaces = relevantNamespaces.filter((namespace) =>
      namespace.id === durableBinding.namespace_id &&
        namespace.script === target.scriptName &&
        (namespace.class ?? namespace.class_name) === target.durableObjectClassName
    );
    requireValue(
      relevantNamespaces.length === 1 && exactNamespaces.length === 1,
      `${logicalName} Durable Object namespace inventory is not exact`
    );
    requireValue(
      identity.created_on === script.created_on &&
        identity.modified_on === script.modified_on,
      `${logicalName} mutable and immutable timestamps disagree`
    );
    stagingTeardownProviderTimestamp(script.created_on, `${logicalName} created_on`);
    stagingTeardownProviderTimestamp(script.modified_on, `${logicalName} modified_on`);
    boundedStagingTeardownProviderText(
      script.etag,
      256,
      `${logicalName} script-list ETag`
    );

    const scriptSettingsResponse = await clients.observation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "script-settings"
      ),
      label: `${logicalName} script-level settings`,
      rawName: rawName("cloudflare", logicalName, "script-settings")
    });
    const scriptSettings = normalizeStagingTeardownWorkerScriptSettings(
      responseResult(scriptSettingsResponse, `${logicalName} script-level settings`),
      `${logicalName} script-level settings`
    );

    const secretsResponse = await clients.observation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "secrets"
      ),
      label: `${logicalName} Worker secret-name inventory`,
      rawName: rawName("cloudflare", logicalName, "secrets")
    });
    const rawSecrets = selectedArray(
      secretsResponse,
      `${logicalName} Worker secret-name inventory`
    );
    requireValue(rawSecrets.length <= 64, `${logicalName} has too many Worker secrets`);
    const secretNames = rawSecrets.map((secret, index) =>
      projectStagingTeardownWorkerSecretName(
        secret,
        `${logicalName} Worker secret ${index}`
      )
    ).sort(compareStagingTeardownCodeUnits);
    requireValue(
      new Set(secretNames).size === secretNames.length,
      `${logicalName} Worker secret-name inventory contains duplicates`
    );

    const versions = await listStrictNumberedPages({
      client: clients.observation,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "versions"
      ),
      label: `${logicalName} Worker versions`,
      rawName: (page) => rawName("cloudflare", logicalName, `versions-${page}`),
      selectItems(response, label) {
        const result = responseResult(response, label);
        requireValue(
          isRecord(result) && Array.isArray(result.items),
          `${label} result must contain an items array`
        );
        return result.items;
      },
      parseItem: projectStagingTeardownWorkerVersionListItem,
      identity: (version) => version.id,
      perPage: 10,
      maxPages: 2,
      maxItems: WORKER_VERSION_MAX_COUNT
    });
    requireValue(versions.length >= 1, `${logicalName} present Worker has no version`);
    const versionState = [];
    for (const [versionIndex, version] of versions.entries()) {
      const detailResponse = await clients.observation.request({
        path: cloudflarePath(
          "client", "v4", "accounts", cf.accountId, "workers", "scripts",
          target.scriptName, "versions", version.id
        ),
        label: `${logicalName} Worker version ${versionIndex} detail`,
        rawName: rawName("cloudflare", logicalName, `version-${versionIndex}`)
      });
      const detail = responseResult(
        detailResponse,
        `${logicalName} Worker version ${versionIndex} detail`
      );
      requireValue(
        isRecord(detail) && detail.id === version.id && detail.number === version.number &&
          isRecord(detail.metadata),
        `${logicalName} Worker version ${versionIndex} detail identity changed`
      );
      const resources = normalizeStagingTeardownWorkerVersionResources(
        detail.resources,
        `${logicalName} Worker version ${versionIndex} resources`
      );
      versionState.push({
        id: version.id,
        number: version.number,
        metadataSha256: stagingTeardownProjectionSha256(
          canonicalStagingTeardownProjection(
            detail.metadata,
            `${logicalName} Worker version ${versionIndex} metadata`
          )
        ),
        resourcesSha256: stagingTeardownProjectionSha256(resources),
        scriptEtag: resources.script.etag
      });
    }
    const deploymentsResponse = await clients.observation.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "workers", "scripts",
        target.scriptName, "deployments"
      ),
      label: `${logicalName} Worker deployments`,
      rawName: rawName("cloudflare", logicalName, "deployments")
    });
    const deployments = normalizeStagingTeardownWorkerDeployments(
      responseResult(deploymentsResponse, `${logicalName} Worker deployments`),
      new Set(versionState.map((version) => version.id)),
      `${logicalName} Worker deployments`
    );

    const stoppedBuilds = await captureStoppedWorkerBuilds({
      clients,
      rawName,
      accountId: cf.accountId,
      logicalName,
      workerId: identity.id,
      phase: "final"
    });
    requireValue(
      serializeCanonicalEvidence(stoppedBuilds) ===
        serializeCanonicalEvidence(initialStoppedBuilds),
      `${logicalName} Worker Builds changed while sealing its projection`
    );

    Object.assign(target, {
      workerId: identity.id,
      expectedPresent: true,
      durableObjectNamespaceId: durableBinding.namespace_id,
      createdOn: identity.created_on,
      modifiedOn: identity.modified_on,
      latestScriptEtag: script.etag,
      versionSettingsSha256: stagingTeardownProjectionSha256(
        normalizeStagingTeardownWorkerVersionSettings(
          settings,
          `${logicalName} Worker version settings`
        )
      ),
      scriptSettingsSha256: stagingTeardownProjectionSha256(scriptSettings),
      deploymentsSha256: stagingTeardownProjectionSha256(deployments),
      stoppedBuildsSha256: stagingTeardownProjectionSha256(stoppedBuilds),
      versionState,
      secretNames
    });
    captureState.set(target.scriptName, { present: true, settings });
    requireValue(
      workerNames[workerIndex] === target.scriptName,
      `${logicalName} Worker order changed during capture`
    );
  }

  const scanner = cf.faultHook;
  const scannerState = captureState.get(scanner.workerName);
  let faultHookPresent = false;
  if (scannerState?.present) {
    const bindings = scannerState.settings.bindings ?? [];
    const activation = bindings.find((binding) =>
      binding?.name === scanner.activationBindingName
    );
    const secret = bindings.find((binding) => binding?.name === scanner.secretBindingName);
    requireValue(
      (activation === undefined) === (secret === undefined),
      "staging fault-hook bindings are only partially installed"
    );
    if (activation !== undefined) {
      requireValue(
        activation.type === "plain_text" && activation.text === "1" &&
          secret.type === "secret_text",
        "staging fault-hook bindings do not have the exact reviewed state"
      );
      faultHookPresent = true;
    }
  }
  scanner.expectedPresent = faultHookPresent;
}

async function captureDns({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const domainsResponse = await clients.compute.request({
    path: cloudflarePath("client", "v4", "accounts", cf.accountId, "workers", "domains"),
    label: "complete Worker custom-domain inventory",
    rawName: rawName("cloudflare", "dns", "worker-domains")
  });
  const domains = selectedArray(domainsResponse, "complete Worker custom-domain inventory");
  requireValue(domains.length <= 1_000, "Worker custom-domain inventory is unbounded");
  const domainIds = new Set();
  const projectedDomains = domains.map((domain, index) => {
    const projected = projectStagingTeardownWorkerDomain(
      domain,
      `Worker domain ${index}`
    );
    requireValue(
      !domainIds.has(projected.id),
      "Worker domain inventory contains duplicate ids"
    );
    domainIds.add(projected.id);
    return projected;
  });

  const packs = await listStrictNumberedPages({
    client: clients.dns,
    basePath: cloudflarePath("client", "v4", "zones", cf.zoneId, "ssl", "certificate_packs"),
    label: "complete Advanced Certificate pack inventory",
    rawName: (page) => rawName("cloudflare", "dns", `certificate-packs-${page}`),
    parseItem: projectStagingTeardownCertificatePack,
    identity: (pack) => pack.id,
    perPage: CERTIFICATE_PACK_PAGE_SIZE,
    maxPages: Math.ceil(CERTIFICATE_PACK_MAX_COUNT / CERTIFICATE_PACK_PAGE_SIZE),
    maxItems: CERTIFICATE_PACK_MAX_COUNT,
    queryEntries: [["status", "all"]]
  });

  let dnsRecordCount = 0;
  for (const target of cf.dns) {
    const logicalName = target.logicalName;
    const domainMatches = projectedDomains.filter((domain) => domain.hostname === target.hostname);
    requireValue(
      domainMatches.length <= 1,
      `${logicalName} matched more than one Worker custom domain`
    );
    let workerDomainId = null;
    let workerDomainCertId = null;
    if (domainMatches.length === 1) {
      const domain = domainMatches[0];
      requireValue(
          domain.zoneId === cf.zoneId &&
          domain.service === target.workerName,
        `${logicalName} Worker custom domain has the wrong zone or service identity`
      );
      workerDomainId = providerIdentity(domain.id, `${logicalName} Worker domain id`);
      workerDomainCertId = providerIdentity(
        domain.certId,
        `${logicalName} Worker domain certificate id`
      );
    }

    const records = await listStrictNumberedPages({
      client: clients.dns,
      basePath: cloudflarePath("client", "v4", "zones", cf.zoneId, "dns_records"),
      label: `${logicalName} exact DNS-record inventory`,
      rawName: (page) => rawName("cloudflare", logicalName, `dns-records-${page}`),
      parseItem(item, label) {
        requireValue(
          isRecord(item) && item.name === target.hostname,
          `${label} does not match the exact staging hostname`
        );
        return projectStagingTeardownDnsRecord(item);
      },
      identity: (record) => record.id,
      perPage: DNS_RECORD_PAGE_SIZE,
      maxPages: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
      maxItems: STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT,
      queryEntries: [["name", target.hostname], ["match", "all"]]
    });
    records.sort((left, right) => compareStagingTeardownCodeUnits(left.id, right.id));
    dnsRecordCount += records.length;

    const packCandidates = packs.filter((pack) => {
      if (pack.type !== "advanced" || pack.status === "deleted") return false;
      const hosts = Array.isArray(pack.hosts)
        ? [...pack.hosts].sort(compareStagingTeardownCodeUnits)
        : [];
      return hosts.length === 1 && hosts[0] === target.hostname;
    });
    requireValue(
      packCandidates.length <= 1,
      `${logicalName} matched more than one live dedicated Advanced Certificate pack`
    );
    const detailedPacks = [];
    for (const [packIndex, candidate] of packCandidates.entries()) {
      const detailResponse = await clients.dns.request({
        path: cloudflarePath(
          "client", "v4", "zones", cf.zoneId, "ssl", "certificate_packs", candidate.id
        ),
        label: `${logicalName} Advanced Certificate pack ${packIndex}`,
        rawName: rawName("cloudflare", logicalName, `certificate-${packIndex}`)
      });
      const projected = projectStagingTeardownCertificatePack(
        responseResult(detailResponse, `${logicalName} Advanced Certificate pack ${packIndex}`),
        `${logicalName} Advanced Certificate pack ${packIndex}`
      );
      requireValue(
        projected.id === candidate.id && projected.type === "advanced" &&
          projected.status !== "deleted" && projected.hosts.length === 1 &&
          projected.hosts[0] === target.hostname,
        `${logicalName} Advanced Certificate pack identity changed during capture`
      );
      detailedPacks.push(projected);
    }
    requireValue(
      detailedPacks.length <= 1,
      `${logicalName} matched more than one live dedicated Advanced Certificate pack`
    );
    let certificatePackId = null;
    let certificateHosts = [];
    let certificatePack = null;
    let certificatePackSha256 = null;
    if (detailedPacks.length === 1) {
      const pack = detailedPacks[0];
      requireValue(
        pack.certificates.every((certificate) =>
          certificate.hosts.length === 1 && certificate.hosts[0] === target.hostname
        ),
        `${logicalName} Advanced Certificate pack contains an off-target certificate`
      );
      if (workerDomainCertId !== null) {
        const certificates = pack.certificates.filter((certificate) =>
          certificate.id === workerDomainCertId
        );
        requireValue(
          certificates.length === 1 && certificates[0].hosts.length === 1 &&
            certificates[0].hosts[0] === target.hostname,
          `${logicalName} Worker-domain and certificate-pack identities disagree`
        );
      }
      certificatePackId = pack.id;
      certificateHosts = [target.hostname];
      certificatePack = pack;
      certificatePackSha256 = stagingTeardownProjectionSha256(pack);
    }
    requireValue(
      domainMatches.length === 0 || certificatePackId !== null,
      `${logicalName} present Worker custom domain lacks its dedicated Advanced Certificate pack`
    );
    const expectedPresent =
      domainMatches.length === 1 || records.length > 0 || certificatePackId !== null;
    Object.assign(target, {
      expectedPresent,
      workerDomainExpectedPresent: domainMatches.length === 1,
      workerDomainId,
      workerDomainCertId,
      dnsRecords: records,
      certificatePackId,
      certificateHosts,
      certificatePack,
      certificatePackSha256
    });
  }
  requireValue(
    dnsRecordCount <= STAGING_TEARDOWN_DNS_RECORD_MAX_COUNT,
    "staging DNS-record inventory exceeds the global target ceiling"
  );
}

async function listContainerApplications({ clients, rawName, manifest }) {
  const basePath = cloudflarePath(
    "client", "v4", "accounts", manifest.cloudflare.accountId,
    "containers", "dash", "applications"
  );
  const applications = [];
  const ids = new Set();
  const tokens = new Set();
  let pageToken = null;
  for (let page = 1; page <= STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES; page += 1) {
    const query = [["per_page", "100"]];
    if (pageToken !== null) query.push(["page_token", pageToken]);
    const response = await clients.compute.request({
      path: queryPath(basePath, query),
      label: `complete container application inventory page ${page}`,
      rawName: rawName("cloudflare", "containers", `applications-${page}`)
    });
    const items = selectedArray(
      response,
      `complete container application inventory page ${page}`
    );
    requireValue(items.length <= 100, "container application page exceeds its item bound");
    for (const [index, item] of items.entries()) {
      requireValue(isRecord(item), `container application page ${page} item ${index} must be an object`);
      providerIdentity(item.id, `container application page ${page} item ${index}.id`);
      providerIdentity(item.name, `container application page ${page} item ${index}.name`);
      requireValue(!ids.has(item.id), "container application pagination repeated an id");
      ids.add(item.id);
      applications.push(item);
    }
    requireValue(
      applications.length <= CONTAINER_APPLICATION_MAX_COUNT,
      "container application inventory exceeds its bounded item limit"
    );
    const info = response.value?.result_info;
    requireValue(
      isRecord(info) && Object.keys(info).length === 1 &&
        Object.hasOwn(info, "next_page_token"),
      "container application pagination has an unsupported provider shape"
    );
    const next = info.next_page_token;
    requireValue(
      next === null ||
        (typeof next === "string" && next.length >= 1 && next.length <= 1_024 &&
          !/[\u0000-\u001f\u007f]/.test(next)),
      "container application pagination returned an invalid page token"
    );
    if (next === null) {
      requireValue(
        items.length < 100,
        "full container application page omitted a continuation token"
      );
      return applications;
    }
    requireValue(
      items.length === 100 && !tokens.has(next),
      "container application pagination returned an invalid or repeated page token"
    );
    tokens.add(next);
    pageToken = next;
  }
  throw new Error("container application inventory exceeded its page limit");
}

async function captureContainerRollouts({ clients, rawName, cf, target }) {
  const basePath = cloudflarePath(
    "client", "v4", "accounts", cf.accountId, "containers", "applications",
    target.applicationId, "rollouts"
  );
  const rollouts = [];
  const ids = new Set();
  let last = null;
  for (let page = 1; page <= CONTAINER_ROLLOUT_MAX_PAGES; page += 1) {
    const query = [["limit", String(CONTAINER_PAGE_SIZE)]];
    if (last !== null) query.push(["last", last]);
    const response = await clients.compute.request({
      path: queryPath(basePath, query),
      label: `${target.logicalName} container rollouts page ${page}`,
      rawName: rawName("cloudflare", target.logicalName, `rollouts-${page}`)
    });
    const rawResult = responseResult(
      response,
      `${target.logicalName} container rollouts page ${page}`
    );
    const rawPageItems = rawResult;
    requireValue(
      Array.isArray(rawPageItems) && rawPageItems.length <= CONTAINER_PAGE_SIZE,
      `${target.logicalName} container rollout page has an unsupported provider shape`
    );
    const rawFinalId = rawPageItems.length === 0
      ? null
      : providerIdentity(
          rawPageItems.at(-1)?.id,
          `${target.logicalName} container rollout page ${page} final id`
        );
    const pageItems = normalizeStagingTeardownContainerCollection(
      rawResult,
      "rollouts",
      `${target.logicalName} container rollouts page ${page}`,
      CONTAINER_PAGE_SIZE
    );
    for (const item of pageItems) {
      requireValue(!ids.has(item.id), `${target.logicalName} rollout pagination repeated an id`);
      ids.add(item.id);
      rollouts.push(item);
    }
    if (pageItems.length < CONTAINER_PAGE_SIZE) {
      return rollouts.sort((left, right) =>
        compareStagingTeardownCodeUnits(left.id, right.id)
      );
    }
    requireValue(rawFinalId !== null, `${target.logicalName} full rollout page lacks a cursor id`);
    last = rawFinalId;
  }
  throw new Error(`${target.logicalName} rollout pagination exceeded its page limit`);
}

async function captureContainerInstances({ clients, rawName, cf, target }) {
  const basePath = cloudflarePath(
    "client", "v4", "accounts", cf.accountId, "containers", "dash",
    "applications", target.applicationId, "instances"
  );
  const inactive = [];
  const ids = new Set();
  const tokens = new Set();
  let pageToken = null;
  for (let page = 1; page <= CONTAINER_INSTANCE_MAX_PAGES; page += 1) {
    const query = [["per_page", String(CONTAINER_PAGE_SIZE)]];
    if (pageToken !== null) query.push(["page_token", pageToken]);
    const response = await clients.compute.request({
      path: queryPath(basePath, query),
      label: `${target.logicalName} container instances page ${page}`,
      rawName: rawName("cloudflare", target.logicalName, `instances-${page}`)
    });
    const result = responseResult(
      response,
      `${target.logicalName} container instances page ${page}`
    );
    requireValue(
      isRecord(result) &&
        Object.keys(result).every((key) => ["instances", "durable_objects"].includes(key)) &&
        Object.hasOwn(result, "instances") &&
        Array.isArray(result.instances) && result.instances.length <= CONTAINER_PAGE_SIZE &&
        result.instances.every(isRecord),
      `${target.logicalName} container instance page has an unsupported provider shape`
    );
    requireValue(
      result.instances.length === 0,
      `${target.logicalName} still has a live or nonterminal container placement`
    );
    const durableObjects = Object.hasOwn(result, "durable_objects")
      ? result.durable_objects
      : [];
    requireValue(
      Array.isArray(durableObjects) && durableObjects.length <= CONTAINER_PAGE_SIZE,
      `${target.logicalName} inactive Durable Object page is unbounded`
    );
    for (const [index, value] of durableObjects.entries()) {
      const normalized = normalizeStagingTeardownInactiveContainerDurableObject(
        value,
        `${target.logicalName} inactive Durable Object page ${page} item ${index}`
      );
      requireValue(
        !ids.has(normalized.id),
        `${target.logicalName} inactive Durable Object pagination repeated an id`
      );
      ids.add(normalized.id);
      inactive.push(normalized);
    }
    const info = response.value?.result_info;
    requireValue(
      isRecord(info) && Object.keys(info).length === 1 &&
        Object.hasOwn(info, "next_page_token"),
      `${target.logicalName} container instance pagination has an unsupported provider shape`
    );
    const next = info.next_page_token;
    requireValue(
      next === null ||
        (typeof next === "string" && next.length >= 1 && next.length <= 1_024 &&
          !/[\u0000-\u001f\u007f]/.test(next)),
      `${target.logicalName} container instance pagination returned an invalid token`
    );
    if (next === null) {
      requireValue(
        durableObjects.length < CONTAINER_PAGE_SIZE,
        `${target.logicalName} full container instance page omitted a continuation token`
      );
      return inactive.sort((left, right) =>
        compareStagingTeardownCodeUnits(left.id, right.id)
      );
    }
    requireValue(
      !tokens.has(next),
      `${target.logicalName} container instance pagination returned an invalid token`
    );
    tokens.add(next);
    pageToken = next;
  }
  throw new Error(`${target.logicalName} instance pagination exceeded its page limit`);
}

async function captureContainers({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const applications = await listContainerApplications({ clients, rawName, manifest });
  for (const [index, target] of cf.containers.entries()) {
    const matches = applications.filter((application) =>
      application.name === target.applicationName
    );
    requireValue(
      matches.length <= 1,
      `${target.logicalName} matched more than one container application`
    );
    if (matches.length === 0) continue;
    const listedId = providerIdentity(matches[0].id, `${target.logicalName} listed application id`);
    const response = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "containers", "applications", listedId
      ),
      label: `${target.logicalName} exact container application`,
      rawName: rawName("cloudflare", target.logicalName, "application")
    });
    const normalized = normalizeStagingTeardownContainerApplication(
      responseResult(response, `${target.logicalName} exact container application`),
      `${target.logicalName} exact container application`
    );
    requireValue(
      normalized.accountId === cf.accountId,
      `${target.logicalName} application account does not match the reviewed account`
    );
    requireValue(
      normalized.applicationId === listedId &&
        normalized.applicationName === target.applicationName,
      `${target.logicalName} exact application identity changed during capture`
    );
    const worker = cf.workers[index];
    if (worker.expectedPresent) {
      requireValue(
        normalized.durableObjectNamespaceId === worker.durableObjectNamespaceId,
        `${target.logicalName} namespace does not match its canonical Worker`
      );
    }
    target.applicationId = listedId;
    target.expectedPresent = true;
    target.durableObjectNamespaceId = normalized.durableObjectNamespaceId;
    target.resolvedImageDigest = normalized.resolvedImageDigest;
    target.applicationSha256 = stagingTeardownProjectionSha256(normalized.projection);

    const deploymentsResponse = await clients.compute.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "containers", "applications",
        listedId, "deployments"
      ),
      label: `${target.logicalName} container deployments`,
      rawName: rawName("cloudflare", target.logicalName, "container-deployments")
    });
    const deployments = normalizeStagingTeardownContainerCollection(
      responseResult(deploymentsResponse, `${target.logicalName} container deployments`),
      "deployments",
      `${target.logicalName} container deployments`,
      CONTAINER_DEPLOYMENT_MAX_COUNT
    );
    for (const [deploymentIndex, deployment] of deployments.entries()) {
      requireValue(
        deployment.account_id === cf.accountId,
        `${target.logicalName} deployment ${deploymentIndex} account does not match`
      );
      if (Object.hasOwn(deployment, "app_id")) {
        requireValue(
          deployment.app_id === listedId,
          `${target.logicalName} deployment ${deploymentIndex} application does not match`
        );
      }
    }
    const rollouts = await captureContainerRollouts({ clients, rawName, cf, target });
    const inactive = await captureContainerInstances({ clients, rawName, cf, target });
    target.deploymentsSha256 = stagingTeardownProjectionSha256(deployments);
    target.rolloutsSha256 = stagingTeardownProjectionSha256(rollouts);
    target.inactiveDurableObjectsSha256 = stagingTeardownProjectionSha256(inactive);
  }
}

async function listAccountBuckets({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const all = [];
  for (const jurisdiction of R2_JURISDICTIONS) {
    const buckets = await listCloudflareCursorPages({
      client: clients.r2,
      basePath: cloudflarePath("client", "v4", "accounts", cf.accountId, "r2", "buckets"),
      label: `complete account R2 bucket inventory (${jurisdiction})`,
      rawName: (page) => rawName(
        "cloudflare",
        "r2",
        `buckets-${jurisdiction}-${page}`
      ),
      maxPages: R2_BUCKET_LIST_MAX_PAGES,
      pageSize: 1_000,
      requestOptions: { cloudflareR2Jurisdiction: jurisdiction },
      extract(response, label) {
        const result = responseResult(response, label);
        const info = response.value?.result_info;
        requireValue(
          isRecord(result) && Array.isArray(result.buckets) && isRecord(info),
          `${label} has an unsupported provider shape`
        );
        const nextCursor = info.cursor ?? null;
        return {
          items: result.buckets.map((bucket, index) => {
            requireValue(isRecord(bucket), `${label} bucket ${index} must be an object`);
            requireValue(
              bucket.jurisdiction === undefined || bucket.jurisdiction === jurisdiction,
              `${label} returned a bucket from the wrong jurisdiction`
            );
            return bucket.jurisdiction === undefined
              ? { ...bucket, jurisdiction }
              : bucket;
          }),
          nextCursor,
          isTruncated: nextCursor !== null && nextCursor !== ""
        };
      }
    });
    all.push(...buckets);
  }
  return all;
}

async function captureBuckets({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const listedBuckets = await listAccountBuckets({ clients, rawName, manifest });
  const identities = new Set();
  const projectedBuckets = listedBuckets.map((bucket) => {
    const projected = projectStagingTeardownR2Bucket(bucket);
    const identity = `${projected.jurisdiction}\u0000${projected.name}`;
    requireValue(
      typeof projected.name === "string" && !identities.has(identity),
      "R2 bucket inventory contains a repeated or invalid jurisdiction/name identity"
    );
    identities.add(identity);
    return projected;
  });
  let totalObjects = 0;
  for (const target of cf.buckets) {
    const nonDefaultMatches = projectedBuckets.filter((bucket) =>
      bucket.name === target.bucketName && bucket.jurisdiction !== R2_TARGET_JURISDICTION
    );
    requireValue(
      nonDefaultMatches.length === 0,
      `${target.logicalName} has a same-name bucket outside the default R2 jurisdiction`
    );
    const matches = projectedBuckets.filter((bucket) =>
      bucket.name === target.bucketName && bucket.jurisdiction === R2_TARGET_JURISDICTION
    );
    requireValue(
      matches.length <= 1,
      `${target.logicalName} matched more than one R2 bucket`
    );
    if (matches.length === 0) continue;
    const listed = matches[0];
    const exactResponse = await clients.r2.request({
      cloudflareR2Jurisdiction: R2_TARGET_JURISDICTION,
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "r2", "buckets", target.bucketName
      ),
      label: `${target.logicalName} exact R2 bucket identity`,
      rawName: rawName("cloudflare", target.logicalName, "bucket")
    });
    const direct = responseResult(exactResponse, `${target.logicalName} exact R2 bucket identity`);
    const exact = projectStagingTeardownR2Bucket(direct);
    requireValue(
      serializeCanonicalEvidence(exact) === serializeCanonicalEvidence(listed),
      `${target.logicalName} R2 bucket identity changed during capture`
    );

    const lifecycleResponse = await clients.r2.request({
      cloudflareR2Jurisdiction: R2_TARGET_JURISDICTION,
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "r2", "buckets",
        target.bucketName, "lifecycle"
      ),
      label: `${target.logicalName} lifecycle configuration`,
      rawName: rawName("cloudflare", target.logicalName, "lifecycle")
    });
    const lifecycle = responseResult(
      lifecycleResponse,
      `${target.logicalName} lifecycle configuration`
    );
    requireValue(
      isRecord(lifecycle) && Array.isArray(lifecycle.rules),
      `${target.logicalName} lifecycle configuration has an unsupported provider shape`
    );
    const lifecycleRules = normalizeStagingTeardownR2LifecycleRules(
      lifecycle.rules,
      `${target.logicalName} lifecycle rules`
    );

    const managedResponse = await clients.r2.request({
      cloudflareR2Jurisdiction: R2_TARGET_JURISDICTION,
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "r2", "buckets",
        target.bucketName, "domains", "managed"
      ),
      label: `${target.logicalName} managed r2.dev domain`,
      rawName: rawName("cloudflare", target.logicalName, "managed-domain")
    });
    const managed = responseResult(
      managedResponse,
      `${target.logicalName} managed r2.dev domain`
    );
    exactKeys(
      managed,
      ["bucketId", "domain", "enabled"],
      `${target.logicalName} managed r2.dev domain`
    );
    requireValue(
      managed.enabled === false,
      `${target.logicalName} managed r2.dev domain must be disabled before sealing`
    );
    providerIdentity(managed.bucketId, `${target.logicalName} managed-domain bucket id`);
    requireValue(
      typeof managed.domain === "string" && managed.domain.length >= 1 &&
        managed.domain.length <= 253 && !/[\u0000-\u001f\u007f]/.test(managed.domain),
      `${target.logicalName} managed r2.dev domain is invalid`
    );

    const objects = await listCloudflareCursorPages({
      client: clients.r2,
      basePath: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "r2", "buckets",
        target.bucketName, "objects"
      ),
      label: `${target.logicalName} exact R2 object inventory`,
      rawName: (page) => rawName("cloudflare", target.logicalName, `objects-${page}`),
      maxPages: R2_OBJECT_LIST_MAX_PAGES,
      pageSize: 100,
      requestOptions: { cloudflareR2Jurisdiction: R2_TARGET_JURISDICTION },
      extract(response, label) {
        const result = responseResult(response, label);
        const info = response.value?.result_info;
        requireValue(
          Array.isArray(result) && isRecord(info) && typeof info.is_truncated === "boolean",
          `${label} has an unsupported provider shape`
        );
        return {
          items: result,
          nextCursor: info.cursor ?? null,
          isTruncated: info.is_truncated
        };
      }
    });
    const projectedObjects = objects.map(projectStagingTeardownR2Object)
      .sort((left, right) => compareStagingTeardownCodeUnits(left.key, right.key));
    totalObjects += projectedObjects.length;
    Object.assign(target, {
      expectedPresent: true,
      expectedCreationDate: exact.creationDate,
      expectedJurisdiction: exact.jurisdiction,
      expectedLocation: exact.location,
      expectedStorageClass: exact.storageClass,
      expectedLifecycleRules: lifecycleRules,
      managedDomainBucketId: managed.bucketId,
      managedDomainDomain: managed.domain,
      objects: projectedObjects
    });
  }
  requireValue(
    totalObjects <= STAGING_TEARDOWN_R2_OBJECT_KEY_MAX_COUNT,
    "staging R2 object inventory exceeds the global target ceiling"
  );
}

async function captureCredentialSets({ clients, rawName, manifest }) {
  const cf = manifest.cloudflare;
  const tokens = await listStrictNumberedPages({
    client: clients.token,
    basePath: cloudflarePath("client", "v4", "accounts", cf.accountId, "tokens"),
    label: "complete account-owned token inventory",
    rawName: (page) => rawName("cloudflare", "tokens", `list-${page}`),
    parseItem(item, label) {
      requireValue(isRecord(item), `${label} must be an object`);
      requireValue(
        typeof item.id === "string" && /^[0-9a-f]{32}$/.test(item.id),
        `${label}.id must be 32 lowercase hex`
      );
      requireValue(
        typeof item.name === "string" && item.name.length >= 1 && item.name.length <= 120 &&
          item.name === item.name.trim() && !/[\u0000-\u001f\u007f]/.test(item.name),
        `${label}.name must be bounded provider text`
      );
      return item;
    },
    identity: (token) => token.id,
    perPage: TOKEN_LIST_PAGE_SIZE,
    maxPages: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    maxItems: TOKEN_LIST_MAX_COUNT,
    queryEntries: [["include_expired", "true"]],
    allowOmittedTotalPages: true
  });
  for (const target of cf.credentialSets) {
    const matches = tokens.filter((token) => token.name === target.tokenName);
    requireValue(
      matches.length <= 1,
      `${target.logicalName} matched more than one account-owned token`
    );
    if (matches.length === 0) continue;
    const tokenId = matches[0].id;
    const detailResponse = await clients.token.request({
      path: cloudflarePath(
        "client", "v4", "accounts", cf.accountId, "tokens", tokenId
      ),
      label: `${target.logicalName} exact account-token detail`,
      rawName: rawName("cloudflare", target.logicalName, "token-detail")
    });
    const detail = responseResult(
      detailResponse,
      `${target.logicalName} exact account-token detail`
    );
    requireValue(
      isRecord(detail) && detail.id === tokenId && detail.name === target.tokenName &&
        Array.isArray(detail.policies),
      `${target.logicalName} account-token identity or policy shape changed during capture`
    );
    const policies = canonicalStagingTeardownProjection(
      detail.policies,
      `${target.logicalName} account-token policies`
    );
    Object.assign(target, {
      expectedPresent: true,
      tokenId,
      expectedPolicies: policies,
      expectedPolicySha256: stagingTeardownProjectionSha256(policies)
    });
  }
}

async function captureGithubRunner({ clients, rawName, manifest }) {
  const [owner, repository] = manifest.github.repository.split("/");
  const target = manifest.github.runner;
  const runners = await listStrictNumberedPages({
    client: clients.github,
    basePath: cloudflarePath("repos", owner, repository, "actions", "runners"),
    label: "complete repository runner inventory",
    rawName: (page) => rawName("github", target.logicalName, `runners-${page}`),
    selectItems(response, label, page) {
      requireValue(
        isRecord(response.value) && Number.isSafeInteger(response.value.total_count) &&
          response.value.total_count >= 0 && Array.isArray(response.value.runners),
        `${label} has an unsupported GitHub pagination shape`
      );
      // Adapt the GitHub total_count shape to the same strict page ledger used
      // for Cloudflare without retaining any raw body in the target manifest.
      response.value.result_info = {
        count: response.value.runners.length,
        page,
        per_page: 100,
        total_count: response.value.total_count,
        total_pages: response.value.total_count === 0
          ? 0
          : Math.ceil(response.value.total_count / 100)
      };
      return response.value.runners;
    },
    parseItem(runner, label) {
      requireValue(isRecord(runner), `${label} must be an object`);
      requireValue(Number.isSafeInteger(runner.id) && runner.id >= 1, `${label}.id is invalid`);
      requireValue(
        typeof runner.name === "string" && runner.name.length >= 1 && runner.name.length <= 100,
        `${label}.name is invalid`
      );
      return runner;
    },
    identity: (runner) => runner.id,
    perPage: 100,
    maxPages: STAGING_TEARDOWN_PROVIDER_LIST_MAX_PAGES,
    maxItems: 1_000
  });
  const matches = runners.filter((runner) => runner.name === target.name);
  requireValue(matches.length <= 1, "staging runner name matched more than one registration");
  if (matches.length === 0) return;
  const runner = matches[0];
  requireValue(
    runner.busy === false && runner.status === "offline",
    "staging runner must be offline and non-busy before target sealing"
  );
  requireValue(
    Array.isArray(runner.labels),
    "staging runner labels must be an array"
  );
  const labels = runner.labels.map((label, index) => {
    requireValue(
      isRecord(label) && typeof label.name === "string" && label.name.length <= 100,
      `staging runner label ${index} is invalid`
    );
    return label.name;
  }).sort(compareStagingTeardownCodeUnits);
  requireValue(
    serializeCanonicalEvidence(labels) ===
      serializeCanonicalEvidence(STAGING_TEARDOWN_RUNNER_LABELS),
    "staging runner labels do not match the exact offline target identity"
  );
  target.expectedPresent = true;
  target.id = runner.id;
}

export function stagingTeardownTargetCaptureCredentialsFromEnvironment(
  env,
  { readSecretFile }
) {
  requireValue(isRecord(env), "staging teardown target capture environment is required");
  requireValue(
    typeof readSecretFile === "function",
    "staging teardown target capture secret-file reader is required"
  );
  const credentials = {};
  for (const [property, environmentName] of Object.entries(
    STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES
  )) {
    const fileEnvironmentName = `${environmentName}_FILE`;
    const direct = env[environmentName];
    const file = env[fileEnvironmentName];
    requireValue(
      (typeof direct === "string" && direct.length >= 1) !==
        (typeof file === "string" && file.length >= 1),
      `${environmentName} requires exactly one direct value or ${fileEnvironmentName}`
    );
    let value;
    if (typeof direct === "string" && direct.length >= 1) {
      value = direct;
    } else {
      try {
        value = readSecretFile(file, environmentName);
      } catch {
        throw new Error(`${environmentName} secret file could not be read safely`);
      }
    }
    requireValue(
      typeof value === "string" && value.length >= 20 && value.length <= 4_096 &&
        value === value.trim() && !/\s/.test(value),
      `${environmentName} must contain one bounded non-whitespace credential`
    );
    credentials[property] = value;
  }
  requireValue(
    new Set(Object.values(credentials)).size === Object.keys(credentials).length,
    "staging teardown target capture read credentials must be pairwise distinct"
  );
  return Object.freeze(credentials);
}

/**
 * Discover the exact existing staging teardown target from fresh provider
 * state. Every provider client is GET-only. The caller owns raw-byte custody
 * through persistRaw and must destroy those bytes before releasing manifest.
 */
export async function captureStagingTeardownTargetManifest({
  stagingSourceCommit,
  accountId,
  zoneId,
  credentials,
  fetchImpl = globalThis.fetch,
  persistRaw,
  cloudflareApiBaseUrl = "https://api.cloudflare.com",
  githubApiBaseUrl = "https://api.github.com"
}) {
  requireValue(
    typeof stagingSourceCommit === "string" && FULL_SHA.test(stagingSourceCommit),
    "staging teardown target capture commit must be a full lowercase SHA"
  );
  requireValue(
    typeof accountId === "string" && ACCOUNT_ID.test(accountId),
    "staging teardown target capture account id must be 32 lowercase hex"
  );
  requireValue(
    typeof zoneId === "string" && ZONE_ID.test(zoneId),
    "staging teardown target capture zone id must be 32 lowercase hex"
  );
  requireValue(typeof fetchImpl === "function", "target capture fetch implementation is required");
  requireValue(typeof persistRaw === "function", "target capture private raw sink is required");
  const clients = captureClients({
    credentials,
    fetchImpl,
    persistRaw,
    cloudflareApiBaseUrl,
    githubApiBaseUrl
  });
  const rawName = indexedRawNamer();
  const manifest = stagingTeardownTargetManifestTemplate({
    stagingSourceCommit,
    accountId,
    zoneId
  });
  await captureWorkers({ clients, rawName, manifest });
  await captureDns({ clients, rawName, manifest });
  await captureContainers({ clients, rawName, manifest });
  await captureBuckets({ clients, rawName, manifest });
  await captureCredentialSets({ clients, rawName, manifest });
  await captureGithubRunner({ clients, rawName, manifest });
  return Object.freeze({
    manifest: validateStagingTeardownTargetManifest(manifest, stagingSourceCommit),
    requestCounts: snapshotRequestCounts(clients)
  });
}

export const STAGING_TEARDOWN_TARGET_CAPTURE_REQUEST_LIMITS = CAPTURE_REQUEST_LIMITS;
