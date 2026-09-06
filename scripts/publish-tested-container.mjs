#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_ID, REPOSITORY, assertPublishedImageIdentity, assertRegistryManifest } from "./published-container-lib.mjs";

const [testedFile, publishedFile] = process.argv.slice(2);
assert.ok(testedFile && publishedFile && process.argv.length === 4, "Pass tested and published evidence paths");
assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.ok(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
assert.ok(process.env.CLOUDFLARE_API_TOKEN, "Configure CLOUDFLARE_CONTAINER_DEPLOY_TOKEN before enabling publication");
const run = (bin, args, capture = true) => execFileSync(bin, args, {
  encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  timeout: 600_000, maxBuffer: 4 * 1024 * 1024
});
const commit = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(commit, process.env.GITHUB_SHA);
assert.match(commit, /^[0-9a-f]{40}$/);
assert.match(process.env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
const tested = JSON.parse(readFileSync(testedFile, "utf8"));
assert.equal(tested.source?.commit, commit);
assert.equal(tested.artifacts?.length, 1);
const imageId = tested.artifacts[0].imageId;
assert.match(imageId, /^sha256:[0-9a-f]{64}$/);
assert.equal(run("docker", ["image", "inspect", "site-behavior-lab:smoke", "--format", "{{.Id}}"] ).trim(), imageId);
const tag = `site-behavior-lab-scanner:${commit}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
run("docker", ["tag", imageId, tag], false);
try {
  // Push the already exercised image. There is deliberately no build command.
  run(process.execPath, [path.resolve("node_modules/wrangler/bin/wrangler.js"), "containers", "push", tag,
    "--config", "wrangler.container.jsonc"], false);
  run(process.execPath, ["scripts/release-evidence.mjs", "--container-image", "site-behavior-lab:smoke",
    "--output", publishedFile], false);
  const published = JSON.parse(readFileSync(publishedFile, "utf8"));
  const reference = assertPublishedImageIdentity(published, tested);
  const manifest = JSON.parse(run("docker", ["manifest", "inspect", "--verbose", reference]));
  assertRegistryManifest(manifest, reference, imageId);
  console.log(`Published tested image ${reference}; registry manifest addresses tested configuration ${imageId}.`);
} finally {
  // The ephemeral registry credential must not outlive this step.
  try { run("docker", ["logout", "registry.cloudflare.com"], false); } catch { /* preserve original failure */ }
}
