import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { scansAvailableAfterEdgeOverlay } from "./container-health-overlay";

test("the edge health overlay cannot turn a container refusal back into readiness", () => {
  assert.equal(scansAvailableAfterEdgeOverlay(false, []), false);
  assert.equal(scansAvailableAfterEdgeOverlay(false, ["edge refused"]), false);
  assert.equal(scansAvailableAfterEdgeOverlay(true, ["edge refused"]), false);
  assert.equal(scansAvailableAfterEdgeOverlay(true, []), true);
  assert.equal(scansAvailableAfterEdgeOverlay(undefined, []), false);
  assert.equal(scansAvailableAfterEdgeOverlay(null, []), false);
  assert.equal(scansAvailableAfterEdgeOverlay("true", []), false);
});

test("the Containers Worker forwards the public-r2 rollout gate into Node", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  assert.match(source, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS\?: string;/);
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: this\.env\.SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS \?\? ""/
  );
});
