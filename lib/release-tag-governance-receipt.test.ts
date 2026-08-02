import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const repository = "iAnonymous3000/site-behavior-lab";
const releaseApp = {
  clientId: "Iv23releaseclient123",
  integrationId: 111,
  slug: "site-behavior-release",
  permissions: { contents: "write", metadata: "read" },
  events: [],
  installation: {
    id: 1111,
    accountLogin: "iAnonymous3000",
    accountType: "User",
    repositorySelection: "selected",
    proofKind: "app-jwt-full-installation-repository-enumeration",
    repositories: [repository]
  }
};
const promotionApp = {
  clientId: "Iv23promotionclient1",
  integrationId: 222,
  slug: "site-behavior-promotion",
  permissions: { contents: "write", metadata: "read" },
  events: [],
  installation: {
    id: 2222,
    accountLogin: "iAnonymous3000",
    accountType: "User",
    repositorySelection: "selected",
    proofKind: "app-jwt-full-installation-repository-enumeration",
    repositories: [repository]
  }
};
const secretScope = {
  name: "RELEASE_APP_PRIVATE_KEY",
  observedAt: "2026-08-01T01:02:03.000Z",
  scopeKind: "point-in-time-name-inventory",
  environment: "release-tag",
  environmentPresent: true,
  repositoryPresent: false,
  ownerLogin: "iAnonymous3000",
  ownerType: "User",
  organizationPresent: null
};
const createdAt = "2026-08-01T00:00:00Z";
const updatedAt = "2026-08-01T01:00:00Z";

function ruleset(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "fixture",
    target: "branch",
    source_type: "Repository",
    source: repository,
    enforcement: "active",
    conditions: {
      ref_name: { exclude: [], include: ["refs/heads/production"] }
    },
    rules: [{ type: "non_fast_forward" }],
    created_at: createdAt,
    updated_at: updatedAt,
    bypass_actors: [],
    ...overrides
  };
}

function productionEvidenceRules() {
  return [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_linear_history" },
    {
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "Supply-chain Security", integration_id: 15368 },
          { context: "Typecheck, Unit Tests, Build", integration_id: 15368 },
          { context: "Chromium Smoke Test", integration_id: 15368 },
          {
            context: "Docker Runtime and Public R2 Smoke",
            integration_id: 15368
          },
          {
            context: "Attest exact-SHA evidence manifests",
            integration_id: 15368
          }
        ],
        strict_required_status_checks_policy: false
      }
    }
  ];
}

