import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runFixtureGit } from "./git-fixture";
import { receiptFollowingCandidateCitationViolation } from "./measurement-candidate-binding";

const ROOT = process.cwd();
const RELEASE_SCRIPT = path.join(ROOT, "scripts", "release-evidence.mjs");
const PROVENANCE_SCRIPT = path.join(ROOT, "scripts", "static-deployment-provenance.mjs");

const hasArchivedReleaseReceipt = (version: string): boolean =>
  existsSync(path.join(ROOT, "docs", "release-receipts", version, "release-receipt.json"));

type StaticDeploymentProvenance = {
  buildDeploymentReceipt(
    commit: string,
    options?: { cwd?: string }
  ): { schemaVersion: number; deployment: string; revisionCommittedAt: string };
};

/** The receipt producer itself, so fixtures never restate the published shape. */
const staticDeploymentProvenance = (): Promise<StaticDeploymentProvenance> =>
  import(PROVENANCE_SCRIPT) as Promise<StaticDeploymentProvenance>;

type ReleaseEvidenceModule = {
  selectCitedReceiptedVersion(receiptedVersions: string[], policyVersion: string): string | null;
};

/** The release producer itself, so expectations never restate its selection rule. */
const releaseEvidenceModule = (): Promise<ReleaseEvidenceModule> =>
  import(RELEASE_SCRIPT) as Promise<ReleaseEvidenceModule>;

/**
 * The one receipt-following citation contract, executed against any repo-shaped
 * tree. CITATION.cff must cite exactly the release the producer's own exported
 * selector picks from the archived receipts, with that receipt's recorded
 * date, in the development state as well as the released one; the changelog's
 * dated section still follows the POLICY, because the declaration is what
 * moves it. The repository-state test and the fixture pair-test both run this
 * helper, and the pair-test runs the real producer against the identical tree,
 * so the unit expectation and scripts/release-evidence.mjs can only move
 * together.
 */
