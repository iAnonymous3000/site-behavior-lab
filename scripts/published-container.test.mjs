import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPOSITORY, IMAGE_REPOSITORY, assertPublishedImageIdentity,
  validatePublishedContainer, validMainRun, attestationArgs, sha256, assertRegistryManifest
} from "./published-container-lib.mjs";

const commit = "1".repeat(40);
const tree = "2".repeat(40);
const imageId = `sha256:${"3".repeat(64)}`;
const reference = `${IMAGE_REPOSITORY}@sha256:${"4".repeat(64)}`;
const configBytes = Buffer.from('{"name":"example"}\n');
function receipts() {
  const tested = {
    schemaVersion: 1, evidenceKind: "exact-source-and-tested-artifact-manifest",
    source: { repository: `https://github.com/${REPOSITORY}`, commit, tree },
    inputs: { productionContainerConfig: { path: "wrangler.container.jsonc", bytes: configBytes.length, sha256: sha256(configBytes) } },
    artifacts: [{ name: "container-image", kind: "docker-image-inspection", image: "site-behavior-lab:smoke",
      imageId, repoDigests: [], os: "linux", architecture: "amd64", sourceCommit: commit,
      rootfsLayers: [`sha256:${"5".repeat(64)}`], bytes: 12345, runtime: { node: "24.18.1" } }]
  };
  const published = structuredClone(tested);
  published.artifacts[0].repoDigests = [reference];
  return { tested, published };
}

test("registry publication preserves every original observation and adds only one immutable reference", () => {
  const { tested, published } = receipts();
  assert.equal(assertPublishedImageIdentity(published, tested), reference);
  assert.equal(validatePublishedContainer(published, { commit, tree, configBytes }), reference);
  assert.deepEqual(tested.artifacts[0].repoDigests, []);
});

test("registry readback must bind the manifest digest to the tested image config, not just a matching tag", () => {
  const manifest = { Descriptor: { digest: reference.split("@")[1] }, SchemaV2Manifest: {
    schemaVersion: 2, config: { digest: imageId }, layers: [{ digest: `sha256:${"a".repeat(64)}` }]
  } };
  assertRegistryManifest(manifest, reference, imageId);
  assert.throws(() => assertRegistryManifest(manifest, reference, `sha256:${"b".repeat(64)}`));
  assert.throws(() => assertRegistryManifest(manifest, reference.replace(/4/g, "c"), imageId));
  assert.throws(() => assertRegistryManifest({ Descriptor: manifest.Descriptor, manifests: [manifest] }, reference, imageId));
});

test("a substituted image, source, layer, runtime, config or extra observation cannot inherit passed checks", () => {
  const mutations = [
    (p) => p.artifacts[0].imageId = `sha256:${"6".repeat(64)}`,
    (p) => p.artifacts[0].rootfsLayers.push(`sha256:${"6".repeat(64)}`),
    (p) => p.artifacts[0].runtime.node = "99.0.0",
    (p) => p.artifacts[0].bytes++,
    (p) => p.source.commit = "7".repeat(40),
    (p) => p.inputs.productionContainerConfig.sha256 = "8".repeat(64),
    (p) => p.artifacts.push(structuredClone(p.artifacts[0])),
    (p) => p.extraClaim = true
  ];
  for (const mutate of mutations) {
    const { tested, published } = receipts(); mutate(published);
    assert.throws(() => assertPublishedImageIdentity(published, tested));
  }
});

test("mutable tags, wrong account/repository, malformed digests and another platform are refused", () => {
  for (const value of [IMAGE_REPOSITORY + ":latest", reference.replace("dea2502", "aaa2502"),
    reference.replace("site-behavior-lab-scanner@", "other@"), reference.slice(0, -1), reference + "\n", "https://" + reference]) {
    const { tested, published } = receipts(); published.artifacts[0].repoDigests = [value];
    assert.throws(() => assertPublishedImageIdentity(published, tested), value);
  }
  const { tested, published } = receipts(); published.artifacts[0].architecture = "arm64";
  assert.throws(() => assertPublishedImageIdentity(published, tested));
});

test("an authentic receipt is still unusable for another source tree or deployment configuration", () => {
  const { published } = receipts();
  for (const expected of [{ commit: "a".repeat(40), tree, configBytes },
    { commit, tree: "b".repeat(40), configBytes }, { commit, tree, configBytes: Buffer.from("changed") }]) {
    assert.throws(() => validatePublishedContainer(published, expected));
  }
});

