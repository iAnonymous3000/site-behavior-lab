#!/usr/bin/env node
// Resolve only evidence produced by the exact gated main revision.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { REPOSITORY, run, resolveProductionCi } from "./production-ci-lib.mjs";
import { PUBLISHED_EVIDENCE, validatePublishedContainer } from "./published-container-lib.mjs";

assert.ok(process.env.GITHUB_OUTPUT);
const candidate = resolveProductionCi();
if (!candidate) {
  appendFileSync(process.env.GITHUB_OUTPUT, "current=false\n");
  process.exit(0);
}
const { commit, runId } = candidate;
const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP, "published-container-"));
run("gh", ["run", "download", String(runId), "--repo", REPOSITORY,
  "--name", `exact-sha-published-container-evidence-${commit}`, "--dir", directory]);
const file = path.join(directory, PUBLISHED_EVIDENCE);
const reference = validatePublishedContainer(JSON.parse(readFileSync(file)), {
  commit, tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
  configBytes: readFileSync("wrangler.container.jsonc")
});
assert.ok(!/[\r\n]/.test(file));
appendFileSync(process.env.GITHUB_OUTPUT, `current=true\nevidence=${file}\nimage=${reference}\nci_run=${runId}\n`);
console.log(`Resolved image from gated main CI run ${runId}: ${reference}. Attestation verification is required before deploy.`);
