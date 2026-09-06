import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { directoryManifest } from "./release-evidence.mjs";
import { REPOSITORY } from "./production-ci-lib.mjs";
import { sha256 } from "./published-container-lib.mjs";
import { deploymentReceiptViolation } from "./static-deployment-provenance.mjs";
import { withHttpOperationDeadline } from "./http-response.mjs";

export const PAGES_PROJECT = "site-behavior-lab";
export const PAGES_ORIGIN = "https://sitebehavior.org";
export const STATIC_EVIDENCE = "site-behavior-lab-static-release-evidence.json";

export function validatePagesReceipt(receipt, { commit, tree }) {
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.evidenceKind, "exact-source-and-tested-artifact-manifest");
  assert.equal(receipt.source?.repository, `https://github.com/${REPOSITORY}`);
  assert.equal(receipt.source?.commit, commit, "Static evidence has a different source commit");
  assert.equal(receipt.source?.tree, tree, "Static evidence has a different source tree");
  assert.equal(receipt.artifacts?.length, 1);
  const artifact = receipt.artifacts[0];
  assert.equal(artifact.name, "static-pages");
  assert.equal(artifact.kind, "directory-manifest");
  assert.equal(artifact.path, "out");
  assert.equal(artifact.digestAlgorithm, "sha256");
  assert.equal(artifact.deployment?.deployment, commit);
  assert.ok(Number.isSafeInteger(artifact.fileCount) && artifact.fileCount > 0 && artifact.fileCount <= 20_000);
  assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= 700 * 1024 * 1024);
  assert.equal(artifact.files?.length, artifact.fileCount);
  assert.match(artifact.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256(JSON.stringify(artifact.files)), artifact.manifestSha256);
  let previous = "";
  for (const file of artifact.files) {
    assert.equal(typeof file.path, "string");
    assert.ok(file.path > previous && !file.path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(file.path) &&
      file.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Unsafe or duplicate static artifact path");
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    // This pipeline verifies a static export, not a Pages Functions program.
    assert.ok(!file.path.startsWith("_worker.js") && !file.path.startsWith("functions/"));
    previous = file.path;
  }
  assert.equal(artifact.files.reduce((sum, file) => sum + file.bytes, 0), artifact.bytes);
  for (const file of ["index.html", "deployment.json", "_headers", "reports/index.json", "scan-report.schema.json"]) {
    assert.ok(artifact.files.some((entry) => entry.path === file), `Static export is missing ${file}`);
  }
  return artifact;
}

export async function verifyPagesArtifact(directory, artifact, { commit, cwd = process.cwd() }) {
  // Recompute every file, including dotfiles. Changed, extra, missing, special
  // or symlinked entries cannot pass by carrying a valid receipt alongside them.
  const actual = await directoryManifest(directory);
  assert.equal(actual.bytes, artifact.bytes);
  assert.equal(actual.files.length, artifact.fileCount);
  assert.deepEqual(actual.files, artifact.files, "Downloaded Pages bytes differ from the tested artifact");
  assert.equal(sha256(JSON.stringify(actual.files)), artifact.manifestSha256);
  const deployment = JSON.parse(await readFile(path.join(directory, "deployment.json"), "utf8"));
  assert.equal(deploymentReceiptViolation(deployment, commit, { cwd }), null);
  assert.deepEqual(deployment, artifact.deployment);
}

export function assertPagesProject(project) {
  assert.equal(project?.name, PAGES_PROJECT);
  assert.equal(project.production_branch, "production");
  assert.ok(project.domains?.includes("sitebehavior.org"), "Pages project has lost its production domain");
  assert.equal(project.source?.config?.production_deployments_enabled, false,
    "Disable automatic Pages production builds before activating the prebuilt deployer");
  assert.equal(project.source?.config?.preview_deployment_setting, "none");
}

export function assertPagesDeployment(project, commit) {
  assertPagesProject(project);
  const deployed = project.canonical_deployment;
  assert.equal(deployed?.environment, "production");
  assert.equal(deployed.latest_stage?.status, "success");
  assert.equal(deployed.deployment_trigger?.metadata?.commit_hash, commit);
  assert.match(deployed.id, /^[0-9a-f-]{36}$/);
  return deployed.id;
}

export async function waitForPagesDeployment({ project, readLiveFile, artifact, commit,
  timeoutMs = 5 * 60_000, pollMs = 10_000, onPending = console.log }) {
  const paths = ["deployment.json", "reports/index.json", "scan-report.schema.json",
    artifact.files.find((file) => file.path.startsWith("_next/static/") && file.path.endsWith(".js"))?.path];
  assert.ok(paths.every(Boolean), "No compiled browser asset in the tested export");
  return withHttpOperationDeadline({ timeoutMs, label: "Pages rollout convergence" }, async (signal) => {
    for (;;) {
      signal.throwIfAborted();
      try {
        const deploymentId = assertPagesDeployment(await project(signal), commit);
        for (const filePath of paths) {
          signal.throwIfAborted();
          const expected = artifact.files.find((file) => file.path === filePath);
          const bytes = await readLiveFile(expected, signal);
          assert.equal(bytes.byteLength, expected.bytes);
          assert.equal(sha256(bytes), expected.sha256, `Live Pages ${filePath} differs from the tested file`);
        }
        signal.throwIfAborted();
        return { deploymentId, verifiedLivePaths: paths };
      } catch (error) {
        signal.throwIfAborted();
        onPending(`Waiting for Pages rollout: ${error.message}`);
        await delay(pollMs, undefined, { signal });
      }
    }
  });
}
