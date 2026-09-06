#!/usr/bin/env node
// Deploy only the static bytes tested and signed by the gated production SHA.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY, attestationArgs, resolveProductionCi, run } from "./production-ci-lib.mjs";
import { ACCOUNT_ID } from "./published-container-lib.mjs";
import { PAGES_PROJECT, PAGES_ORIGIN, STATIC_EVIDENCE, validatePagesReceipt,
  verifyPagesArtifact, assertPagesProject, waitForPagesDeployment } from "./published-pages-lib.mjs";
import { readResponseBytesWithinLimit, readResponseJsonWithinLimit, withHttpOperationDeadline } from "./http-response.mjs";
import { resolveExactStaticDeploymentCommit } from "./static-deployment-provenance.mjs";

const cwd = process.cwd();
assert.ok(process.env.GITHUB_OUTPUT && process.env.CLOUDFLARE_API_TOKEN);
const candidate = resolveProductionCi();
if (!candidate) process.exit(0);
const { commit, runId } = candidate;
assert.equal(resolveExactStaticDeploymentCommit({ cwd }), commit);
const temporary = await mkdtemp(path.join(process.env.RUNNER_TEMP, "tested-pages-"));
run("gh", ["run", "download", String(runId), "--repo", REPOSITORY,
  "--name", `exact-sha-static-evidence-${commit}`, "--dir", temporary]);
const evidencePath = path.join(temporary, STATIC_EVIDENCE);
const info = await lstat(evidencePath);
assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024);
const evidenceBytes = await readFile(evidencePath);
const artifact = validatePagesReceipt(JSON.parse(evidenceBytes), {
  commit, tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim()
});
const gh = run(process.execPath, ["scripts/ensure-gh-attestation-verifier.mjs"]).trim();
const signatures = JSON.parse(run(gh, attestationArgs(evidencePath, commit)));
assert.ok(Array.isArray(signatures) && signatures.length > 0, "No verified main-CI static attestation");
assert.ok((await readFile(evidencePath)).equals(evidenceBytes), "Receipt changed during verification");

const directory = path.join(temporary, "out");
run("gh", ["run", "download", String(runId), "--repo", REPOSITORY,
  "--name", `tested-pages-${commit}`, "--dir", directory]);
await verifyPagesArtifact(directory, artifact, { commit, cwd });

const projectUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}`;
async function readProject(outerSignal) {
  return withHttpOperationDeadline({ timeoutMs: 10_000, label: "Pages provider readback" }, async (signal) => {
    const response = await fetch(projectUrl, { signal: outerSignal ? AbortSignal.any([signal, outerSignal]) : signal,
      redirect: "error", cache: "no-store",
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
    const body = await readResponseJsonWithinLimit(response, { maxBytes: 1024 * 1024, label: "Pages provider readback" });
    assert.ok(response.ok && body.success === true, `Pages provider read failed (${response.status})`);
    return body.result;
  });
}
assertPagesProject(await readProject());
// Check again immediately before the write: older jobs cannot roll back a
// newer promotion, and deployment never invents a replacement main artifact.
const latest = JSON.parse(run("gh", ["api", `repos/${REPOSITORY}/git/ref/heads/production`])).object.sha;
if (latest !== commit) {
  console.log(`Skipping superseded Pages deployment ${commit}.`);
  process.exit(0);
}
assert.equal(resolveExactStaticDeploymentCommit({ cwd }), commit);
execFileSync(process.execPath, [path.join(cwd, "node_modules/wrangler/bin/wrangler.js"),
  "pages", "deploy", directory, "--project-name", PAGES_PROJECT, "--branch", "production",
  "--commit-hash", commit, "--commit-dirty=false"], {
  // No repository-local Functions or Wrangler config can be picked up here.
  cwd: temporary, stdio: "inherit", timeout: 5 * 60_000, killSignal: "SIGKILL",
  env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" }
});

// Provider success and live source/asset readback are separate evidence.
const readback = await waitForPagesDeployment({ project: readProject, artifact, commit,
  readLiveFile: (expected, outerSignal) => withHttpOperationDeadline(
    { timeoutMs: 10_000, label: "Live Pages artifact" }, async (signal) => {
        const url = new URL(expected.path, `${PAGES_ORIGIN}/`);
        url.searchParams.set("verify", `${commit}-${Date.now()}`);
        const response = await fetch(url, { signal: AbortSignal.any([signal, outerSignal]), redirect: "error", cache: "no-store" });
        const bytes = await readResponseBytesWithinLimit(response, { maxBytes: expected.bytes, label: "Live Pages artifact" });
        assert.ok(response.ok, `Live Pages ${expected.path} returned ${response.status}`);
        return bytes;
      })
});
await writeFile(path.join(process.env.RUNNER_TEMP, "production-pages-readback.json"), `${JSON.stringify({
  observedAt: new Date().toISOString(), sourceCommit: commit, ciRunId: runId,
  ...readback, manifestSha256: artifact.manifestSha256
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await appendFile(process.env.GITHUB_OUTPUT, "deployed=true\n");
console.log(`Verified Pages deployment ${readback.deploymentId} serves tested source ${commit}.`);
