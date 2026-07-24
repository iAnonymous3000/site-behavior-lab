import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the production R2 delete canary Worker is isolated and bound only to the reports bucket", async () => {
  const [config, source] = await Promise.all([
    readFile("wrangler.r2-delete-canary.jsonc", "utf8"),
    readFile("cloudflare/r2-delete-canary-worker.ts", "utf8")
  ]);

  assert.match(config, /"name"\s*:\s*"site-behavior-lab-r2-delete-canary"/);
  assert.match(config, /"main"\s*:\s*"cloudflare\/r2-delete-canary-worker\.ts"/);
  assert.match(config, /"binding"\s*:\s*"REPORTS"/);
  assert.match(config, /"bucket_name"\s*:\s*"site-behavior-lab-reports"/);
  assert.doesNotMatch(config, /routes|custom_domains/);

  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /pathname !== "\/run"/);
  assert.match(source, /SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN/);
  assert.match(source, /runR2DeleteCanary/);
  assert.doesNotMatch(source, /url\.searchParams|get\("key"\)|request\.json/);
});
