import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

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
    assert.match(document, /Pages automatic preview deployments[\s\S]{0,50}enabled/i);
    assert.match(document, /public by default/i);
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

  assert.match(
    readme,
    /wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN \\\s*\n\s*-c wrangler\.browser-run\.jsonc/
  );
  assert.match(
    readme,
    /wrangler secret put TURNSTILE_SECRET_KEY \\\s*\n\s*-c wrangler\.browser-run\.jsonc/
  );
  assert.match(
    envExample,
    /wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN -c wrangler\.browser-run\.jsonc/
  );
  assert.match(envExample, /wrangler secret put TURNSTILE_SECRET_KEY -c wrangler\.browser-run\.jsonc/);
  assert.match(productionConfig, /retired Browser Run self-host path/i);
  assert.doesNotMatch(productionConfig, /wrangler\.jsonc \(the Browser Run/i);
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
