import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import test, { after } from "node:test";
import ts from "typescript";

const ROOT = process.cwd();
const FIXTURE_ROOT = mkdtempSync(path.join(tmpdir(), "site-behavior-lab-container-deploy-"));
const SCRIPT = path.join(FIXTURE_ROOT, "scripts/deploy-container.mjs");

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));
mkdirSync(path.dirname(SCRIPT), { recursive: true });
copyFileSync(path.join(ROOT, "scripts/deploy-container.mjs"), SCRIPT);
for (const config of [
  "wrangler.container.jsonc",
  "wrangler.container.staging.jsonc",
  "wrangler.container.watch-staging.jsonc"
]) {
  copyFileSync(path.join(ROOT, config), path.join(FIXTURE_ROOT, config));
}
execFileSync("git", ["init", "--quiet"], { cwd: FIXTURE_ROOT });
execFileSync("git", ["config", "user.email", "container-deploy-test@sitebehavior.invalid"], {
  cwd: FIXTURE_ROOT
});
execFileSync("git", ["config", "user.name", "Container deploy test"], { cwd: FIXTURE_ROOT });
execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: FIXTURE_ROOT });
execFileSync("git", ["add", "."], { cwd: FIXTURE_ROOT });
execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: FIXTURE_ROOT });
const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: FIXTURE_ROOT,
  encoding: "utf8"
}).trim();

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: FIXTURE_ROOT,
    encoding: "utf8",
    env: { ...process.env, WORKERS_CI_COMMIT_SHA: COMMIT }
  });
}

function generatedConfigs() {
  return readdirSync(FIXTURE_ROOT).filter((entry) =>
    /^wrangler\.container(?:\.[A-Za-z0-9._-]+)?\.generated\.\d+\.jsonc$/.test(entry)
  );
}

