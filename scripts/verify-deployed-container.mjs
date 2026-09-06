#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { IMAGE_REPOSITORY } from "./published-container-lib.mjs";
import { readResponseJsonWithinLimit, withHttpOperationDeadline } from "./http-response.mjs";

function readApplication(timeoutMs) {
  const apps = JSON.parse(execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js",
    "containers", "list", "--json", "--config", "wrangler.container.jsonc"], {
    encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024
  }));
  const matches = apps.filter((app) => app.name === "site-behavior-lab-scanner-scannercontainer");
  assert.equal(matches.length, 1, "Expected exactly one production container application");
  assert.ok(typeof matches[0].id === "string" && matches[0].id.length > 0,
    "Expected a production container application ID");
  return matches[0];
}

async function readHealth(timeoutMs) {
  return withHttpOperationDeadline(
    { timeoutMs, label: "Deployed scanner health" },
    async (signal) => {
      const response = await fetch("https://scan.sitebehavior.org/api/health", {
        cache: "no-store", redirect: "error", signal
      });
      const value = await readResponseJsonWithinLimit(response, {
        maxBytes: 256 * 1024, label: "Deployed scanner health"
      });
      assert.ok(response.ok, `Scanner health returned HTTP ${response.status}`);
      return value;
    }
  );
}

export async function waitForDeployment({
  expectedImage, expectedCommit,
  // Cloudflare can drain a replaced process for up to 15 minutes. This is a
  // ceiling, not a fixed wait; a matching provider/runtime pair returns at once.
  timeoutMs = 20 * 60_000, pollMs = 10_000,
  application = readApplication, health = readHealth,
  now = () => performance.now(), sleep = setTimeout, onPending = console.log
}) {
  assert.ok(expectedImage?.startsWith(`${IMAGE_REPOSITORY}@sha256:`));
  assert.match(expectedImage.slice(IMAGE_REPOSITORY.length), /^@sha256:[0-9a-f]{64}$/);
  assert.match(expectedCommit ?? "", /^[0-9a-f]{40}$/);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isSafeInteger(pollMs) && pollMs > 0);
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(0, Math.floor(deadline - now()));
  let lastObservation = "No provider/runtime observation completed";
  while (remaining() > 0) {
    try {
      // Capture and check the budget once. A deadline crossed between two clock
      // reads must never pass timeout: 0 to Node, where zero means unlimited.
      const applicationBudget = Math.min(60_000, remaining());
      if (applicationBudget <= 0) break;
      const app = await application(applicationBudget);
      lastObservation = `Cloudflare image: ${app.image ?? "unavailable"}`;
      const healthBudget = Math.min(10_000, remaining());
      if (app.image === expectedImage && healthBudget > 0) {
        const live = await health(healthBudget);
        lastObservation += `; live revision: ${live?.deployment ?? "unavailable"}`;
        // Never combine a matching image from a previous attempt with a later
        // health response, or accept an observation completed after the deadline.
        if (live?.deployment === expectedCommit && remaining() > 0) {
          return { observedAt: new Date().toISOString(), sourceCommit: live.deployment,
            applicationId: app.id, image: app.image };
        }
      }
    } catch (error) {
      lastObservation = error.message;
    }
    onPending(`Waiting for container rollout: ${lastObservation}`);
    if (remaining() > 0) await sleep(Math.min(pollMs, remaining()));
  }
  throw new Error(`Container rollout did not converge within ${timeoutMs}ms. Expected ${expectedImage} and ${expectedCommit}. Last observation: ${lastObservation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const readback = await waitForDeployment({
    expectedImage: process.env.EXPECTED_IMAGE, expectedCommit: process.env.GITHUB_SHA
  });
  writeFileSync(path.join(process.env.RUNNER_TEMP, "production-container-readback.json"),
    JSON.stringify(readback, null, 2) + "\n", { flag: "wx" });
  console.log(`Provider targets ${readback.image}; live scanner identifies ${readback.sourceCommit}.`);
}