test("release governance capture binds full bypass lists and public updated_at", async () => {
  const {
    buildReleaseTagGovernanceReceipt,
    publicRulesetProjection,
    releaseTagGovernanceReceiptFreshnessProblems,
    releaseTagGovernanceReceiptProblems,
    releaseTagGovernanceReceiptSha256,
    serializeReleaseTagGovernanceReceipt
  } = await script("release-tag-governance-receipt-lib.mjs");
  const immutable = ruleset({
    id: 20050122,
    name: "Protect immutable release tags",
    target: "tag",
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    rules: [
      { type: "deletion" },
      { type: "update" }
    ]
  });
  const creation = ruleset({
    id: 20060001,
    name: "Restrict release tag creation",
    target: "tag",
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    rules: [{ type: "creation" }],
    bypass_actors: [
      { actor_id: releaseApp.integrationId, actor_type: "Integration", bypass_mode: "always" }
    ]
  });
  const productionEvidence = ruleset({
    id: 20050303,
    name: "Protect production evidence",
    rules: productionEvidenceRules()
  });
  const productionUpdater = ruleset({
    id: 20050309,
    name: "Restrict production updates to promoter App",
    rules: [{ type: "update" }],
    bypass_actors: [
      {
        actor_id: promotionApp.integrationId,
        actor_type: "Integration",
        bypass_mode: "always"
      }
    ]
  });
  const receipt = buildReleaseTagGovernanceReceipt({
    repository,
    capturedAt: "2026-08-01T01:02:03.000Z",
    releaseApp,
    promotionApp,
    secretScope,
    immutableTags: immutable,
    tagCreation: creation,
    productionEvidence,
    productionUpdater
  });
  assert.deepEqual(releaseTagGovernanceReceiptProblems(receipt), []);
  const bytes = serializeReleaseTagGovernanceReceipt(receipt);
  assert.deepEqual(JSON.parse(bytes), receipt);
  assert.equal(bytes.endsWith("\n"), true);
  assert.equal(bytes.slice(0, -1).includes("\n"), false);
  assert.match(releaseTagGovernanceReceiptSha256(receipt), /^[0-9a-f]{64}$/);
  assert.deepEqual(
    releaseTagGovernanceReceiptFreshnessProblems(
      receipt,
      Date.parse("2026-08-02T01:02:03.000Z")
    ),
    []
  );
  assert.match(
    releaseTagGovernanceReceiptFreshnessProblems(
      receipt,
      Date.parse("2026-08-02T01:02:03.001Z")
    ).join("; "),
    /older than 1 day/
  );
  assert.match(
    releaseTagGovernanceReceiptFreshnessProblems(
      receipt,
      Date.parse("2026-08-01T00:00:00.000Z")
    ).join("; "),
    /in the future/
  );
  assert.deepEqual(
    publicRulesetProjection(
      Object.fromEntries(
        Object.entries(creation).filter(([key]) => key !== "bypass_actors")
      )
    ),
    {
      id: receipt.rulesets.tagCreation.id,
      name: receipt.rulesets.tagCreation.name,
      target: receipt.rulesets.tagCreation.target,
      sourceType: receipt.rulesets.tagCreation.sourceType,
      source: receipt.rulesets.tagCreation.source,
      enforcement: receipt.rulesets.tagCreation.enforcement,
      conditions: receipt.rulesets.tagCreation.conditions,
      rules: receipt.rulesets.tagCreation.rules,
      createdAt: receipt.rulesets.tagCreation.createdAt,
      updatedAt: receipt.rulesets.tagCreation.updatedAt
    }
  );

  const weakened = structuredClone(receipt);
  weakened.rulesets.tagCreation.bypassActors = [];
  assert.match(
    releaseTagGovernanceReceiptProblems(weakened).join("; "),
    /release App as sole always bypass/
  );
  const wrongProductionBranch = structuredClone(receipt);
  wrongProductionBranch.rulesets.productionUpdater.conditions = {
    ref_name: { exclude: [], include: ["refs/heads/main"] }
  };
  assert.match(
    releaseTagGovernanceReceiptProblems(wrongProductionBranch).join("; "),
    /refs\/heads\/production update-only/
  );
  const broadProductionEvidence = structuredClone(receipt);
  broadProductionEvidence.rulesets.productionEvidence.conditions = {
    ref_name: { exclude: [], include: ["~ALL"] }
  };
  assert.match(
    releaseTagGovernanceReceiptProblems(broadProductionEvidence).join("; "),
    /exact active refs\/heads\/production/
  );
  const vacuousUpdater = structuredClone(receipt);
  vacuousUpdater.rulesets.productionUpdater.rules = [];
  assert.match(
    releaseTagGovernanceReceiptProblems(vacuousUpdater).join("; "),
    /update-only/
  );
  const parameterizedUpdater = structuredClone(receipt);
  parameterizedUpdater.rulesets.productionUpdater.rules = [
    {
      type: "update",
      parameters: { update_allows_fetch_and_merge: false }
    }
  ];
  assert.match(
    releaseTagGovernanceReceiptProblems(parameterizedUpdater).join("; "),
    /update-only/
  );
  const parameterizedImmutableUpdate = structuredClone(receipt);
  parameterizedImmutableUpdate.rulesets.immutableTags.rules[1] = {
    type: "update",
    parameters: { update_allows_fetch_and_merge: false }
  };
  assert.match(
    releaseTagGovernanceReceiptProblems(parameterizedImmutableUpdate).join(
      "; "
    ),
    /update\+deletion/
  );
  for (const weakenedRules of [
    [],
    productionEvidenceRules().slice(1),
    productionEvidenceRules().map((rule, index) =>
      index === 3
        ? {
            ...rule,
            parameters: {
              ...(rule as { parameters: Record<string, unknown> }).parameters,
              required_status_checks: (
                rule as {
                  parameters: {
                    required_status_checks: Array<Record<string, unknown>>;
                  };
                }
              ).parameters.required_status_checks.slice(0, 4)
            }
          }
        : rule
    ),
    productionEvidenceRules().map((rule, index) =>
      index === 3
        ? {
            ...rule,
            parameters: {
              ...(rule as { parameters: Record<string, unknown> }).parameters,
              strict_required_status_checks_policy: true
            }
          }
        : rule
    )
  ]) {
    const weakenedEvidence = structuredClone(receipt);
    weakenedEvidence.rulesets.productionEvidence.rules = weakenedRules;
    assert.match(
      releaseTagGovernanceReceiptProblems(weakenedEvidence).join("; "),
      /five GitHub Actions required-check/
    );
  }
  const extraPermission = structuredClone(receipt);
  (extraPermission.releaseApp.permissions as Record<string, string>).actions =
    "read";
  assert.match(
    releaseTagGovernanceReceiptProblems(extraPermission).join("; "),
    /permissions must be exactly/
  );
  const eventSubscription = structuredClone(receipt);
  eventSubscription.promotionApp.events = ["push"];
  assert.match(
    releaseTagGovernanceReceiptProblems(eventSubscription).join("; "),
    /events must be exactly the empty array/
  );
  const allRepositories = structuredClone(receipt);
  allRepositories.releaseApp.installation.repositorySelection = "all";
  assert.match(
    releaseTagGovernanceReceiptProblems(allRepositories).join("; "),
    /repositorySelection must be selected/
  );
  const multipleRepositories = structuredClone(receipt);
  multipleRepositories.promotionApp.installation.repositories.push(
    "iAnonymous3000/other"
  );
  assert.match(
    releaseTagGovernanceReceiptProblems(multipleRepositories).join("; "),
    /contain only the exact repository/
  );
  const repositorySecretFallback = structuredClone(receipt);
  repositorySecretFallback.secretScope.repositoryPresent = true;
  assert.match(
    releaseTagGovernanceReceiptProblems(repositorySecretFallback).join("; "),
    /exists only on release-tag/
  );
  const staleSecretInventory = structuredClone(receipt);
  staleSecretInventory.secretScope.observedAt = "2026-07-31T01:02:03.000Z";
  assert.match(
    releaseTagGovernanceReceiptProblems(staleSecretInventory).join("; "),
    /point-in-time proof/
  );
  const organizationSecretFallback = structuredClone(receipt);
  organizationSecretFallback.secretScope.ownerType = "Organization";
  organizationSecretFallback.secretScope.organizationPresent = true;
  assert.match(
    releaseTagGovernanceReceiptProblems(organizationSecretFallback).join("; "),
    /exists only on release-tag|prove absence/
  );
});

