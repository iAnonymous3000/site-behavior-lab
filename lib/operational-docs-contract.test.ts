import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("operations docs distinguish the active synthetic from the active required delete canary", () => {
  const readme = source("README.md");
  const containerRunbook = source("docs/deploy-cloudflare-containers.md");
  const goLive = source("docs/go-live-public-scanner.md");
  const envExample = source(".env.example");

  assert.match(readme, /hourly production synthetic is active/i);
  assert.doesNotMatch(readme, /activation of the hourly scan\/write\/read synthetic/i);
  assert.match(containerRunbook, /Production synthetic \(active\)/);
  assert.match(containerRunbook, /synthetic never[\s\S]*does not replace the separately authenticated delete\s+canary/i);
  assert.match(goLive, /hourly production synthetic is active/i);
  assert.match(readme, /R2 delete canary is also active and required/i);
  assert.match(
    containerRunbook,
    /reference deployment's R2 delete canary is active and required as of\s+2026-07-29/i
  );
  assert.match(containerRunbook, /Production Health run 30483261603/);
  assert.match(goLive, /R2 delete canary is now active and required/i);
  assert.match(envExample, /SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN=/);

  for (const document of [readme, containerRunbook, goLive]) {
    assert.match(document, /WAF[\s-]*(?:ceiling|rate)/i);
    assert.match(
      document,
      /(?:log[\s-]*retention|logs?[\s\S]{0,100}seven-day range|historical\s+log-query)/i
    );
    assert.match(document, /R2 delete[- ]canary/i);
    assert.match(document, /independent\s+egress backstop/i);
  }
});

test("current operator docs record the fresh WAF and seven-day log receipts", () => {
  const readme = source("README.md");
  const containerRunbook = source("docs/deploy-cloudflare-containers.md");
  const goLive = source("docs/go-live-public-scanner.md");
  const evidenceSurvey = source("docs/report-view-evidence-survey.md");

  for (const document of [readme, containerRunbook, goLive, evidenceSurvey]) {
    assert.match(document, /2026-07-29/);
    assert.match(document, /combined WAF (?:ceiling|rate-limiting rule)/i);
    assert.match(
      document,
      /ten\s+requests\s+per\s+ten\s+seconds\s+per\s+IP\s+with\s+a\s+ten-second\s+block/i
    );
    assert.match(document, /both\s+`POST \/api\/scan`\s+and\s+`GET \/api\/scan\/admission`/i);
    assert.match(
      document,
      /eleventh bounded invalid\s+request received\s+`429` plus\s+`Retry-After: 10`/i
    );
    assert.match(document, /Security Events matched[\s\S]{0,100}method[\s\S]{0,40}path/i);
    assert.match(
      document,
      /ordinary\s+application\s+`400`\s+returned\s+after\s+the\s+block\s+expired/i
    );
    assert.match(
      document,
      /bounded\s+seven-day\s+Workers\s+Observability\s+dashboard\s+query\s+returned\s+80\s+visible\s+`\/api\/health`\s+matches/i
    );
    assert.match(document, /`2026-07-22 18:23`[\s\S]{0,100}`2026-07-29 11:25`/i);
    assert.match(
      document,
      /`\/reports\/` query returned eight visible\s+matches[\s\S]{0,100}`2026-07-22 13:04`[\s\S]{0,100}`2026-07-29 11:42`[\s\S]{0,100}report\s+identifiers redacted/i
    );
    assert.match(document, /R2 delete[- ]canary[\s\S]{0,180}active[\s\S]{0,40}required/i);
    assert.match(document, /direct smoke/i);
    assert.match(document, /Production Health run 30483261603/i);
    assert.match(
      document,
      /(?:write\/read\/delete\/absence|created,\s+read,\s+deleted,\s+and proved\s+absence)/i
    );
    assert.match(
      document,
      /point-in-time receipts[\s\S]{0,180}(?:capture fresh receipts|re-capture them)/i
    );
    assert.match(document, /independent\s+egress backstop/i);
    assert.doesNotMatch(document, /fresh historical seven-day[\s\S]{0,60}(?:required|pending)/i);
    assert.doesNotMatch(document, /recovery-route WAF[\s\S]{0,40}(?:missing|pending|required)/i);
  }

  for (const document of [readme, goLive, evidenceSurvey]) {
    assert.match(document, /scanner non-production[\s\S]{0,40}(?:builds are )?disabled/i);
    // Previews still BUILD, so "enabled" stays asserted; what changed on
    // 2026-07-28 is that they are Access-restricted instead of public. Pin the
    // new posture so the docs cannot drift back to calling them public.
    assert.match(document, /Pages\s+automatic\s+preview\s+deployments[\s\S]{0,50}enabled/i);
    assert.match(document, /Access-(?:protected|restricted)/i);
    assert.doesNotMatch(document, /preview deployments are (?:currently )?enabled and\s+public/i);
  }
  assert.doesNotMatch(readme, /non-production Pages builds (?:are )?disabled/i);
  assert.match(
    evidenceSurvey,
    /2026-07-28 preview recheck[\s\S]{0,140}Pages\s+automatic preview deployments[\s\S]{0,80}Access-restricted/i
  );

  assert.doesNotMatch(
    readme,
    /WAF-ceiling verification, container-log retention\/query verification[\s\S]*remain operator work/i
  );
  assert.doesNotMatch(
    goLive,
    /Container-log retention\/query verification, WAF-ceiling verification[\s\S]*remain external/i
  );
  assert.doesNotMatch(evidenceSurvey, /Pages uses[\s\S]{0,60}previews disabled/i);
  assert.doesNotMatch(goLive, /receipt covers only\s+`POST \/api\/scan`/i);
});

