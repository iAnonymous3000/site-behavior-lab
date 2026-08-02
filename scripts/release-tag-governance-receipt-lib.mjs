import {
  exactKeys,
  isRecord,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const RELEASE_TAG_GOVERNANCE_RECEIPT_PATH =
  "research/ops-receipts/release-tag-governance.json";
export const RELEASE_TAG_GOVERNANCE_RECEIPT_KIND =
  "site-behavior-release-tag-governance-setup";
export const RELEASE_TAG_GOVERNANCE_RECEIPT_SCHEMA_VERSION = 1;
export const IMMUTABLE_TAG_RULESET_ID = 20050122;
export const PRODUCTION_EVIDENCE_RULESET_ID = 20050303;
export const PRODUCTION_UPDATER_RULESET_ID = 20050309;
export const RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS = 1;
const FUTURE_SKEW_MS = 10 * 60 * 1000;

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "repository",
  "capturedAt",
  "releaseApp",
  "promotionApp",
  "secretScope",
  "rulesets"
];
const APP_KEYS = [
  "clientId",
  "integrationId",
  "slug",
  "permissions",
  "events",
  "installation"
];
const APP_PERMISSION_KEYS = ["contents", "metadata"];
const INSTALLATION_KEYS = [
  "id",
  "accountLogin",
  "accountType",
  "repositorySelection",
  "proofKind",
  "repositories"
];
const SECRET_SCOPE_KEYS = [
  "name",
  "observedAt",
  "scopeKind",
  "environment",
  "environmentPresent",
  "repositoryPresent",
  "ownerLogin",
  "ownerType",
  "organizationPresent"
];
const RULESET_ROLES = [
  "immutableTags",
  "tagCreation",
  "productionEvidence",
  "productionUpdater"
];
const RULESET_KEYS = [
  "id",
  "name",
  "target",
  "sourceType",
  "source",
  "enforcement",
  "conditions",
  "rules",
  "createdAt",
  "updatedAt",
  "bypassActors"
];
const BYPASS_KEYS = ["actorId", "actorType", "bypassMode"];
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const EXPECTED_PRODUCTION_CHECKS = [
  "Supply-chain Security",
  "Typecheck, Unit Tests, Build",
  "Chromium Smoke Test",
  "Docker Runtime and Public R2 Smoke",
  "Attest exact-SHA evidence manifests"
];
const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

function canonicalInstant(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function githubInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("release governance receipt contains a non-JSON value");
}

function normalizeBypassActor(actor, label) {
  if (!isRecord(actor)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(actor).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "actor_id" ||
    keys[1] !== "actor_type" ||
    keys[2] !== "bypass_mode"
  ) {
    throw new Error(
      `${label} must expose exactly actor_id, actor_type, and bypass_mode`
    );
  }
  return {
    actorId: actor.actor_id,
    actorType: actor.actor_type,
    bypassMode: actor.bypass_mode
  };
}

export function normalizeDetailedRuleset(ruleset, label = "ruleset") {
  if (!isRecord(ruleset)) throw new Error(`${label} must be an object`);
  if (!Object.hasOwn(ruleset, "bypass_actors")) {
    throw new Error(
      `${label}.bypass_actors is hidden; capture requires a maintainer credential with ruleset write visibility`
    );
  }
  if (!Array.isArray(ruleset.bypass_actors)) {
    throw new Error(`${label}.bypass_actors must be an array`);
  }
  if (!Array.isArray(ruleset.rules) || !isRecord(ruleset.conditions)) {
    throw new Error(`${label} must expose rules and conditions`);
  }
  return {
    id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    sourceType: ruleset.source_type,
    source: ruleset.source,
    enforcement: ruleset.enforcement,
    conditions: cloneJson(ruleset.conditions),
    rules: cloneJson(ruleset.rules),
    createdAt: ruleset.created_at,
    updatedAt: ruleset.updated_at,
    bypassActors: ruleset.bypass_actors.map((actor, index) =>
      normalizeBypassActor(actor, `${label}.bypass_actors[${index}]`)
    )
  };
}

export function publicRulesetProjection(ruleset, label = "ruleset") {
  if (!isRecord(ruleset)) throw new Error(`${label} must be an object`);
  if (!Array.isArray(ruleset.rules) || !isRecord(ruleset.conditions)) {
    throw new Error(`${label} must expose rules and conditions`);
  }
  return {
    id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    sourceType: ruleset.source_type,
    source: ruleset.source,
    enforcement: ruleset.enforcement,
    conditions: cloneJson(ruleset.conditions),
    rules: cloneJson(ruleset.rules),
    createdAt: ruleset.created_at,
    updatedAt: ruleset.updated_at
  };
}

