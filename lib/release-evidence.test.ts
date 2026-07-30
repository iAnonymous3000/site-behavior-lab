import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const ROOT = process.cwd();
const RELEASE_SCRIPT = path.join(ROOT, "scripts", "release-evidence.mjs");
const PROVENANCE_SCRIPT = path.join(ROOT, "scripts", "static-deployment-provenance.mjs");

type StaticDeploymentProvenance = {
  buildDeploymentReceipt(
    commit: string,
    options?: { cwd?: string }
  ): { schemaVersion: number; deployment: string; revisionCommittedAt: string };
};

/** The receipt producer itself, so fixtures never restate the published shape. */
const staticDeploymentProvenance = (): Promise<StaticDeploymentProvenance> =>
  import(PROVENANCE_SCRIPT) as Promise<StaticDeploymentProvenance>;

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

  // Pre-1.0 milestone releases: a tag marks a reviewed, CI-green, promoted
  // revision with an attested receipt. It never upgrades the API or publication
  // claims, which both states keep disabled.
  assert.equal(policy.schemaVersion, 2);
  assert.equal(["development", "released"].includes(policy.status), true);
  assert.match(policy.version, /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(policy.stablePublicApi, false);
  assert.equal(policy.npmPublication, "disabled");
  if (policy.status === "released") {
    assert.equal(policy.releaseTag, `v${policy.version}`);
    assert.match(policy.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
  } else {
    assert.equal(policy.releaseTag, null);
    assert.equal(policy.releaseDate, null);
  }
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, policy.version);
  assert.equal(lock.version, policy.version);
  assert.equal(lock.packages[""].version, policy.version);
  assert.equal(manifest.packageManager, "npm@11.11.0");
  assert.deepEqual(manifest.engines, { node: "24.14.1", npm: "11.11.0" });
  assert.equal(lock.packages[""].packageManager, manifest.packageManager);
  assert.deepEqual(lock.packages[""].engines, manifest.engines);
  assert.match(citation, new RegExp(`^version: "${policy.version}"$`, "m"));
  // Ongoing work always has a home, in either state.
  assert.equal((changelog.match(/^## Unreleased$/gm) ?? []).length, 1);
  const datedForVersion = new RegExp(`^## \\[?${policy.version.replace(/\./g, "\\.")}\\]?\\s+-\\s*(\\d{4}-\\d{2}-\\d{2})$`, "m");
  if (policy.status === "released") {
    assert.match(citation, new RegExp(`^date-released: "${policy.releaseDate}"$`, "m"));
    const dated = changelog.match(datedForVersion);
    assert.notEqual(dated, null, "a released changelog must carry its dated section");
    assert.equal(dated![1], policy.releaseDate);
  } else {
    assert.doesNotMatch(citation, /^date-released:/m);
    assert.doesNotMatch(changelog, datedForVersion);
  }
  assert.equal(manifest.scripts["release:evidence"], "node scripts/release-evidence.mjs");
  assert.match(releaseGuide, /pre-1\.0 development\s+line/);
  // The guide must state what a tag does and does not claim, and must keep the
  // ordering that makes the claim true: promote first, then tag.
  assert.match(releaseGuide, /What a release tag claims/);
  assert.match(releaseGuide, /promoted to `production` before the tag existed/);
  assert.match(releaseGuide, /does not claim API stability/);
  assert.match(releaseGuide, /schema contracts \(v1 frozen,\s+v2\/r1, v2\/r2\) version\s+independently/);
  assert.match(releaseGuide, /Cutting a release/);
  assert.match(releaseGuide, /release\.tagExists/);
  assert.match(releaseGuide, /release\.evidencesReleaseCommit/);
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
    /Playwright base[\s\S]*Node 24\.18\.0 with npm 11\.16\.0[\s\S]*intentionally distinct/
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
    /RUN test "\$\(node --version\)" = "v24\.18\.0" \\\n\s+&& test "\$\(npm --version\)" = "11\.16\.0"/
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
  assert.equal(["development", "released"].includes(receipt.release.status), true);
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

  const validReceipt = JSON.parse(
    await readFile(path.join(fixture.root, "out", "deployment.json"), "utf8")
  );
  await writeFile(
    path.join(fixture.root, "out", "deployment.json"),
    `${JSON.stringify({ ...validReceipt, deployment: "f".repeat(40) }, null, 2)}\n`
  );
  const wrongMarker = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.notEqual(wrongMarker.status, 0);
  assert.match(wrongMarker.stderr, /deployment\.json must identify the exact clean source commit/);

  // An extra field in a published provenance artifact is a leak, not a nicety.
  await writeFile(
    path.join(fixture.root, "out", "deployment.json"),
    `${JSON.stringify({ ...validReceipt, extra: "surprise" }, null, 2)}\n`
  );
  const extraKey = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.notEqual(extraKey.status, 0);
  assert.match(extraKey.stderr, /must carry exactly deployment, revisionCommittedAt, and schemaVersion/);

  // The timestamp's value is being derivable from the SHA. A build clock would
  // make every rebuild of one commit differ and break exact-SHA comparison.
  await writeFile(
    path.join(fixture.root, "out", "deployment.json"),
    `${JSON.stringify({ ...validReceipt, revisionCommittedAt: new Date(0).toISOString() }, null, 2)}\n`
  );
  const wrongClock = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.notEqual(wrongClock.status, 0);
  assert.match(wrongClock.stderr, /must be the committer date of that exact commit/);
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
    process.stdout.write((process.env.FIXTURE_CONTAINER_NODE || "v24.18.0") + "\\n");
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
      node: "24.18.0",
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
      FIXTURE_CONTAINER_NODE: "v24.19.0"
    }
  );
  assert.notEqual(wrongRuntime.status, 0);
  assert.match(wrongRuntime.stderr, /requires node 24\.18\.0, not v24\.19\.0/);

  // A runtime image that ships ANY answering package manager is rejected,
  // including one at the base's own pinned version: the contract is absence,
  // not a version.
  for (const presentNpm of ["11.16.0", "11.17.0"]) {
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
  const { buildDeploymentReceipt: buildLinkedReceipt } = await staticDeploymentProvenance();
  await writeFile(
    path.join(external, "artifact", "deployment.json"),
    `${JSON.stringify(buildLinkedReceipt(fixture.commit, { cwd: fixture.root }), null, 2)}\n`
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
  if (entrypoint === "--entrypoint=node") process.stdout.write("v24.18.0\\n");
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

function workflowJob(workflow: string, id: string): string {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must declare the ${id} job`);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/\n  [a-zA-Z0-9_-]+:\n/);
  return workflow.slice(start, next === -1 ? workflow.length : bodyStart + next);
}

async function makeFixture(
  t: TestContext,
  options: {
    policyVersion?: string;
    packageVersion?: string;
    policy?: Record<string, unknown>;
    citation?: string;
    changelog?: string;
  } = {}
) {
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
      version: options.packageVersion ?? "0.1.0",
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
      version: options.packageVersion ?? "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": {
          version: options.packageVersion ?? "0.1.0",
          packageManager: "npm@11.11.0",
          engines: { node: "24.14.1", npm: "11.11.0" }
        }
      }
    })}\n`
  );
  await writeFile(
    path.join(root, "release-policy.json"),
    `${JSON.stringify(
      options.policy ?? {
        schemaVersion: 2,
        status: "development",
        version: options.policyVersion ?? "0.1.0",
        releaseTag: null,
        releaseDate: null,
        stablePublicApi: false,
        npmPublication: "disabled"
      }
    )}\n`
  );
  await writeFile(
    path.join(root, "CITATION.cff"),
    options.citation ?? 'cff-version: 1.2.0\nversion: "0.1.0"\n'
  );
  await writeFile(path.join(root, "CHANGELOG.md"), options.changelog ?? "# Changelog\n\n## Unreleased\n");
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
  // Built by the real producer, never hand-written. A fixture that restates the
  // receipt shape cannot notice the producer and the gate drifting apart, which
  // is exactly how a three-key receipt shipped against a two-key gate.
  const { buildDeploymentReceipt } = await staticDeploymentProvenance();
  await writeFile(
    path.join(root, "out", "deployment.json"),
    `${JSON.stringify(buildDeploymentReceipt(commit, { cwd: root }), null, 2)}\n`
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

test("the release workflow tags only a promoted, CI-green revision and attests its receipt", async () => {
  const workflow = await source(".github/workflows/release.yml");
  const prepare = workflowJob(workflow, "prepare");
  const attest = workflowJob(workflow, "attest");
  const tag = workflowJob(workflow, "tag");

  // A release is curated: a human dispatches it, and only from the default
  // branch.
  assert.match(workflow, /on:\n\s+workflow_dispatch:/);
  assert.match(
    workflow,
    /if: github\.ref_type == 'branch' && github\.ref_name == github\.event\.repository\.default_branch/
  );

  // The four refusals that make the tag mean something.
  assert.match(workflow, /release-policy\.json status must be released before a tag is cut/);
  assert.match(workflow, /already exists; releases are immutable/);
  assert.match(prepare, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/production/);
  // Run-level success for a SHA is not proof; the gate requires a completed
  // trusted main-branch run of THIS repository and verifies each required job.
  assert.match(workflow, /No successful trusted main-branch CI run recorded for/);
  assert.match(prepare, /node scripts\/verify-required-ci-jobs\.mjs/);

  // A dispatch runs at the branch tip, which drifts away from the revision the
  // release actually names. Every gate, the receipt, and the tag must describe
  // the resolved revision, so no step may fall back to the dispatch SHA.
  assert.match(prepare, /git checkout --quiet --detach "\$release_sha"/);
  assert.match(prepare, /No commit on main declares release-policy\.json version/);
  assert.match(prepare, /is not reachable from main/);
  assert.match(prepare, /does not contain the commit that declared/);
  assert.match(prepare, /head_sha=\$\{RELEASE_SHA\}/);
  assert.match(attest, /source\?\.commit !== process\.env\.RELEASE_SHA/);
  assert.match(tag, /object: process\.env\.RELEASE_SHA/);

  // Candidate and dependency code is confined to a read-only fresh runner.
  assert.match(
    prepare,
    /permissions:\n\s+contents: read\n\s+actions: read/
  );
  assert.doesNotMatch(prepare, /(?:contents|actions|id-token|attestations|artifact-metadata): write/);
  assert.match(prepare, /persist-credentials: false/);
  assert.doesNotMatch(prepare, /secrets\.|actions\/attest@|git tag|git push|uses: \.\//);
  assert.match(prepare, /npm ci/);
  assert.match(prepare, /npx playwright install --with-deps chromium/);
  assert.match(prepare, /npm run build:pages/);
  assert.match(prepare, /npm run test:smoke:static/);
  assert.ok(
    prepare.indexOf("npm ci") <
      prepare.indexOf("npx playwright install --with-deps chromium"),
    "the release job must install locked dependencies before invoking the pinned Playwright CLI"
  );
  assert.ok(
    prepare.indexOf("npx playwright install --with-deps chromium") <
      prepare.indexOf("npm run test:smoke:static"),
    "the release job must install Chromium before launching the static smoke browser"
  );
  assert.match(prepare, /npm run release:evidence --/);
  assert.match(prepare, /archive: false/);
  assert.match(prepare, /receipt_artifact_id: \$\{\{ steps\.receipt_artifact\.outputs\.artifact-id \}\}/);
  // The attestation job refuses a handoff whose artifact metadata does not
  // carry exactly the receipt's file name, so the upload must state that name
  // rather than inherit whatever the action happens to default to.
  const receiptFileName =
    "site-behavior-lab-release-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}\\.json";
  assert.match(prepare, new RegExp(`name: ${receiptFileName}`));
  assert.match(prepare, new RegExp(`path: \\$\\{\\{ runner\\.temp \\}\\}/${receiptFileName}`));
  const candidateExecution = prepare.slice(prepare.indexOf("Verify every required CI job without an API token"));
  assert.doesNotMatch(
    candidateExecution,
    /GH_TOKEN|github\.token/,
    "candidate verifier, dependencies, builds, and receipt code must not receive the GitHub API token"
  );

  // Attestation authority receives one immutable artifact ID on a fresh
  // runner, validates it as hostile data, and cannot write repository refs.
  assert.match(attest, /needs: prepare/);
  assert.match(
    attest,
    /permissions:\n\s+contents: read\n\s+actions: read\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/
  );
  assert.doesNotMatch(
    attest,
    /contents: write|actions\/checkout|actions\/setup-node|npm (?:ci|run)|node_modules|uses: \.\//
  );
  assert.doesNotMatch(attest, /git fetch|git checkout|git tag|git push/);
  assert.match(
    attest,
    /artifact-ids: \$\{\{ needs\.prepare\.outputs\.receipt_artifact_id \}\}/
  );
  assert.match(attest, /digest-mismatch: error/);
  assert.match(attest, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(attest, /JSON\.stringify\(receipt, null, 2\)/);
  assert.match(attest, /artifact\?\.workflow_run\?\.head_sha !== process\.env\.GITHUB_SHA/);
  assert.match(attest, /receipt\.source\?\.commit !== process\.env\.RELEASE_SHA/);
  assert.match(attest, /receipt\.release\?\.status !== "released"/);

  // A receipt that only agrees with itself proves nothing about what was built,
  // because the job that built it also wrote it. The privileged job must take
  // the real bytes as a second immutable handoff and recompute every digest,
  // so a manifest describing files that were never produced fails here.
  assert.match(prepare, /path: out\n/);
  assert.match(prepare, /static_artifact_id: \$\{\{ steps\.static_artifact\.outputs\.artifact-id \}\}/);
  assert.match(attest, /artifact-ids: \$\{\{ needs\.prepare\.outputs\.static_artifact_id \}\}/);
  assert.match(attest, /The immutable static-artifact metadata does not identify this workflow handoff/);
  assert.match(attest, /entry\.isSymbolicLink\(\)/);
  assert.match(attest, /walked\.push\(\{ path: relative, bytes: fileBytes\.byteLength, sha256: sha256\(fileBytes\) \}\)/);
  assert.match(attest, /The receipt does not describe the built bytes at/);
  assert.match(attest, /The recomputed static manifest digest does not match the receipt/);
  assert.match(attest, /The built static bytes were not handed to the attestation job/);
  assert.ok(
    attest.indexOf("release-static") < attest.indexOf("Attest the validated release receipt"),
    "the built bytes must be verified before anything is signed"
  );

  // Release authority is not the same as dispatch permission. Both identities
  // are checked, and the tag job names an environment so an external
  // protection rule can apply to the only job that can write a ref.
  assert.match(tag, /environment: release-tag/);
  assert.match(tag, /ACTOR: \$\{\{ github\.actor \}\}/);
  assert.match(tag, /TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(tag, /is not an approved release author/);
  // Trim per entry, never across the whole list: deleting all whitespace after
  // splitting on commas also deletes the separators, collapsing a two-name
  // allowlist into one name that matches nobody. It fails closed, so it would
  // refuse every release the moment a second approver is added.
  assert.doesNotMatch(tag, /tr ',' '\\n' \| tr -d/);
  assert.match(tag, /tr ',' '\\n'\)"/);
  assert.ok(
    tag.indexOf("Require an approved release author") < tag.indexOf("git/refs"),
    "authorization must be checked before any ref is created"
  );
  assert.match(attest, /receipt\.release\?\.evidencesReleaseCommit !== false/);
  assert.match(attest, /staticArtifact\.deployment\?\.deployment !== process\.env\.RELEASE_SHA/);
  assert.match(attest, /uses: actions\/attest@[a-f0-9]{40} # v4\.2\.0/);

  // Tag authority is smaller still: contents write only, no checkout, code,
  // dependency, OIDC, or attestation authority. It creates, never updates, the
  // annotated tag through GitHub's Git database API.
  assert.match(tag, /needs:\n\s+- prepare\n\s+- attest/);
  assert.match(tag, /permissions:\n\s+contents: write/);
  assert.doesNotMatch(tag, /actions:|id-token:|attestations:|artifact-metadata:/);
  assert.doesNotMatch(tag, /actions\/checkout|actions\/setup-node|npm (?:ci|run)|node_modules|uses: \.\//);
  assert.doesNotMatch(tag, /git fetch|git checkout|git tag|git push|--method PATCH|force\s*[:=]\s*true/);
  assert.match(tag, /repos\/\$\{GITHUB_REPOSITORY\}\/git\/tags/);
  assert.match(tag, /repos\/\$\{GITHUB_REPOSITORY\}\/git\/refs/);
  assert.match(tag, /ref: `refs\/tags\/\$\{process\.env\.RELEASE_TAG\}`/);

  // The receipt must be validated before attestation, and attestation must
  // finish before the tag job can run.
  assert.ok(
    attest.indexOf("Validate downloaded release receipt as hostile data") <
      attest.indexOf("uses: actions/attest@"),
    "the receipt must be validated before it is attested"
  );
  // Same extractor the execution tests use, so the text checked here and the
  // text executed there can never be two different things.
  const inlineControllers = releaseControllers(workflow);
  for (const [index, controller] of inlineControllers.entries()) {
    const checked = spawnSync(process.execPath, ["--check"], { input: controller, encoding: "utf8" });
    assert.equal(checked.status, 0, `inline release controller ${index + 1} must parse: ${checked.stderr}`);
  }

  // A tag must never quietly widen what the project claims.
  assert.match(workflow, /A release may not claim a stable public API or npm publication/);
  assert.match(workflow, /no stable public API and no npm publication/i);
  assert.match(workflow, /permissions:\n\s+contents: read/);
});

test("the released state is verified, not merely permitted", { skip: hostToolchainSkip }, async (t) => {
  const releasedPolicy = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    status: "released",
    version: "0.1.0",
    releaseTag: "v0.1.0",
    releaseDate: "2026-07-25",
    stablePublicApi: false,
    npmPublication: "disabled",
    ...overrides
  });
  const citation = 'cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-07-25"\n';
  const changelog = "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-07-25\n";

  // The honest released shape is accepted, and the receipt reports that the tag
  // does not exist yet because it is cut only after promotion.
  const ok = await makeFixture(t, { policy: releasedPolicy(), citation, changelog });
  const accepted = runEvidence(ok.root, ["--static-dir", "out"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(accepted.stdout);
  assert.equal(receipt.release.status, "released");
  assert.equal(receipt.release.tag, "v0.1.0");
  assert.equal(receipt.release.releaseDate, "2026-07-25");
  assert.equal(receipt.release.tagExists, false);
  assert.equal(receipt.release.evidencesReleaseCommit, false);

  // Once the tag exists and names this commit, the receipt says so.
  const taggedOk = await makeFixture(t, { policy: releasedPolicy(), citation, changelog });
  git(taggedOk.root, ["tag", "-a", "v0.1.0", "-m", "release"]);
  const taggedAccepted = runEvidence(taggedOk.root, ["--static-dir", "out"]);
  assert.equal(taggedAccepted.status, 0, taggedAccepted.stderr);
  const taggedReceipt = JSON.parse(taggedAccepted.stdout);
  assert.equal(taggedReceipt.release.tagExists, true);
  assert.equal(taggedReceipt.release.evidencesReleaseCommit, true);

  // A release may never widen the project's claims.
  for (const [overrides, pattern] of [
    [{ stablePublicApi: true }, /stable-API and npm-publication claims disabled/],
    [{ npmPublication: "enabled" }, /stable-API and npm-publication claims disabled/],
    [{ version: "1.0.0", releaseTag: "v1.0.0" }, /pre-1\.0 semantic version/],
    [{ releaseTag: "0.1.0" }, /must name the tag v<version>/],
    [{ releaseDate: "July 25 2026" }, /one YYYY-MM-DD release date/],
    [{ status: "generally-available" }, /status must be exactly development or released/],
    [{ schemaVersion: 1 }, /must use schemaVersion 2/]
  ] as const) {
    const badVersion = (overrides as Record<string, unknown>).version as string | undefined;
    const bad = await makeFixture(t, {
      policy: releasedPolicy(overrides),
      packageVersion: badVersion,
      citation: badVersion ? citation.replace('"0.1.0"', `"${badVersion}"`) : citation,
      changelog: badVersion ? changelog.replace("[0.1.0]", `[${badVersion}]`) : changelog
    });
    const refused = runEvidence(bad.root, ["--static-dir", "out"]);
    assert.notEqual(refused.status, 0, `expected refusal for ${JSON.stringify(overrides)}`);
    assert.match(refused.stderr, pattern);
  }

  // The dated evidence must agree with the policy, in both files.
  const wrongCitation = await makeFixture(t, {
    policy: releasedPolicy(),
    citation: 'cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-01-01"\n',
    changelog
  });
  const citationRefused = runEvidence(wrongCitation.root, ["--static-dir", "out"]);
  assert.notEqual(citationRefused.status, 0);
  assert.match(citationRefused.stderr, /released CITATION\.cff must carry exactly the policy's release date/);

  const wrongChangelog = await makeFixture(t, {
    policy: releasedPolicy(),
    citation,
    changelog: "# Changelog\n\n## Unreleased\n"
  });
  const changelogRefused = runEvidence(wrongChangelog.root, ["--static-dir", "out"]);
  assert.notEqual(changelogRefused.status, 0);
  assert.match(changelogRefused.stderr, /released changelog must carry exactly one dated section/);

  // A tag that names a different version than the policy is refused.
  const strayTag = await makeFixture(t, { policy: releasedPolicy(), citation, changelog });
  git(strayTag.root, ["tag", "-a", "0.1.0", "-m", "stray"]);
  const strayRefused = runEvidence(strayTag.root, ["--static-dir", "out"]);
  assert.notEqual(strayRefused.status, 0);
  assert.match(strayRefused.stderr, /Release tag set for 0\.1\.0 must be exactly v0\.1\.0/);
});

test("the release runbook regenerates the supply-chain input its own version bump rewrites", async () => {
  const releaseGuide = await source("RELEASE.md");
  // Bumping the version rewrites package-lock.json, which THIRD_PARTY_INVENTORY
  // pins by digest. Cutting 0.2.0 without regenerating it took CI red on the
  // required supply-chain gate, exactly as a stale Brave-list inventory did.
  assert.match(releaseGuide, /node scripts\/third-party-inventory\.mjs/);
  assert.match(releaseGuide, /npm run supply-chain:third-party:check/);
  assert.match(releaseGuide, /pinned\s+supply-chain input/);
  const bumpStep = releaseGuide.indexOf("bumps `package.json` and `package-lock.json`");
  const regenerate = releaseGuide.indexOf("node scripts/third-party-inventory.mjs");
  assert.notEqual(bumpStep, -1);
  assert.ok(regenerate > bumpStep, "the regeneration must be documented with the bump that requires it");
});

/**
 * Extract the privileged controllers from the workflow. Every consumer, the
 * syntax check and the execution tests alike, goes through this one function so
 * the text under test is always the text the workflow runs. A copied validator
 * would drift from the gate exactly the way a copied contract always has here.
 */
function extractControllers(text: string): string[] {
  return [...text.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/g)].map((match) => match[1]);
}

function releaseControllers(workflow: string): string[] {
  const found = extractControllers(workflow);
  assert.ok(found.length >= 7, "every privileged controller must remain visible to the harness");
  return found;
}

/** The receipt validator, addressed by its step so a reordering cannot silently test another script. */
function releaseValidatorController(workflow: string): string {
  const step = "- name: Validate downloaded release receipt as hostile data";
  const occurrences = workflow.split(step).length - 1;
  assert.equal(occurrences, 1, "exactly one validator step must exist");
  const after = workflow.slice(workflow.indexOf(step));
  const end = after.indexOf("- name: Attest the validated release receipt");
  assert.notEqual(end, -1, "the validator must precede attestation");
  const controllers = extractControllers(after.slice(0, end));
  assert.equal(controllers.length, 1, "the validator step must hold exactly one controller");
  return controllers[0];
}

const RELEASED_POLICY = {
  schemaVersion: 2,
  status: "released",
  version: "0.1.0",
  releaseTag: "v0.1.0",
  releaseDate: "2026-07-25",
  stablePublicApi: false,
  npmPublication: "disabled"
};
const RELEASED_CITATION = 'cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-07-25"\n';
const RELEASED_CHANGELOG = "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-07-25\n";

type AttestContext = {
  runnerTemp: string;
  env: NodeJS.ProcessEnv;
  receiptPath: string;
  staticDir: string;
  contextDir: string;
  writeContext: (name: string, value: unknown) => Promise<void>;
};

/**
 * Build the exact runner state the attestation step reads: the produced receipt,
 * the built tree it describes, and the API readbacks. Everything is derived from
 * a real fixture and a real producer run, never hand-written, so a producer or
 * gate change shows up here instead of being restated.
 */
async function attestContext(t: TestContext): Promise<AttestContext> {
  const fixture = await makeFixture(t, {
    policy: RELEASED_POLICY,
    citation: RELEASED_CITATION,
    changelog: RELEASED_CHANGELOG
  });
  const produced = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.equal(produced.status, 0, produced.stderr);
  const receipt = JSON.parse(produced.stdout);

  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-attest-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const runId = "9001";
  const runAttempt = "1";
  const receiptDir = path.join(runnerTemp, "release-receipt");
  const staticDir = path.join(runnerTemp, "release-static");
  const contextDir = path.join(runnerTemp, "release-context");
  await mkdir(receiptDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `site-behavior-lab-release-${runId}-${runAttempt}.json`);
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(receiptPath, receiptBytes);
  cpSync(path.join(fixture.root, "out"), staticDir, { recursive: true });

  const writeContext = async (name: string, value: unknown) =>
    writeFile(path.join(contextDir, name), `${JSON.stringify(value)}\n`);
  // Repository files the gate reads back through the API. The required-job list
  // comes from the real repository so the job names stay in the one file
  // lib/required-ci-jobs.test.ts already pins; the rest describe the fixture.
  const writeFileContent = async (repositoryPath: string, from: string) => {
    const safe = repositoryPath.replace(/[/.]/g, "_");
    await writeContext(`content-${safe}.json`, {
      type: "file",
      encoding: "base64",
      content: (await readFile(path.join(from, repositoryPath))).toString("base64")
    });
  };
  await writeFileContent(".github/required-ci-jobs.json", ROOT);
  // Derive the rest from the receipt's own declared inputs plus the metadata
  // files the gate names directly, so a producer that starts describing another
  // input cannot leave this fixture silently short of it.
  const declaredInputs = Object.values(receipt.inputs ?? {}).map(
    (input) => (input as { path: string }).path
  );
  for (const repositoryPath of new Set([
    ...declaredInputs,
    "CHANGELOG.md",
    "CITATION.cff",
    "package-lock.json",
    "package.json",
    "release-policy.json"
  ])) {
    await writeFileContent(repositoryPath, fixture.root);
  }

  const digest = createHash("sha256").update(receiptBytes).digest("hex");
  const commitDate = new Date(
    Date.parse(git(fixture.root, ["show", "--no-patch", "--format=%cI", fixture.commit]).trim())
  );
  await writeContext("artifact.json", {
    id: 11,
    name: `site-behavior-lab-release-${runId}-${runAttempt}.json`,
    expired: false,
    size_in_bytes: Buffer.byteLength(receiptBytes),
    digest: `sha256:${digest}`,
    workflow_run: { id: Number(runId), head_sha: "b".repeat(40) }
  });
  await writeContext("static-artifact.json", {
    id: 12,
    name: `site-behavior-lab-static-${runId}-${runAttempt}`,
    expired: false,
    size_in_bytes: 4096,
    workflow_run: { id: Number(runId), head_sha: "b".repeat(40) }
  });
  await writeContext("commit.json", {
    sha: fixture.commit,
    tree: { sha: git(fixture.root, ["rev-parse", "HEAD^{tree}"]).trim() },
    // The API renders the instant without milliseconds; the receipt normalizes
    // it with them. Both spellings must be accepted.
    committer: { date: commitDate.toISOString().replace(".000Z", "Z") }
  });
  for (const branch of ["main", "production"]) {
    await writeContext(`${branch}.json`, { base_commit: { sha: fixture.commit }, status: "identical" });
  }
  const requiredJobs = JSON.parse(
    await readFile(path.join(ROOT, ".github", "required-ci-jobs.json"), "utf8")
  ) as { jobs: string[] };
  await writeContext("ci-jobs.json", [
    { jobs: requiredJobs.jobs.map((name) => ({ name, conclusion: "success" })) }
  ]);

  return {
    runnerTemp,
    receiptPath,
    staticDir,
    contextDir,
    writeContext,
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: runAttempt,
      GITHUB_SHA: "b".repeat(40),
      GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
      GITHUB_OUTPUT: path.join(runnerTemp, "github-output"),
      ARTIFACT_ID: "11",
      ARTIFACT_DIGEST: `sha256:${digest}`,
      STATIC_ARTIFACT_ID: "12",
      RELEASE_SHA: fixture.commit,
      REQUESTED_SHA: fixture.commit,
      RELEASE_VERSION: "0.1.0",
      RELEASE_TAG: "v0.1.0"
    }
  };
}

function runValidator(controller: string, context: AttestContext, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--input-type=commonjs", "-e", controller], {
    cwd: context.runnerTemp,
    env: { ...context.env, ...overrides },
    encoding: "utf8"
  });
}

test("the isolated release validator accepts one honest receipt", { skip: hostToolchainSkip }, async (t) => {
  // Executes the SAME controller text the workflow runs, against a receipt the
  // real producer built. String assertions cannot tell a gate that always
  // passes from one that never can: this repository shipped a validator that
  // could never accept anything, and no test noticed.
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));
  const context = await attestContext(t);

  const accepted = runValidator(controller, context);
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);
  assert.match(accepted.stdout, /Validated isolated release receipt sha256:[0-9a-f]{64} against \d+ independently hashed static file/);
  const output = await readFile(context.env.GITHUB_OUTPUT as string, "utf8");
  assert.match(output, /^receipt_sha256=[0-9a-f]{64}$/m);
});

test("the validator compares commit instants, not their spelling", { skip: hostToolchainSkip }, async (t) => {
  // The regression that made every release impossible: the receipt normalizes
  // the committer date with milliseconds and the API renders it without, so a
  // string equality could never hold.
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));
  const context = await attestContext(t);
  const commit = JSON.parse(await readFile(path.join(context.contextDir, "commit.json"), "utf8"));
  const instant = Date.parse(commit.committer.date);

  for (const spelling of [
    new Date(instant).toISOString(),
    new Date(instant).toISOString().replace(".000Z", "Z"),
    new Date(instant).toISOString().replace("Z", "+00:00")
  ]) {
    await context.writeContext("commit.json", { ...commit, committer: { date: spelling } });
    const run = runValidator(controller, context);
    assert.equal(run.status, 0, `${spelling} must be accepted: ${run.stderr}`);
  }

  for (const wrong of [new Date(instant + 1000).toISOString(), "not-a-date", ""]) {
    await context.writeContext("commit.json", { ...commit, committer: { date: wrong } });
    const run = runValidator(controller, context);
    assert.equal(run.status, 1, `${wrong} must be refused`);
    assert.match(run.stderr, /does not match the GitHub commit object/);
  }
});

test("the validator refuses every tampered static tree", { skip: hostToolchainSkip }, async (t) => {
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));

  const tamper = async (mutate: (staticDir: string) => Promise<void>, expected: RegExp) => {
    const context = await attestContext(t);
    await mutate(context.staticDir);
    const run = runValidator(controller, context);
    assert.equal(run.status, 1, `expected refusal, got: ${run.stdout}`);
    assert.match(run.stderr, expected);
  };

  // A byte the receipt does not describe.
  await tamper(
    async (dir) => writeFile(path.join(dir, "asset.txt"), "tampered\n"),
    /does not describe the built bytes/
  );
  // A file the build never produced.
  await tamper(
    async (dir) => writeFile(path.join(dir, "extra.txt"), "surprise\n"),
    /static file\(s\) but the build produced|does not describe the built bytes/
  );
  // A file the manifest claims but the build lacks.
  await tamper(async (dir) => rm(path.join(dir, "asset.txt")), /static file\(s\) but the build produced/);
  // A symlink, which the walk must refuse outright rather than follow.
  await tamper(async (dir) => {
    await rm(path.join(dir, "asset.txt"));
    await symlink("/etc/hostname", path.join(dir, "asset.txt"));
  }, /contain a symlink/);
  // No handoff at all.
  await tamper(async (dir) => rm(dir, { recursive: true, force: true }), /were not handed to the attestation job/);
});

