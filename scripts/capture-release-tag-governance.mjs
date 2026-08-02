#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseTagGovernanceReceipt,
  IMMUTABLE_TAG_RULESET_ID,
  PRODUCTION_EVIDENCE_RULESET_ID,
  PRODUCTION_UPDATER_RULESET_ID,
  releaseTagGovernanceReceiptSha256,
  serializeReleaseTagGovernanceReceipt
} from "./release-tag-governance-receipt-lib.mjs";
import { writeExclusive } from "./operator-evidence-common.mjs";

function usage() {
  return [
    "Requires a maintainer GH_TOKEN plus short-lived RELEASE_APP_JWT and PROMOTION_APP_JWT environment variables.",
    "Usage: node scripts/capture-release-tag-governance.mjs",
    "  --repository <owner/name>",
    "  --release-app-client-id <client-id>",
    "  --release-app-integration-id <numeric-id>",
    "  --release-app-slug <slug>",
    "  --promotion-app-client-id <client-id>",
    "  --promotion-app-integration-id <numeric-id>",
    "  --promotion-app-slug <slug>",
    "  --creation-ruleset-id <numeric-id>",
    "  --output <new-file>"
  ].join(" ");
}

function parseArgs(argv) {
  const allowed = new Set([
    "--repository",
    "--release-app-client-id",
    "--release-app-integration-id",
    "--release-app-slug",
    "--promotion-app-client-id",
    "--promotion-app-integration-id",
    "--promotion-app-slug",
    "--creation-ruleset-id",
    "--output"
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.length === 0) {
      throw new Error(usage());
    }
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} may appear once`);
    values[flag] = value;
  }
  for (const flag of allowed) {
    if (!Object.hasOwn(values, flag)) throw new Error(`${flag} is required`);
  }
  return values;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be numeric`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large`);
  return parsed;
}

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const githubCli = execFileSync(
  process.execPath,
  [path.join(rootDir, "scripts", "ensure-gh-attestation-verifier.mjs")],
  {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "inherit"]
  }
).trim();
if (!path.isAbsolute(githubCli)) {
  throw new Error("the byte-pinned GitHub CLI resolver did not return an absolute path");
}

function githubApi(args, token = process.env.GH_TOKEN, maximum = 1024 * 1024) {
  if (typeof token !== "string" || token.length < 1) {
    throw new Error("the required GitHub credential is absent");
  }
  const output = execFileSync(
    githubCli,
    [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      ...args
    ],
    {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: maximum,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error(`${args.at(-1)} returned non-UTF-8 bytes`);
  }
  return text;
}

function fetchJson(endpoint, token = process.env.GH_TOKEN) {
  const text = githubApi([endpoint], token);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} returned invalid JSON`);
  }
}