test("container deploy check preserves the production default", () => {
  const result = run(["--check"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Container deploy config pins ${COMMIT}.`);
  assert.deepEqual(generatedConfigs(), []);
});

test("container deploy check accepts a safe repo-root staging config", () => {
  const result = run(["--config", "wrangler.container.staging.jsonc", "--check"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`wrangler\\.container\\.staging\\.jsonc pins ${COMMIT}`));
  assert.deepEqual(generatedConfigs(), []);
});

test("container deploy check accepts the isolated watch-staging config", () => {
  const result = run(["--config", "wrangler.container.watch-staging.jsonc", "--check"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`wrangler\\.container\\.watch-staging\\.jsonc pins ${COMMIT}`));
  assert.deepEqual(generatedConfigs(), []);
});

test("staging config is isolated, gated, and pinned to its exact coordinator origin", () => {
  const configPath = path.join(ROOT, "wrangler.container.staging.jsonc");
  const source = readFileSync(configPath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(configPath, source);

  assert.equal(parsed.error, undefined);
  const config = parsed.config;
  assert.equal(config.name, "site-behavior-lab-scanner-staging");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    {
      pattern: "scan-staging.sitebehavior.org",
      custom_domain: true,
      previews_enabled: false
    }
  ]);
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN, "https://sitebehavior.org");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS, "0");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT, "staging");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS, "1");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_DURABLE_JOBS, "1");
  assert.equal(
    config.vars.SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL,
    "https://scan-staging.sitebehavior.org"
  );
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_R2_BUCKET, "site-behavior-lab-reports-staging");
  assert.equal(config.containers[0].name, "site-behavior-lab-scanner-staging-container");
  assert.equal(config.containers[0].class_name, "ScannerContainer");
  assert.equal(config.containers[0].max_instances, 1);
  assert.deepEqual(config.durable_objects.bindings, [{ name: "SCANNER", class_name: "ScannerContainer" }]);
  assert.equal(source.split("__SITE_BEHAVIOR_LAB_BUILD_COMMIT__").length - 1, 1);
  const requiredSecrets = [
    "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN",
    "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN",
    "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
    "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
    "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
  ];
  assert.deepEqual(config.secrets.required, requiredSecrets);
  for (const secret of requiredSecrets) {
    assert.equal(Object.hasOwn(config.vars, secret), false, `${secret} must remain an operator-set secret`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["cf:container:staging:deploy"],
    "node scripts/deploy-container.mjs --config wrangler.container.staging.jsonc"
  );
  assert.equal(
    packageJson.scripts["cf:container:staging:verify"],
    "node scripts/deploy-container.mjs --check --config wrangler.container.staging.jsonc"
  );
});

test("watch staging is open behind Turnstile, separately authorized, and isolated from production", () => {
  const configPath = path.join(ROOT, "wrangler.container.watch-staging.jsonc");
  const source = readFileSync(configPath, "utf8");
  const parsed = ts.parseConfigFileTextToJson(configPath, source);

  assert.equal(parsed.error, undefined);
  const config = parsed.config;
  assert.equal(config.name, "site-behavior-lab-watch-staging");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    {
      pattern: "scan-watch-staging.sitebehavior.org",
      custom_domain: true,
      previews_enabled: false
    }
  ]);
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS, "1");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_DURABLE_JOBS, "1");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES, "1");
  assert.equal(config.vars.SITE_BEHAVIOR_LAB_CONTAINER_SHARDING, "0");
  assert.equal(
    config.vars.SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL,
    "https://scan-watch-staging.sitebehavior.org"
  );
  assert.equal(
    config.vars.SITE_BEHAVIOR_LAB_R2_BUCKET,
    "site-behavior-lab-reports-watch-staging"
  );
  assert.equal(config.containers[0].name, "site-behavior-lab-watch-staging-container");
  assert.equal(config.containers[0].max_instances, 1);
  assert.equal(source.split("__SITE_BEHAVIOR_LAB_BUILD_COMMIT__").length - 1, 1);
  const requiredSecrets = [
    "TURNSTILE_SECRET_KEY",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN",
    "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY",
    "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN",
    "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
    "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
    "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
  ];
  assert.deepEqual(config.secrets.required, requiredSecrets);
  assert.equal(Object.hasOwn(config.vars, "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN"), false);
  assert.equal(Object.hasOwn(config.vars, "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS"), false);
  for (const secret of requiredSecrets) {
    assert.equal(Object.hasOwn(config.vars, secret), false, `${secret} must remain an operator-set secret`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["cf:container:watch-staging:deploy"],
    "node scripts/deploy-container.mjs --config wrangler.container.watch-staging.jsonc"
  );
  assert.equal(
    packageJson.scripts["cf:container:watch-staging:verify"],
    "node scripts/deploy-container.mjs --check --config wrangler.container.watch-staging.jsonc"
  );
});

test("container deploy rejects config paths and unknown arguments", () => {
  const escaped = run(["--check", "--config", "../wrangler.container.jsonc"]);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /safe \.jsonc filename located directly in the repository root/);

  const unknown = run(["--check", "--dry-run"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown argument: --dry-run/);
  assert.deepEqual(generatedConfigs(), []);
});

test("local container deployment rejects dirty provenance while CI pins an explicit commit", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /git", \["status", "--porcelain", "--untracked-files=all"\]/);
  assert.match(source, /Container deployment provenance requires a clean Git worktree/);
  assert.match(source, /workersCommit !== localCommit/);
  assert.match(source, /resolveBuildCommit\(\{ requireClean: !check \}\)/);
});

test("container images exclude transient configs, local secrets, and Rust build output", () => {
  const dockerignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
  const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(dockerignore, /^wrangler\.container\.generated\.\*\.jsonc$/m);
  assert.match(dockerignore, /^\.dev\.vars$/m);
  assert.match(dockerignore, /^\.dev\.vars\.\*$/m);
  assert.match(dockerignore, /^tools\/adblock-wasm\/target$/m);
  assert.match(gitignore, /^\.dev\.vars$/m);
  assert.match(gitignore, /^\.dev\.vars\.\*$/m);
});
