import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("operations docs distinguish the active production synthetic from the delete canary", () => {
  const readme = source("README.md");
  const containerRunbook = source("docs/deploy-cloudflare-containers.md");
  const goLive = source("docs/go-live-public-scanner.md");
  const envExample = source(".env.example");

  assert.match(readme, /hourly production synthetic is active/i);
  assert.doesNotMatch(readme, /activation of the hourly scan\/write\/read synthetic/i);
  assert.match(containerRunbook, /Production synthetic \(active\)/);
  assert.match(containerRunbook, /synthetic never[\s\S]*not the still-separate delete canary/i);
  assert.match(goLive, /hourly production synthetic is active/i);
  assert.match(readme, /R2 delete canary is implemented and CI-wired but is not live/i);
  assert.match(containerRunbook, /code-ready, not live/i);
  assert.match(goLive, /code and production-health lane being[\s\S]*do not prove it is\s+deployed or configured/i);
  assert.match(envExample, /SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN=/);

  for (const document of [readme, containerRunbook, goLive]) {
    assert.match(document, /WAF[\s-]*(?:ceiling|rate)/i);
    assert.match(document, /(?:log[\s-]*retention|logs?[\s\S]{0,100}seven-day range)/i);
    assert.match(document, /R2 delete[- ]canary/i);
    assert.match(document, /independent\s+egress backstop/i);
  }
});

test("current operator docs keep verified WAF/log controls separate from preview and remaining gates", () => {
  const readme = source("README.md");
  const goLive = source("docs/go-live-public-scanner.md");
  const evidenceSurvey = source("docs/report-view-evidence-survey.md");

  for (const document of [readme, goLive, evidenceSurvey]) {
    assert.match(document, /2026-07-21/);
    assert.match(document, /ten\s+requests per ten seconds per IP with a\s+ten-second block/i);
    assert.match(document, /Worker logs[\s\S]{0,120}(?:configured )?seven-day range/i);
    assert.match(document, /report URLs redacted/i);
    assert.match(document, /fresh[\s\S]{0,80}(?:release )?receipts/i);
    assert.match(document, /R2 delete[- ]canary/i);
    assert.match(document, /independent\s+egress backstop/i);
  }

  for (const document of [readme, evidenceSurvey]) {
    assert.match(document, /scanner non-production[\s\S]{0,40}(?:builds are )?disabled/i);
    // Previews still BUILD, so "enabled" stays asserted; what changed on
    // 2026-07-28 is that they are Access-restricted instead of public. Pin the
    // new posture so the docs cannot drift back to calling them public.
    assert.match(document, /Pages automatic preview deployments[\s\S]{0,50}enabled/i);
    assert.match(document, /Access-(?:protected|restricted)/i);
    assert.doesNotMatch(document, /preview deployments are (?:currently )?enabled and\s+public/i);
  }

  assert.doesNotMatch(
    readme,
    /WAF-ceiling verification, container-log retention\/query verification[\s\S]*remain operator work/i
  );
  assert.doesNotMatch(
    goLive,
    /Container-log retention\/query verification, WAF-ceiling verification[\s\S]*remain external/i
  );
  assert.doesNotMatch(evidenceSurvey, /Pages uses[\s\S]{0,60}previews disabled/i);
  assert.match(
    goLive,
    /GET `?\/api\/scan\/admission`?[\s\S]{0,300}(?:WAF|rate[- ]limiting)/i
  );
  assert.match(goLive, /receipt covers only `POST \/api\/scan`/i);
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