function fetchPaginatedJson(endpoint, token = process.env.GH_TOKEN) {
  const text = githubApi(
    ["--paginate", "--slurp", endpoint],
    token,
    4 * 1024 * 1024
  );
  let pages;
  try {
    pages = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} returned invalid paginated JSON`);
  }
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100) {
    throw new Error(`${endpoint} returned an invalid bounded page set`);
  }
  return pages;
}

function secretNames(endpoint) {
  const pages = fetchPaginatedJson(endpoint);
  const names = pages.flatMap((page) =>
    Array.isArray(page?.secrets) ? page.secrets.map((secret) => secret?.name) : []
  );
  if (
    names.some((name) => typeof name !== "string" || name.length < 1) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`${endpoint} returned malformed or duplicate secret names`);
  }
  const declaredTotal = pages.at(-1)?.total_count;
  if (!Number.isSafeInteger(declaredTotal) || declaredTotal !== names.length) {
    throw new Error(`${endpoint} pagination did not enumerate every secret name`);
  }
  return names;
}

function normalizeAppAndInstallation({
  label,
  configured,
  repository,
  owner,
  jwt
}) {
  if (typeof jwt !== "string" || jwt.length < 1) {
    throw new Error(`${label} App JWT is required for installation capture`);
  }
  const live = fetchJson(`apps/${configured.slug}`, jwt);
  if (
    live?.id !== configured.integrationId ||
    live?.client_id !== configured.clientId ||
    live?.slug !== configured.slug
  ) {
    throw new Error(
      `${label} App client id, Integration id, and slug do not identify one public GitHub App`
    );
  }
  const installation = fetchJson(`repos/${repository}/installation`, jwt);
  if (
    !Number.isSafeInteger(installation?.id) ||
    installation.id < 1 ||
    installation?.app_id !== configured.integrationId ||
    installation?.account?.login !== owner.login ||
    installation?.account?.type !== owner.type ||
    installation?.repository_selection !== "selected"
  ) {
    throw new Error(
      `${label} App is not one selected-repository installation on the exact owner`
    );
  }

  // This token request is deliberately un-narrowed: the following
  // /installation/repositories enumeration therefore proves the underlying
  // installation's repository set. A current-repository-scoped token minted
  // by the release workflow cannot make that claim.
  const tokenResponse = JSON.parse(
    githubApi(
      [
        "--method",
        "POST",
        `app/installations/${installation.id}/access_tokens`
      ],
      jwt
    )
  );
  if (typeof tokenResponse?.token !== "string" || tokenResponse.token.length < 1) {
    throw new Error(`${label} App did not mint a full-installation capture token`);
  }
  let repositoryPages;
  try {
    repositoryPages = fetchPaginatedJson(
      "installation/repositories?per_page=100",
      tokenResponse.token
    );
  } finally {
    try {
      githubApi(["--method", "DELETE", "installation/token"], tokenResponse.token);
    } catch {
      throw new Error(`${label} App capture token could not be revoked`);
    }
  }
  const repositories = repositoryPages.flatMap((page) =>
    Array.isArray(page?.repositories)
      ? page.repositories.map((candidate) => candidate?.full_name)
      : []
  );
  const declaredTotal = repositoryPages.at(-1)?.total_count;
  if (
    declaredTotal !== repositories.length ||
    repositories.length !== 1 ||
    repositories[0] !== repository
  ) {
    throw new Error(
      `${label} App installation must enumerate exactly the target repository`
    );
  }
  return {
    ...configured,
    permissions: live.permissions,
    events: live.events,
    installation: {
      id: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repository_selection,
      proofKind: "app-jwt-full-installation-repository-enumeration",
      repositories
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = options["--repository"];
  const creationRulesetId = positiveInteger(
    options["--creation-ruleset-id"],
    "--creation-ruleset-id"
  );
  const configuredReleaseApp = {
    clientId: options["--release-app-client-id"],
    integrationId: positiveInteger(
      options["--release-app-integration-id"],
      "--release-app-integration-id"
    ),
    slug: options["--release-app-slug"]
  };
  const configuredPromotionApp = {
    clientId: options["--promotion-app-client-id"],
    integrationId: positiveInteger(
      options["--promotion-app-integration-id"],
      "--promotion-app-integration-id"
    ),
    slug: options["--promotion-app-slug"]
  };
  const repositoryMetadata = fetchJson(`repos/${repository}`);
  const owner = {
    login: repositoryMetadata?.owner?.login,
    type: repositoryMetadata?.owner?.type
  };
  if (
    owner.login !== repository.split("/")[0] ||
    !["User", "Organization"].includes(owner.type)
  ) {
    throw new Error("the repository owner identity is malformed");
  }
  const releaseApp = normalizeAppAndInstallation({
    label: "release",
    configured: configuredReleaseApp,
    repository,
    owner,
    jwt: process.env.RELEASE_APP_JWT
  });
  const promotionApp = normalizeAppAndInstallation({
    label: "promotion",
    configured: configuredPromotionApp,
    repository,
    owner,
    jwt: process.env.PROMOTION_APP_JWT
  });
  const secretName = "RELEASE_APP_PRIVATE_KEY";
  const environmentSecrets = secretNames(
    `repos/${repository}/environments/release-tag/secrets?per_page=100`
  );
  const repositorySecrets = secretNames(
    `repos/${repository}/actions/secrets?per_page=100`
  );
  const organizationSecrets =
    owner.type === "Organization"
      ? secretNames(`orgs/${owner.login}/actions/secrets?per_page=100`)
      : null;
  const capturedAt = new Date().toISOString();
  const secretScope = {
    name: secretName,
    observedAt: capturedAt,
    scopeKind: "point-in-time-name-inventory",
    environment: "release-tag",
    environmentPresent: environmentSecrets.includes(secretName),
    repositoryPresent: repositorySecrets.includes(secretName),
    ownerLogin: owner.login,
    ownerType: owner.type,
    organizationPresent:
      organizationSecrets === null
        ? null
        : organizationSecrets.includes(secretName)
  };
  const receipt = buildReleaseTagGovernanceReceipt({
    repository,
    capturedAt,
    releaseApp,
    promotionApp,
    secretScope,
    immutableTags: fetchJson(
      `repos/${repository}/rulesets/${IMMUTABLE_TAG_RULESET_ID}`
    ),
    tagCreation: fetchJson(
      `repos/${repository}/rulesets/${creationRulesetId}`
    ),
    productionEvidence: fetchJson(
      `repos/${repository}/rulesets/${PRODUCTION_EVIDENCE_RULESET_ID}`
    ),
    productionUpdater: fetchJson(
      `repos/${repository}/rulesets/${PRODUCTION_UPDATER_RULESET_ID}`
    )
  });
  const bytes = serializeReleaseTagGovernanceReceipt(receipt);
  await writeExclusive(options["--output"], bytes);
  console.log(
    `Captured full-bypass governance receipt; set RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256=${releaseTagGovernanceReceiptSha256(
      receipt
    )}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
