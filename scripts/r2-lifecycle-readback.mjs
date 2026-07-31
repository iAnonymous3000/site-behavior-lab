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
// With --from-wrangler the rules come from `wrangler r2 bucket lifecycle
// list` under wrangler's own stored OAuth instead: no token ever touches this
// process. Wrangler prints prose, so that mode reconstructs the API rule
// shape from its fixed line format and the receipt names its source; the
// API-token mode remains the higher-fidelity capture for the ceremony.
//
// Usage: node scripts/r2-lifecycle-readback.mjs [--from-wrangler] [receipt-output.json]
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { validateReportsLifecycleRules } from "./r2-lifecycle-lib.mjs";

const RESPONSE_MAX_BYTES = 1024 * 1024;
const args = process.argv.slice(2);
const fromWrangler = args[0] === "--from-wrangler";
if (fromWrangler) args.shift();

const bucket = process.env.SITE_BEHAVIOR_LAB_R2_BUCKET?.trim() || "site-behavior-lab-reports";
const SECONDS_PER_DAY = 86_400;

/**
 * Parse wrangler's fixed four-line rule blocks (name/enabled/prefix/action)
 * back into the API rule shape the validator consumes. Unknown action
 * wording throws rather than guessing: a receipt built on a misread rule
 * would defeat the gate it feeds.
 */
function rulesFromWranglerText(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const name = line.match(/^name:\s+(.+)$/);
    if (name) {
      current = { id: name[1].trim(), enabled: false, conditions: { prefix: "" } };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const enabled = line.match(/^enabled:\s+(Yes|No)$/);
    if (enabled) current.enabled = enabled[1] === "Yes";
    const prefix = line.match(/^prefix:\s+(.+)$/);
    if (prefix) current.conditions.prefix = prefix[1].trim() === "(all prefixes)" ? "" : prefix[1].trim();
    const action = line.match(/^action:\s+(.+)$/);
    if (action) {
      const expire = action[1].match(/^Expire objects after (\d+) days?$/);
      const abort = action[1].match(/^Abort incomplete multipart uploads after (\d+) days?$/);
      if (expire) {
        current.deleteObjectsTransition = {
          condition: { type: "Age", maxAge: Number(expire[1]) * SECONDS_PER_DAY }
        };
      } else if (abort) {
        current.abortMultipartUploadsTransition = {
          condition: { type: "Age", maxAge: Number(abort[1]) * SECONDS_PER_DAY }
        };
      } else {
        throw new Error(`Unrecognized wrangler lifecycle action wording: ${action[1]}`);
      }
    }
  }
  if (rules.length === 0) throw new Error("No lifecycle rules found in wrangler output.");
  return rules;
}

let rules;
let source;
if (fromWrangler) {
  const text = execFileSync("npx", ["wrangler", "r2", "bucket", "lifecycle", "list", bucket], {
    encoding: "utf8"
  });
  rules = rulesFromWranglerText(text);
  source = "wrangler-oauth-cli-text";
} else {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (or use --from-wrangler).");
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
  rules = Array.isArray(body.result?.rules) ? body.result.rules : [];
  source = "cloudflare-api";
}
const verdict = validateReportsLifecycleRules(rules);
const receipt = {
  kind: "site-behavior-r2-lifecycle-readback",
  receiptVersion: 1,
  bucket,
  source,
  recordedAt: new Date().toISOString(),
  rules,
  observedReportsDeletionRules: verdict.observed,
  violations: verdict.violations,
  ok: verdict.ok
};
receipt.receiptDigest = createHash("sha256")
  .update(JSON.stringify({ ...receipt, receiptDigest: undefined }))
  .digest("hex");

const outputPath = args[0];
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
