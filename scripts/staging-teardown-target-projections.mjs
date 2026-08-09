import {
  isRecord,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CERTIFICATE_PACK_STATUSES = new Set([
  "initializing", "pending_validation", "deleted", "pending_issuance",
  "pending_deployment", "pending_deletion", "pending_expiration", "expired",
  "active", "initializing_timed_out", "validation_timed_out",
  "issuance_timed_out", "deployment_timed_out", "deletion_timed_out",
  "pending_cleanup", "staging_deployment", "staging_active", "deactivating",
  "inactive", "backup_issued", "holding_deployment"
]);
const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Canonical teardown projections must sort identically on every host. String
 * locale collation differs across macOS/Linux and across ICU versions, while
 * the relational operators compare deterministic UTF-16 code units.
 */
export function compareStagingTeardownCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Exact teardown identity cannot use canon-v1's lossy NFC normalization as an
 * admission mechanism: provider strings (notably R2 keys) can be byte-distinct
 * before normalization. Refuse every non-NFC value/key and normalized-key
 * collision before any canonical serialization or digest is computed.
 */
export function assertStagingTeardownProjectionNfc(value, label) {
  requireValue(
    typeof label === "string" && label.length >= 1 && label.length <= 256,
    "staging teardown NFC projection label must be bounded"
  );
  const ancestors = new Set();
  const visit = (current, path, depth) => {
    requireValue(depth <= 128, `${path} exceeds the exact projection depth limit`);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      requireValue(
        current === current.normalize("NFC"),
        `${path} must already be NFC; exact provider bytes must not be normalized silently`
      );
      return;
    }
    if (typeof current === "number") {
      requireValue(Number.isFinite(current), `${path} must be one finite JSON number`);
      return;
    }
    requireValue(
      typeof current === "object" && current !== null,
      `${path} contains a non-JSON value`
    );
    requireValue(!ancestors.has(current), `${path} contains a cyclic value`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        requireValue(
          Object.keys(current).length === current.length &&
            current.every((_entry, index) => Object.hasOwn(current, index)),
          `${path} must be one dense JSON array without extra properties`
        );
        current.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      requireValue(
        prototype === Object.prototype || prototype === null,
        `${path} must be one plain JSON object`
      );
      const normalizedKeys = new Set();
      for (const [index, key] of Object.keys(current).entries()) {
        const normalized = key.normalize("NFC");
        requireValue(
          !normalizedKeys.has(normalized),
          `${path} contains object keys that collide after NFC normalization`
        );
        normalizedKeys.add(normalized);
        requireValue(
          key === normalized,
          `${path} object key ${index} must already be NFC`
        );
        visit(current[key], `${path}.field${index}`, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };
  visit(value, label, 0);
  return value;
}

export function serializeStagingTeardownProjection(value, label) {
  assertStagingTeardownProjectionNfc(value, label);
  return serializeCanonicalEvidence(value);
}

export function boundedStagingTeardownProviderText(value, maximum, label) {
  requireValue(
    typeof value === "string" && value.length >= 1 && value.length <= maximum &&
      value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    `${label} must be bounded provider text`
  );
  return value;
}

export function stagingTeardownProviderTimestamp(value, label) {
  requireValue(
    typeof value === "string" && value.length >= 20 && value.length <= 40 &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    `${label} must be a bounded RFC 3339 timestamp`
  );
  return value;
}

export function canonicalStagingTeardownProjection(value, label) {
  try {
    return JSON.parse(serializeStagingTeardownProjection(value, label));
  } catch {
    throw new Error(`${label} is not bounded canonical JSON`);
  }
}

export function stagingTeardownProjectionSha256(value) {
  return sha256Bytes(serializeStagingTeardownProjection(
    value,
    "staging teardown SHA-256 projection"
  ));
}

export function projectStagingTeardownWorkerDomain(domain, label) {
  requireValue(isRecord(domain), `${label} must be an object`);
  for (const field of ["id", "cert_id", "zone_id"]) {
    requireValue(
      typeof domain[field] === "string" && PROVIDER_ID.test(domain[field]),
      `${label}.${field} must be one bounded provider identity`
    );
  }
  const hostname = boundedStagingTeardownProviderText(
    domain.hostname,
    253,
    `${label}.hostname`
  );
  const service = boundedStagingTeardownProviderText(
    domain.service,
    128,
    `${label}.service`
  );
  requireValue(PROVIDER_ID.test(service), `${label}.service must identify one Worker`);
  const zoneName = boundedStagingTeardownProviderText(
    domain.zone_name,
    253,
    `${label}.zone_name`
  );
  const environment = domain.environment === undefined
    ? null
    : boundedStagingTeardownProviderText(
        domain.environment,
        128,
        `${label}.environment`
      );
  return canonicalStagingTeardownProjection({
    id: domain.id,
    certId: domain.cert_id,
    hostname,
    service,
    zoneId: domain.zone_id,
    zoneName,
    environment
  }, `${label} projection`);
}

export function projectStagingTeardownDnsRecord(record) {
  requireValue(isRecord(record), "staging teardown DNS record must be an object");
  requireValue(
    record.tags === undefined || Array.isArray(record.tags),
    "staging teardown DNS record tags must be an array when present"
  );
  requireValue(
    record.settings === undefined || isRecord(record.settings),
    "staging teardown DNS record settings must be an object when present"
  );
  requireValue(
    record.data === undefined || isRecord(record.data),
    "staging teardown DNS record data must be an object when present"
  );
  requireValue(
    isRecord(record.meta),
    "staging teardown DNS record meta must be an object"
  );
  requireValue(
    typeof record.proxiable === "boolean",
    "staging teardown DNS record proxiable must be boolean"
  );
  for (const field of ["comment_modified_on", "tags_modified_on"]) {
    requireValue(
      record[field] === undefined || typeof record[field] === "string",
      `staging teardown DNS record ${field} must be omitted or an instant`
    );
  }
  requireValue(
    typeof record.zone_id === "string" && PROVIDER_ID.test(record.zone_id) &&
      typeof record.zone_name === "string" && record.zone_name.length >= 1 &&
      record.zone_name.length <= 253,
    "staging teardown DNS record zone identity is invalid"
  );
  return canonicalStagingTeardownProjection({
    id: record?.id,
    type: record?.type,
    name: record?.name,
    content: record?.content,
    proxied: record?.proxied,
    ttl: record?.ttl,
    priority: record?.priority ?? null,
    comment: record?.comment ?? null,
    commentModifiedOn: record.comment_modified_on ?? null,
    data: record.data === undefined ? null : record.data,
    meta: record.meta,
    proxiable: record.proxiable,
    tags: record.tags === undefined
      ? []
      : [...record.tags].sort(compareStagingTeardownCodeUnits),
    settings: record.settings === undefined ? {} : record.settings,
    tagsModifiedOn: record.tags_modified_on ?? null,
    createdOn: record?.created_on,
    modifiedOn: record?.modified_on,
    zoneId: record.zone_id,
    zoneName: record.zone_name
  }, "staging teardown DNS record projection");
}

export function projectStagingTeardownR2Object(object) {
  requireValue(isRecord(object), "staging teardown R2 object must be an object");
  requireValue(
    typeof object?.key === "string" && object.key === object.key.normalize("NFC"),
    "R2 object key must already be NFC; byte-distinct keys must never be silently normalized"
  );
  requireValue(
    typeof object.etag === "string" && Number.isSafeInteger(object.size) && object.size >= 0 &&
      typeof object.last_modified === "string",
    "staging teardown R2 object must expose key, etag, size, and last_modified identity"
  );
  requireValue(
    object.ssec === undefined || typeof object.ssec === "boolean",
    "staging teardown R2 ssec must be boolean when present"
  );
  requireValue(
    object.storage_class === undefined ||
      object.storage_class === "Standard" || object.storage_class === "InfrequentAccess",
    "staging teardown R2 storage_class is invalid when present"
  );
  requireValue(
    object.custom_metadata === undefined || isRecord(object.custom_metadata),
    "staging teardown R2 custom_metadata must be an object when present"
  );
  requireValue(
    object.http_metadata === undefined || isRecord(object.http_metadata),
    "staging teardown R2 http_metadata must be an object when present"
  );
  return canonicalStagingTeardownProjection({
    key: object?.key,
    etag: object?.etag,
    size: object?.size,
    lastModified: object?.last_modified,
    ssec: object.ssec === undefined ? false : object.ssec,
    storageClass: object.storage_class === undefined ? "Standard" : object.storage_class,
    customMetadata: object.custom_metadata === undefined ? {} : object.custom_metadata,
    httpMetadata: object.http_metadata === undefined ? {} : object.http_metadata
  }, "staging teardown R2 object projection");
}

export function projectStagingTeardownR2Bucket(bucket) {
  requireValue(isRecord(bucket), "staging teardown R2 bucket must be an object");
  requireValue(
    Object.keys(bucket).every((key) =>
      ["creation_date", "jurisdiction", "location", "name", "storage_class"].includes(key)
    ) && typeof bucket.name === "string" && typeof bucket.creation_date === "string",
    "staging teardown R2 bucket must expose only its documented identity fields"
  );
  requireValue(
    bucket.jurisdiction === undefined ||
      ["default", "eu", "fedramp"].includes(bucket.jurisdiction),
    "staging teardown R2 bucket jurisdiction is invalid when present"
  );
  requireValue(
    bucket.location === undefined ||
      ["apac", "eeur", "enam", "weur", "wnam", "oc"].includes(bucket.location),
    "staging teardown R2 bucket location is invalid when present"
  );
  requireValue(
    bucket.storage_class === undefined ||
      bucket.storage_class === "Standard" || bucket.storage_class === "InfrequentAccess",
    "staging teardown R2 bucket storage_class is invalid when present"
  );
  return canonicalStagingTeardownProjection({
    name: bucket.name,
    creationDate: bucket.creation_date,
    jurisdiction: bucket.jurisdiction === undefined ? "default" : bucket.jurisdiction,
    location: bucket.location === undefined ? null : bucket.location,
    storageClass: bucket.storage_class === undefined ? "Standard" : bucket.storage_class
  }, "staging teardown R2 bucket projection");
}

export function normalizeStagingTeardownR2LifecycleRules(rules, label) {
  requireValue(Array.isArray(rules), `${label} must be an array`);
  return rules.map((rule, index) => {
    requireValue(isRecord(rule), `${label}[${index}] must be an object`);
    requireValue(
      rule.storageClassTransitions === undefined ||
        Array.isArray(rule.storageClassTransitions),
      `${label}[${index}].storageClassTransitions must be an array when present`
    );
    return canonicalStagingTeardownProjection({
      ...rule,
      storageClassTransitions: rule.storageClassTransitions === undefined
        ? []
        : rule.storageClassTransitions
    }, `${label}[${index}]`);
  });
}

export function normalizeStagingTeardownWorkerBindings(bindings, label) {
  requireValue(
    Array.isArray(bindings) && bindings.length <= 128,
    `${label} must be a bounded binding array`
  );
  const names = new Set();
  const normalized = bindings.map((binding, index) => {
    const bindingLabel = `${label}[${index}]`;
    requireValue(isRecord(binding), `${bindingLabel} must be an object`);
    requireValue(
      typeof binding.name === "string" && PROVIDER_ID.test(binding.name) &&
        !names.has(binding.name),
      `${bindingLabel}.name must be one unique bounded binding name`
    );
    names.add(binding.name);
    boundedStagingTeardownProviderText(binding.type, 64, `${bindingLabel}.type`);
    if (binding.type === "secret_text" || binding.type === "secret_key") {
      requireValue(
        Object.keys(binding).length === 2 &&
          Object.hasOwn(binding, "name") && Object.hasOwn(binding, "type"),
        `${bindingLabel} ${binding.type} binding must contain exactly name and type`
      );
      // Secret values and key material never enter a manifest projection. The
      // separately enumerated name set still seals additions and removals.
      return { name: binding.name, type: binding.type };
    }
    return canonicalStagingTeardownProjection(binding, bindingLabel);
  });
  return normalized.sort((left, right) => compareStagingTeardownCodeUnits(
    serializeStagingTeardownProjection(left, `${label} normalized left binding`),
    serializeStagingTeardownProjection(right, `${label} normalized right binding`)
  ));
}

export function normalizeStagingTeardownWorkerVersionSettings(settings, label) {
  requireValue(isRecord(settings), `${label} must be an object`);
  const normalized = canonicalStagingTeardownProjection(settings, label);
  normalized.bindings = normalizeStagingTeardownWorkerBindings(
    settings.bindings === undefined ? [] : settings.bindings,
    `${label}.bindings`
  );
  return normalized;
}

export function normalizeStagingTeardownWorkerScriptSettings(settings, label) {
  requireValue(isRecord(settings), `${label} must be an object`);
  if (settings.logpush !== undefined) {
    requireValue(typeof settings.logpush === "boolean", `${label}.logpush must be boolean`);
  }
  const tags = settings.tags === undefined || settings.tags === null ? [] : settings.tags;
  requireValue(
    Array.isArray(tags) && tags.length <= 64 &&
      tags.every((tag) => typeof tag === "string" && tag.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(tag)),
    `${label}.tags must be null, omitted, or a bounded string array`
  );
  const normalizedTags = [...tags].sort(compareStagingTeardownCodeUnits);
  requireValue(
    new Set(normalizedTags).size === normalizedTags.length,
    `${label}.tags must not contain duplicates`
  );
  const tailConsumers = settings.tail_consumers === undefined ||
      settings.tail_consumers === null
    ? []
    : settings.tail_consumers;
  requireValue(
    Array.isArray(tailConsumers) && tailConsumers.length === 0,
    `${label}.tail_consumers must be null, omitted, or empty before Worker deletion`
  );
  return canonicalStagingTeardownProjection({
    ...settings,
    logpush: settings.logpush === undefined ? false : settings.logpush,
    tags: normalizedTags,
    tail_consumers: []
  }, label);
}

export function projectStagingTeardownWorkerSecretName(secret, label) {
  requireValue(isRecord(secret), `${label} must be an object`);
  requireValue(
    typeof secret.name === "string" && PROVIDER_ID.test(secret.name),
    `${label}.name must be one bounded secret name`
  );
  requireValue(
    secret.type === "secret_text" || secret.type === "secret_key",
    `${label}.type must be a supported secret binding type`
  );
  return secret.name;
}

export function projectStagingTeardownWorkerVersionListItem(item, label) {
  requireValue(isRecord(item), `${label} must be an object`);
  requireValue(
    typeof item.id === "string" && PROVIDER_ID.test(item.id),
    `${label}.id must be a bounded version identity`
  );
  requireValue(
    Number.isSafeInteger(item.number) && item.number >= 1,
    `${label}.number must be a positive safe integer`
  );
  requireValue(isRecord(item.metadata), `${label}.metadata must be an object`);
  if (item.metadata.created_on !== undefined) {
    stagingTeardownProviderTimestamp(item.metadata.created_on, `${label}.metadata.created_on`);
  }
  if (item.metadata.modified_on !== undefined) {
    stagingTeardownProviderTimestamp(item.metadata.modified_on, `${label}.metadata.modified_on`);
  }
  return {
    id: item.id,
    number: item.number,
    metadata: canonicalStagingTeardownProjection(item.metadata, `${label}.metadata`)
  };
}

export function normalizeStagingTeardownWorkerVersionResources(resources, label) {
  requireValue(isRecord(resources), `${label} must be an object`);
  requireValue(isRecord(resources.script), `${label}.script must be an object`);
  requireValue(
    typeof resources.script.etag === "string" && SHA256.test(resources.script.etag),
    `${label}.script.etag must be 64 lowercase hex`
  );
  requireValue(
    resources.script_runtime === undefined || isRecord(resources.script_runtime),
    `${label}.script_runtime must be an object when present`
  );
  const normalized = canonicalStagingTeardownProjection(resources, label);
  normalized.bindings = normalizeStagingTeardownWorkerBindings(
    resources.bindings === undefined ? [] : resources.bindings,
    `${label}.bindings`
  );
  return normalized;
}

export function normalizeStagingTeardownWorkerDeployments(value, versionIds, label) {
  requireValue(
    isRecord(value) && Object.keys(value).length === 1 &&
      Object.hasOwn(value, "deployments") && Array.isArray(value.deployments) &&
      value.deployments.length <= 20,
    `${label}.deployments must be a bounded array`
  );
  requireValue(versionIds instanceof Set, `${label} version identity set is invalid`);
  const deploymentIds = new Set();
  const normalized = value.deployments.map((deployment, deploymentIndex) => {
    const deploymentLabel = `${label}.deployments[${deploymentIndex}]`;
    requireValue(isRecord(deployment), `${deploymentLabel} must be an object`);
    requireValue(
      typeof deployment.id === "string" && PROVIDER_ID.test(deployment.id) &&
        !deploymentIds.has(deployment.id),
      `${deploymentLabel}.id must be one unique bounded deployment identity`
    );
    deploymentIds.add(deployment.id);
    stagingTeardownProviderTimestamp(deployment.created_on, `${deploymentLabel}.created_on`);
    boundedStagingTeardownProviderText(deployment.source, 128, `${deploymentLabel}.source`);
    requireValue(
      deployment.strategy === "percentage",
      `${deploymentLabel}.strategy must be percentage`
    );
    requireValue(
      Array.isArray(deployment.versions) && deployment.versions.length >= 1 &&
        deployment.versions.length <= 20,
      `${deploymentLabel}.versions must be a bounded non-empty array`
    );
    const deployedVersions = new Set();
    let percentageTotal = 0;
    for (const [versionIndex, version] of deployment.versions.entries()) {
      const versionLabel = `${deploymentLabel}.versions[${versionIndex}]`;
      requireValue(isRecord(version), `${versionLabel} must be an object`);
      requireValue(
        typeof version.version_id === "string" && versionIds.has(version.version_id) &&
          !deployedVersions.has(version.version_id),
        `${versionLabel}.version_id must identify one enumerated version exactly once`
      );
      requireValue(
        typeof version.percentage === "number" && Number.isFinite(version.percentage) &&
          version.percentage >= 0.01 && version.percentage <= 100,
        `${versionLabel}.percentage is invalid`
      );
      deployedVersions.add(version.version_id);
      percentageTotal += version.percentage;
    }
    requireValue(
      Math.abs(percentageTotal - 100) < 1e-9,
      `${deploymentLabel} percentages must total exactly 100`
    );
    return canonicalStagingTeardownProjection(deployment, deploymentLabel);
  });
  return { deployments: normalized };
}

export function projectStagingTeardownStoppedWorkerBuild(item, label) {
  requireValue(isRecord(item), `${label} must be an object`);
  requireValue(
    typeof item.build_uuid === "string" && PROVIDER_UUID.test(item.build_uuid),
    `${label}.build_uuid must be one canonical provider UUID`
  );
  requireValue(
    ["queued", "initializing", "running", "stopped"].includes(item.status),
    `${label}.status must be one documented Worker Builds status`
  );
  const outcome = item.build_outcome ?? null;
  requireValue(
    outcome === null ||
      ["success", "fail", "skipped", "cancelled", "terminated"].includes(outcome),
    `${label}.build_outcome must be one documented Worker Builds outcome or absent`
  );
  return canonicalStagingTeardownProjection(
    { buildOutcome: outcome, id: item.build_uuid, status: item.status },
    `${label} projection`
  );
}

export function projectStagingTeardownCertificatePack(value, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(
    typeof value.id === "string" && PROVIDER_ID.test(value.id),
    `${label}.id must be one bounded provider identity`
  );
  boundedStagingTeardownProviderText(value.type, 64, `${label}.type`);
  requireValue(
    typeof value.status === "string" && CERTIFICATE_PACK_STATUSES.has(value.status),
    `${label}.status must be one documented certificate-pack status`
  );
  requireValue(
    Array.isArray(value.hosts) && value.hosts.length >= 1 && value.hosts.length <= 100,
    `${label}.hosts must be a bounded non-empty array`
  );
  const hosts = value.hosts.map((host, index) =>
    boundedStagingTeardownProviderText(host, 253, `${label}.hosts[${index}]`)
  ).sort(compareStagingTeardownCodeUnits);
  requireValue(new Set(hosts).size === hosts.length, `${label}.hosts contains duplicates`);
  requireValue(
    Array.isArray(value.certificates) && value.certificates.length <= 20,
    `${label}.certificates must be a bounded array`
  );
  const certificateIds = new Set();
  const certificates = value.certificates.map((certificate, index) => {
    const certificateLabel = `${label}.certificates[${index}]`;
    requireValue(isRecord(certificate), `${certificateLabel} must be an object`);
    requireValue(
      typeof certificate.id === "string" && PROVIDER_ID.test(certificate.id) &&
        !certificateIds.has(certificate.id),
      `${certificateLabel}.id must be one unique bounded provider identity`
    );
    certificateIds.add(certificate.id);
    requireValue(
      Array.isArray(certificate.hosts) && certificate.hosts.length >= 1 &&
        certificate.hosts.length <= 100,
      `${certificateLabel}.hosts must be a bounded non-empty array`
    );
    const certificateHosts = certificate.hosts.map((host, hostIndex) =>
      boundedStagingTeardownProviderText(
        host,
        253,
        `${certificateLabel}.hosts[${hostIndex}]`
      )
    ).sort(compareStagingTeardownCodeUnits);
    requireValue(
      new Set(certificateHosts).size === certificateHosts.length,
      `${certificateLabel}.hosts contains duplicates`
    );
    boundedStagingTeardownProviderText(
      certificate.status,
      64,
      `${certificateLabel}.status`
    );
    return { id: certificate.id, hosts: certificateHosts, status: certificate.status };
  }).sort((left, right) => compareStagingTeardownCodeUnits(left.id, right.id));
  return canonicalStagingTeardownProjection(
    { id: value.id, type: value.type, status: value.status, hosts, certificates },
    `${label} exact projection`
  );
}

export function normalizeStagingTeardownContainerApplication(application, label) {
  requireValue(isRecord(application), `${label} must be an object`);
  requireValue(
    typeof application.id === "string" && PROVIDER_ID.test(application.id),
    `${label}.id must be one bounded provider identity`
  );
  requireValue(
    typeof application.name === "string" && PROVIDER_ID.test(application.name),
    `${label}.name must be one bounded provider identity`
  );
  for (const field of [
    "created_at", "account_id", "version", "configuration", "instances",
    "scheduling_policy", "durable_objects"
  ]) {
    requireValue(Object.hasOwn(application, field), `${label} must expose ${field}`);
  }
  stagingTeardownProviderTimestamp(application.created_at, `${label}.created_at`);
  requireValue(
    !Object.hasOwn(application, "updated_at"),
    `${label}.updated_at is not part of the documented Application response`
  );
  requireValue(
    typeof application.account_id === "string" && PROVIDER_ID.test(application.account_id),
    `${label}.account_id must be one bounded provider identity`
  );
  requireValue(
    Number.isInteger(application.version) && application.version >= 0,
    `${label}.version must be one non-negative integer`
  );
  requireValue(
    application.instances === 0,
    `${label}.instances must be zero; container scheduling is not quiescent`
  );
  requireValue(
    !Object.hasOwn(application, "active_rollout_id"),
    `${label}.active_rollout_id must be absent; a rollout is still active`
  );
  if (Object.hasOwn(application, "health")) {
    const healthFields = ["active", "healthy", "failed", "starting", "scheduling"];
    requireValue(
      isRecord(application.health) && Object.keys(application.health).length === 1 &&
        Object.hasOwn(application.health, "instances") &&
        isRecord(application.health.instances),
      `${label}.health must contain exactly one instances object`
    );
    const actualHealthFields = Object.keys(application.health.instances)
      .sort(compareStagingTeardownCodeUnits);
    const expectedHealthFields = [...healthFields].sort(compareStagingTeardownCodeUnits);
    requireValue(
      actualHealthFields.length === expectedHealthFields.length &&
        actualHealthFields.every((field, index) => field === expectedHealthFields[index]),
      `${label}.health.instances must expose exactly the documented health counts`
    );
    for (const field of healthFields) {
      requireValue(
        Number.isInteger(application.health.instances[field]) &&
          application.health.instances[field] === 0,
        `${label}.health.instances.${field} must be zero before destructive drain`
      );
    }
  }
  boundedStagingTeardownProviderText(
    application.scheduling_policy,
    128,
    `${label}.scheduling_policy`
  );
  requireValue(
    isRecord(application.configuration) &&
      typeof application.configuration.image === "string",
    `${label}.configuration.image must be a resolved image reference`
  );
  const digestMatch = application.configuration.image.match(/@(sha256:[0-9a-f]{64})$/);
  requireValue(digestMatch !== null, `${label}.configuration.image must end in a SHA-256 digest`);
  requireValue(
    isRecord(application.durable_objects) &&
      typeof application.durable_objects.namespace_id === "string" &&
      PROVIDER_ID.test(application.durable_objects.namespace_id),
    `${label}.durable_objects.namespace_id must be one bounded provider identity`
  );
  requireValue(
    !Object.hasOwn(application, "jobs") || application.jobs === false,
    `${label}.jobs must be absent or false; job-mode applications cannot be proven drained by the instance inventory`
  );
  const projection = canonicalStagingTeardownProjection({
    ...application,
    jobs: false
  }, label);
  return {
    accountId: application.account_id,
    applicationId: application.id,
    applicationName: application.name,
    durableObjectNamespaceId: application.durable_objects.namespace_id,
    projection,
    resolvedImageDigest: digestMatch[1]
  };
}

export function normalizeStagingTeardownContainerCollection(
  value,
  collectionName,
  label,
  maximum
) {
  const items = value;
  requireValue(
    Array.isArray(items) && items.length <= maximum,
    `${label} must be a bounded ${collectionName} array`
  );
  const ids = new Set();
  return items.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    requireValue(isRecord(item), `${itemLabel} must be an object`);
    requireValue(
      typeof item.id === "string" && PROVIDER_ID.test(item.id) && !ids.has(item.id),
      `${itemLabel}.id must be one unique bounded provider identity`
    );
    ids.add(item.id);
    if (collectionName === "deployments") {
      for (const field of [
        "created_at", "account_id", "version", "type", "image", "location",
        "placements_ref", "vcpu", "memory", "memory_mib", "node_group", "network"
      ]) {
        requireValue(Object.hasOwn(item, field), `${itemLabel} must expose ${field}`);
      }
      stagingTeardownProviderTimestamp(item.created_at, `${itemLabel}.created_at`);
      requireValue(
        typeof item.account_id === "string" && PROVIDER_ID.test(item.account_id),
        `${itemLabel}.account_id must be one bounded provider identity`
      );
      requireValue(
        Number.isInteger(item.version) && item.version >= 0,
        `${itemLabel}.version must be one non-negative integer`
      );
      requireValue(
        ["default", "jobs", "durable_object"].includes(item.type),
        `${itemLabel}.type must be one documented deployment type`
      );
      boundedStagingTeardownProviderText(item.image, 2_048, `${itemLabel}.image`);
      requireValue(isRecord(item.location), `${itemLabel}.location must be an object`);
      boundedStagingTeardownProviderText(
        item.location.name,
        256,
        `${itemLabel}.location.name`
      );
      requireValue(
        typeof item.location.enabled === "boolean",
        `${itemLabel}.location.enabled must be boolean`
      );
      if (Object.hasOwn(item.location, "region")) {
        boundedStagingTeardownProviderText(
          item.location.region,
          256,
          `${itemLabel}.location.region`
        );
      }
      boundedStagingTeardownProviderText(
        item.placements_ref,
        2_048,
        `${itemLabel}.placements_ref`
      );
      requireValue(
        typeof item.vcpu === "number" && Number.isFinite(item.vcpu) && item.vcpu > 0,
        `${itemLabel}.vcpu must be one positive finite number`
      );
      boundedStagingTeardownProviderText(item.memory, 64, `${itemLabel}.memory`);
      requireValue(
        Number.isInteger(item.memory_mib) && item.memory_mib > 0,
        `${itemLabel}.memory_mib must be one positive integer`
      );
      requireValue(
        item.node_group === "metal" || item.node_group === "cloudchamber",
        `${itemLabel}.node_group must be one documented node group`
      );
      requireValue(isRecord(item.network), `${itemLabel}.network must be an object`);
      requireValue(
        ["public", "public-by-port", "private"].includes(item.network.mode),
        `${itemLabel}.network.mode must be one documented network mode`
      );
      for (const field of ["ipv4", "ipv6"]) {
        if (Object.hasOwn(item.network, field)) {
          boundedStagingTeardownProviderText(
            item.network[field],
            128,
            `${itemLabel}.network.${field}`
          );
        }
      }
      if (Object.hasOwn(item, "app_id")) {
        requireValue(
          typeof item.app_id === "string" && PROVIDER_ID.test(item.app_id),
          `${itemLabel}.app_id must be one bounded provider identity`
        );
      }
      if (Object.hasOwn(item, "app_version")) {
        requireValue(
          Number.isInteger(item.app_version) && item.app_version >= 0,
          `${itemLabel}.app_version must be one non-negative integer`
        );
      }
      if (Object.hasOwn(item, "current_placement")) {
        const placement = item.current_placement;
        requireValue(isRecord(placement), `${itemLabel}.current_placement must be an object`);
        for (const field of [
          "id", "created_at", "deployment_id", "deployment_version", "terminate", "status"
        ]) {
          requireValue(
            Object.hasOwn(placement, field),
            `${itemLabel}.current_placement must expose ${field}`
          );
        }
        requireValue(
          typeof placement.id === "string" && PROVIDER_ID.test(placement.id),
          `${itemLabel}.current_placement.id must be one bounded provider identity`
        );
        stagingTeardownProviderTimestamp(
          placement.created_at,
          `${itemLabel}.current_placement.created_at`
        );
        requireValue(
          placement.deployment_id === item.id,
          `${itemLabel}.current_placement.deployment_id must match its deployment`
        );
        requireValue(
          Number.isInteger(placement.deployment_version) && placement.deployment_version >= 0,
          `${itemLabel}.current_placement.deployment_version must be one non-negative integer`
        );
        requireValue(
          typeof placement.terminate === "boolean",
          `${itemLabel}.current_placement.terminate must be boolean`
        );
        requireValue(
          isRecord(placement.status) &&
            ["placed", "stopping", "running", "failed", "stopped", "unhealthy"]
              .includes(placement.status.health),
          `${itemLabel}.current_placement.status.health is invalid`
        );
        requireValue(
          placement.status.health === "failed" || placement.status.health === "stopped",
          `${itemLabel}.current_placement is not terminal; durable container work is not quiescent`
        );
        requireValue(
          placement.terminate === true,
          `${itemLabel}.current_placement must be terminating before destructive drain`
        );
        if (Object.hasOwn(placement.status, "ready")) {
          requireValue(
            placement.status.ready === false,
            `${itemLabel}.current_placement.status.ready must be false before destructive drain`
          );
        }
        if (Object.hasOwn(placement.status, "container_status")) {
          boundedStagingTeardownProviderText(
            placement.status.container_status,
            256,
            `${itemLabel}.current_placement.status.container_status`
          );
          requireValue(
            placement.status.container_status === "failed" ||
              placement.status.container_status === "stopped",
            `${itemLabel}.current_placement.status.container_status must be terminal`
          );
        }
        if (Object.hasOwn(placement.status, "durable_object")) {
          requireValue(
            placement.status.durable_object === "disconnected",
            `${itemLabel}.current_placement durable object must be disconnected before destructive drain`
          );
        }
        if (Object.hasOwn(placement, "last_update")) {
          stagingTeardownProviderTimestamp(
            placement.last_update,
            `${itemLabel}.current_placement.last_update`
          );
        }
        if (Object.hasOwn(placement, "durable_object_actor_id")) {
          boundedStagingTeardownProviderText(
            placement.durable_object_actor_id,
            256,
            `${itemLabel}.current_placement.durable_object_actor_id`
          );
        }
      }
    }
    if (collectionName === "rollouts") {
      for (const field of [
        "description", "created_at", "last_updated_at", "kind", "strategy",
        "current_version", "target_version", "current_configuration",
        "target_configuration", "status", "health", "steps", "progress"
      ]) {
        requireValue(Object.hasOwn(item, field), `${itemLabel} must expose ${field}`);
      }
      boundedStagingTeardownProviderText(item.description, 1_024, `${itemLabel}.description`);
      stagingTeardownProviderTimestamp(item.created_at, `${itemLabel}.created_at`);
      stagingTeardownProviderTimestamp(item.last_updated_at, `${itemLabel}.last_updated_at`);
      if (Object.hasOwn(item, "started_at")) {
        stagingTeardownProviderTimestamp(item.started_at, `${itemLabel}.started_at`);
      }
      requireValue(
        ["full_auto", "full_manual", "durable_objects_auto"].includes(item.kind),
        `${itemLabel}.kind must be one documented rollout kind`
      );
      requireValue(item.strategy === "rolling", `${itemLabel}.strategy must be rolling`);
      for (const field of ["current_version", "target_version"]) {
        requireValue(
          Number.isInteger(item[field]) && item[field] >= 0,
          `${itemLabel}.${field} must be one non-negative integer`
        );
      }
      requireValue(
        isRecord(item.current_configuration) && isRecord(item.target_configuration),
        `${itemLabel} rollout configurations must be objects`
      );
      requireValue(
        isRecord(item.health) && isRecord(item.health.instances),
        `${itemLabel}.health.instances must be an object`
      );
      for (const field of ["active", "healthy", "failed", "starting", "scheduling"]) {
        requireValue(
          Number.isInteger(item.health.instances[field]) && item.health.instances[field] >= 0,
          `${itemLabel}.health.instances.${field} must be one non-negative integer`
        );
      }
      requireValue(
        Array.isArray(item.steps) && item.steps.length <= 100,
        `${itemLabel}.steps must be one bounded array`
      );
      for (const [stepIndex, step] of item.steps.entries()) {
        const stepLabel = `${itemLabel}.steps[${stepIndex}]`;
        requireValue(isRecord(step), `${stepLabel} must be an object`);
        for (const field of ["id", "step_size", "description", "status"]) {
          requireValue(Object.hasOwn(step, field), `${stepLabel} must expose ${field}`);
        }
        requireValue(
          step.id === stepIndex + 1,
          `${stepLabel}.id must equal its one-based sequential position`
        );
        requireValue(
          isRecord(step.step_size) &&
            typeof step.step_size.percentage === "number" &&
            Number.isFinite(step.step_size.percentage) &&
            step.step_size.percentage >= 10 && step.step_size.percentage <= 100,
          `${stepLabel}.step_size.percentage is invalid`
        );
        boundedStagingTeardownProviderText(step.description, 1_024, `${stepLabel}.description`);
        requireValue(
          ["pending", "progressing", "reverting", "completed", "reverted"]
            .includes(step.status),
          `${stepLabel}.status is invalid`
        );
        for (const field of ["reason", "started_at", "completed_at"]) {
          if (!Object.hasOwn(step, field)) continue;
          if (field === "reason") {
            boundedStagingTeardownProviderText(step[field], 1_024, `${stepLabel}.${field}`);
          } else {
            stagingTeardownProviderTimestamp(step[field], `${stepLabel}.${field}`);
          }
        }
      }
      requireValue(isRecord(item.progress), `${itemLabel}.progress must be an object`);
      for (const field of ["total_steps", "current_step", "updated_instances", "total_instances"]) {
        requireValue(
          Number.isInteger(item.progress[field]) && item.progress[field] >= 0,
          `${itemLabel}.progress.${field} must be one non-negative integer`
        );
      }
      requireValue(
        item.status === "completed" || item.status === "reverted" ||
          item.status === "replaced",
        `${itemLabel}.status must be one terminal container rollout status`
      );
    }
    return canonicalStagingTeardownProjection(item, itemLabel);
  }).sort((left, right) => compareStagingTeardownCodeUnits(left.id, right.id));
}

export function normalizeStagingTeardownInactiveContainerDurableObject(value, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  requireValue(
    Object.keys(value).every((key) =>
      ["id", "deployment_id", "placement_id", "assigned_at", "name"].includes(key)
    ),
    `${label} contains an unsupported provider field`
  );
  requireValue(
    typeof value.id === "string" && PROVIDER_ID.test(value.id),
    `${label}.id must be one bounded provider identity`
  );
  stagingTeardownProviderTimestamp(value.assigned_at, `${label}.assigned_at`);
  requireValue(
    value.name === undefined ||
      (typeof value.name === "string" && value.name.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(value.name)),
    `${label}.name must be absent or bounded provider text`
  );
  requireValue(
    !Object.hasOwn(value, "deployment_id"),
    `${label} is still attached to a live container deployment`
  );
  requireValue(
    !Object.hasOwn(value, "placement_id"),
    `${label} is still attached to a live container placement`
  );
  return canonicalStagingTeardownProjection({
    assignedAt: value.assigned_at,
    id: value.id,
    name: Object.hasOwn(value, "name") ? value.name : null
  }, `${label} projection`);
}