async function assertReceiptFollowingCitation(root: string): Promise<void> {
  const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8")) as {
    status: string;
    version: string;
    releaseDate: string | null;
  };
  const citation = await readFile(path.join(root, "CITATION.cff"), "utf8");
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const receiptsDir = path.join(root, "docs", "release-receipts");
  const { selectCitedReceiptedVersion } = await releaseEvidenceModule();
  const receipted = readdirSync(receiptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(receiptsDir, name, "release-receipt.json")));
  const expectedCited = selectCitedReceiptedVersion(receipted, policy.version);
  assert.ok(expectedCited, "at least one archived release receipt must exist to cite");
  const citedVersions = [...citation.matchAll(/^version: "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(
    citedVersions,
    [expectedCited],
    `CITATION.cff must cite exactly the most recent receipted release (${expectedCited})`
  );
  const receipt = JSON.parse(
    readFileSync(path.join(receiptsDir, expectedCited, "release-receipt.json"), "utf8")
  ) as { releaseDate?: string; release?: { releaseDate?: string } };
  const expectedDate = receipt.releaseDate ?? receipt.release?.releaseDate;
  assert.match(
    expectedDate ?? "",
    /^\d{4}-\d{2}-\d{2}$/,
    `the archived receipt for ${expectedCited} must carry a usable release date`
  );
  const citedDates = [...citation.matchAll(/^date-released: "(\d{4}-\d{2}-\d{2})"$/gm)].map(
    (match) => match[1]
  );
  assert.deepEqual(
    citedDates,
    [expectedDate],
    "CITATION.cff must carry exactly the cited receipt's recorded release date, in development too"
  );
  // Ongoing work always has a home, in either state.
  assert.equal((changelog.match(/^## Unreleased$/gm) ?? []).length, 1);
  const datedForVersion = new RegExp(
    `^## \\[?${policy.version.replace(/\./g, "\\.")}\\]?\\s+-\\s*(\\d{4}-\\d{2}-\\d{2})$`,
    "m"
  );
  if (policy.status === "released") {
    const dated = changelog.match(datedForVersion);
    assert.notEqual(dated, null, "a released changelog must carry its dated section");
    assert.equal(dated![1], policy.releaseDate);
  } else {
    assert.doesNotMatch(changelog, datedForVersion);
  }
}

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

test("repository metadata truthfully describes the governed 0.x and exact 1.0 lines", async () => {
  const manifest = JSON.parse(await source("package.json"));
  const lock = JSON.parse(await source("package-lock.json"));
  const policy = JSON.parse(await source("release-policy.json"));
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
  // CITATION.cff tracks the last version that actually EXISTS as a tagged,
  // receipted release, not the declared one. Coupling it to policy.version
  // forced a standalone overclaim during the declare-then-tag window: citation
  // tooling reads this file alone, without RELEASE.md's sequence or this
  // policy, so it would assert a release date for a version with no tag and no
  // receipt. It catches up once the receipt is archived. The expectation is
  // the same helper the fixture pair-test runs together with the real
  // producer, and it selects through the producer's own exported rule, so
  // this test can no longer hold a private contract the producer refuses:
  // its old development branch demanded NO date-released line while the
  // producer demanded the receipted date unconditionally, which would have
  // made CI unsatisfiable on the first routine flip to status development.
  await assertReceiptFollowingCitation(ROOT);
  assert.match(releaseGuide, /RELEASE_MEASUREMENT_BINDING_SHA256/);
  assert.match(
    releaseGuide,
    /authorized maintainer may set or\s+rotate it \*\*only after\*\* independently verifying/
  );
  assert.match(
    releaseGuide,
    /digest printed by candidate CI[\s\S]*is not sufficient authority/
  );
  assert.equal(manifest.scripts["release:evidence"], "node scripts/release-evidence.mjs");
  assert.match(
    releaseGuide,
    /governed 0\.x development line[\s\S]*exact 1\.0\.0 line/
  );
  // The guide names the current release and its archived receipt, and keeps
  // the one recorded tag-ceremony failure WITH its completed recovery: the
  // old pin here required "the tag does not exist", which locked the stale
  // pre-recovery narrative in place after v0.4.0-rc.1 and v0.4.0 were tagged.
  assert.match(
    releaseGuide,
    /The current release is `v0\.4\.0`[\s\S]*docs\/release-receipts\/0\.4\.0\/release-receipt\.json/
  );
  assert.match(
    releaseGuide,
    /30653749957[\s\S]*HTTP 403[\s\S]*fresh dispatch from\s+the updated `main` workflow/
  );
  assert.match(
    releaseGuide,
    /A failed dispatch is never approved or\s+rerun; the ceremony restarts from `main`\./
  );
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
    /Playwright base[\s\S]*Node 24\.18\.1 with npm 11\.16\.0[\s\S]*intentionally distinct/
  );
  assert.match(releaseGuide, /Preview deployments[\s\S]*remained public by default/);
  assert.match(
    releaseGuide,
    /attestation subjects are the two receipt JSON files and the[\s\S]*canonical container package inventory[\s\S]*not the[\s\S]*Cloudflare deployment/
  );
  assert.match(
    releaseGuide,
    /first[\s\S]*live `main` CI attestation receipt and independent readback[\s\S]*external proof gate/i
  );
  assert.match(
    releaseGuide,
    /private key[\s\S]*\*\*only\*\* as the `RELEASE_APP_PRIVATE_KEY` secret on the `release-tag`[\s\S]*no repository- or organization-scoped secret/
  );
  assert.match(
    releaseGuide,
    /do\s+not\s+configure a legacy `RELEASE_APP_ID` fallback/
  );
  assert.match(
    releaseGuide,
    /After any change to `\.github\/workflows\/release\.yml`, start a \*\*fresh[\s\S]*workflow dispatch\*\*/
  );
  assert.match(releaseGuide, /re-run the \*\*failed tag job only\*\*, not all jobs/);
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
    /RUN test "\$\(node --version\)" = "v24\.18\.1" \\\n\s+&& test "\$\(npm --version\)" = "11\.16\.0"/
  );

  const app = workflow.slice(workflow.indexOf("\n  pages:"), workflow.indexOf("\n  smoke:"));
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

test("release evidence explicitly binds one selected governance receipt", { skip: hostToolchainSkip }, async (t) => {
  const fixture = await makeFixture(t);
  const governanceDigest = "a".repeat(64);
  const result = runEvidence(fixture.root, [
    "--static-dir",
    "out",
    "--release-tag-governance-receipt-sha256",
    governanceDigest
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.releaseTagGovernanceReceiptSha256, governanceDigest);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "artifacts",
    "evidenceKind",
    "inputs",
    "release",
    "releaseTagGovernanceReceiptSha256",
    "schemaVersion",
    "source"
  ]);

  const malformed = runEvidence(fixture.root, [
    "--static-dir",
    "out",
    "--release-tag-governance-receipt-sha256",
    "A".repeat(64)
  ]);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /must be one lowercase sha256/);
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
    process.stdout.write((process.env.FIXTURE_CONTAINER_NODE || "v24.18.1") + "\\n");
    process.exit(0);
  }
  if (entrypoint === "--entrypoint=npm") {
    if (process.env.FIXTURE_CONTAINER_NPM) {
      process.stdout.write(process.env.FIXTURE_CONTAINER_NPM + "\\n");
      process.exit(0);
    }
    if (process.env.FIXTURE_NPM_PROBE_EXIT) {
      if (process.env.FIXTURE_NPM_PROBE_STDERR) process.stderr.write(process.env.FIXTURE_NPM_PROBE_STDERR + "\\n");
      process.exit(Number(process.env.FIXTURE_NPM_PROBE_EXIT));
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
      node: "24.18.1",
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
  assert.match(wrongRuntime.stderr, /requires node 24\.18\.1, not v24\.19\.0/);

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

  // "absent" is an ATTESTED supply-chain claim, so only docker's own
  // executable-not-found answer may produce it. The probe used to catch every
  // throw and return "absent", so a timeout, an OOM kill, or npm failing to
  // create $HOME/.npm under --read-only published the same assurance as a real
  // not-found -- an image that had started shipping npm again would still be
  // attested clean.
  for (const [label, exitCode, stderrText] of [
    ["a bare 127 with no not-found text", "127", ""],
    ["an OOM-killed container", "137", "container killed"],
    ["a read-only cache failure", "243", "EROFS: read-only file system"]
  ] as const) {
    const inconclusive = runEvidence(
      fixture.root,
      ["--container-image", "site-behavior-lab:smoke"],
      {
        DOCKER_BIN: docker,
        FIXTURE_COMMIT: fixture.commit,
        FIXTURE_NPM_PROBE_EXIT: exitCode,
        ...(stderrText ? { FIXTURE_NPM_PROBE_STDERR: stderrText } : {})
      }
    );
    assert.notEqual(inconclusive.status, 0, label);
    assert.match(inconclusive.stderr, /package-manager probe was inconclusive/, label);
    assert.doesNotMatch(inconclusive.stderr, /"npm": *"absent"/, label);
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
  if (entrypoint === "--entrypoint=node") process.stdout.write("v24.18.1\\n");
  else if (entrypoint === "--entrypoint=npm") {
    // Docker's own not-found answer. A bare 127 with no stderr is now treated
    // as inconclusive, because "absent" is an attested supply-chain claim and
    // any other non-zero exit (timeout, OOM kill, read-only cache failure) must
    // not be published as proof the image ships no package manager.
    process.stderr.write("exec: \\"npm\\": executable file not found\\n");
    process.exit(127);
  }
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
    /**
     * The release the fixture has an archived receipt for.
     *
     * CITATION.cff is checked against the most recent RECEIPTED release, not
     * the declared one, so every fixture needs a receipt the way a real
     * repository always has one. Defaults to the citation's own version so the
     * common case is consistent without each test restating it.
     */
    receiptedVersion?: string | null;
    receiptedDate?: string;
    /**
     * Extra archived receipts beyond the primary one, for selection-order
     * cases (a stable receipt beside an rc receipt, a closed rc line beside
     * its final stable release).
     */
    additionalReceipts?: Array<{ version: string; date: string }>;
  } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-release-evidence-"));
  // A real repository always carries at least one archived receipt, and the
  // citation coupling reads it. Pass receiptedVersion: null to build the
  // no-receipt tree deliberately.
  const receiptedVersion =
    options.receiptedVersion === undefined ? options.packageVersion ?? "0.1.0" : options.receiptedVersion;
  // Default the receipt's date to the fixture's own declared release date, so a
  // test that supplies a released policy and a matching CITATION stays
  // self-consistent without restating the date a third time.
  const policyReleaseDate =
    typeof options.policy?.releaseDate === "string" ? options.policy.releaseDate : null;
  const receiptedDate = options.receiptedDate ?? policyReleaseDate ?? "2026-01-01";
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
    options.citation ??
      `cff-version: 1.2.0\nversion: "${receiptedVersion ?? "0.1.0"}"\ndate-released: "${receiptedDate}"\n`
  );
  await writeFile(path.join(root, "CHANGELOG.md"), options.changelog ?? "# Changelog\n\n## Unreleased\n");
  const receipts = [
    ...(receiptedVersion === null ? [] : [{ version: receiptedVersion, date: receiptedDate }]),
    ...(options.additionalReceipts ?? [])
  ];
  for (const receipt of receipts) {
    await mkdir(path.join(root, "docs", "release-receipts", receipt.version), { recursive: true });
    await writeFile(
      path.join(root, "docs", "release-receipts", receipt.version, "release-receipt.json"),
      `${JSON.stringify({
        version: receipt.version,
        releaseDate: receipt.date,
        artifacts: []
      })}\n`
    );
  }
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
  return runFixtureGit(cwd, args);
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
  assert.match(prepare, /npm run release:readiness:check/);
  assert.match(
    prepare,
    /name: Prefetch immutable measurement-freeze evidence for release 1\.0\n\s+id: freeze_context/
  );
  assert.match(
    prepare,
    /GH_TOKEN: \$\{\{ github\.token \}\}[\s\S]*artifacts-pages\.json[\s\S]*artifact\.json[\s\S]*artifact\.zip/
  );
  for (const bound of [
    "run.json:1048576",
    "artifacts-pages.json:4194304",
    "artifact.json:1048576",
    "artifact.zip:1048576"
  ]) {
    assert.match(prepare, new RegExp(bound.replace(".", "\\.")));
  }
  const freezeArtifactMetadataGuard = prepare.indexOf(
    "value.size_in_bytes <= 1024 * 1024"
  );
  const freezeArtifactDownload = prepare.indexOf(
    '"repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip"'
  );
  assert.ok(
    freezeArtifactMetadataGuard !== -1 &&
      freezeArtifactDownload !== -1 &&
      freezeArtifactMetadataGuard < freezeArtifactDownload,
    "the trusted prefetch must reject oversized artifact metadata before downloading the ZIP"
  );
  assert.match(prepare, /value\.expired === false/);
  assert.match(prepare, /value\.workflow_run\?\.id === runId/);
  assert.match(prepare, /value\.workflow_run\?\.head_sha === candidate/);
  assert.match(
    prepare,
    /const files = \[\s+"artifact\.json",\s+"artifact\.zip",\s+"artifacts-pages\.json",\s+"run\.json"\s+\]/
  );
  assert.match(
    prepare,
    /site-behavior-lab-measurement-freeze-artifact-context-v1\\0/
  );
  assert.match(
    prepare,
    /context_sha256=\$\{digest\.digest\("hex"\)\}\\n/
  );
  assert.match(
    prepare,
    /SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256: \$\{\{ steps\.freeze_context\.outputs\.context_sha256 \}\}/
  );
  assert.match(
    prepare,
    /governance_receipt_sha256: \$\{\{ steps\.governance_selector\.outputs\.receipt_sha256 \}\}/
  );
  assert.match(
    prepare,
    /measurement_binding_required: \$\{\{ steps\.measurement_binding_policy\.outputs\.binding_required \}\}/
  );
  assert.match(
    prepare,
    /measurement_binding_sha256: \$\{\{ steps\.measurement_binding_policy\.outputs\.binding_sha256 \}\}/
  );
  const governanceSnapshot = prepare.slice(
    prepare.indexOf("- name: Snapshot external release trust roots"),
    prepare.indexOf("- name: Checkout full history without persisted credentials")
  );
  assert.ok(
    prepare.indexOf("- name: Snapshot external release trust roots") <
      prepare.indexOf("- name: Checkout full history without persisted credentials"),
    "external trust roots must be snapshotted before checkout or package execution"
  );
  assert.match(
    governanceSnapshot,
    /SELECTED_GOVERNANCE_RECEIPT_SHA256: \$\{\{ vars\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 \}\}/
  );
  assert.match(
    governanceSnapshot,
    /SELECTED_MEASUREMENT_BINDING_SHA256: \$\{\{ vars\.RELEASE_MEASUREMENT_BINDING_SHA256 \}\}/
  );
  assert.match(governanceSnapshot, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(
    governanceSnapshot,
    /printf 'receipt_sha256=%s\\n' "\$SELECTED_GOVERNANCE_RECEIPT_SHA256" >> "\$GITHUB_OUTPUT"/
  );
  assert.doesNotMatch(governanceSnapshot, /GH_TOKEN|gh api|actions\/variables/);
  assert.equal(
    (workflow.match(/\$\{\{ vars\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 \}\}/g) ?? []).length,
    1,
    "the governance selector must be evaluated exactly once"
  );
  assert.equal(
    (workflow.match(/\$\{\{ vars\.RELEASE_MEASUREMENT_BINDING_SHA256 \}\}/g) ?? []).length,
    1,
    "the external whole-binding pin must be evaluated exactly once"
  );
  assert.doesNotMatch(
    prepare.slice(0, prepare.indexOf("steps:")),
    /\benvironment:/,
    "prepare must not enter an environment before snapshotting external trust roots"
  );
  const bindingPolicy = prepare.slice(
    prepare.indexOf("- name: Classify the release measurement-binding requirement"),
    prepare.indexOf("- name: Verify the release policy names exactly this version")
  );
  assert.match(bindingPolicy, /binding_required=true/);
  assert.match(bindingPolicy, /binding_required=false/);
  assert.match(bindingPolicy, /binding_sha256=not-required/);
  assert.match(bindingPolicy, /SNAPSHOTTED_MEASUREMENT_BINDING_SHA256/);
  assert.doesNotMatch(bindingPolicy, /vars\.RELEASE_MEASUREMENT_BINDING_SHA256/);
  assert.match(
    prepare,
    /SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT=\$\{context\}" >> "\$GITHUB_ENV"/
  );
  assert.match(
    prepare,
    /npm run release:readiness:check -- \\\n\s+--live-artifact-context "\$RUNNER_TEMP\/measurement-freeze-artifact-context"/
  );
  assert.match(
    prepare,
    /--live-artifact-context-sha256 "\$SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256"/
  );
  assert.ok(
    prepare.indexOf(
      "Prefetch immutable measurement-freeze evidence for release 1.0"
    ) <
      prepare.indexOf(
        "Verify every required CI job without an API token"
      ),
    "workflow-owned API prefetch must finish before the candidate no-token boundary"
  );
  assert.match(prepare, /npx playwright install --with-deps chromium/);
  assert.match(prepare, /npm run build:pages/);
  assert.match(prepare, /npm run test:smoke:static/);
  assert.ok(
    prepare.indexOf("npm ci") <
      prepare.indexOf("npm run release:readiness:check"),
    "release 1.0 readiness must run after the locked dependency install"
  );
  assert.ok(
    prepare.indexOf("npm run release:readiness:check") <
      prepare.indexOf("npx playwright install --with-deps chromium"),
    "release 1.0 readiness must refuse before browser installation and artifact handoff"
  );
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
  assert.match(
    prepare,
    /--release-tag-governance-receipt-sha256 "\$RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256"/
  );
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
  assert.match(
    attest,
    /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: \$\{\{ needs\.prepare\.outputs\.governance_receipt_sha256 \}\}/
  );
  assert.doesNotMatch(attest, /actions\/variables\/RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/);
  assert.match(attest, /receipt\.schemaVersion !== 2/);
  assert.match(
    attest,
    /receipt\.releaseTagGovernanceReceiptSha256 !==\s*process\.env\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/
  );

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
  // The exact reviewed action revision, not any 40-hex SHA: a shape-only pin
  // would bless a swapped, unreviewed attest action that kept the comment.
  assert.match(attest, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);

  // Tag authority is smaller still: the native workflow token stays read-only
  // and a separately configured release App mints the one contents-write token
  // only inside the environment-gated job. It creates, never updates, the
  // annotated tag through GitHub's Git database API.
  assert.match(tag, /needs:\n\s+- prepare\n\s+- attest/);
  assert.match(tag, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(tag, /actions:|id-token:|attestations:|artifact-metadata:/);
  assert.doesNotMatch(tag, /actions\/checkout|actions\/setup-node|npm (?:ci|run)|node_modules|uses: \.\//);
  assert.doesNotMatch(tag, /git fetch|git checkout|git tag|git push|--method PATCH|force\s*[:=]\s*true/);
  assert.doesNotMatch(tag, /actions\/variables\/RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/);
  assert.doesNotMatch(tag, /\$\{\{ vars\.RELEASE_MEASUREMENT_BINDING_SHA256 \}\}/);
  const measurementTrustRoot = tag.slice(
    tag.indexOf("- name: Verify external measurement-binding trust root before release authority"),
    tag.indexOf("- name: Require dedicated release App configuration")
  );
  assert.match(
    measurementTrustRoot,
    /GH_TOKEN: \$\{\{ github\.token \}\}/
  );
  assert.match(
    measurementTrustRoot,
    /RELEASE_MEASUREMENT_BINDING_REQUIRED: \$\{\{ needs\.prepare\.outputs\.measurement_binding_required \}\}/
  );
  assert.match(
    measurementTrustRoot,
    /RELEASE_MEASUREMENT_BINDING_SHA256: \$\{\{ needs\.prepare\.outputs\.measurement_binding_sha256 \}\}/
  );
  assert.match(
    measurementTrustRoot,
    /contents\/\$\{release_binding_path\}\?ref=\$\{RELEASE_SHA\}/
  );
  assert.match(measurementTrustRoot, /createHash\("sha256"\)\.update\(raw\)/);
  assert.match(measurementTrustRoot, /JSON\.stringify\(binding, null, 2\)/);
  assert.match(measurementTrustRoot, /topLevelKeys/);
  assert.match(measurementTrustRoot, /governanceRows\.length !== 1/);
  assert.match(measurementTrustRoot, /candidate-commit\.json/);
  assert.match(measurementTrustRoot, /candidate-to-release\.json/);
  assert.doesNotMatch(measurementTrustRoot, /secrets\.|release_app_token|npm (?:ci|run)|actions\/checkout/);
  assert.ok(
    tag.indexOf("Verify external measurement-binding trust root before release authority") <
      tag.indexOf("Mint dedicated release App token"),
    "raw binding authentication must finish before release authority is minted"
  );
  assert.match(tag, /name: Require dedicated release App configuration/);
  const releaseAppConfiguration = tag.slice(
    tag.indexOf("- name: Require dedicated release App configuration"),
    tag.indexOf("- name: Mint dedicated release App token")
  );
  assert.match(
    releaseAppConfiguration,
    /RELEASE_APP_CLIENT_ID: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /RELEASE_APP_INTEGRATION_ID: \$\{\{ vars\.RELEASE_APP_INTEGRATION_ID \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /RELEASE_TAG_CREATION_RULESET_ID: \$\{\{ vars\.RELEASE_TAG_CREATION_RULESET_ID \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: \$\{\{ needs\.prepare\.outputs\.governance_receipt_sha256 \}\}/
  );
  assert.doesNotMatch(
    tag,
    /RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: \$\{\{ vars\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 \}\}/
  );
  assert.match(tag, /RELEASE_APP_PRIVATE_KEY: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/);
  assert.match(
    releaseAppConfiguration,
    /PROMOTION_APP_CLIENT_ID: \$\{\{ vars\.PROMOTION_APP_CLIENT_ID \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /PROMOTION_APP_INTEGRATION_ID: \$\{\{ vars\.PROMOTION_APP_INTEGRATION_ID \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /PROMOTION_APP_SLUG: \$\{\{ vars\.PROMOTION_APP_SLUG \}\}/
  );
  assert.match(
    releaseAppConfiguration,
    /"\$RELEASE_APP_CLIENT_ID" == "\$PROMOTION_APP_CLIENT_ID"/
  );
  assert.match(releaseAppConfiguration, /release App must be distinct from the production promotion App/i);
  assert.doesNotMatch(releaseAppConfiguration, /PROMOTION_APP_PRIVATE_KEY/);
  assert.match(
    tag,
    /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0/
  );
  assert.match(tag, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(tag, /RELEASE_APP_ID/);
  assert.match(tag, /private-key: \$\{\{ secrets\.RELEASE_APP_PRIVATE_KEY \}\}/);
  assert.match(tag, /permission-contents: write/);
  assert.doesNotMatch(tag, /permission-administration|Administration:\s*write/);
  const tokenMint = tag.slice(
    tag.indexOf("- name: Mint dedicated release App token"),
    tag.indexOf("- name: Verify pinned tag and production governance")
  );
  assert.doesNotMatch(tokenMint, /PROMOTION_APP/);
  assert.doesNotMatch(
    tokenMint,
    /^\s+(?:owner|repositories):/m,
    "the pinned action's default must keep the release token scoped to this repository"
  );
  const governanceReadback = tag.slice(
    tag.indexOf("- name: Verify pinned tag and production governance"),
    tag.indexOf("- name: Create the annotated release tag atomically through the Git database API")
  );
  assert.match(
    governanceReadback,
    /GH_TOKEN: \$\{\{ steps\.release_app_token\.outputs\.token \}\}/
  );
  assert.match(
    governanceReadback,
    /RELEASE_APP_SLUG: \$\{\{ steps\.release_app_token\.outputs\.app-slug \}\}/
  );
  assert.match(governanceReadback, /apps\/\$\{RELEASE_APP_SLUG\}/);
  assert.match(
    governanceReadback,
    /contents\/research\/ops-receipts\/release-tag-governance\/\$\{RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256\}\.json\?ref=\$\{RELEASE_SHA\}/
  );
  assert.match(
    governanceReadback,
    /contents\/RELEASE_READINESS\.json\?ref=\$\{RELEASE_SHA\}/
  );
  assert.doesNotMatch(governanceReadback, /contents\/research\/measurement-candidate-binding\.json/);
  assert.match(governanceReadback, /release-measurement-binding/);
  assert.match(governanceReadback, /bindingDigest !==/);
  assert.match(governanceReadback, /github-actions-prepare-snapshot/);
  assert.match(governanceReadback, /release-tag-governance-receipt/);
  assert.match(governanceReadback, /selectedBindingEntries\.length !== 1/);
  assert.doesNotMatch(governanceReadback, /governanceGate\?\.sha256/);
  assert.match(
    governanceReadback,
    /receiptDigest !==\s*process\.env\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256/
  );
  assert.match(governanceReadback, /site-behavior-release-tag-governance-setup/);
  assert.match(governanceReadback, /canonicalJson\(live\) !==\s*canonicalJson\(receiptPublicProjection\(pinned\)\)/);
  assert.match(governanceReadback, /pinned\.updatedAt/);
  for (const rulesetId of ["20050122", "20050303", "20050309"]) {
    assert.match(
      governanceReadback,
      new RegExp(`rulesets/${rulesetId}`)
    );
  }
  assert.match(governanceReadback, /refs\/tags\/v\*/);
  assert.match(governanceReadback, /JSON\.stringify\(\["deletion", "update"\]\)/);
  assert.match(governanceReadback, /creation\.bypassActors\.length !== 1/);
  assert.match(governanceReadback, /actorType !== "Integration"/);
  assert.match(governanceReadback, /bypassMode !== "always"/);
  assert.match(governanceReadback, /The release App must not bypass the \$\{name\} ruleset/);
  const tagCreation = tag.slice(
    tag.indexOf("- name: Create the annotated release tag atomically through the Git database API"),
    tag.indexOf("- name: Record the release in the run summary")
  );
  assert.match(tagCreation, /GH_TOKEN: \$\{\{ steps\.release_app_token\.outputs\.token \}\}/);
  assert.doesNotMatch(tagCreation, /github\.token/);
  assert.match(
    tagCreation,
    /GITHUB_RUN_ATTEMPT" == "1" && "\$preflight_status" != "404"/
  );
  assert.match(tagCreation, /--write-out "%\{http_code\}"/);
  assert.match(tagCreation, /"\$create_status" == "201"/);
  assert.match(tagCreation, /"\$create_status" == "422"/);
  assert.match(tagCreation, /response\.message === "Reference already exists"/);
  assert.match(tagCreation, /only exact HTTP 422 Reference already exists may enter reconciliation/);
  assert.match(tagCreation, /Release workflow run: https:\/\/github\.com\/\$\{process\.env\.GITHUB_REPOSITORY\}\/actions\/runs\/\$\{process\.env\.GITHUB_RUN_ID\}/);
  assert.match(
    tagCreation,
    /Release governance receipt sha256: \$\{process\.env\.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256\}/
  );
  assert.match(
    tagCreation,
    /Release measurement binding required: \$\{process\.env\.RELEASE_MEASUREMENT_BINDING_REQUIRED\}/
  );
  assert.match(
    tagCreation,
    /Release measurement binding sha256: \$\{process\.env\.RELEASE_MEASUREMENT_BINDING_SHA256\}/
  );
  assert.match(tagCreation, /repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(tagCreation, /ref\?\.object\?\.type !== "tag"/);
  assert.match(tagCreation, /actual\?\.object\?\.type !== expected\.type/);
  assert.match(tagCreation, /actual\?\.object\?\.sha !== expected\.object/);
  assert.match(tagCreation, /actual\?\.message !== expected\.message/);
  assert.match(tagCreation, /Reconciled exact existing annotated tag/);
  assert.doesNotMatch(
    tagCreation,
    /steps\.release_app_token\.outputs\.token\s*\|\|/,
    "tag publication must not fall back when the release App cannot mint a token"
  );
  assert.ok(
    tag.indexOf("Require an approved release author") <
      tag.indexOf("Require dedicated release App configuration") &&
      tag.indexOf("Recheck branch reachability immediately before publication") <
        tag.indexOf("Require dedicated release App configuration") &&
      tag.indexOf("Require dedicated release App configuration") <
        tag.indexOf("Mint dedicated release App token") &&
      tag.indexOf("Mint dedicated release App token") <
        tag.indexOf("Verify pinned tag and production governance") &&
      tag.indexOf("Verify pinned tag and production governance") <
        tag.indexOf("- name: Create the annotated release tag atomically through the Git database API"),
    "release authority must be minted only after every non-secret authorization check"
  );
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
  assert.match(workflow, /no blanket stable public API and no npm publication/i);
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

  // The governed widening is deliberately narrow: exact 1.0.0 and numbered
  // 1.0.0 release candidates use the same disabled API/npm claims.
  for (const version of ["1.0.0-rc.1", "1.0.0"]) {
    const v1 = await makeFixture(t, {
      policy: releasedPolicy({ version, releaseTag: `v${version}` }),
      packageVersion: version,
      citation: citation.replace('"0.1.0"', `"${version}"`),
      changelog: changelog.replace("[0.1.0]", `[${version}]`)
    });
    const v1Accepted = runEvidence(v1.root, ["--static-dir", "out"]);
    assert.equal(v1Accepted.status, 0, v1Accepted.stderr);
    assert.equal(JSON.parse(v1Accepted.stdout).release.tag, `v${version}`);
  }

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
    [{ version: "1.0.1", releaseTag: "v1.0.1" }, /supported 0\.x or exact 1\.0 semantic version/],
    [{ version: "1.0.0-rc.0", releaseTag: "v1.0.0-rc.0" }, /supported 0\.x or exact 1\.0 semantic version/],
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

  // The dated evidence must agree with the RECEIPT, in both files.
  //
  // This previously required CITATION.cff to carry the POLICY's release date,
  // which is what made the standalone overclaim mandatory: a version declared
  // but not yet tagged or receipted had to be cited as released. Citation
  // tooling reads this file alone and never sees the declare-then-tag window.
  const wrongCitation = await makeFixture(t, {
    policy: releasedPolicy(),
    citation: 'cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-01-01"\n',
    changelog
  });
  const citationRefused = runEvidence(wrongCitation.root, ["--static-dir", "out"]);
  assert.notEqual(citationRefused.status, 0);
  assert.match(citationRefused.stderr, /CITATION\.cff must carry the receipted release date/);

  // And the inverse, which is the defect this replaced: citing a version that
  // is declared but has no receipt must be refused, not required.
  const declaredButUnreceipted = await makeFixture(t, {
    policy: releasedPolicy({ version: "0.2.0", releaseTag: "v0.2.0" }),
    packageVersion: "0.2.0",
    receiptedVersion: "0.1.0",
    receiptedDate: "2026-07-25",
    citation: 'cff-version: 1.2.0\nversion: "0.2.0"\ndate-released: "2026-07-25"\n',
    changelog: changelog.replace("[0.1.0]", "[0.2.0]")
  });
  const unreceiptedRefused = runEvidence(declaredButUnreceipted.root, ["--static-dir", "out"]);
  assert.notEqual(unreceiptedRefused.status, 0, "citing an unreceipted version must be refused");
  assert.match(
    unreceiptedRefused.stderr,
    /must declare the most recent receipted release \(0\.1\.0\), not the declared version 0\.2\.0/
  );

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

test("the cited release follows the receipts through rc rehearsals and their close", { skip: hostToolchainSkip }, async (t) => {
  const releasedPolicy = (version: string, releaseDate: string) => ({
    schemaVersion: 2,
    status: "released",
    version,
    releaseTag: `v${version}`,
    releaseDate,
    stablePublicApi: false,
    npmPublication: "disabled"
  });
  const cite = (version: string, date: string) =>
    `cff-version: 1.2.0\nversion: "${version}"\ndate-released: "${date}"\n`;
  const log = (version: string, date: string) =>
    `# Changelog\n\n## Unreleased\n\n## [${version}] - ${date}\n`;

  // The four receipt states a governed line passes through. The producer used
  // to prefer stable receipts unconditionally, so an rc rehearsal whose own
  // receipt was archived while the policy still named it (the recorded
  // 0.4.0-rc.1 state, required again before 1.0) could not cite anything the
  // repository-state guard would also accept.
  type MatrixState = {
    name: string;
    options: Parameters<typeof makeFixture>[1] & {
      policy: { version: string };
      receiptedVersion: string;
    };
    expectedCited: string;
    wrongCitation: string;
  };
  const states: MatrixState[] = [
    {
      // The ordinary ceremony window: 0.2.0 declared, only 0.1.0 receipted.
      name: "stable-only",
      options: {
        policy: releasedPolicy("0.2.0", "2026-02-10"),
        packageVersion: "0.2.0",
        receiptedVersion: "0.1.0",
        receiptedDate: "2026-01-01",
        citation: cite("0.1.0", "2026-01-01"),
        changelog: log("0.2.0", "2026-02-10")
      },
      expectedCited: "0.1.0",
      // Citing the declared-but-unreceipted version is the old overclaim.
      wrongCitation: cite("0.2.0", "2026-02-10")
    },
    {
      // A project whose only receipt is a candidate cites the candidate.
      name: "rc-only",
      options: {
        policy: releasedPolicy("0.2.0", "2026-02-10"),
        packageVersion: "0.2.0",
        receiptedVersion: "0.1.0-rc.1",
        receiptedDate: "2026-01-02",
        citation: cite("0.1.0-rc.1", "2026-01-02"),
        changelog: log("0.2.0", "2026-02-10")
      },
      expectedCited: "0.1.0-rc.1",
      wrongCitation: cite("0.2.0", "2026-02-10")
    },
    {
      // The rehearsal state: the policy names the rc, its receipt is archived,
      // and an older stable receipt exists beside it. The rc is the release
      // that happened, so it is what gets cited; the stable-first rule made
      // this state satisfy neither the producer nor the repository guard.
      name: "rc-receipted-as-policy",
      options: {
        policy: releasedPolicy("0.2.0-rc.1", "2026-02-01"),
        packageVersion: "0.2.0-rc.1",
        receiptedVersion: "0.2.0-rc.1",
        receiptedDate: "2026-02-01",
        additionalReceipts: [{ version: "0.1.0", date: "2026-01-01" }],
        citation: cite("0.2.0-rc.1", "2026-02-01"),
        changelog: log("0.2.0-rc.1", "2026-02-01")
      },
      expectedCited: "0.2.0-rc.1",
      // The stable-first answer, which the fix retires.
      wrongCitation: cite("0.1.0", "2026-01-01")
    },
    {
      // The rc line closed: the final stable release is receipted and cited.
      name: "post-close-stable",
      options: {
        policy: releasedPolicy("0.2.0", "2026-02-10"),
        packageVersion: "0.2.0",
        receiptedVersion: "0.2.0",
        receiptedDate: "2026-02-10",
        additionalReceipts: [{ version: "0.2.0-rc.1", date: "2026-02-01" }],
        citation: cite("0.2.0", "2026-02-10"),
        changelog: log("0.2.0", "2026-02-10")
      },
      expectedCited: "0.2.0",
      wrongCitation: cite("0.2.0-rc.1", "2026-02-01")
    }
  ];

  const { selectCitedReceiptedVersion } = await releaseEvidenceModule();
  for (const state of states) {
    const receiptedVersions = [
      state.options.receiptedVersion,
      ...(state.options.additionalReceipts ?? []).map((receipt) => receipt.version)
    ];
    assert.equal(
      selectCitedReceiptedVersion(receiptedVersions, state.options.policy.version),
      state.expectedCited,
      state.name
    );

    const fixture = await makeFixture(t, state.options);
    await assertReceiptFollowingCitation(fixture.root);
    const accepted = runEvidence(fixture.root, ["--static-dir", "out"]);
    assert.equal(accepted.status, 0, `${state.name}: ${accepted.stderr}`);

    // Mutation in the other direction: the same tree citing any other release
    // must refuse, so the acceptance above cannot come from a vacuous check.
    const wrongFixture = await makeFixture(t, { ...state.options, citation: state.wrongCitation });
    const refused = runEvidence(wrongFixture.root, ["--static-dir", "out"]);
    assert.notEqual(refused.status, 0, `${state.name} must refuse ${state.wrongCitation}`);
    assert.match(refused.stderr, /must declare the most recent receipted release/, state.name);
  }

  // The date is bound to the cited receipt, not just any well-formed date.
  const wrongDate = await makeFixture(t, {
    ...states[0].options,
    citation: cite("0.1.0", "2026-01-05")
  });
  const dateRefused = runEvidence(wrongDate.root, ["--static-dir", "out"]);
  assert.notEqual(dateRefused.status, 0);
  assert.match(dateRefused.stderr, /must carry the receipted release date/);
});

test("the development-state citation contract and the producer agree on one tree", { skip: hostToolchainSkip }, async (t) => {
  // The routine post-release flip: status development while the receipt for
  // the last release exists and CITATION.cff cites it WITH its date. The unit
  // expectation used to demand no date-released line in development while the
  // producer demanded the receipted date unconditionally, so the first flip
  // to development made CI unsatisfiable and each half still passed its own
  // fixtures. Run BOTH halves against one identical tree so the pair can
  // never silently diverge again.
  const fixture = await makeFixture(t);
  await assertReceiptFollowingCitation(fixture.root);
  const accepted = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.equal(accepted.status, 0, accepted.stderr);

  // And both halves refuse the same dateless tree, so neither can drift back
  // to the old development contract alone.
  const dateless = await makeFixture(t, {
    citation: 'cff-version: 1.2.0\nversion: "0.1.0"\n'
  });
  await assert.rejects(
    () => assertReceiptFollowingCitation(dateless.root),
    /recorded release date/
  );
  const refused = runEvidence(dateless.root, ["--static-dir", "out"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /must carry the receipted release date/);
});

test("the 1.0 candidate binding and the producer accept one candidate-shaped tree", { skip: hostToolchainSkip }, async (t) => {
  // lib/measurement-candidate-binding.ts used to require the 1.0 candidate's
  // CITATION.cff to name 1.0.0 with no date-released line, while this
  // producer, running in the required app and docker gates at that same
  // commit, refuses any citation that is not the most recent receipted
  // release with its receipted date. The accepted sets were disjoint: no
  // CI-green candidate commit could satisfy the binding, so the decided 1.0
  // finalization chronology was unreachable. Run the real producer AND the
  // binding's exported candidate-citation contract against one identical
  // candidate-shaped tree, in acceptance and in refusal, so the two gates
  // can never diverge again.
  const candidateShape = {
    policyVersion: "1.0.0",
    packageVersion: "1.0.0",
    receiptedVersion: "0.5.0",
    receiptedDate: "2026-08-11",
    citation: 'cff-version: 1.2.0\nversion: "0.5.0"\ndate-released: "2026-08-11"\n',
    changelog: "# Changelog\n\n## Unreleased\n\n## [1.0.0] - UNRELEASED\n"
  };
  const fixture = await makeFixture(t, candidateShape);
  await assertReceiptFollowingCitation(fixture.root);
  const accepted = runEvidence(fixture.root, ["--static-dir", "out"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const citationBytes = await readFile(path.join(fixture.root, "CITATION.cff"), "utf8");
  assert.equal(receiptFollowingCandidateCitationViolation(citationBytes), null);

  // Both gates refuse the binding's retired candidate shape on the same tree.
  const retired = 'cff-version: 1.2.0\nversion: "1.0.0"\n';
  assert.match(
    receiptFollowingCandidateCitationViolation(retired) ?? "",
    /never the unreceipted 1\.0\.0/
  );
  const retiredFixture = await makeFixture(t, { ...candidateShape, citation: retired });
  const refused = runEvidence(retiredFixture.root, ["--static-dir", "out"]);
  assert.notEqual(refused.status, 0);
  assert.match(
    refused.stderr,
    /must declare the most recent receipted release \(0\.5\.0\), not the declared version 1\.0\.0/
  );
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

/** The exact-existing-tag reconciler, addressed by its unique success marker. */
function releaseTagReconciliationController(workflow: string): string {
  const step = "- name: Create the annotated release tag atomically through the Git database API";
  const occurrences = workflow.split(step).length - 1;
  assert.equal(occurrences, 1, "exactly one tag-publication step must exist");
  const after = workflow.slice(workflow.indexOf(step));
  const end = after.indexOf("- name: Record the release in the run summary");
  assert.notEqual(end, -1, "tag publication must precede the release summary");
  const matching = extractControllers(after.slice(0, end)).filter((controller) =>
    controller.includes("Reconciled exact existing annotated tag")
  );
  assert.equal(matching.length, 1, "the tag step must hold exactly one exact-existing-tag reconciler");
  return matching[0];
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
async function attestContext(
  t: TestContext,
  options: {
    fixture?: Parameters<typeof makeFixture>[1];
    /** The dispatched version; defaults to the released fixture's 0.1.0. */
    releaseVersion?: string;
  } = {}
): Promise<AttestContext> {
  const releaseVersion = options.releaseVersion ?? "0.1.0";
  const fixture = await makeFixture(t, {
    policy: RELEASED_POLICY,
    citation: RELEASED_CITATION,
    changelog: RELEASED_CHANGELOG,
    ...options.fixture
  });
  const governanceReceiptSha256 = "a".repeat(64);
  const produced = runEvidence(fixture.root, [
    "--static-dir",
    "out",
    "--release-tag-governance-receipt-sha256",
    governanceReceiptSha256
  ]);
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
  // The citation gate re-runs the receipt selection itself, so hand it the
  // same directory listing and receipt bytes the read-back step fetches,
  // derived from the fixture's real archive rather than restated.
  const receiptsDir = path.join(fixture.root, "docs", "release-receipts");
  const archivedVersions = readdirSync(receiptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  await writeContext(
    "release-receipts.json",
    archivedVersions.map((name) => ({ type: "dir", name }))
  );
  for (const name of archivedVersions) {
    await writeFileContent(`docs/release-receipts/${name}/release-receipt.json`, fixture.root);
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
      RELEASE_VERSION: releaseVersion,
      RELEASE_TAG: `v${releaseVersion}`,
      RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: governanceReceiptSha256
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

test("the attest citation selector is the producer's exported selector, byte for byte", async () => {
  // The isolated attest job may never execute candidate code (its guard above
  // bans checkout and npm outright), so it carries a copy of
  // selectCitedReceiptedVersion instead of importing it. A copy is the
  // contract-restatement defect class, so pin it to the export's exact
  // source text: a change to either side that does not move the other
  // fails here.
  const { selectCitedReceiptedVersion } = await releaseEvidenceModule();
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  assert.ok(
    normalize(controller).includes(normalize(selectCitedReceiptedVersion.toString())),
    "the validator must carry the exported selector's exact text"
  );
});

test("the validator accepts the ceremony-window citation and refuses the declared one", { skip: hostToolchainSkip }, async (t) => {
  const controller = releaseValidatorController(await source(".github/workflows/release.yml"));
  // The shape every honest ceremony has: 0.2.0 declared released in the
  // policy while only 0.1.0 is receipted, so CITATION.cff still cites 0.1.0.
  // The old gate required the citation to carry 0.2.0 with its date, which
  // the release-evidence gate refuses at the same SHA, and the receipt only
  // exists after this very workflow succeeds, so no tree could satisfy both
  // and no release could ever be attested again.
  const ceremony = {
    releaseVersion: "0.2.0",
    fixture: {
      policy: {
        ...RELEASED_POLICY,
        version: "0.2.0",
        releaseTag: "v0.2.0",
        releaseDate: "2026-02-10"
      },
      packageVersion: "0.2.0",
      receiptedVersion: "0.1.0",
      receiptedDate: "2026-01-01",
      citation: 'cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-01-01"\n',
      changelog: "# Changelog\n\n## Unreleased\n\n## [0.2.0] - 2026-02-10\n"
    }
  };
  const accepted = runValidator(controller, await attestContext(t, ceremony));
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);

  const encodedCitation = (text: string) => ({
    type: "file",
    encoding: "base64",
    content: Buffer.from(text).toString("base64")
  });

  // Citing the declared version before its receipt exists is the standalone
  // overclaim the receipt-following contract retired; the validator must
  // refuse it rather than require it.
  const advanced = await attestContext(t, ceremony);
  await advanced.writeContext(
    "content-CITATION_cff.json",
    encodedCitation('cff-version: 1.2.0\nversion: "0.2.0"\ndate-released: "2026-02-10"\n')
  );
  const advancedRefused = runValidator(controller, advanced);
  assert.equal(advancedRefused.status, 1, advancedRefused.stdout);
  assert.match(
    advancedRefused.stderr,
    /must cite the most recent receipted release \(0\.1\.0, 2026-01-01\)/
  );

  // Post-archival replay: the default context is the state after the receipt
  // for the policy's own version is archived and the citation has advanced.
  // The same check passes there because the selector now prefers the declared
  // version once its receipt exists; a date differing from that receipt still
  // refuses.
  const postArchival = await attestContext(t);
  await postArchival.writeContext(
    "content-CITATION_cff.json",
    encodedCitation('cff-version: 1.2.0\nversion: "0.1.0"\ndate-released: "2026-07-26"\n')
  );
  const dateRefused = runValidator(controller, postArchival);
  assert.equal(dateRefused.status, 1, dateRefused.stdout);
  assert.match(
    dateRefused.stderr,
    /must cite the most recent receipted release \(0\.1\.0, 2026-07-25\)/
  );

  // An empty archive cannot satisfy the citation contract at all.
  const noReceipts = await attestContext(t);
  await noReceipts.writeContext("release-receipts.json", []);
  const emptyRefused = runValidator(controller, noReceipts);
  assert.equal(emptyRefused.status, 1, emptyRefused.stdout);
  assert.match(emptyRefused.stderr, /No archived release receipt exists at the release SHA/);
});

type TagReconciliationContext = {
  runnerTemp: string;
  expected: Record<string, unknown>;
  ref: Record<string, unknown>;
  actual: Record<string, unknown>;
  write: (name: string, value: unknown) => Promise<void>;
};

async function tagReconciliationContext(t: TestContext): Promise<TagReconciliationContext> {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "site-behavior-lab-tag-reconcile-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const target = "a".repeat(40);
  const objectSha = "b".repeat(40);
  const tag = "v0.4.0-rc.1";
  const message = [
    `Site Behavior Lab ${tag}`,
    "",
    "Curated release. No blanket stable public API and no npm publication.",
    "Attested exact-source release receipt: https://github.com/iAnonymous3000/site-behavior-lab/attestations/38229999",
    `Release receipt sha256: ${"c".repeat(64)}`
  ].join("\n");
  const expected = { tag, message, object: target, type: "commit" };
  const ref = { ref: `refs/tags/${tag}`, object: { type: "tag", sha: objectSha } };
  const actual = {
    sha: objectSha,
    tag,
    message,
    object: { type: "commit", sha: target }
  };
  const write = (name: string, value: unknown) =>
    writeFile(path.join(runnerTemp, name), `${JSON.stringify(value)}\n`);
  await Promise.all([
    write("tag-object.json", expected),
    write("existing-tag-ref.json", ref),
    write("existing-tag-object.json", actual)
  ]);
  return { runnerTemp, expected, ref, actual, write };
}

function runTagReconciliation(controller: string, context: TagReconciliationContext) {
  return spawnSync(process.execPath, ["--input-type=commonjs", "-e", controller], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: context.runnerTemp }
  });
}

test("the tag publisher reconciles only its exact existing annotated ref", async (t) => {
  const controller = releaseTagReconciliationController(await source(".github/workflows/release.yml"));
  const context = await tagReconciliationContext(t);
  const accepted = runTagReconciliation(controller, context);
  assert.equal(accepted.status, 0, `${accepted.stderr}${accepted.stdout}`);
  assert.match(accepted.stdout, /Reconciled exact existing annotated tag v0\.4\.0-rc\.1 at a{40}/);
});

test("the atomic tag publisher remains valid bash around its HTTP reconciliation branch", async () => {
  const workflow = await source(".github/workflows/release.yml");
  const step = workflow.slice(
    workflow.indexOf(
      "- name: Create the annotated release tag atomically through the Git database API"
    ),
    workflow.indexOf("- name: Record the release in the run summary")
  );
  const body = step.slice(step.indexOf("run: |") + "run: |".length);
  const shell = body
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
  const syntax = spawnSync("bash", ["-n"], {
    input: shell,
    encoding: "utf8"
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the tag publisher refuses every mismatched existing ref or tag object", async (t) => {
  const controller = releaseTagReconciliationController(await source(".github/workflows/release.yml"));
  const cases: Array<{
    name: string;
    mutate: (context: TagReconciliationContext) => Promise<void>;
    expected: RegExp;
  }> = [
    {
      name: "ref name",
      mutate: (context) =>
        context.write("existing-tag-ref.json", { ...context.ref, ref: "refs/tags/v0.4.0-rc.2" }),
      expected: /wrong name/
    },
    {
      name: "lightweight ref",
      mutate: (context) =>
        context.write("existing-tag-ref.json", {
          ...context.ref,
          object: { ...(context.ref.object as Record<string, unknown>), type: "commit" }
        }),
      expected: /not annotated/
    },
    {
      name: "different tag object",
      mutate: (context) =>
        context.write("existing-tag-object.json", { ...context.actual, sha: "d".repeat(40) }),
      expected: /does not identify the fetched tag object/
    },
    {
      name: "tag name",
      mutate: (context) =>
        context.write("existing-tag-object.json", { ...context.actual, tag: "v0.4.0-rc.2" }),
      expected: /wrong tag name/
    },
    {
      name: "target type",
      mutate: (context) =>
        context.write("existing-tag-object.json", {
          ...context.actual,
          object: { ...(context.actual.object as Record<string, unknown>), type: "tree" }
        }),
      expected: /different release commit or object type/
    },
    {
      name: "target commit",
      mutate: (context) =>
        context.write("existing-tag-object.json", {
          ...context.actual,
          object: { ...(context.actual.object as Record<string, unknown>), sha: "e".repeat(40) }
        }),
      expected: /different release commit or object type/
    },
    {
      name: "evidence message",
      mutate: (context) =>
        context.write("existing-tag-object.json", {
          ...context.actual,
          message: `${context.actual.message as string}\ntampered`
        }),
      expected: /different attestation or receipt evidence/
    }
  ];

  for (const candidate of cases) {
    const context = await tagReconciliationContext(t);
    await candidate.mutate(context);
    const refused = runTagReconciliation(controller, context);
    assert.equal(refused.status, 1, `${candidate.name} must be refused: ${refused.stdout}`);
    assert.match(refused.stderr, candidate.expected, candidate.name);
  }
});

function releaseWorkflowShellStep(
  workflow: string,
  name: string,
  nextName: string
): string {
  const startMarker = `- name: ${name}`;
  const endMarker = `- name: ${nextName}`;
  assert.equal(
    workflow.split(startMarker).length - 1,
    1,
    `${name} must exist exactly once`
  );
  const step = workflow.slice(workflow.indexOf(startMarker));
  const end = step.indexOf(endMarker);
  assert.notEqual(end, -1, `${name} must precede ${nextName}`);
  const bounded = step.slice(0, end);
  const run = bounded.indexOf("run: |");
  assert.notEqual(run, -1, `${name} must use a literal shell block`);
  return bounded
    .slice(run + "run: |".length)
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");
}

test("release trust-root snapshot and version classifier fail closed", async (t) => {
  const workflow = await source(".github/workflows/release.yml");
  const snapshot = releaseWorkflowShellStep(
    workflow,
    "Snapshot external release trust roots",
    "Checkout full history without persisted credentials"
  );
  const classify = releaseWorkflowShellStep(
    workflow,
    "Classify the release measurement-binding requirement",
    "Select the release binding contract"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-release-trust-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const governance = "a".repeat(64);
  const binding = "b".repeat(64);
  const runSnapshot = async (measurement: string) => {
    const output = path.join(root, `snapshot-${measurement || "empty"}-${Date.now()}`);
    const result = spawnSync("bash", ["-c", snapshot], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        SELECTED_GOVERNANCE_RECEIPT_SHA256: governance,
        SELECTED_MEASUREMENT_BINDING_SHA256: measurement
      }
    });
    return {
      result,
      output: result.status === 0 ? await readFile(output, "utf8") : ""
    };
  };

  const empty = await runSnapshot("");
  assert.equal(empty.result.status, 0, empty.result.stderr);
  assert.match(empty.output, /^receipt_sha256=[0-9a-f]{64}$/m);
  assert.match(empty.output, /^raw_measurement_binding_sha256=$/m);
  const pinned = await runSnapshot(binding);
  assert.equal(pinned.result.status, 0, pinned.result.stderr);
  assert.match(pinned.output, new RegExp(`^raw_measurement_binding_sha256=${binding}$`, "m"));
  assert.equal((await runSnapshot("B".repeat(64))).result.status, 1);

  const runClassify = (version: string, resolved: string, digest: string) => {
    const output = path.join(root, `classify-${Math.random()}`);
    const result = spawnSync("bash", ["-c", classify], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        REQUESTED_VERSION: version,
        RESOLVED_RELEASE_VERSION: resolved,
        SNAPSHOTTED_MEASUREMENT_BINDING_SHA256: digest
      }
    });
    return {
      result,
      output: result.status === 0 ? readFile(output, "utf8") : Promise.resolve("")
    };
  };

  const zero = runClassify("0.4.0", "0.4.0", "");
  assert.equal(zero.result.status, 0, zero.result.stderr);
  assert.match(await zero.output, /^binding_required=false$/m);
  assert.match(await zero.output, /^binding_sha256=not-required$/m);
  assert.equal(runClassify("1.0.0", "1.0.0", "").result.status, 1);
  const one = runClassify("1.0.0-rc.1", "1.0.0-rc.1", binding);
  assert.equal(one.result.status, 0, one.result.stderr);
  assert.match(await one.output, /^binding_required=true$/m);
  assert.match(await one.output, new RegExp(`^binding_sha256=${binding}$`, "m"));
  assert.equal(runClassify("1.0.0", "1.0.0-rc.1", binding).result.status, 1);
  assert.equal(runClassify("1.0.1", "1.0.1", binding).result.status, 1);
});

test("pre-authority measurement trust root rejects skeletons and skips all 0.x fetches", async (t) => {
  const workflow = await source(".github/workflows/release.yml");
  const controller = releaseWorkflowShellStep(
    workflow,
    "Verify external measurement-binding trust root before release authority",
    "Require dedicated release App configuration"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "site-behavior-binding-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" >> "$GH_CALL_LOG"\ncase "$*" in\n  *contents/research/measurement-candidate-binding.json*|*contents/research/v1-release-binding.json*) /bin/cat "$BINDING_FIXTURE" ;;\n  *git/commits/*) /bin/cat "$COMMIT_FIXTURE" ;;\n  *compare/*) /bin/cat "$COMPARE_FIXTURE" ;;\n  *) exit 97 ;;\nesac\n`
  );
  await chmod(gh, 0o755);

  const candidate = "c".repeat(40);
  const candidateTree = "d".repeat(40);
  const release = "e".repeat(40);
  const governance = "a".repeat(64);
  const fullBinding = {
    schemaVersion: 1,
    artifactKind: "site-behavior-measurement-candidate-binding",
    repository: "iAnonymous3000/site-behavior-lab",
    targetRelease: "1.0.0",
    candidateCommit: candidate,
    candidateTree,
    measurementInputs: {},
    measurementIdentity: {},
    calibrationPolicy: {},
    durablePrerequisite: {},
    sourceEvidence: {},
    attestationPolicy: {},
    evidence: [
      {
        category: "release-tag-governance-receipt",
        path: `research/ops-receipts/release-tag-governance/${governance}.json`,
        change: "added",
        sha256: governance
      }
    ],
    calibrationStudies: []
  };
  const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const run = async (
    version: string,
    required: string,
    bindingBytes: string,
    selectedDigest: string,
    githubCandidateTree: string = candidateTree,
    releaseBindingPath: string = "research/measurement-candidate-binding.json"
  ) => {
    const runnerTemp = await mkdtemp(path.join(root, "run-"));
    const bindingFixture = path.join(runnerTemp, "binding.json");
    const commitFixture = path.join(runnerTemp, "commit.json");
    const compareFixture = path.join(runnerTemp, "compare.json");
    const callLog = path.join(runnerTemp, "gh-calls.log");
    await writeFile(bindingFixture, bindingBytes);
    await writeFile(
      commitFixture,
      JSON.stringify({ sha: candidate, tree: { sha: githubCandidateTree } })
    );
    await writeFile(
      compareFixture,
      JSON.stringify({
        base_commit: { sha: candidate },
        head_commit: { sha: release },
        merge_base_commit: { sha: candidate },
        status: "ahead",
        behind_by: 0
      })
    );
    const result = spawnSync("bash", ["-c", controller], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
        GH_CALL_LOG: callLog,
        BINDING_FIXTURE: bindingFixture,
        COMMIT_FIXTURE: commitFixture,
        COMPARE_FIXTURE: compareFixture,
        RELEASE_SHA: release,
        RELEASE_VERSION: version,
        RELEASE_MEASUREMENT_BINDING_REQUIRED: required,
        RELEASE_MEASUREMENT_BINDING_SHA256: selectedDigest,
        RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: governance,
        RELEASE_BINDING_PATH: releaseBindingPath
      }
    });
    let calls = "";
    try {
      calls = await readFile(callLog, "utf8");
    } catch {
      // An empty call log proves the controller exited before invoking gh.
    }
    return { result, calls };
  };

  const zero = await run("0.4.0", "false", "", "not-required");
  assert.equal(zero.result.status, 0, zero.result.stderr);
  assert.equal(zero.calls, "", "0.x must not fetch a measurement binding");

  const missingPin = await run("1.0.0", "true", canonical(fullBinding), "");
  assert.equal(missingPin.result.status, 1);
  assert.equal(missingPin.calls, "", "missing v1 pins must fail before fetching");

  const coreBinding = {
    schemaVersion: 1, artifactKind: "site-behavior-v1-release-binding",
    repository: fullBinding.repository, targetRelease: "1.0.0",
    candidateCommit: candidate, candidateTree, evidence: fullBinding.evidence
  };
  const coreBytes = canonical(coreBinding);
  const coreDigest = createHash("sha256").update(coreBytes).digest("hex");
  const core = await run("1.0.0", "true", coreBytes, coreDigest, candidateTree, "research/v1-release-binding.json");
  assert.equal(core.result.status, 0, core.result.stderr);
  assert.match(core.calls, /contents\/research\/v1-release-binding\.json/);
  const crossContract = await run("1.0.0", "true", coreBytes, coreDigest);
  assert.equal(crossContract.result.status, 1, "a core binding cannot impersonate the legacy contract");
  const invalidPath = await run("1.0.0", "true", coreBytes, coreDigest, candidateTree, "research/arbitrary.json");
  assert.equal(invalidPath.result.status, 1);
  assert.equal(invalidPath.calls, "");
  const coreMismatch = await run("1.0.0", "true", coreBytes, "f".repeat(64), candidateTree, "research/v1-release-binding.json");
  assert.equal(coreMismatch.result.status, 1);
  assert.match(coreMismatch.result.stderr, /external maintainer pin/);

  const fullBytes = canonical(fullBinding);
  const mismatch = await run("1.0.0", "true", fullBytes, "f".repeat(64));
  assert.equal(mismatch.result.status, 1);
  assert.match(mismatch.result.stderr, /do not match the external maintainer pin/);

  const skeletonBytes = canonical({ evidence: fullBinding.evidence });
  const skeleton = await run(
    "1.0.0",
    "true",
    skeletonBytes,
    createHash("sha256").update(skeletonBytes).digest("hex")
  );
  assert.equal(skeleton.result.status, 1);
  assert.match(skeleton.result.stderr, /wrong schema, identity, or top-level shape/);

  const wrongRepositoryBytes = canonical({
    ...fullBinding,
    repository: "attacker/example"
  });
  const wrongRepository = await run(
    "1.0.0",
    "true",
    wrongRepositoryBytes,
    createHash("sha256").update(wrongRepositoryBytes).digest("hex")
  );
  assert.equal(wrongRepository.result.status, 1);
  assert.match(wrongRepository.result.stderr, /wrong schema, identity, or top-level shape/);

  const wrongTree = await run(
    "1.0.0",
    "true",
    fullBytes,
    createHash("sha256").update(fullBytes).digest("hex"),
    "f".repeat(40)
  );
  assert.equal(wrongTree.result.status, 1);
  assert.match(wrongTree.result.stderr, /candidate commit\/tree identity is not an ancestor/);

  const accepted = await run(
    "1.0.0-rc.1",
    "true",
    fullBytes,
    createHash("sha256").update(fullBytes).digest("hex")
  );
  assert.equal(accepted.result.status, 0, `${accepted.result.stderr}${accepted.result.stdout}`);
  assert.match(accepted.result.stdout, /Verified external measurement-binding sha256:/);
  assert.equal(accepted.calls.trim().split("\n").length, 3);
});

test("the dedicated-release-App configuration executes as a real separation gate", async () => {
  const workflow = await source(".github/workflows/release.yml");
  const step = workflow.slice(workflow.indexOf("- name: Require dedicated release App configuration"));
  const body = step.slice(step.indexOf("run: |") + "run: |".length, step.indexOf("- name: Mint dedicated release App token"));
  const script = body
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
    .join("\n");

  const run = (
    releaseClientId: string,
    promotionClientId: string,
    privateKey: string,
    integrationId = "481516",
    creationRulesetId = "20059999",
    promotionIntegrationId = "481517",
    promotionSlug = "site-behavior-promotion",
    receiptSha256 = "a".repeat(64)
  ) =>
    spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        RELEASE_APP_CLIENT_ID: releaseClientId,
        RELEASE_APP_INTEGRATION_ID: integrationId,
        RELEASE_TAG_CREATION_RULESET_ID: creationRulesetId,
        RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256: receiptSha256,
        PROMOTION_APP_CLIENT_ID: promotionClientId,
        PROMOTION_APP_INTEGRATION_ID: promotionIntegrationId,
        PROMOTION_APP_SLUG: promotionSlug,
        RELEASE_APP_PRIVATE_KEY: privateKey
      }
    });

  assert.equal(run("Iv1.release", "Iv1.promotion", "private-key").status, 0);
  assert.equal(run("", "Iv1.promotion", "private-key").status, 1);
  assert.equal(run("Iv1.release", "", "private-key").status, 1);
  assert.equal(run("Iv1.release", "Iv1.promotion", "").status, 1);
  assert.equal(
    run("Iv1.release", "Iv1.promotion", "private-key", "", "20059999")
      .status,
    1
  );
  assert.equal(
    run("Iv1.release", "Iv1.promotion", "private-key", "481516", "")
      .status,
    1
  );
  assert.equal(
    run("Iv1.release", "Iv1.promotion", "private-key", "481516", "20050122")
      .status,
    1
  );
  assert.equal(
    run(
      "Iv1.release",
      "Iv1.promotion",
      "private-key",
      "481516",
      "20059999",
      "481516"
    ).status,
    1
  );
  assert.equal(
    run(
      "Iv1.release",
      "Iv1.promotion",
      "private-key",
      "481516",
      "20059999",
      "481517",
      ""
    ).status,
    1
  );
  assert.equal(
    run(
      "Iv1.release",
      "Iv1.promotion",
      "private-key",
      "481516",
      "20059999",
      "481517",
      "site-behavior-promotion",
      "bad"
    ).status,
    1
  );
  const reused = run("Iv1.same", "Iv1.same", "private-key");
  assert.equal(reused.status, 1);
  assert.match(reused.stdout, /must be distinct from the production promotion App/);
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

test("a declared release with no archived receipt must say so in the policy", () => {
  // REGRESSION. `status: "released"` has been true for 0.5.0 since 2026-08-11
  // with no v0.5.0 tag and no receipt under docs/release-receipts/. That window
  // is legitimate -- RELEASE.md declares the version at step 1 and creates the
  // tag at step 4 -- but it was unbounded and nothing observed it. The v0.2.0
  // reconciliation on 2026-07-29 treated the identical state as a
  // misrepresentation, so the project has already decided this matters.
  //
  // This does not impose a deadline; picking one is an operator decision. It
  // requires the state to be DECLARED, so a release that stalls is visible in
  // the policy itself rather than inferable only by noticing a missing tag.
  const policy = JSON.parse(
    readFileSync(path.join(process.cwd(), "release-policy.json"), "utf8")
  ) as {
    status: string;
    version: string;
    tagPending?: { declaredAt?: string; note?: string };
  };
  if (policy.status !== "released") return;

  const receiptArchived = hasArchivedReleaseReceipt(policy.version);

  if (receiptArchived) {
    assert.equal(
      policy.tagPending,
      undefined,
      `${policy.version} has an archived receipt, so tagPending must be removed`
    );
    return;
  }

  assert.ok(
    policy.tagPending?.declaredAt,
    `release-policy.json declares ${policy.version} released, but no receipt exists at ` +
      `docs/release-receipts/${policy.version}. Either complete the tag sequence or record ` +
      `tagPending.declaredAt so the open window is explicit.`
  );
  assert.match(
    policy.tagPending.declaredAt,
    /^\d{4}-\d{2}-\d{2}$/,
    "tagPending.declaredAt must be an ISO date"
  );

  // CITATION.cff is consumed STANDALONE by citation tooling, which never sees
  // RELEASE.md's hedge or this policy. It must not assert a release date for a
  // version that has no tag and no receipt.
  const citation = readFileSync(path.join(process.cwd(), "CITATION.cff"), "utf8");
  const citedVersion = citation.match(/^version:\s*"?([^"\n]+)"?/m)?.[1];
  assert.notEqual(
    citedVersion,
    policy.version,
    `CITATION.cff cites ${policy.version} as released while its tag and receipt do not exist. ` +
      `Citation tooling reads this file alone, so the claim stands unqualified.`
  );
});
