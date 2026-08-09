import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseStrictJson } from "../lib/strict-json.ts";
import {
  stagingTeardownTargetManifestTemplate,
  validateStagingTeardownTargetManifest
} from "./staging-teardown-provider-adapters.mjs";
import { requiredHostedStagingTeardownEnvironment } from "./staging-teardown-hosted-capture-lib.mjs";
import { serializeCanonicalEvidence, sha256Bytes } from "./operator-evidence-common.mjs";
import { runStagingTeardownTargetCaptureCommand } from "./staging-teardown-target-capture-command.mjs";
import {
  STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES,
  stagingTeardownTargetCaptureCredentialsFromEnvironment
} from "./staging-teardown-target-capture-lib.mjs";
import {
  createIndexedPrivateResponseSink,
  destroyIndexedPrivateResponseDirectory,
  readMode0600SecretFile
} from "./staging-teardown-target-private-io.mjs";

const SCRIPT = path.join(process.cwd(), "scripts", "staging-teardown-target-manifest.mjs");
const COMMIT = "c".repeat(40);
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);

function common() {
  return [
    "--candidate-commit", COMMIT,
    "--account-id", ACCOUNT,
    "--zone-id", ZONE
  ];
}

test("the generator creates, seals, and verifies one canonical target manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "staging-teardown-targets-"));
  try {
    const templatePath = path.join(directory, "template.json");
    const templateResult = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT, "--template", ...common(), "--output", templatePath],
      { encoding: "utf8" }
    ));
    assert.equal(statSync(templatePath).mode & 0o777, 0o600);
    const templateText = readFileSync(templatePath, "utf8");
    const template = parseStrictJson(templateText);
    validateStagingTeardownTargetManifest(template, COMMIT);
    assert.equal(templateResult.sha256, sha256Bytes(serializeCanonicalEvidence(template)));

    // Populate only exact provider facts; the sealer owns identity fields,
    // policy hashing, strict parsing, validation, and canonical bytes.
    const draft = structuredClone(template);
    const credential = draft.cloudflare.credentialSets[0];
    credential.expectedPresent = true;
    credential.tokenId = "1".repeat(32);
    credential.expectedPolicies = [{
      effect: "allow",
      permission_groups: [{
        id: "2efd5506f9c8494dacb1fa10a3e7d5b6",
        name: "Workers R2 Storage Bucket Item Write"
      }],
      resources: {
        [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_site-behavior-lab-reports-staging`]: "*"
      }
    }];
    const draftPath = path.join(directory, "draft.json");
    writeFileSync(draftPath, JSON.stringify(draft), { mode: 0o600 });
    const sealedPath = path.join(directory, "sealed.json");
    const sealedResult = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT, "--seal", ...common(), "--input", draftPath, "--output", sealedPath],
      { encoding: "utf8" }
    ));
    const sealedText = readFileSync(sealedPath, "utf8");
    const sealed = parseStrictJson(sealedText);
    validateStagingTeardownTargetManifest(sealed, COMMIT);
    assert.equal(
      sealed.cloudflare.credentialSets[0].expectedPolicySha256,
      sha256Bytes(serializeCanonicalEvidence(sealed.cloudflare.credentialSets[0].expectedPolicies))
    );
    assert.equal(sealedResult.sha256, sha256Bytes(sealedText));

    const verify = JSON.parse(execFileSync(
      process.execPath,
      [SCRIPT, "--verify", ...common(), "--input", sealedPath],
      { encoding: "utf8" }
    ));
    assert.deepEqual(verify, { ok: true, sha256: sealedResult.sha256 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the sealer rejects duplicate-key drafts and leaves no output", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "staging-teardown-targets-bad-"));
  try {
    const input = path.join(directory, "duplicate.json");
    const output = path.join(directory, "sealed.json");
    writeFileSync(input, '{"cloudflare":{},"cloudflare":{}}', { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--seal", ...common(), "--input", input, "--output", output],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /strict JSON without duplicate keys/);
    assert.equal(result.stdout, "");
    assert.throws(() => statSync(output), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted environment independently binds canonical manifest, account, and zone", () => {
  const manifest = stagingTeardownTargetManifestTemplate({
    stagingSourceCommit: COMMIT,
    accountId: ACCOUNT,
    zoneId: ZONE
  });
  const targetJson = serializeCanonicalEvidence(manifest);
  const env = {
    GITHUB_SHA: COMMIT,
    GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
    GITHUB_REF: "refs/heads/main",
    STAGING_TEARDOWN_PROVIDER_KIND: "cloudflare-github-exact-v1",
    STAGING_TEARDOWN_TARGETS_JSON: targetJson,
    STAGING_TEARDOWN_TARGETS_SHA256: sha256Bytes(targetJson),
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    STAGING_TEARDOWN_CF_ZONE_ID: ZONE,
    STAGING_TEARDOWN_CF_COMPUTE_TOKEN: "compute_" + "c".repeat(32),
    STAGING_TEARDOWN_CF_DNS_TOKEN: "dns_" + "d".repeat(32),
    STAGING_TEARDOWN_CF_R2_TOKEN: "r2_" + "r".repeat(32),
    STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN: "admin_" + "a".repeat(32),
    STAGING_TEARDOWN_CF_OBSERVATION_TOKEN: "observation_" + "o".repeat(32),
    STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID: "Iv1.stagingteardownclient",
    STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY: "test-private-key-parsed-by-the-token-provider"
  };
  const parsed = requiredHostedStagingTeardownEnvironment(env);
  assert.equal(parsed.cloudflareAccountId, ACCOUNT);
  assert.equal(parsed.cloudflareZoneId, ZONE);
  assert.equal(parsed.targetManifestSha256, env.STAGING_TEARDOWN_TARGETS_SHA256);
  assert.equal(parsed.githubApp.clientId, env.STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID);
  assert.equal(parsed.githubApp.privateKey, env.STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY);
  assert.equal(Object.hasOwn(parsed.credentials, "githubRunnerAdminToken"), false);

  assert.throws(
    () => requiredHostedStagingTeardownEnvironment({ ...env, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) }),
    /must exactly match the target manifest/
  );
  assert.throws(
    () => requiredHostedStagingTeardownEnvironment({ ...env, STAGING_TEARDOWN_TARGETS_SHA256: "0".repeat(64) }),
    /must bind the canonical strict target manifest/
  );
  const legacy = { ...env, STAGING_TEARDOWN_GITHUB_RUNNER_ADMIN_TOKEN: "github_" + "g".repeat(32) };
  delete legacy.STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY;
  assert.throws(
    () => requiredHostedStagingTeardownEnvironment(legacy),
    /STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY is required/
  );
});

test("capture raw bytes are strict-indexed 0600 files destroyed before target output", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "staging-target-capture-")));
  const privateDirectory = path.join(directory, "raw");
  const output = path.join(directory, "captured.json");
  const events = [];
  try {
    const result = await runStagingTeardownTargetCaptureCommand({
      privateDirectory,
      async capture(persistRaw) {
        assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
        await persistRaw(
          "001.cloudflare.worker-settings.json",
          Buffer.from('{"provider":"private"}')
        );
        assert.equal(
          statSync(path.join(privateDirectory, "001.cloudflare.worker-settings.json")).mode & 0o777,
          0o600
        );
        events.push("captured");
        return { safe: true };
      },
      writeOutput(captured) {
        assert.equal(existsSync(privateDirectory), false);
        writeFileSync(output, JSON.stringify(captured), { flag: "wx", mode: 0o600 });
        events.push("output");
        return "ok";
      }
    });
    assert.equal(result, "ok");
    assert.deepEqual(events, ["captured", "output"]);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed capture destroys private bytes and cannot create target output", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "staging-target-failure-")));
  const privateDirectory = path.join(directory, "raw");
  const output = path.join(directory, "captured.json");
  let writes = 0;
  try {
    await assert.rejects(
      runStagingTeardownTargetCaptureCommand({
        privateDirectory,
        async capture(persistRaw) {
          await persistRaw("001.github.runners.json", Buffer.from("private-response"));
          throw new Error("private provider detail");
        },
        writeOutput() {
          writes += 1;
          writeFileSync(output, "should-not-exist", { flag: "wx", mode: 0o600 });
        }
      }),
      /private provider detail/
    );
    assert.equal(writes, 0);
    assert.equal(existsSync(privateDirectory), false);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private IO canonicalizes a symlinked parent but refuses child symlinks, bad modes, and bad indexes", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "staging-target-private-")));
  try {
    const realParent = path.join(directory, "real");
    mkdirSync(realParent, { mode: 0o700 });
    const alias = path.join(directory, "alias");
    symlinkSync(realParent, alias);
    const sink = createIndexedPrivateResponseSink(path.join(alias, "raw"));
    assert.equal(sink.directory, path.join(realParent, "raw"));
    await assert.rejects(
      sink.persistRaw("002.cloudflare.out-of-order.json", Buffer.from("x")),
      /strictly indexed/
    );
    await sink.persistRaw("001.cloudflare.first.json", Buffer.from("x"));
    destroyIndexedPrivateResponseDirectory(sink.directory);

    const secret = path.join(realParent, "credential.txt");
    writeFileSync(secret, "s".repeat(32), { mode: 0o644 });
    assert.throws(() => readMode0600SecretFile(secret), /mode 0600/);
    chmodSync(secret, 0o600);
    assert.equal(readMode0600SecretFile(secret), "s".repeat(32));
    const secretLink = path.join(realParent, "credential-link.txt");
    symlinkSync(secret, secretLink);
    assert.throws(() => readMode0600SecretFile(secretLink), /non-symbolic-link/);
    const rawLink = path.join(realParent, "raw-link");
    symlinkSync(secret, rawLink);
    assert.throws(
      () => createIndexedPrivateResponseSink(rawLink),
      /must not already exist/
    );

    const hostileSink = createIndexedPrivateResponseSink(path.join(realParent, "hostile-raw"));
    const hostileChild = path.join(
      hostileSink.directory,
      "001.cloudflare.hostile-child.json"
    );
    symlinkSync(secret, hostileChild);
    await assert.rejects(
      hostileSink.persistRaw(
        "001.cloudflare.hostile-child.json",
        Buffer.from("must-not-overwrite")
      ),
      /EEXIST/
    );
    destroyIndexedPrivateResponseDirectory(hostileSink.directory);
    assert.equal(readMode0600SecretFile(secret), "s".repeat(32));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capture credentials come only from named environment values or mode-0600 files", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "staging-target-secrets-")));
  try {
    const env = {};
    Object.values(STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES)
      .forEach((name, index) => { env[name] = `${index}`.repeat(32); });
    const fileBackedName = STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES.githubRunnerReadToken;
    const file = path.join(directory, "github-token.txt");
    writeFileSync(file, `${"g".repeat(32)}\n`, { mode: 0o600 });
    delete env[fileBackedName];
    env[`${fileBackedName}_FILE`] = file;
    const credentials = stagingTeardownTargetCaptureCredentialsFromEnvironment(env, {
      readSecretFile: readMode0600SecretFile
    });
    assert.equal(credentials.githubRunnerReadToken, "g".repeat(32));

    const secretValue = "never-print-this-secret".repeat(2);
    const invalid = { ...env, [fileBackedName]: secretValue };
    assert.throws(
      () => stagingTeardownTargetCaptureCredentialsFromEnvironment(invalid, {
        readSecretFile: readMode0600SecretFile
      }),
      (error) => {
        assert.doesNotMatch(error.message, /never-print-this-secret/);
        return true;
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("capture CLI failures are generic and never print environment credential values", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "staging-target-cli-redaction-")));
  const privateDirectory = path.join(directory, "already-exists");
  const output = path.join(directory, "captured.json");
  mkdirSync(privateDirectory, { mode: 0o700 });
  const args = [
    SCRIPT,
    "--capture",
    ...common(),
    "--private-dir", privateDirectory,
    "--output", output
  ];
  const secretValues = [];
  const env = { ...process.env };
  Object.values(STAGING_TEARDOWN_TARGET_CAPTURE_SECRET_NAMES)
    .forEach((name, index) => {
      const value = `never-print-capture-secret-${index}-${String(index).repeat(24)}`;
      env[name] = value;
      secretValues.push(value);
    });
  try {
    assert.ok(args.every((argument) => !secretValues.includes(argument)));
    const result = spawnSync(process.execPath, ["--no-warnings", ...args], {
      encoding: "utf8",
      env
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "staging teardown target capture failed\n");
    for (const secret of secretValues) {
      assert.doesNotMatch(result.stderr, new RegExp(secret));
    }
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