test("delete-canary activation is explicit, independently credentialed, and reversible", () => {
  const runbook = source("docs/deploy-cloudflare-containers.md");
  const workflow = source(".github/workflows/production-health.yml");

  assert.match(runbook, /SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN/);
  assert.match(source("wrangler.r2-delete-canary.jsonc"), /SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN/);

  for (const name of [
    "PRODUCTION_R2_DELETE_CANARY_TOKEN",
    "PRODUCTION_R2_DELETE_CANARY_URL",
    "PRODUCTION_R2_DELETE_CANARY_REQUIRED"
  ]) {
    assert.match(runbook, new RegExp(name));
    assert.match(workflow, new RegExp(name));
  }

  assert.match(runbook, /wrangler deploy -c wrangler\.r2-delete-canary\.jsonc/);
  assert.match(runbook, /node scripts\/smoke-production-r2-delete\.mjs/);
  assert.match(runbook, /Only then make credential loss fail loudly/i);
  assert.match(runbook, /PRODUCTION_R2_DELETE_CANARY_REQUIRED --body 1/);
  assert.match(runbook, /wrangler delete site-behavior-lab-r2-delete-canary --force/i);
  assert.match(runbook, /Never delete or rename the production reports bucket/i);
});

test("durable rollout docs require isolated staging teardown before production activation", () => {
  const nodeRunbook = source("docs/deploy-node-container.md");
  const goLive = source("docs/go-live-public-scanner.md");
  const envExample = source(".env.example");

  assert.match(nodeRunbook, /isolated-staging gate/i);
  assert.match(nodeRunbook, /Tear down[\s\S]*Only then prepare a \*\*separate reviewed production change\*\*/i);
  assert.doesNotMatch(nodeRunbook, /Deploy with `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1` while public ingress remains locked/i);
  assert.match(goLive, /Do \*\*not\*\* install production\s+durable credentials as the first rollout step/i);
  assert.match(goLive, /new production-only values[\s\S]*normal CI-gated promotion/i);
  assert.match(envExample, /Do not enable it[\s\S]*isolated,[\s\S]*token-gated staging topology/i);
});

test("measurement-freeze policy distinguishes stale proposals from the controlled collection lane", () => {
  const release = source("RELEASE.md");

  assert.match(release, /featured-gallery[\s\S]{0,100}05:23 UTC on 2026-08-03 and\s+2026-08-10/);
  assert.match(release, /all 13 formerly deferred sites/);
  assert.match(release, /07:23 UTC seed-catalog legs do not cover these sites/);
  assert.match(release, /2026-08-11 through 2026-08-17 inclusive/);
  assert.match(
    release,
    /Re-defer only[\s\S]{0,80}same closed unavailable reason repeated\s+in both complete\s+cycles/
  );
  assert.match(release, /Only after that PR[\s\S]{0,220}SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1/);

  assert.match(
    release,
    /`automation\/\*` proposal whose[\s\S]{0,100}began \*\*before\*\* freeze activation[\s\S]{0,100}must not be merged/
  );
  assert.match(
    release,
    /post-activation `automation\/featured-scan-\*` proposals[\s\S]{0,120}may be reviewed and merged\s+during the freeze/
  );
  assert.match(
    release,
    /Until a later code-enforced Dependabot pause\s+exists, no `dependabot\/\*` PR may be merged while the freeze is active/
  );
  assert.doesNotMatch(release, /do not MERGE any\s+open `automation\/\*` proposal during a freeze window/);
});