function exactTagCondition(ruleset) {
  return (
    ruleset.target === "tag" &&
    ruleset.enforcement === "active" &&
    isRecord(ruleset.conditions) &&
    Object.keys(ruleset.conditions).length === 1 &&
    isRecord(ruleset.conditions.ref_name) &&
    Object.keys(ruleset.conditions.ref_name).sort().join(",") ===
      "exclude,include" &&
    Array.isArray(ruleset.conditions.ref_name.include) &&
    ruleset.conditions.ref_name.include.length === 1 &&
    ruleset.conditions.ref_name.include[0] === "refs/tags/v*" &&
    Array.isArray(ruleset.conditions.ref_name.exclude) &&
    ruleset.conditions.ref_name.exclude.length === 0
  );
}

function exactProductionCondition(ruleset) {
  return (
    ruleset.target === "branch" &&
    ruleset.enforcement === "active" &&
    isRecord(ruleset.conditions) &&
    Object.keys(ruleset.conditions).length === 1 &&
    isRecord(ruleset.conditions.ref_name) &&
    Object.keys(ruleset.conditions.ref_name).sort().join(",") ===
      "exclude,include" &&
    Array.isArray(ruleset.conditions.ref_name.include) &&
    ruleset.conditions.ref_name.include.length === 1 &&
    ruleset.conditions.ref_name.include[0] ===
      "refs/heads/production" &&
    Array.isArray(ruleset.conditions.ref_name.exclude) &&
    ruleset.conditions.ref_name.exclude.length === 0
  );
}

function exactRuleTypes(ruleset, expected) {
  if (!Array.isArray(ruleset.rules) || ruleset.rules.length !== expected.length) {
    return false;
  }
  const types = ruleset.rules.map((rule) => rule?.type).sort();
  if (JSON.stringify(types) !== JSON.stringify([...expected].sort())) return false;
  return ruleset.rules.every(
    (rule) => isRecord(rule) && Object.keys(rule).join(",") === "type"
  );
}

function exactProductionEvidenceRules(ruleset) {
  if (!Array.isArray(ruleset.rules) || ruleset.rules.length !== 4) return false;
  const [deletion, nonFastForward, linearHistory, requiredChecks] =
    ruleset.rules;
  if (
    !isRecord(deletion) ||
    Object.keys(deletion).join(",") !== "type" ||
    deletion.type !== "deletion" ||
    !isRecord(nonFastForward) ||
    Object.keys(nonFastForward).join(",") !== "type" ||
    nonFastForward.type !== "non_fast_forward" ||
    !isRecord(linearHistory) ||
    Object.keys(linearHistory).join(",") !== "type" ||
    linearHistory.type !== "required_linear_history" ||
    !isRecord(requiredChecks) ||
    Object.keys(requiredChecks).sort().join(",") !== "parameters,type" ||
    requiredChecks.type !== "required_status_checks" ||
    !isRecord(requiredChecks.parameters) ||
    Object.keys(requiredChecks.parameters).sort().join(",") !==
      "do_not_enforce_on_create,required_status_checks,strict_required_status_checks_policy" ||
    requiredChecks.parameters.do_not_enforce_on_create !== false ||
    requiredChecks.parameters.strict_required_status_checks_policy !== false ||
    !Array.isArray(requiredChecks.parameters.required_status_checks) ||
    requiredChecks.parameters.required_status_checks.length !==
      EXPECTED_PRODUCTION_CHECKS.length
  ) {
    return false;
  }
  return requiredChecks.parameters.required_status_checks.every(
    (check, index) =>
      isRecord(check) &&
      Object.keys(check).sort().join(",") === "context,integration_id" &&
      check.context === EXPECTED_PRODUCTION_CHECKS[index] &&
      check.integration_id === GITHUB_ACTIONS_INTEGRATION_ID
  );
}

function exactBareUpdateRule(ruleset) {
  return (
    Array.isArray(ruleset.rules) &&
    ruleset.rules.length === 1 &&
    isRecord(ruleset.rules[0]) &&
    Object.keys(ruleset.rules[0]).join(",") === "type" &&
    ruleset.rules[0].type === "update"
  );
}

