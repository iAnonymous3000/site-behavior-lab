import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
    // The contract is that these receipts are described as point-in-time AND
    // that the reader is told to re-capture them. It is deliberately NOT a
    // pin on the surrounding sentence: this assertion previously matched
    // wording which claimed the follow-ups were closed, so correcting that
    // false claim broke the guard rather than the guard catching it.
    assert.match(document, /point-in-time receipts/i);
    assert.match(
      document,
      /(?:capture fresh receipts|re-capture them)/i,
      "operator docs must tell the reader these receipts need re-capturing"
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

test("staging teardown docs preserve the exact hosted subject and post-candidate archive chronology", () => {
  const goLive = source("docs/go-live-public-scanner.md");
  const operator = source("docs/operator-evidence-capture.md");

  for (const document of [goLive, operator]) {
    assert.match(document, /research\/ops-evidence\/staging-teardown\.json/);
    assert.match(document, /before\s+(?:selecting\s+)?candidate `C`/i);
    assert.match(document, /after `C`/i);
    assert.match(document, /(?:profile `staging-teardown`|`staging-teardown` profile)/i);
    assert.match(document, /exactly one[\s\S]{0,80}`provider-capture`/i);
    assert.match(document, /private provider[- ]responses?[\s\S]{0,100}(?:must )?never/i);
  }
  assert.match(operator, /copy the hosted receipt byte-for-byte/i);
  assert.match(operator, /TEARDOWN_ARTIFACT_DIGEST/);
  assert.match(operator, /cmp -s[\s\S]{0,180}TEARDOWN_RECEIPT_SHA256/);
  assert.match(operator, /hosted-evidence-archive[\s\S]{0,100}change:\"added\"/);
  assert.match(goLive, /do \*\*not\*\* merge a receipt carrier[\s\S]{0,160}flag-only child `F`/i);
});

test("operator docs distinguish landed code from remaining configuration work", () => {
  const hosted = source("docs/hosted-evidence-provenance.md");
  const calibrationChecklist = source(
    "docs/calibration-prereg-drafts/operator-checklist.md"
  );
  const frameConstruction = source(
    "docs/calibration-prereg-drafts/frame-construction.md"
  );
  const release = source("RELEASE.md");

  assert.match(
    hosted,
    /staging teardown adapter `cloudflare-github-exact-v1` is implemented and\s+source-closed/i
  );
  assert.doesNotMatch(hosted, /fails closed\s+until its exact provider adapter/i);
  assert.match(calibrationChecklist, /\[x\] CODE: assemble custody wiring is implemented/i);
  assert.doesNotMatch(calibrationChecklist, /refuses at line 35 today/i);
  assert.match(frameConstruction, /assemble custody wiring is already implemented and tested/i);
  assert.doesNotMatch(frameConstruction, /same PR as the assemble custody wiring/i);
  assert.match(
    release,
    /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256=<receipt-sha256>[\s\\]*npm run release:readiness/
  );
});

test("sensitive release and teardown inputs never enter shell history or linger on disk", () => {
  const release = source("RELEASE.md");
  const operator = source("docs/operator-evidence-capture.md");
  const goLive = source("docs/go-live-public-scanner.md");

  assert.doesNotMatch(
    release,
    /^\s*(?:GH_TOKEN|RELEASE_APP_JWT|PROMOTION_APP_JWT)=<[^>]+>/m
  );
  assert.match(release, /cleanup_release_governance_credentials\(\)/);
  assert.match(release, /trap cleanup_release_governance_credentials EXIT/);
  for (const name of [
    "GH_TOKEN",
    "RELEASE_APP_JWT",
    "PROMOTION_APP_JWT"
  ]) {
    assert.match(release, new RegExp(`IFS= read -r -s ${name}`));
  }
  assert.match(release, /export GH_TOKEN RELEASE_APP_JWT PROMOTION_APP_JWT/);

  assert.match(operator, /TEARDOWN_TARGET_DIR="\$\(mktemp -d/);
  assert.match(operator, /chmod 0700 "\$TEARDOWN_TARGET_DIR"/);
  assert.match(operator, /trap cleanup_staging_teardown_target EXIT/);
  assert.match(operator, /rm -rf -- "\$TEARDOWN_TARGET_DIR"/);
  assert.match(
    operator,
    /staging:teardown-targets --[\s\\]*--capture[\s\S]{0,400}--private-dir "\$TEARDOWN_TARGET_DIR\/provider-responses"/
  );
  assert.match(operator, /test ! -e "\$TEARDOWN_TARGET_DIR\/provider-responses"/);
  assert.doesNotMatch(operator, /staging:teardown-targets` CLI does not query Cloudflare or GitHub/i);
  assert.doesNotMatch(operator, /command "\$TEARDOWN_EDITOR"/);
  for (const name of [
    "STAGING_TEARDOWN_CAPTURE_CF_COMPUTE_READ_TOKEN_FILE",
    "STAGING_TEARDOWN_CAPTURE_CF_DNS_READ_TOKEN_FILE",
    "STAGING_TEARDOWN_CAPTURE_CF_R2_READ_TOKEN_FILE",
    "STAGING_TEARDOWN_CAPTURE_CF_TOKEN_READ_TOKEN_FILE",
    "STAGING_TEARDOWN_CAPTURE_CF_OBSERVATION_READ_TOKEN_FILE",
    "STAGING_TEARDOWN_CAPTURE_GITHUB_APP_READ_TOKEN_FILE"
  ]) {
    assert.match(operator, new RegExp(name));
  }
  assert.match(operator, /repository \*\*Administration read\*\*/);
  assert.match(operator, /full dedicated Advanced Certificate pack[\s\S]{0,240}nested certificate's id/);
  assert.match(
    operator,
    /explicitly lists `default`, `eu`, and `fedramp`[\s\S]{0,100}`cf-r2-jurisdiction`/
  );
  assert.match(operator, /same-name nondefault bucket blocks the\s+ceremony/);
  assert.match(operator, /`jobs` must be absent or exactly `false`/);
  assert.doesNotMatch(operator, /`jobs` must be absent,/);
  assert.doesNotMatch(operator, /application must omit `jobs`/i);
  assert.match(
    operator,
    /TEARDOWN_TARGET_SHA256="\$\([\s\S]{0,500}--verify[\s\S]{0,500}jq -er/
  );
  assert.match(
    operator,
    /gh secret set STAGING_TEARDOWN_TARGETS_JSON[\s\S]{0,120}--env release-evidence[\s\S]{0,160}< "\$TEARDOWN_TARGET_DIR\/staging-teardown-targets\.sealed\.json"/
  );
  assert.match(
    operator,
    /gh variable set STAGING_TEARDOWN_TARGETS_SHA256[\s\S]{0,120}--body "\$TEARDOWN_TARGET_SHA256"/
  );
  assert.doesNotMatch(operator, /STAGING_TEARDOWN_TARGETS_JSON=/);
  assert.match(
    operator,
    /Do not automate credential retirement inside the hosted teardown job/i
  );
  assert.match(operator, /partial attempt needs the same narrowly scoped authorities/i);
  for (const name of [
    "STAGING_TEARDOWN_CF_COMPUTE_TOKEN",
    "STAGING_TEARDOWN_CF_DNS_TOKEN",
    "STAGING_TEARDOWN_CF_R2_TOKEN",
    "STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN",
    "STAGING_TEARDOWN_CF_OBSERVATION_TOKEN",
    "STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY"
  ]) {
    assert.match(operator, new RegExp(`\\n  ${name}\\n`));
  }
  assert.match(operator, /gh secret delete "\$name" --env release-evidence/);
  assert.match(operator, /gh variable delete "\$name" --env release-evidence/);
  assert.match(operator, /gh secret list --env release-evidence --json name/);
  assert.match(operator, /gh variable list --env release-evidence --json name/);
  assert.match(operator, /name-only\s+absence readback/i);
  assert.match(operator, /uninstall or disable[\s\S]{0,100}repository-only App installation/i);

  assert.doesNotMatch(
    goLive,
    /(?:SMOKE_SCAN_ACCESS_TOKEN|DURABLE_REPLAY_ACCESS_TOKEN|DURABLE_REPLAY_FAULT_TOKEN)=<[^>]+>/
  );
  assert.match(goLive, /trap cleanup_durable_replay_credentials EXIT/);
  const replayShaGuard = goLive.indexOf(
    '[[ "$DURABLE_REPLAY_EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]'
  );
  const firstReplayReceiptPath = goLive.indexOf(
    'LEASE_EXPIRY_RECEIPT="$DURABLE_REPLAY_RECEIPT_DIR/${DURABLE_REPLAY_EXPECTED_SHA}-lease-expiry.json"'
  );
  assert.ok(replayShaGuard >= 0);
  assert.ok(
    firstReplayReceiptPath > replayShaGuard,
    "the exact replay-parent SHA must be validated before it enters a receipt path"
  );
  assert.match(
    goLive,
    /IFS= read -r -s DURABLE_REPLAY_ACCESS_TOKEN[\s\S]{0,180}IFS= read -r -s DURABLE_REPLAY_FAULT_TOKEN/
  );
  assert.match(
    goLive,
    /export DURABLE_REPLAY_ACCESS_TOKEN DURABLE_REPLAY_FAULT_TOKEN/
  );
  assert.match(
    goLive,
    /run_durable_replay lease-expiry "\$LEASE_EXPIRY_RECEIPT"[\s\S]{0,120}run_durable_replay lost-resolve "\$LOST_RESOLVE_RECEIPT"/
  );
  assert.match(goLive, /trap cleanup_scanner_smoke_token EXIT/);
  assert.match(goLive, /IFS= read -r -s SMOKE_SCAN_ACCESS_TOKEN/);
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

test("calibration docs never assert a corpus size the corpus contradicts", () => {
  // REGRESSION. Both calibration docs stated "the committed corpus holds six r2
  // runs, all clean" and the design doc derived ceremony survival odds from it.
  // The corpus refreshed at #144 one day after those docs landed, to 126 r2 runs
  // with 73 censored, and #159/#161 built on the new corpus without correcting
  // the sizing surface. Nothing read these docs, so nothing noticed.
  //
  // Present-tense claims only: describing the historical premise is how the
  // correction itself is written, and must stay allowed.
  const reportsDir = path.join(process.cwd(), "public", "reports");
  let actualR2Runs = 0;
  for (const file of readdirSync(reportsDir)) {
    if (!file.endsWith(".json") || file.includes("provenance")) continue;
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(readFileSync(path.join(reportsDir, file), "utf8"));
    } catch {
      continue;
    }
    for (const arm of ["run", "baseline", "variant"]) {
      const run = wire[arm] as { qualityFacts?: unknown; quality?: { byFamily?: unknown } } | undefined;
      if (run?.qualityFacts && run.quality?.byFamily) actualR2Runs += 1;
    }
  }
  assert.ok(actualR2Runs > 0, "corpus probe found no r2 runs; the guard would be vacuous");

  // The docs write these sentences with an adverb between subject and verb
  // ("it now holds"), markdown emphasis on the number ("**126"), and would
  // legitimately comma-group a four-digit count. The first version of this
  // regex allowed none of those, so it matched ZERO sentences in the committed
  // docs and passed no matter what they claimed. The verbs stay present-tense
  // only: "held" must never match, because past-tense framing of the
  // superseded premise is how the correction itself is written.
  const present =
    /\b(?:corpus|it)\s+(?:(?:now|currently|today)\s+)?(?:holds|contains)\s+(?:only\s+)?[*_]{0,3}([a-z0-9,]+)[*_]{0,3}\s+r2\s+runs/gi;
  let presentTenseClaims = 0;
  for (const doc of ["calibration-cname-uncloaking-design.md", "calibration-findings.md"]) {
    const text = readFileSync(path.join(process.cwd(), "docs", doc), "utf8");
    for (const match of text.matchAll(present)) {
      presentTenseClaims += 1;
      const claimed = Number(match[1].replaceAll(",", ""));
      assert.ok(
        Number.isFinite(claimed) && claimed === actualR2Runs,
        `${doc} claims the corpus holds ${match[1]} r2 runs; it holds ${actualR2Runs}. ` +
          `State the count in digits matching the corpus, or state a superseded premise in the past tense.`
      );
    }
  }
  // Without this, a wording drift that blinds the regex reads as a clean pass,
  // which is exactly how the first version shipped inert.
  assert.ok(
    presentTenseClaims > 0,
    "the guard matched no present-tense corpus-size sentence in either calibration doc; " +
      "its regex no longer sees the docs' own phrasing"
  );
});