test("release governance producer is an explicit operator command", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  );
  assert.equal(
    manifest.scripts["release:governance:capture"],
    "node scripts/run-schema-cli.mjs release-tag-governance-capture"
  );
  const guide = readFileSync(
    path.join(process.cwd(), "RELEASE.md"),
    "utf8"
  );
  assert.match(guide, /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/);
  assert.match(guide, /Do not grant Administration permission/);
  assert.match(guide, /complete bypass list for all four rulesets/);
  assert.match(guide, /explicitly point-in-time secret-name inventory/);
  assert.match(
    guide,
    /current-repository-scoped token as proof of the\s+underlying installation scope/
  );
  const producer = readFileSync(
    path.join(process.cwd(), "scripts", "capture-release-tag-governance.mjs"),
    "utf8"
  );
  assert.match(producer, /ensure-gh-attestation-verifier\.mjs/);
  assert.match(producer, /path\.isAbsolute\(githubCli\)/);
  assert.match(producer, /timeout:\s*30_000/);
  assert.match(producer, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(producer, /process\.env\.RELEASE_APP_JWT/);
  assert.match(producer, /process\.env\.PROMOTION_APP_JWT/);
  assert.match(producer, /repos\/\$\{repository\}\/installation/);
  assert.match(
    producer,
    /app\/installations\/\$\{installation\.id\}\/access_tokens/
  );
  assert.match(producer, /installation\/repositories\?per_page=100/);
  assert.match(producer, /"--method", "DELETE", "installation\/token"/);
  assert.match(
    producer,
    /environments\/release-tag\/secrets\?per_page=100/
  );
  assert.match(producer, /repos\/\$\{repository\}\/actions\/secrets/);
  assert.match(producer, /orgs\/\$\{owner\.login\}\/actions\/secrets/);
  assert.doesNotMatch(producer, /execFileSync\(\s*["']gh["']/);
});

test("release workflow executes the pinned governance validator against exact live shapes", async (t) => {
  const {
    buildReleaseTagGovernanceReceipt,
    serializeReleaseTagGovernanceReceipt
  } = await script("release-tag-governance-receipt-lib.mjs");
  const immutable = ruleset({
    id: 20050122,
    name: "Protect immutable release tags",
    target: "tag",
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    rules: [
      { type: "deletion" },
      { type: "update" }
    ]
  });
  const creation = ruleset({
    id: 20060001,
    name: "Restrict release tag creation",
    target: "tag",
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    rules: [{ type: "creation" }],
    bypass_actors: [
      {
        actor_id: releaseApp.integrationId,
        actor_type: "Integration",
        bypass_mode: "always"
      }
    ]
  });
  const productionEvidence = ruleset({
    id: 20050303,
    name: "Protect production evidence",
    rules: productionEvidenceRules()
  });
  const productionUpdater = ruleset({
    id: 20050309,
    name: "Restrict production updates to promoter App",
    rules: [{ type: "update" }],
    bypass_actors: [
      {
        actor_id: promotionApp.integrationId,
        actor_type: "Integration",
        bypass_mode: "always"
      }
    ]
  });
  const ceremonyCapturedAt = new Date().toISOString();
  const receipt = buildReleaseTagGovernanceReceipt({
    repository,
    capturedAt: ceremonyCapturedAt,
    releaseApp,
    promotionApp,
    secretScope: { ...secretScope, observedAt: ceremonyCapturedAt },
    immutableTags: immutable,
    tagCreation: creation,
    productionEvidence,
    productionUpdater
  });
  const receiptBytes = serializeReleaseTagGovernanceReceipt(receipt);
  const runnerTemp = mkdtempSync(
    path.join(os.tmpdir(), "site-behavior-release-governance-")
  );
  t.after(() => rmSync(runnerTemp, { recursive: true, force: true }));
  const context = path.join(runnerTemp, "release-governance");
  mkdirSync(context);
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(context, name), `${JSON.stringify(value)}\n`);
  writeFileSync(path.join(context, "receipt.json"), receiptBytes);
  write("readiness.json", {
    gates: {
      "release-tag-governance": {
        kind: "release-tag-governance",
        artifact:
          "research/ops-receipts/release-tag-governance.json",
        sha256: createHash("sha256").update(receiptBytes).digest("hex"),
        maxAgeDays: 1
      }
    }
  });
  write("release-app.json", {
    id: releaseApp.integrationId,
    client_id: releaseApp.clientId,
    slug: releaseApp.slug,
    permissions: releaseApp.permissions,
    events: releaseApp.events
  });
  write("promotion-app.json", {
    id: promotionApp.integrationId,
    client_id: promotionApp.clientId,
    slug: promotionApp.slug,
    permissions: promotionApp.permissions,
    events: promotionApp.events
  });
  write("immutable-tags.json", immutable);
  write("tag-creation.json", creation);
  write("production-evidence.json", productionEvidence);
  write("production-updater.json", productionUpdater);
  writeFileSync(
    path.join(context, "required-ci-jobs.json"),
    readFileSync(path.join(process.cwd(), ".github", "required-ci-jobs.json"))
  );

  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8"
  );
  const step = workflow.slice(
    workflow.indexOf("- name: Verify pinned tag and production governance"),
    workflow.indexOf(
      "- name: Create the annotated release tag atomically through the Git database API"
    )
  );
  const start = step.indexOf("node <<'NODE'\n") + "node <<'NODE'\n".length;
  const end = step.indexOf("\n          NODE", start);
  assert.ok(start > "node <<'NODE'\n".length && end > start);
  const controller = step
    .slice(start, end)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
  const run = (candidateReceiptBytes = receiptBytes) => {
    writeFileSync(
      path.join(context, "receipt.json"),
      candidateReceiptBytes
    );
    write("readiness.json", {
      gates: {
        "release-tag-governance": {
          kind: "release-tag-governance",
          artifact:
            "research/ops-receipts/release-tag-governance.json",
          sha256: createHash("sha256")
            .update(candidateReceiptBytes)
            .digest("hex"),
          maxAgeDays: 1
        }
      }
    });
    return spawnSync(process.execPath, ["--input-type=commonjs", "-e", controller], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        GITHUB_REPOSITORY: repository,
        RELEASE_APP_CLIENT_ID: releaseApp.clientId,
        RELEASE_APP_INTEGRATION_ID: String(releaseApp.integrationId),
        RELEASE_APP_SLUG: releaseApp.slug,
        RELEASE_TAG_CREATION_RULESET_ID: String(creation.id),
        RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: createHash("sha256")
          .update(candidateReceiptBytes)
          .digest("hex"),
        PROMOTION_APP_CLIENT_ID: promotionApp.clientId,
        PROMOTION_APP_INTEGRATION_ID: String(promotionApp.integrationId),
        PROMOTION_APP_SLUG: promotionApp.slug
      }
    });
  };
  const accepted = run();
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);

  write("tag-creation.json", {
    ...creation,
    updated_at: "2026-08-01T02:00:00Z"
  });
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /public shape or GitHub updated_at differs/);

  write("tag-creation.json", creation);
  const staleCapturedAt = new Date(
    Date.now() - 24 * 60 * 60 * 1000 - 1
  ).toISOString();
  const staleReceipt = {
    ...receipt,
    capturedAt: staleCapturedAt,
    secretScope: {
      ...receipt.secretScope,
      observedAt: staleCapturedAt
    }
  };
  const stale = run(serializeReleaseTagGovernanceReceipt(staleReceipt));
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /outside its fixed 24-hour ceremony window/);
});