function appProblems(app, label, repository) {
  const problems = [];
  if (!exactKeys(app, APP_KEYS, label, problems)) return problems;
  if (!positiveSafeInteger(app.integrationId)) {
    problems.push(`${label}.integrationId must be a positive safe integer`);
  }
  if (typeof app.clientId !== "string" || !CLIENT_ID.test(app.clientId)) {
    problems.push(`${label}.clientId is malformed`);
  }
  if (typeof app.slug !== "string" || !SLUG.test(app.slug)) {
    problems.push(`${label}.slug is malformed`);
  }
  if (
    !exactKeys(app.permissions, APP_PERMISSION_KEYS, `${label}.permissions`, problems) ||
    app.permissions?.contents !== "write" ||
    app.permissions?.metadata !== "read"
  ) {
    problems.push(
      `${label}.permissions must be exactly contents write and metadata read`
    );
  }
  if (!Array.isArray(app.events) || app.events.length !== 0) {
    problems.push(`${label}.events must be exactly the empty array`);
  }
  if (
    !exactKeys(
      app.installation,
      INSTALLATION_KEYS,
      `${label}.installation`,
      problems
    )
  ) {
    return problems;
  }
  const installation = app.installation;
  if (!positiveSafeInteger(installation.id)) {
    problems.push(`${label}.installation.id must be a positive safe integer`);
  }
  if (
    typeof installation.accountLogin !== "string" ||
    installation.accountLogin !== repository.split("/")[0] ||
    !["User", "Organization"].includes(installation.accountType)
  ) {
    problems.push(
      `${label}.installation must belong to the exact repository owner`
    );
  }
  if (installation.repositorySelection !== "selected") {
    problems.push(`${label}.installation.repositorySelection must be selected`);
  }
  if (
    installation.proofKind !==
    "app-jwt-full-installation-repository-enumeration"
  ) {
    problems.push(
      `${label}.installation.proofKind must identify the App-JWT full-installation enumeration`
    );
  }
  if (
    !Array.isArray(installation.repositories) ||
    installation.repositories.length !== 1 ||
    installation.repositories[0] !== repository
  ) {
    problems.push(
      `${label}.installation.repositories must contain only the exact repository`
    );
  }
  return problems;
}

function rulesetProblems(ruleset, label) {
  const problems = [];
  if (!exactKeys(ruleset, RULESET_KEYS, label, problems)) return problems;
  if (!positiveSafeInteger(ruleset.id)) {
    problems.push(`${label}.id must be a positive safe integer`);
  }
  for (const [key, maximum] of [
    ["name", 256],
    ["target", 32],
    ["sourceType", 64],
    ["source", 256],
    ["enforcement", 32]
  ]) {
    if (
      typeof ruleset[key] !== "string" ||
      ruleset[key].length < 1 ||
      ruleset[key].length > maximum
    ) {
      problems.push(`${label}.${key} must be a bounded non-empty string`);
    }
  }
  if (!githubInstant(ruleset.createdAt) || !githubInstant(ruleset.updatedAt)) {
    problems.push(`${label} must carry GitHub-created createdAt and updatedAt instants`);
  }
  if (!isRecord(ruleset.conditions) || !Array.isArray(ruleset.rules)) {
    problems.push(`${label} must carry conditions and rules`);
  }
  if (!Array.isArray(ruleset.bypassActors)) {
    problems.push(`${label}.bypassActors must be the full visible array`);
  } else {
    for (const [index, actor] of ruleset.bypassActors.entries()) {
      const actorLabel = `${label}.bypassActors[${index}]`;
      if (!exactKeys(actor, BYPASS_KEYS, actorLabel, problems)) continue;
      if (!positiveSafeInteger(actor.actorId)) {
        problems.push(`${actorLabel}.actorId must be a positive safe integer`);
      }
      if (
        typeof actor.actorType !== "string" ||
        typeof actor.bypassMode !== "string"
      ) {
        problems.push(`${actorLabel} type and mode must be strings`);
      }
    }
  }
  return problems;
}