test("operator commands and topology names target explicit Wrangler configs", () => {
  const readme = source("README.md");
  const envExample = source(".env.example");
  const productionConfig = source("wrangler.container.jsonc");

  // Every operator secret command names its config explicitly: no root
  // wrangler.jsonc exists, so a defaulted command would target nothing.
  assert.match(
    envExample,
    /wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN -c wrangler\.container\.jsonc/
  );
  assert.match(envExample, /wrangler secret put TURNSTILE_SECRET_KEY -c wrangler\.container\.jsonc/);
  assert.match(
    envExample,
    /wrangler secret put -c wrangler\.container\.jsonc SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/
  );
  assert.match(productionConfig, /the only scanner deployment/i);

  // The Browser Run worker was deleted, not gated. Nothing may reference its
  // config, its risk-acceptance flag, or its npm scripts again: a stale command
  // would silently target a file that does not exist.
  const packageJson = source("package.json");
  for (const [name, text] of [
    ["README.md", readme],
    [".env.example", envExample],
    ["wrangler.container.jsonc", productionConfig],
    ["package.json", packageJson]
  ] as const) {
    assert.doesNotMatch(text, /-c wrangler\.browser-run\.jsonc/, `${name} still runs a deleted config`);
    assert.doesNotMatch(
      text,
      /SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK/,
      `${name} still documents the deleted risk flag`
    );
  }
  assert.doesNotMatch(packageJson, /"cf:(deploy|dev|kv:create)"/);
});

test("release runbook matches the current Wrangler and three-gate CI contract", () => {
  const goLive = source("docs/go-live-public-scanner.md");
  const packageLock = JSON.parse(source("package-lock.json")) as {
    packages?: Record<string, { version?: string }>;
  };
  const wranglerVersion = packageLock.packages?.["node_modules/wrangler"]?.version;

  assert.ok(wranglerVersion, "package-lock must resolve Wrangler");
  assert.match(goLive, new RegExp(`currently locks Wrangler ${wranglerVersion.replaceAll(".", "\\.")}`));
  assert.match(
    goLive,
    /all\s+five promotion gates \(`supply-chain`, `app`, `smoke`, `docker`, and `attest`\)/i
  );
  assert.doesNotMatch(goLive, /After both\s+test jobs pass/i);
});

test("release operators get a fail-closed scaffold for every attestation gate", () => {
  const release = source("RELEASE.md");
  const packageJson = JSON.parse(source("package.json")) as {
    scripts?: Record<string, string>;
  };
  const scaffold = source("scripts/release-attestation-scaffold.mjs");

  assert.equal(
    packageJson.scripts?.["release:attestation-scaffold"],
    "node scripts/release-attestation-scaffold.mjs"
  );
  assert.match(
    release,
    /npm run release:attestation-scaffold -- --gate egress-backstop/
  );
  assert.match(release, /collectionEnvironmentDigest/);
  assert.match(release, /collectionProducerCommitsDigest/);
  assert.match(release, /docs\/operator-evidence-capture\.md/);
  assert.match(
    release,
    /derives the attestation's candidate, deployment, policy, image, and inventory\s+bindings/
  );
  assert.match(release, /"true": false/);
  assert.match(scaffold, /releaseAttestationScaffold/);
  assert.doesNotMatch(
    release,
    /"candidateCommit": "<full-40-character-sha>"[\s\S]{0,100}"networkPolicyDigest"/
  );
});

test("the README names the methodology version the scanner actually records", () => {
  // The README quoted a methodology string that drifted twice over: it still
  // said playwright-1.61.1 against a 1.62.0 runtime, and predated the
  // subject-validity/detector-coverage suffixes entirely. A reader checking a
  // report's recorded methodology against the documentation would not have
  // found the documented one anywhere. Pin the prose to the constant instead
  // of to a transcription of it.
  const readme = source("README.md");
  assert.match(
    readme,
    new RegExp(NODE_SCANNER_METHODOLOGY_VERSION.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")),
    "README must quote the current NODE_SCANNER_METHODOLOGY_VERSION verbatim"
  );
  // No superseded Playwright component may survive anywhere in the prose.
  assert.doesNotMatch(readme, /playwright-1\.61\.\d+/);
});

test("the README does not describe Access-protected Pages previews as public", () => {
  const readme = source("README.md");
  assert.doesNotMatch(readme, /preview deployments are (?:currently )?enabled and public/i);
  assert.doesNotMatch(readme, /public by default/i);
  assert.match(readme, /preview deployments[\s\S]{0,60}Access-protected/i);
});
