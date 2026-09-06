#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { IMAGE_REPOSITORY } from "./published-container-lib.mjs";

const expected = process.env.EXPECTED_IMAGE;
assert.ok(expected?.startsWith(`${IMAGE_REPOSITORY}@sha256:`));
assert.match(expected.slice(IMAGE_REPOSITORY.length), /^@sha256:[0-9a-f]{64}$/);
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
const apps = JSON.parse(execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js",
  "containers", "list", "--json", "--config", "wrangler.container.jsonc"], {
  encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024
}));
const matches = apps.filter((app) => app.name === "site-behavior-lab-scanner-scannercontainer");
assert.equal(matches.length, 1, "Expected exactly one production container application");
assert.equal(matches[0].image, expected, "Cloudflare application targets a different image");
let health;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch("https://scan.sitebehavior.org/api/health", { signal: AbortSignal.timeout(10_000) });
    if (response.ok) health = await response.json();
  } catch { /* bounded rollout polling; final mismatch is a failure */ }
  if (health?.deployment === process.env.GITHUB_SHA) break;
  await setTimeout(10_000);
}
assert.equal(health?.deployment, process.env.GITHUB_SHA, "Live scanner has not reached the promoted revision");
writeFileSync(path.join(process.env.RUNNER_TEMP, "production-container-readback.json"), JSON.stringify({
  observedAt: new Date().toISOString(), sourceCommit: health.deployment,
  applicationId: matches[0].id, image: matches[0].image
}, null, 2) + "\n", { flag: "wx" });
console.log(`Provider targets ${expected}; live scanner identifies ${health.deployment}.`);
