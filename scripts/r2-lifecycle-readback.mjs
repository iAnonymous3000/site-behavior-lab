#!/usr/bin/env node
// Read back and canonically archive the exact production R2 lifecycle source.
// The receipt embeds the bounded provider bytes, then re-derives every rule and
// verdict field from those bytes.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  buildR2LifecycleReadbackReceipt,
  PRODUCTION_R2_BUCKET,
  R2_LIFECYCLE_SOURCE_MAX_BYTES,
  serializeR2LifecycleReadbackReceipt
} from "./r2-lifecycle-lib.mjs";
import {
  readResponseBytesWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import { writeExclusiveAtomic } from "./operator-evidence-common.mjs";

const OPERATION_TIMEOUT_MS = 30_000;
const args = process.argv.slice(2);
const fromWrangler = args[0] === "--from-wrangler";
if (fromWrangler) args.shift();
if (args.length > 1 || args.some((arg) => arg.startsWith("--"))) {
  throw new Error(
    "Usage: node scripts/r2-lifecycle-readback.mjs [--from-wrangler] [new-receipt.json]"
  );
}

const configuredBucket =
  process.env.SITE_BEHAVIOR_LAB_R2_BUCKET?.trim() ||
  PRODUCTION_R2_BUCKET;
if (configuredBucket !== PRODUCTION_R2_BUCKET) {
  throw new Error(
    `SITE_BEHAVIOR_LAB_R2_BUCKET must be exactly ${PRODUCTION_R2_BUCKET}`
  );
}

async function exactLocalWranglerEntrypoint() {
  const repositoryRoot = process.cwd();
  const entrypoint = await realpath(
    path.join(repositoryRoot, "node_modules", ".bin", "wrangler")
  );
  const expectedRoot = await realpath(
    path.join(repositoryRoot, "node_modules", "wrangler")
  );
  const relative = path.relative(expectedRoot, entrypoint);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "the local wrangler entrypoint must resolve inside node_modules/wrangler"
    );
  }
  return entrypoint;
}

async function captureWranglerBytes() {
  const entrypoint = await exactLocalWranglerEntrypoint();
  try {
    return execFileSync(
      process.execPath,
      [
        entrypoint,
        "r2",
        "bucket",
        "lifecycle",
        "list",
        PRODUCTION_R2_BUCKET
      ],
      {
        encoding: "buffer",
        timeout: OPERATION_TIMEOUT_MS,
        maxBuffer: R2_LIFECYCLE_SOURCE_MAX_BYTES
      }
    );
  } catch (error) {
    if (error && typeof error === "object" && "signal" in error) {
      throw new Error(
        `local wrangler lifecycle readback failed or exceeded ${OPERATION_TIMEOUT_MS}ms`
      );
    }
    throw error;
  }
}

async function captureApiBytes() {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (or use --from-wrangler)"
    );
  }
  return withHttpOperationDeadline(
    {
      timeoutMs: OPERATION_TIMEOUT_MS,
      label: "production R2 lifecycle readback"
    },
    async (signal) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
          accountId
        )}/r2/buckets/${encodeURIComponent(
          PRODUCTION_R2_BUCKET
        )}/lifecycle`,
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal
        }
      );
      const bytes = await readResponseBytesWithinLimit(response, {
        maxBytes: R2_LIFECYCLE_SOURCE_MAX_BYTES,
        label: `lifecycle readback for ${PRODUCTION_R2_BUCKET}`
      });
      if (!response.ok) {
        throw new Error(
          `Lifecycle readback failed with HTTP ${response.status}`
        );
      }
      return bytes;
    }
  );
}

const sourceBytes = fromWrangler
  ? await captureWranglerBytes()
  : await captureApiBytes();
const receipt = buildR2LifecycleReadbackReceipt({
  bucket: PRODUCTION_R2_BUCKET,
  source: fromWrangler ? "wrangler-oauth-cli-text" : "cloudflare-api",
  recordedAt: new Date().toISOString(),
  sourceBytes
});

const outputPath = args[0];
if (outputPath) {
  await writeExclusiveAtomic(
    outputPath,
    serializeR2LifecycleReadbackReceipt(receipt)
  );
  console.log(`Receipt written to ${outputPath}`);
}

console.log(`bucket: ${PRODUCTION_R2_BUCKET}`);
for (const rule of receipt.observedReportsDeletionRules) {
  console.log(
    `rule ${rule.id}: prefix "${rule.prefix}" deletes at ${String(
      rule.effectiveDays
    )} days`
  );
}
if (receipt.ok) {
  console.log("Lifecycle rules match the documented retention policy.");
} else {
  for (const violation of receipt.violations) {
    console.log(`VIOLATION ${violation}`);
  }
  process.exitCode = 1;
}