export function releaseTagGovernanceReceiptProblems(receipt) {
  const problems = [];
  if (!exactKeys(receipt, RECEIPT_KEYS, "receipt", problems)) return problems;
  if (
    receipt.schemaVersion !== RELEASE_TAG_GOVERNANCE_RECEIPT_SCHEMA_VERSION ||
    receipt.artifactKind !== RELEASE_TAG_GOVERNANCE_RECEIPT_KIND
  ) {
    problems.push("receipt schemaVersion or artifactKind is unsupported");
  }
  if (typeof receipt.repository !== "string" || !REPOSITORY.test(receipt.repository)) {
    problems.push("receipt.repository must be owner/name");
  }
  if (!canonicalInstant(receipt.capturedAt)) {
    problems.push("receipt.capturedAt must be a canonical UTC instant");
  }
  problems.push(
    ...appProblems(receipt.releaseApp, "receipt.releaseApp", receipt.repository),
    ...appProblems(
      receipt.promotionApp,
      "receipt.promotionApp",
      receipt.repository
    )
  );
  if (
    receipt.promotionApp?.integrationId === receipt.releaseApp?.integrationId ||
    receipt.promotionApp?.clientId === receipt.releaseApp?.clientId ||
    receipt.promotionApp?.slug === receipt.releaseApp?.slug ||
    receipt.promotionApp?.installation?.id ===
      receipt.releaseApp?.installation?.id
  ) {
    problems.push(
      "receipt release and promotion Apps and installations must be distinct identities"
    );
  }
  if (
    exactKeys(receipt.secretScope, SECRET_SCOPE_KEYS, "receipt.secretScope", problems)
  ) {
    if (
      receipt.secretScope.name !== "RELEASE_APP_PRIVATE_KEY" ||
      receipt.secretScope.scopeKind !== "point-in-time-name-inventory" ||
      receipt.secretScope.environment !== "release-tag" ||
      receipt.secretScope.environmentPresent !== true ||
      receipt.secretScope.repositoryPresent !== false ||
      receipt.secretScope.ownerLogin !== receipt.repository.split("/")[0] ||
      !["User", "Organization"].includes(receipt.secretScope.ownerType) ||
      !canonicalInstant(receipt.secretScope.observedAt) ||
      receipt.secretScope.observedAt !== receipt.capturedAt
    ) {
      problems.push(
        "receipt.secretScope must be a point-in-time proof that RELEASE_APP_PRIVATE_KEY exists only on release-tag"
      );
    }
    if (
      (receipt.secretScope.ownerType === "Organization" &&
        receipt.secretScope.organizationPresent !== false) ||
      (receipt.secretScope.ownerType === "User" &&
        receipt.secretScope.organizationPresent !== null)
    ) {
      problems.push(
        "receipt.secretScope.organizationPresent must prove absence for an organization owner and be null only for a user owner"
      );
    }
  }
  if (!exactKeys(receipt.rulesets, RULESET_ROLES, "receipt.rulesets", problems)) {
    return problems;
  }
  for (const role of RULESET_ROLES) {
    problems.push(
      ...rulesetProblems(receipt.rulesets[role], `receipt.rulesets.${role}`)
    );
    if (
      receipt.rulesets[role]?.sourceType !== "Repository" ||
      receipt.rulesets[role]?.source !== receipt.repository
    ) {
      problems.push(
        `receipt.rulesets.${role} must be sourced by the exact repository`
      );
    }
  }
  if (problems.length > 0) return problems;

  const releaseAppId = receipt.releaseApp.integrationId;
  const immutable = receipt.rulesets.immutableTags;
  const creation = receipt.rulesets.tagCreation;
  const productionEvidence = receipt.rulesets.productionEvidence;
  const productionUpdater = receipt.rulesets.productionUpdater;
  if (
    immutable.id !== IMMUTABLE_TAG_RULESET_ID ||
    !exactTagCondition(immutable) ||
    immutable.bypassActors.length !== 0 ||
    !exactRuleTypes(immutable, ["deletion", "update"])
  ) {
    problems.push(
      "immutableTags must be active refs/tags/v* update+deletion with zero bypass"
    );
  }
  if (
    creation.id === IMMUTABLE_TAG_RULESET_ID ||
    !exactTagCondition(creation) ||
    creation.bypassActors.length !== 1 ||
    creation.bypassActors[0].actorId !== releaseAppId ||
    creation.bypassActors[0].actorType !== "Integration" ||
    creation.bypassActors[0].bypassMode !== "always" ||
    !exactRuleTypes(creation, ["creation"])
  ) {
    problems.push(
      "tagCreation must be a separate active refs/tags/v* creation-only ruleset with the release App as sole always bypass"
    );
  }
  if (
    productionEvidence.id !== PRODUCTION_EVIDENCE_RULESET_ID ||
    !exactProductionCondition(productionEvidence) ||
    productionEvidence.bypassActors.length !== 0 ||
    !exactProductionEvidenceRules(productionEvidence)
  ) {
    problems.push(
      "productionEvidence must be the exact active refs/heads/production deletion, non-fast-forward, linear-history, and five GitHub Actions required-check ruleset with zero bypass"
    );
  }
  if (
    productionUpdater.id !== PRODUCTION_UPDATER_RULESET_ID ||
    !exactProductionCondition(productionUpdater) ||
    !exactBareUpdateRule(productionUpdater) ||
    productionUpdater.bypassActors.length !== 1 ||
    productionUpdater.bypassActors[0].actorType !== "Integration" ||
    productionUpdater.bypassActors[0].bypassMode !== "always" ||
    productionUpdater.bypassActors[0].actorId !==
      receipt.promotionApp.integrationId
  ) {
    problems.push(
      "productionUpdater must be active refs/heads/production update-only with exactly one distinct promotion App always bypass"
    );
  }
  return problems;
}

