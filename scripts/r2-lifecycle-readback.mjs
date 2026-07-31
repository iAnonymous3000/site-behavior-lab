#!/usr/bin/env node
// Read back the production R2 bucket's lifecycle rules through the Cloudflare
// API and validate them against the documented retention policy (exactly one
// reports/ deletion backstop at eight days or later). Writes a timestamped
// receipt JSON when a path is given, so the release checklist can pin the
// rule state instead of trusting a dashboard glance.
//
//   CLOUDFLARE_API_TOKEN   R2-read-capable token (operator secret)
//   CLOUDFLARE_ACCOUNT_ID  account owning the bucket
//   SITE_BEHAVIOR_LAB_R2_BUCKET  bucket name (default: site-behavior-lab-reports)
//
// Usage: node scripts/r2-lifecycle-readback.mjs [receipt-output.json]
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { validateReportsLifecycleRules } from "./r2-lifecycle-lib.mjs";

const RESPONSE_MAX_BYTES = 1024 * 1024;

const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const bucket = process.env.SITE_BEHAVIOR_LAB_R2_BUCKET?.trim() || "site-behavior-lab-reports";
if (!token || !accountId) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.");
  process.exit(1);
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`,
  { headers: { authorization: `Bearer ${token}` } }
);
const body = JSON.parse(
  await readResponseTextWithinLimit(response, {
    maxBytes: RESPONSE_MAX_BYTES,
    label: `lifecycle readback for ${bucket}`
  })
);
if (!response.ok || body?.success !== true) {
  console.error(`Lifecycle readback failed (HTTP ${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
  process.exit(1);
}

const rules = Array.isArray(body.result?.rules) ? body.result.rules : [];
const verdict = validateReportsLifecycleRules(rules);
const receipt = {
  kind: "site-behavior-r2-lifecycle-readback",
  receiptVersion: 1,
  bucket,
  recordedAt: new Date().toISOString(),
  rules,
  observedReportsDeletionRules: verdict.observed,
  violations: verdict.violations,
  ok: verdict.ok
};
receipt.receiptDigest = createHash("sha256")
  .update(JSON.stringify({ ...receipt, receiptDigest: undefined }))
  .digest("hex");

const outputPath = process.argv[2];
if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Receipt written to ${outputPath}`);
}

console.log(`bucket: ${bucket}`);
for (const rule of verdict.observed) {
  console.log(`rule ${rule.id}: prefix "${rule.prefix}" deletes at ${rule.effectiveDays} days`);
}
if (verdict.ok) {
  console.log("Lifecycle rules match the documented retention policy.");
} else {
  for (const violation of verdict.violations) console.log(`VIOLATION ${violation}`);
  process.exit(1);
}