test("run selection excludes PRs, forks, other workflows and different revisions", () => {
  const run = { id: 123, run_attempt: 1, repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY }, head_sha: commit, head_branch: "main",
    path: ".github/workflows/ci.yml", event: "push" };
  assert.equal(validMainRun(run, commit), true);
  for (const patch of [{ event: "pull_request" }, { event: "pull_request_target" },
    { head_repository: { full_name: "attacker/fork" } }, { repository: { full_name: "attacker/fork" } },
    { head_sha: "a".repeat(40) }, { head_branch: "feature" }, { path: ".github/workflows/other.yml" },
    { id: 0 }, { run_attempt: 0 }]) assert.equal(validMainRun({ ...run, ...patch }, commit), false);
});

test("attestation policy binds hosted main CI and its exact source and signer revision", () => {
  const args = attestationArgs("/tmp/evidence.json", commit);
  for (const [flag, value] of [["--repo", REPOSITORY], ["--source-ref", "refs/heads/main"],
    ["--source-digest", commit], ["--signer-digest", commit],
    ["--signer-workflow", `${REPOSITORY}/.github/workflows/ci.yml`]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes("--deny-self-hosted-runners"));
});

test("isolated attestation independently executes the exact publication identity validator", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const embedded = ci.split("          function assertPublishedImageIdentity")[1]
    .split("\n          const tested =")[0].replace(/^ {10}/gm, "");
  assert.equal("function assertPublishedImageIdentity" + embedded, assertPublishedImageIdentity.toString());
  const start = ci.indexOf("      - name: Publish the tested production image");
  assert.ok(start > ci.indexOf("      - name: Enforce container security and package-evidence gates"));
  const publish = ci.slice(start, ci.indexOf("  # This job never", start));
  assert.match(publish, /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(publish, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(publish, /continue-on-error/);
  const attest = ci.slice(ci.indexOf("\n  attest:"), ci.indexOf("\n  promote:"));
  assert.doesNotMatch(attest, /actions\/checkout|CLOUDFLARE_API_TOKEN|npm ci/);
  assert.match(attest, /Attest published container evidence/);
});

test("deployment verifies signatures before invoking Wrangler and generates only a digest deployment", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-published-deploy-"));
  const evidenceFile = path.join(tmpdir(), `sbl-published-${path.basename(root)}.json`);
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "node_modules/wrangler/bin"), { recursive: true });
    symlinkSync(path.resolve("node_modules/typescript"), path.join(root, "node_modules/typescript"));
    for (const script of ["deploy-container.mjs", "published-container-lib.mjs", "measurement-candidate-build-proof.mjs"]) {
      copyFileSync(path.join("scripts", script), path.join(root, "scripts", script));
    }
    const actualConfig = readFileSync("wrangler.container.jsonc");
    writeFileSync(path.join(root, "wrangler.container.jsonc"), actualConfig);
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n*.marker\nwrangler.container.generated.*.jsonc\n");
    const fakeGh = path.join(root, "node_modules/gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node\nif(process.env.FAIL_ATTESTATION)process.exit(1);console.log('[{}]');\n`, { mode: 0o755 });
    writeFileSync(path.join(root, "scripts/ensure-gh-attestation-verifier.mjs"), `console.log(${JSON.stringify(fakeGh)});\n`);
    writeFileSync(path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      `const fs=require('node:fs');const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('-c')+1]));fs.writeFileSync('deployed.marker',JSON.stringify(config));\n`);
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
    } }).trim();
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const { published } = receipts();
    published.source.commit = git("rev-parse", "HEAD"); published.source.tree = git("rev-parse", "HEAD^{tree}");
    published.artifacts[0].sourceCommit = published.source.commit;
    published.inputs.productionContainerConfig = { path: "wrangler.container.jsonc", bytes: actualConfig.length, sha256: sha256(actualConfig) };
    writeFileSync(evidenceFile, JSON.stringify(published));
    const execute = (failure) => spawnSync(process.execPath, ["scripts/deploy-container.mjs", "--published-evidence", evidenceFile], {
      cwd: root, encoding: "utf8", env: { ...process.env, WORKERS_CI_COMMIT_SHA: published.source.commit, FAIL_ATTESTATION: failure ? "1" : "" }
    });
    const failed = execute(true);
    assert.notEqual(failed.status, 0);
    assert.ok(!readdirSync(root).includes("deployed.marker"));
    const passed = execute(false);
    assert.equal(passed.status, 0, passed.stderr);
    const config = JSON.parse(readFileSync(path.join(root, "deployed.marker")));
    assert.equal(config.containers[0].image, reference);
    assert.equal(config.containers[0].image_vars, undefined);
    assert.equal(config.containers[0].instance_type, "standard-2");
    assert.equal(config.vars.SITE_BEHAVIOR_LAB_DURABLE_JOBS, "0");
    assert.ok(!readdirSync(root).some((name) => name.startsWith("wrangler.container.generated.")));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(evidenceFile, { force: true }); }
});
