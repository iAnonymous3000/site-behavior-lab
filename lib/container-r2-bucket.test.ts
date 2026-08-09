import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  CONTAINER_R2_BUCKET_ENV,
  requireContainerR2Bucket
} from "./container-r2-bucket";

test("the Containers Worker refuses an absent or blank R2 bucket", () => {
  for (const value of [undefined, "", " ", "\t\n"]) {
    assert.throws(
      () => requireContainerR2Bucket(value),
      new RegExp(`${CONTAINER_R2_BUCKET_ENV} must name the deployment's R2 bucket`)
    );
  }
});

test("the Containers Worker preserves explicit production and staging R2 buckets", () => {
  for (const bucket of [
    "site-behavior-lab-reports",
    "site-behavior-lab-reports-staging",
    "site-behavior-lab-reports-watch-staging"
  ]) {
    assert.equal(requireContainerR2Bucket(bucket), bucket);
  }
});

test("the Containers Worker applies the required-bucket guard at its environment boundary", async () => {
  const source = await readFile(
    path.join(process.cwd(), "cloudflare/container-worker.ts"),
    "utf8"
  );
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_R2_BUCKET: requireContainerR2Bucket\(this\.env\.SITE_BEHAVIOR_LAB_R2_BUCKET\)/
  );
  assert.doesNotMatch(
    source,
    /SITE_BEHAVIOR_LAB_R2_BUCKET: this\.env\.SITE_BEHAVIOR_LAB_R2_BUCKET \?\?/
  );
});