test("the validator refuses wrong handoff, CI, source, and policy facts", { skip: hostToolchainSkip }, async (t) => {
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));

  const refuse = async (
    name: string,
    mutate: (context: AttestContext) => Promise<void>,
    expected: RegExp
  ) => {
    const context = await attestContext(t);
    await mutate(context);
    const run = runValidator(controller, context);
    assert.equal(run.status, 1, `${name} must be refused, got: ${run.stdout}`);
    assert.match(run.stderr, expected, name);
  };

  const artifactOf = async (context: AttestContext, file: string) =>
    JSON.parse(await readFile(path.join(context.contextDir, file), "utf8"));

  // Artifact metadata must identify this exact run, attempt, name, and SHA.
  await refuse("wrong receipt run id", async (c) => {
    const artifact = await artifactOf(c, "artifact.json");
    await c.writeContext("artifact.json", { ...artifact, workflow_run: { id: 4242, head_sha: "b".repeat(40) } });
  }, /immutable artifact metadata/);
  await refuse("wrong receipt head sha", async (c) => {
    const artifact = await artifactOf(c, "artifact.json");
    await c.writeContext("artifact.json", { ...artifact, workflow_run: { id: 9001, head_sha: "c".repeat(40) } });
  }, /immutable artifact metadata/);
  await refuse("wrong receipt artifact name", async (c) => {
    const artifact = await artifactOf(c, "artifact.json");
    await c.writeContext("artifact.json", { ...artifact, name: "site-behavior-lab-release-other.json" });
  }, /immutable artifact metadata/);
  await refuse("expired receipt artifact", async (c) => {
    const artifact = await artifactOf(c, "artifact.json");
    await c.writeContext("artifact.json", { ...artifact, expired: true });
  }, /immutable artifact metadata/);
  await refuse("wrong static artifact metadata", async (c) => {
    const artifact = await artifactOf(c, "static-artifact.json");
    await c.writeContext("static-artifact.json", { ...artifact, name: "site-behavior-lab-static-wrong" });
  }, /immutable static-artifact metadata/);

  // CI must be the trusted run with every required job green.
  await refuse("a required job missing", async (c) => {
    const jobs = await artifactOf(c, "ci-jobs.json");
    await c.writeContext("ci-jobs.json", [{ jobs: jobs[0].jobs.slice(1) }]);
  }, /did not run exactly once and conclude success/);
  await refuse("a required job failed", async (c) => {
    const jobs = await artifactOf(c, "ci-jobs.json");
    const mutated = jobs[0].jobs.map((job: { name: string }, index: number) =>
      index === 0 ? { ...job, conclusion: "failure" } : job
    );
    await c.writeContext("ci-jobs.json", [{ jobs: mutated }]);
  }, /did not run exactly once and conclude success/);

  // Source identity and branch reachability.
  await refuse("a source commit that is not the release SHA", async (c) => {
    const commit = await artifactOf(c, "commit.json");
    await c.writeContext("commit.json", { ...commit, sha: "d".repeat(40) });
  }, /does not match the GitHub commit object/);
  await refuse("a release SHA no longer on production", async (c) => {
    await c.writeContext("production.json", { base_commit: { sha: "e".repeat(40) }, status: "identical" });
  }, /no longer reachable from production/);
  await refuse("a release SHA behind main", async (c) => {
    const main = await artifactOf(c, "main.json");
    await c.writeContext("main.json", { ...main, status: "behind" });
  }, /no longer reachable from main/);

  // The receipt bytes themselves must be canonical and honest.
  await refuse("a non-canonical receipt", async (c) => {
    const receipt = JSON.parse(await readFile(c.receiptPath, "utf8"));
    await writeFile(c.receiptPath, `${JSON.stringify(receipt)}\n`);
  }, /canonical|does not match|artifact metadata/);
  await refuse("a policy that is not released", async (c) => {
    const encoded = await artifactOf(c, "content-release-policy_json.json");
    const policy = JSON.parse(Buffer.from(encoded.content, "base64").toString("utf8"));
    await c.writeContext("content-release-policy_json.json", {
      ...encoded,
      content: Buffer.from(`${JSON.stringify({ ...policy, status: "development" }, null, 2)}\n`).toString("base64")
    });
  }, /exact source|released|policy/i);
});

test("the approved-release-actor step executes as a real shell gate", { skip: hostToolchainSkip }, async () => {
  // The allowlist is shell, not JavaScript, so exercise the shell.
  const workflow = await source(".github/workflows/release.yml");
  const step = workflow.slice(workflow.indexOf("- name: Require an approved release author"));
  const body = step.slice(step.indexOf("run: |") + "run: |".length, step.indexOf("- name: Recheck branch"));
  const script = body
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");

  const run = (list: string, actor: string, triggering: string) =>
    spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, APPROVED_RELEASE_ACTORS: list, ACTOR: actor, TRIGGERING_ACTOR: triggering }
    });

  assert.equal(run("iAnonymous3000", "iAnonymous3000", "iAnonymous3000").status, 0);
  // Multi-entry lists and whitespace must survive splitting.
  assert.equal(run("alice,bob", "bob", "bob").status, 0);
  assert.equal(run(" alice , bob ", "alice", "alice").status, 0);
  // Divergent identities, unknown actors, and an empty list all refuse.
  assert.equal(run("alice,bob", "alice", "bob").status, 1);
  assert.equal(run("alice", "mallory", "mallory").status, 1);
  assert.equal(run("", "alice", "alice").status, 1);
});
