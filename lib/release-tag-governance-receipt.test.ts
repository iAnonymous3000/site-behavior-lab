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

function fixtureGit(
  root: string,
  args: string[],
  committedAt?: string
): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: committedAt
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: committedAt,
          GIT_COMMITTER_DATE: committedAt
        }
      : process.env
  });
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  return result.stdout.trim();
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

async function validGovernanceReceipt(capturedAt: string) {
  const { buildReleaseTagGovernanceReceipt } = await script(
    "release-tag-governance-receipt-lib.mjs"
  );
  return buildReleaseTagGovernanceReceipt({
    repository,
    capturedAt,
    releaseApp,
    promotionApp,
    secretScope: { ...secretScope, observedAt: capturedAt },
    immutableTags: ruleset({
      id: 20050122,
      name: "Protect immutable release tags",
      target: "tag",
      conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
      rules: [{ type: "deletion" }, { type: "update" }]
    }),
    tagCreation: ruleset({
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
    }),
    productionEvidence: ruleset({
      id: 20050303,
      name: "Protect production evidence",
      rules: productionEvidenceRules()
    }),
    productionUpdater: ruleset({
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
    })
  });
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
  const foreignRepository = "attacker/example";
  const foreignReceipt = structuredClone(receipt);
  foreignReceipt.repository = foreignRepository;
  for (const app of [foreignReceipt.releaseApp, foreignReceipt.promotionApp]) {
    app.installation.accountLogin = "attacker";
    app.installation.repositories = [foreignRepository];
  }
  foreignReceipt.secretScope.ownerLogin = "attacker";
  for (const ruleset of Object.values(foreignReceipt.rulesets) as Array<{
    source: string;
  }>) {
    ruleset.source = foreignRepository;
  }
  assert.match(
    releaseTagGovernanceReceiptProblems(foreignReceipt).join("; "),
    /receipt\.repository must be iAnonymous3000\/site-behavior-lab/
  );
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

test("release governance selection verifies the committed carrier before approval", async (t) => {
  const {
    releaseTagGovernanceReceiptPath,
    releaseTagGovernanceReceiptSha256,
    serializeReleaseTagGovernanceReceipt
  } = await script("release-tag-governance-receipt-lib.mjs");
  const { verifyReleaseGovernanceSelection } = await script(
    "release-governance-selection-lib.mjs"
  );
  const capturedAt = new Date().toISOString();
  const receipt = await validGovernanceReceipt(capturedAt);
  const digest = releaseTagGovernanceReceiptSha256(receipt);
  const relativePath = releaseTagGovernanceReceiptPath(digest);
  const bytes = serializeReleaseTagGovernanceReceipt(receipt);

  const root = mkdtempSync(
    path.join(os.tmpdir(), "site-behavior-governance-selection-")
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q"]);
  fixtureGit(root, ["config", "user.name", "Governance Test"]);
  fixtureGit(root, ["config", "user.email", "governance@example.invalid"]);
  writeFileSync(path.join(root, "release-policy.json"), "{}\n");
  fixtureGit(root, ["add", "release-policy.json"]);
  fixtureGit(root, ["commit", "-q", "--no-gpg-sign", "-m", "declaration"]);
  const declaration = fixtureGit(root, ["rev-parse", "HEAD"]);

  const absolutePath = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes);
  fixtureGit(root, ["add", relativePath]);
  fixtureGit(root, ["commit", "-q", "--no-gpg-sign", "-m", "governance carrier"]);
  const carrier = fixtureGit(root, ["rev-parse", "HEAD"]);
  const now = Date.parse(capturedAt) + 1_000;

  assert.deepEqual(
    verifyReleaseGovernanceSelection({
      rootDir: root,
      commit: carrier,
      receiptSha256: digest,
      now
    }),
    { commit: carrier, receiptSha256: digest, relativePath, capturedAt }
  );
  assert.throws(
    () =>
      verifyReleaseGovernanceSelection({
        rootDir: root,
        commit: declaration,
        receiptSha256: digest,
        now
      }),
    /not committed in selected release revision.*commit the receipt.*dispatch that carrier SHA/
  );
  assert.throws(
    () =>
      verifyReleaseGovernanceSelection({
        rootDir: root,
        commit: carrier,
        receiptSha256: digest,
        now: Date.parse(capturedAt) + 86_400_001
      }),
    /not fresh.*older than 1 day/
  );

  fixtureGit(root, ["update-index", "--chmod=+x", relativePath]);
  fixtureGit(root, ["commit", "-q", "--no-gpg-sign", "-m", "make receipt executable"]);
  const executableCarrier = fixtureGit(root, ["rev-parse", "HEAD"]);
  assert.throws(
    () =>
      verifyReleaseGovernanceSelection({
        rootDir: root,
        commit: executableCarrier,
        receiptSha256: digest,
        now
      }),
    /regular non-executable Git blob/
  );
});

test("release governance chronology is candidate-to-introduction bounded", async (t) => {
  const { releaseTagGovernanceEvidenceChronologyProblems } = await script(
    "release-readiness-lib.mjs"
  );
  const root = mkdtempSync(
    path.join(os.tmpdir(), "site-behavior-governance-chronology-")
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q"]);
  fixtureGit(root, ["config", "user.name", "Governance Test"]);
  fixtureGit(root, ["config", "user.email", "governance@example.invalid"]);
  writeFileSync(path.join(root, "candidate.txt"), "candidate\n");
  fixtureGit(root, ["add", "candidate.txt"]);
  fixtureGit(
    root,
    ["commit", "-q", "--no-gpg-sign", "-m", "candidate"],
    "2026-08-01T00:00:00Z"
  );
  const candidateCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  const evidencePath =
    `research/ops-receipts/release-tag-governance/${"a".repeat(64)}.json`;
  const absolute = path.join(root, ...evidencePath.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, "{}\n");
  fixtureGit(root, ["add", evidencePath]);
  fixtureGit(
    root,
    ["commit", "-q", "--no-gpg-sign", "-m", "introduce receipt"],
    "2026-08-01T01:00:00Z"
  );
  const carrierCommit = fixtureGit(root, ["rev-parse", "HEAD"]);
  const context = { binding: { candidateCommit, carrierCommit } };

  assert.deepEqual(
    releaseTagGovernanceEvidenceChronologyProblems(
      root,
      context,
      evidencePath,
      "2026-08-01T00:30:00.000Z"
    ),
    []
  );
  assert.match(
    releaseTagGovernanceEvidenceChronologyProblems(
      root,
      context,
      evidencePath,
      "2026-07-31T23:59:58.000Z"
    ).join(" "),
    /must not predate the commit that selected/
  );
  assert.match(
    releaseTagGovernanceEvidenceChronologyProblems(
      root,
      context,
      evidencePath,
      "2026-08-01T01:00:02.001Z"
    ).join(" "),
    /must not follow the commit that finalized/
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
  assert.equal(
    manifest.scripts["release:governance:verify-selection"],
    "node scripts/verify-release-governance-selection.mjs"
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
  assert.match(
    guide,
    /Install the release App private key \*\*before capture\*\*/
  );
  assert.match(
    guide,
    /For a governed `0\.x`\s+release, commit the new receipt[\s\S]*measurement-candidate binding is explicitly not required/
  );
  assert.match(guide, /Dispatch that verified carrier SHA, not the earlier version-declaration/);
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
  assert.match(producer, /releaseTagGovernanceReceiptPath\(digest\)/);
  assert.doesNotMatch(producer, /options\["--output"\]/);
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
  assert.match(producer, /dispatch the carrier commit, not the earlier version-declaration commit/);
  assert.doesNotMatch(producer, /execFileSync\(\s*["']gh["']/);
  const readiness = readFileSync(
    path.join(process.cwd(), "scripts", "release-readiness-lib.mjs"),
    "utf8"
  );
  assert.match(
    readiness,
    /releaseTagGovernanceEvidenceChronologyProblems\([\s\S]*receipt\.capturedAt/
  );
});

test("release workflow snapshots external selectors before checkout or environment", (t) => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8"
  );
  const prepareJob = workflow.slice(
    workflow.indexOf("\n  prepare:"),
    workflow.indexOf("\n  attest:")
  );
  assert.ok(prepareJob.length > 0, "prepare job must remain independently sliceable");
  assert.doesNotMatch(
    prepareJob,
    /^    environment:/m,
    "prepare must remain outside every GitHub environment so an environment-scoped selector cannot shadow the external value"
  );
  assert.equal(
    (workflow.match(/\$\{\{ vars\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 \}\}/g) ?? [])
      .length,
    1,
    "only the non-environment prepare snapshot may resolve the selector"
  );
  assert.equal(
    (workflow.match(/\$\{\{ vars\.RELEASE_MEASUREMENT_BINDING_SHA256 \}\}/g) ?? [])
      .length,
    1,
    "only the pre-checkout prepare snapshot may resolve the binding pin"
  );
  assert.match(
    workflow,
    /governance_receipt_sha256: \$\{\{ steps\.governance_selector\.outputs\.receipt_sha256 \}\}/
  );
  assert.match(
    workflow,
    /--release-tag-governance-receipt-sha256 "\$RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"/
  );
  const selection = workflow.slice(
    workflow.indexOf("- name: Verify the selected governance receipt is committed in the release revision"),
    workflow.indexOf("- name: Classify the release measurement-binding requirement")
  );
  assert.match(
    selection,
    /node scripts\/verify-release-governance-selection\.mjs[\s\S]*--commit "\$RELEASE_SHA"[\s\S]*--receipt-sha256 "\$RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"/
  );
  assert.ok(
    prepareJob.indexOf("- name: Resolve the exact revision this release names") <
      prepareJob.indexOf("- name: Verify the selected governance receipt is committed in the release revision") &&
      prepareJob.indexOf("- name: Verify the selected governance receipt is committed in the release revision") <
        prepareJob.indexOf("- name: Classify the release measurement-binding requirement"),
    "the carrier receipt must be rejected after exact-SHA resolution and before expensive release preparation"
  );

  assert.doesNotMatch(workflow, /actions\/variables\/RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/);
  const step = workflow.slice(
    workflow.indexOf("- name: Snapshot external release trust roots"),
    workflow.indexOf("- name: Checkout full history without persisted credentials")
  );
  assert.match(
    step,
    /SELECTED_GOVERNANCE_RECEIPT_SHA256: \$\{\{ vars\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 \}\}/
  );
  const start = step.indexOf("run: |") + "run: |".length;
  assert.ok(start > "run: |".length);
  const shell = step
    .slice(start)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
  const runnerTemp = mkdtempSync(
    path.join(os.tmpdir(), "site-behavior-governance-selector-")
  );
  t.after(() => rmSync(runnerTemp, { recursive: true, force: true }));
  const digest = "a".repeat(64);
  const run = (value: string) => {
    const output = path.join(runnerTemp, `output-${Math.random()}`);
    const result = spawnSync("bash", ["-c", shell], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        SELECTED_GOVERNANCE_RECEIPT_SHA256: value,
        SELECTED_MEASUREMENT_BINDING_SHA256: ""
      }
    });
    return {
      ...result,
      output:
        result.status === 0 ? readFileSync(output, "utf8") : ""
    };
  };
  const accepted = run(digest);
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);
  assert.equal(
    accepted.output,
    `receipt_sha256=${digest}\nraw_measurement_binding_sha256=\n`
  );
  const malformed = run("A".repeat(64));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stdout, /must resolve to one lowercase sha256/);
  assert.equal(run("").status, 1);
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
  const bindingContext = path.join(
    runnerTemp,
    "release-measurement-binding"
  );
  mkdirSync(bindingContext);
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(context, name), `${JSON.stringify(value)}\n`);
  writeFileSync(path.join(context, "receipt.json"), receiptBytes);
  write("readiness.json", {
    gates: {
      "release-tag-governance": {
        kind: "release-tag-governance",
        artifactDirectory:
          "research/ops-receipts/release-tag-governance",
        digestBinding: {
          kind: "github-actions-prepare-snapshot",
          name: "RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"
        },
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
  const run = (
    candidateReceiptBytes = receiptBytes,
    bindingDigest = createHash("sha256")
      .update(candidateReceiptBytes)
      .digest("hex")
  ) => {
    const candidateDigest = createHash("sha256")
      .update(candidateReceiptBytes)
      .digest("hex");
    writeFileSync(
      path.join(context, "receipt.json"),
      candidateReceiptBytes
    );
    write("readiness.json", {
      gates: {
        "release-tag-governance": {
          kind: "release-tag-governance",
          artifactDirectory:
            "research/ops-receipts/release-tag-governance",
          digestBinding: {
            kind: "github-actions-prepare-snapshot",
            name: "RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"
          },
          maxAgeDays: 1
        }
      }
    });
    const bindingBytes = `${JSON.stringify({
      evidence: [
        {
          category: "release-tag-governance-receipt",
          path:
            `research/ops-receipts/release-tag-governance/${bindingDigest}.json`,
          change: "added",
          sha256: bindingDigest
        }
      ]
    })}\n`;
    writeFileSync(
      path.join(bindingContext, "measurement-candidate-binding.json"),
      bindingBytes
    );
    const measurementBindingDigest = createHash("sha256")
      .update(bindingBytes)
      .digest("hex");
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
        RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: candidateDigest,
        RELEASE_MEASUREMENT_BINDING_REQUIRED: "true",
        RELEASE_MEASUREMENT_BINDING_SHA256: measurementBindingDigest,
        PROMOTION_APP_CLIENT_ID: promotionApp.clientId,
        PROMOTION_APP_INTEGRATION_ID: String(promotionApp.integrationId),
        PROMOTION_APP_SLUG: promotionApp.slug
      }
    });
  };
  const accepted = run();
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);

  const unbound = run(receiptBytes, "0".repeat(64));
  assert.equal(unbound.status, 1);
  assert.match(unbound.stderr, /add-only digest-enumerated evidence/);

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