export function releaseTagGovernanceReceiptFreshnessProblems(
  receipt,
  now = Date.now(),
  maxAgeDays = RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS
) {
  const problems = [];
  if (!Number.isFinite(now)) {
    return ["release governance freshness reference time is invalid"];
  }
  if (
    maxAgeDays !== RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS ||
    !canonicalInstant(receipt?.capturedAt)
  ) {
    return [
      `release governance freshness must use the fixed ${RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS}-day bound and a canonical capturedAt`
    ];
  }
  const capturedAt = Date.parse(receipt.capturedAt);
  if (capturedAt > now + FUTURE_SKEW_MS) {
    problems.push("release governance receipt capturedAt is in the future");
  } else if (
    now - capturedAt >
    RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS * 86_400_000
  ) {
    problems.push(
      `release governance receipt is older than ${RELEASE_TAG_GOVERNANCE_MAX_AGE_DAYS} day; recapture secret scopes immediately before the ceremony`
    );
  }
  return problems;
}

export function buildReleaseTagGovernanceReceipt({
  repository,
  capturedAt = new Date().toISOString(),
  releaseApp,
  promotionApp,
  secretScope,
  immutableTags,
  tagCreation,
  productionEvidence,
  productionUpdater
}) {
  const receipt = {
    schemaVersion: RELEASE_TAG_GOVERNANCE_RECEIPT_SCHEMA_VERSION,
    artifactKind: RELEASE_TAG_GOVERNANCE_RECEIPT_KIND,
    repository,
    capturedAt,
    releaseApp: {
      clientId: releaseApp.clientId,
      integrationId: releaseApp.integrationId,
      slug: releaseApp.slug,
      permissions: cloneJson(releaseApp.permissions),
      events: cloneJson(releaseApp.events),
      installation: cloneJson(releaseApp.installation)
    },
    promotionApp: {
      clientId: promotionApp.clientId,
      integrationId: promotionApp.integrationId,
      slug: promotionApp.slug,
      permissions: cloneJson(promotionApp.permissions),
      events: cloneJson(promotionApp.events),
      installation: cloneJson(promotionApp.installation)
    },
    secretScope: cloneJson(secretScope),
    rulesets: {
      immutableTags: normalizeDetailedRuleset(immutableTags, "immutableTags"),
      tagCreation: normalizeDetailedRuleset(tagCreation, "tagCreation"),
      productionEvidence: normalizeDetailedRuleset(
        productionEvidence,
        "productionEvidence"
      ),
      productionUpdater: normalizeDetailedRuleset(
        productionUpdater,
        "productionUpdater"
      )
    }
  };
  const problems = releaseTagGovernanceReceiptProblems(receipt);
  if (problems.length > 0) {
    throw new Error(`release governance capture refused: ${problems.join("; ")}`);
  }
  return receipt;
}

export function serializeReleaseTagGovernanceReceipt(receipt) {
  const problems = releaseTagGovernanceReceiptProblems(receipt);
  if (problems.length > 0) {
    throw new Error(`invalid release governance receipt: ${problems.join("; ")}`);
  }
  return `${canonicalJson(receipt)}\n`;
}

export function releaseTagGovernanceReceiptSha256(receipt) {
  return sha256Bytes(serializeReleaseTagGovernanceReceipt(receipt));
}
