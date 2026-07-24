import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const ROOT = process.cwd();
const RELEASE_SCRIPT = path.join(ROOT, "scripts", "release-evidence.mjs");
const PROVENANCE_SCRIPT = path.join(ROOT, "scripts", "static-deployment-provenance.mjs");

// scripts/release-evidence.mjs is a host-only release tool: it refuses to run
// under any runtime other than the declared repository toolchain, by design.
// The runtime container image pins its own newer Node from the Playwright
// base, so inside the image's `npm run check` that refusal fires before the
// behaviors below can be reached. State that environmental precondition as an
// explicit skip; every host lane (CI runners, release machines) runs these.
const HOST_TOOLCHAIN_NODE = "24.14.1";
const hostToolchainSkip =
  process.versions.node === HOST_TOOLCHAIN_NODE
    ? false
    : `release evidence runs only under the declared host Node ${HOST_TOOLCHAIN_NODE}; this runtime is ${process.versions.node}`;

test("repository metadata truthfully describes one private development line", async () => {
  const manifest = JSON.parse(await source("package.json"));
  const lock = JSON.parse(await source("package-lock.json"));
  const policy = JSON.parse(await source("release-policy.json"));
  const citation = await source("CITATION.cff");
  const changelog = await source("CHANGELOG.md");
  const releaseGuide = await source("RELEASE.md");

  assert.deepEqual(policy, {
    schemaVersion: 1,
    status: "development",
    version: "0.1.0",
    releaseTag: null,
    stablePublicApi: false,
    npmPublication: "disabled"
  });
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, policy.version);
  assert.equal(lock.version, policy.version);
  assert.equal(lock.packages[""].version, policy.version);
  assert.equal(manifest.packageManager, "npm@11.11.0");
  assert.deepEqual(manifest.engines, { node: "24.14.1", npm: "11.11.0" });
  assert.equal(lock.packages[""].packageManager, manifest.packageManager);
  assert.deepEqual(lock.packages[""].engines, manifest.engines);
  assert.match(citation, /^version: "0\.1\.0"$/m);
  assert.match(changelog, /^## Unreleased$/m);
  assert.doesNotMatch(changelog, /^## \[?0\.1\.0\]?\s+-/m);
  assert.equal(manifest.scripts["release:evidence"], "node scripts/release-evidence.mjs");
  assert.match(releaseGuide, /private `0\.1\.0` development line/);
  assert.match(releaseGuide, /does \*\*not\*\* claim that a[\s\S]*separately deployed Cloudflare artifact/);
  assert.match(releaseGuide, /Critical-operation claims additionally require/);
  assert.match(
    releaseGuide,
    /branch governance allows unreviewed[\s\S]*production` needs all five[\s\S]*trusted main-only attestation job/
  );
  assert.match(releaseGuide, /actual\s+Cloudflare deploy[\s\S]*verified rather than inferred/);
  assert.match(releaseGuide, /External control snapshot \(2026-07-21\)/);
  assert.match(releaseGuide, /ea9e0f1b37388c195e045784bdcf6d40fe877ee0/);
  assert.match(releaseGuide, /production branch `production`[\s\S]*non-production[\s\S]*disabled/);
  assert.match(releaseGuide, /required neither status checks nor review/);
  assert.match(releaseGuide, /Pages still declared `NODE_VERSION=22`[\s\S]*Node `24\.14\.1` with npm `11\.11\.0`/);
  assert.match(
    releaseGuide,
    /Playwright base[\s\S]*Node 24\.17\.0 with npm 11\.13\.0[\s\S]*intentionally distinct/
  );
  assert.match(releaseGuide, /Preview deployments[\s\S]*remained public by default/);
  assert.match(
    releaseGuide,
    /attestation subjects are the receipt JSON files themselves, not the[\s\S]*Cloudflare deployment/
  );
  assert.match(
    releaseGuide,
    /first live `main` CI attestation receipt and independent readback[\s\S]*external proof gate/
  );
});

test("container and CI source contracts preserve exact-SHA evidence after the real gates", async () => {
  const dockerfile = await source("Dockerfile");
  const workflow = await source(".github/workflows/ci.yml");

  assert.match(dockerfile, /org\.opencontainers\.image\.title="Site Behavior Lab"/);
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.source="https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab"/
  );
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{SITE_BEHAVIOR_LAB_BUILD_COMMIT\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses="AGPL-3\.0-or-later"/);
  assert.match(
    dockerfile,
    /RUN test "\$\(node --version\)" = "v24\.17\.0" \\\n\s+&& test "\$\(npm --version\)" = "11\.13\.0"/
  );

  const app = workflow.slice(workflow.indexOf("\n  app:"), workflow.indexOf("\n  smoke:"));
  const docker = workflow.slice(workflow.indexOf("\n  docker:"), workflow.indexOf("\n  attest:"));
  const attest = workflow.slice(workflow.indexOf("\n  attest:"), workflow.indexOf("\n  promote:"));
  assert.ok(app.indexOf("npm run test:smoke:static") < app.indexOf("Record exact-SHA static build evidence"));
  assert.match(app, /--static-dir out/);
  assert.match(app, /exact-sha-static-evidence-\$\{\{ github\.sha \}\}/);
  assert.ok(docker.indexOf("npm run test:smoke:docker") < docker.indexOf("Record exact-SHA container build evidence"));
  assert.match(docker, /DOCKER_SMOKE_PUBLIC_R2: "1"/);
  assert.match(docker, /uses: actions\/checkout@[0-9a-f]+[^\n]*\n\s+with:\n\s+fetch-depth: 0/);
  assert.match(docker, /--container-image site-behavior-lab:smoke/);
  assert.match(docker, /exact-sha-container-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(attest, /name: exact-sha-static-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(attest, /name: exact-sha-container-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(attest, /subject-path:[^\n]*site-behavior-lab-static-release-evidence\.json/);
  assert.match(attest, /subject-path:[^\n]*site-behavior-lab-container-release-evidence\.json/);
  assert.match(attest, /name: exact-sha-provenance-attestations-\$\{\{ github\.sha \}\}/);
  assert.equal(
    (workflow.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ?? []).length >= 2,
    true
  );
});

test("static evidence is deterministic and changes on artifact tampering", { skip: hostToolchainSkip }, async (t) => {
  const fixture = await makeFixture(t);
  const firstPath = await temporaryReceipt(t);
  const secondPath = await temporaryReceipt(t);
  const first = runEvidence(fixture.root, ["--static-dir", "out", "--output", firstPath]);
  const second = runEvidence(fixture.root, ["--static-dir", "out", "--output", secondPath]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstBytes = await readFile(firstPath, "utf8");
  const secondBytes = await readFile(secondPath, "utf8");
  assert.equal(secondBytes, firstBytes);

  const receipt = JSON.parse(firstBytes);
  assert.equal(receipt.source.commit, fixture.commit);
  assert.equal(receipt.source.requiredNode, "24.14.1");
  assert.equal(receipt.source.requiredNpm, "11.11.0");
  assert.equal(receipt.release.status, "development");
  assert.equal(receipt.artifacts[0].name, "static-pages");
  assert.equal(receipt.artifacts[0].deployment.deployment, fixture.commit);
  assert.deepEqual(
    receipt.artifacts[0].files.map((entry: { path: string }) => entry.path),
    ["asset.txt", "deployment.json"]
  );
  assert.equal(git(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).trim(), "");

  await writeFile(path.join(fixture.root, "out", "asset.txt"), "tampered\n");
  const changedPath = await temporaryReceipt(t);
  const changed = runEvidence(fixture.root, ["--static-dir", "out", "--output", changedPath]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(await readFile(changedPath, "utf8"), firstBytes);

  await writeFile(
    path.join(fixture.root, "out", "deployment.json"),
    `${JSON.stringify({ schemaVersion: 1, deployment: "f".repeat(40) })}\n`
  );
  const wrongMarker = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.notEqual(wrongMarker.status, 0);
  assert.match(wrongMarker.stderr, /deployment\.json must identify the exact clean source commit/);
});

test("evidence refuses dirty source and inconsistent release metadata", { skip: hostToolchainSkip }, async (t) => {
  const dirtyFixture = await makeFixture(t);
  await writeFile(path.join(dirtyFixture.root, "package.json"), "{}\n");
  const dirty = runEvidence(dirtyFixture.root, ["--static-dir", "out"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /requires a clean Git worktree/);

  const inconsistent = await makeFixture(t, { policyVersion: "0.2.0" });
  const result = runEvidence(inconsistent.root, ["--static-dir", "out"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json and release-policy\.json versions must match exactly/);

  const tagged = await makeFixture(t);
  git(tagged.root, ["tag", "v0.1.0"]);
  const taggedResult = runEvidence(tagged.root, ["--static-dir", "out"]);
  assert.notEqual(taggedResult.status, 0);
  assert.match(taggedResult.stderr, /Development release policy conflicts with existing tag v0\.1\.0/);
});

test("container evidence requires exact identity and isolated Node/npm runtime probes", { skip: hostToolchainSkip }, async (t) => {
  const fixture = await makeFixture(t);
  const helperRoot = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-fake-docker-"));
  t.after(() => rm(helperRoot, { recursive: true, force: true }));
  const docker = path.join(helperRoot, "fake-docker.mjs");
  const dockerLog = path.join(helperRoot, "docker-calls.jsonl");
  const imageId = `sha256:${"1".repeat(64)}`;
  const layer = `sha256:${"2".repeat(64)}`;
  await writeFile(
    docker,
    `#!/usr/bin/env node
import fs from "node:fs";
const commit = process.env.FIXTURE_COMMIT;
const args = process.argv.slice(2);
if (process.env.FIXTURE_DOCKER_LOG) fs.appendFileSync(process.env.FIXTURE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "run") {
  const entrypoint = args.find((value) => value.startsWith("--entrypoint="));
  if (entrypoint === "--entrypoint=node") {
    process.stdout.write((process.env.FIXTURE_CONTAINER_NODE || "v24.17.0") + "\\n");
    process.exit(0);
  }
  if (entrypoint === "--entrypoint=npm") {
    if (process.env.FIXTURE_CONTAINER_NPM) {
      process.stdout.write(process.env.FIXTURE_CONTAINER_NPM + "\\n");
      process.exit(0);
    }
    process.stderr.write("exec: \\"npm\\": executable file not found\\n");
    process.exit(127);
  }
  process.exit(2);
}
if (args[0] !== "image" || args[1] !== "inspect") process.exit(2);
process.stdout.write(JSON.stringify([{
  Id: ${JSON.stringify(imageId)},
  RepoDigests: [],
  Os: "linux",
  Architecture: "amd64",
  Size: 1234,
  RootFS: { Layers: [${JSON.stringify(layer)}] },
  Config: {
    Env: ["SITE_BEHAVIOR_LAB_BUILD_COMMIT=" + commit],
    Labels: {
      "org.opencontainers.image.title": "Site Behavior Lab",
      "org.opencontainers.image.source": "https://github.com/iAnonymous3000/site-behavior-lab",
      "org.opencontainers.image.revision": commit,
      "org.opencontainers.image.licenses": "AGPL-3.0-or-later"
    }
  }
}]));
`
  );
  await chmod(docker, 0o755);
  const output = await temporaryReceipt(t);
  const result = runEvidence(
    fixture.root,
    ["--container-image", "site-behavior-lab:smoke", "--output", output],
    { DOCKER_BIN: docker, FIXTURE_COMMIT: fixture.commit, FIXTURE_DOCKER_LOG: dockerLog }
  );

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(receipt.artifacts[0], {
    name: "container-image",
    kind: "docker-image-inspection",
    image: "site-behavior-lab:smoke",
    imageId,
    repoDigests: [],
    os: "linux",
    architecture: "amd64",
    bytes: 1234,
    rootfsLayers: [layer],
    sourceCommit: fixture.commit,
    runtime: {
      node: "24.17.0",
      npm: "absent",
      probeIsolation: {
        pull: "never",
        network: "none",
        rootFilesystem: "read-only",
        capabilities: "all-dropped",
        noNewPrivileges: true
      }
    }
  });

  const calls = (await readFile(dockerLog, "utf8"))
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));
  assert.deepEqual(calls, [
    ["image", "inspect", "site-behavior-lab:smoke"],
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--entrypoint=node",
      imageId,
      "--version"
    ],
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--entrypoint=npm",
      imageId,
      "--version"
    ]
  ]);

  const wrongRuntime = runEvidence(
    fixture.root,
    ["--container-image", "site-behavior-lab:smoke"],
    {
      DOCKER_BIN: docker,
      FIXTURE_COMMIT: fixture.commit,
      FIXTURE_CONTAINER_NODE: "v24.18.0"
    }
  );
  assert.notEqual(wrongRuntime.status, 0);
  assert.match(wrongRuntime.stderr, /requires node 24\.17\.0, not v24\.18\.0/);

  // A runtime image that ships ANY answering package manager is rejected,
  // including one at the base's own pinned version: the contract is absence,
  // not a version.
  for (const presentNpm of ["11.13.0", "11.14.0"]) {
    const npmPresent = runEvidence(
      fixture.root,
      ["--container-image", "site-behavior-lab:smoke"],
      {
        DOCKER_BIN: docker,
        FIXTURE_COMMIT: fixture.commit,
        FIXTURE_CONTAINER_NPM: presentNpm
      }
    );
    assert.notEqual(npmPresent.status, 0, presentNpm);
    assert.match(
      npmPresent.stderr,
      new RegExp(`must not ship a package manager; npm answered with ${presentNpm.replaceAll(".", "\\.")}`)
    );
  }
});

test("evidence paths cannot escape through artifact or output symlinks", { skip: hostToolchainSkip }, async (t) => {
  const fixture = await makeFixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-release-links-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(path.join(external, "artifact"));
  await writeFile(path.join(external, "artifact", "asset.txt"), "outside\n");
  await writeFile(
    path.join(external, "artifact", "deployment.json"),
    `${JSON.stringify({ schemaVersion: 1, deployment: fixture.commit })}\n`
  );
  await symlink(path.join(external, "artifact"), path.join(fixture.root, "linked-out"));
  const escapedArtifact = runEvidence(fixture.root, ["--static-dir", "linked-out"]);
  assert.notEqual(escapedArtifact.status, 0);
  assert.match(escapedArtifact.stderr, /must not traverse a symbolic link or leave the repository/);

  const ignoredOutputDirectory = path.join(fixture.root, "receipts");
  await mkdir(ignoredOutputDirectory);
  const outputLink = path.join(external, "linked-output");
  await symlink(ignoredOutputDirectory, outputLink);
  const escapedOutput = runEvidence(fixture.root, [
    "--static-dir",
    "out",
    "--output",
    path.join(outputLink, "evidence.json")
  ]);
  assert.notEqual(escapedOutput.status, 0);
  assert.match(escapedOutput.stderr, /--output parent must already exist as a real directory/);

  const victim = path.join(fixture.root, "package.json");
  const victimBefore = await readFile(victim, "utf8");
  const finalComponentLink = path.join(external, "receipt.json");
  await symlink(victim, finalComponentLink);
  const redirectedFinalComponent = runEvidence(fixture.root, [
    "--static-dir",
    "out",
    "--output",
    finalComponentLink
  ]);
  assert.notEqual(redirectedFinalComponent.status, 0);
  assert.match(redirectedFinalComponent.stderr, /--output must not already exist/);
  assert.equal(await readFile(victim, "utf8"), victimBefore);
  assert.equal(git(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).trim(), "");

  const existingRegular = path.join(external, "existing.json");
  await writeFile(existingRegular, "keep me\n");
  const existingResult = runEvidence(fixture.root, ["--static-dir", "out", "--output", existingRegular]);
  assert.notEqual(existingResult.status, 0);
  assert.match(existingResult.stderr, /--output must not already exist/);
  assert.equal(await readFile(existingRegular, "utf8"), "keep me\n");
});

test("evidence rejects source mutation during container inspection and leaves no receipt", { skip: hostToolchainSkip }, async (t) => {
  const fixture = await makeFixture(t);
  const helperRoot = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-mutating-docker-"));
  t.after(() => rm(helperRoot, { recursive: true, force: true }));
  const docker = path.join(helperRoot, "mutating-docker.mjs");
  await writeFile(
    docker,
    `#!/usr/bin/env node
import fs from "node:fs";
const commit = process.env.FIXTURE_COMMIT;
const args = process.argv.slice(2);
if (args[0] === "run") {
  const entrypoint = args.find((value) => value.startsWith("--entrypoint="));
  if (entrypoint === "--entrypoint=node") process.stdout.write("v24.17.0\\n");
  else if (entrypoint === "--entrypoint=npm") process.exit(127);
  else process.exit(2);
  process.exit(0);
}
if (args[0] !== "image" || args[1] !== "inspect") process.exit(2);
fs.appendFileSync(process.env.FIXTURE_PACKAGE, "\\n");
process.stdout.write(JSON.stringify([{
  Id: "sha256:${"3".repeat(64)}",
  RepoDigests: [],
  Os: "linux",
  Architecture: "amd64",
  Size: 1234,
  RootFS: { Layers: ["sha256:${"4".repeat(64)}"] },
  Config: {
    Env: ["SITE_BEHAVIOR_LAB_BUILD_COMMIT=" + commit],
    Labels: {
      "org.opencontainers.image.title": "Site Behavior Lab",
      "org.opencontainers.image.source": "https://github.com/iAnonymous3000/site-behavior-lab",
      "org.opencontainers.image.revision": commit,
      "org.opencontainers.image.licenses": "AGPL-3.0-or-later"
    }
  }
}]));
`
  );
  await chmod(docker, 0o755);
  const output = await temporaryReceipt(t);
  const result = runEvidence(
    fixture.root,
    ["--container-image", "site-behavior-lab:smoke", "--output", output],
    {
      DOCKER_BIN: docker,
      FIXTURE_COMMIT: fixture.commit,
      FIXTURE_PACKAGE: path.join(fixture.root, "package.json")
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a clean Git worktree/);
  assert.notEqual(git(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).trim(), "");
  await assert.rejects(readFile(output, "utf8"), /ENOENT/);
});

async function source(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), "utf8");
}

async function makeFixture(t: TestContext, options: { policyVersion?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await copyFile(RELEASE_SCRIPT, path.join(root, "scripts", "release-evidence.mjs"));
  await copyFile(PROVENANCE_SCRIPT, path.join(root, "scripts", "static-deployment-provenance.mjs"));
  await writeFile(path.join(root, ".gitignore"), "out/\nreceipts/\nlinked-out\n");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "site-behavior-lab",
      version: "0.1.0",
      private: true,
      packageManager: "npm@11.11.0",
      engines: { node: "24.14.1", npm: "11.11.0" },
      repository: { type: "git", url: "git+https://github.com/iAnonymous3000/site-behavior-lab.git" }
    })}\n`
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "site-behavior-lab",
      version: "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": {
          version: "0.1.0",
          packageManager: "npm@11.11.0",
          engines: { node: "24.14.1", npm: "11.11.0" }
        }
      }
    })}\n`
  );
  await writeFile(
    path.join(root, "release-policy.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      status: "development",
      version: options.policyVersion ?? "0.1.0",
      releaseTag: null,
      stablePublicApi: false,
      npmPublication: "disabled"
    })}\n`
  );
  await writeFile(path.join(root, "CITATION.cff"), 'cff-version: 1.2.0\nversion: "0.1.0"\n');
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
  await writeFile(path.join(root, "Dockerfile"), "FROM scratch\n");
  await writeFile(path.join(root, "wrangler.container.jsonc"), "{}\n");

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Release Evidence Test"]);
  git(root, ["config", "user.email", "release-evidence@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  const commit = git(root, ["rev-parse", "HEAD"]).trim();

  await mkdir(path.join(root, "out"));
  await writeFile(path.join(root, "out", "asset.txt"), "artifact\n");
  await writeFile(
    path.join(root, "out", "deployment.json"),
    `${JSON.stringify({ schemaVersion: 1, deployment: commit })}\n`
  );
  return { root, commit };
}

async function temporaryReceipt(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-release-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "evidence.json");
}

function runEvidence(cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of ["SITE_BEHAVIOR_LAB_BUILD_COMMIT", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA", "DOCKER_BIN"]) {
    delete env[name];
  }
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [path.join(cwd, "scripts", "release-evidence.mjs"), ...args], {
    cwd,
    env,
    encoding: "utf8"
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
