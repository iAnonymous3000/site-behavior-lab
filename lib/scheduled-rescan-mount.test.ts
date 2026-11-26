import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("the retired scheduled-rescan panel and client modules are removed and unreferenced by the homepage", () => {
  for (const retired of [
    "app/_components/scheduled-rescans.tsx",
    "lib/encrypted-watch-client.ts",
    "lib/scheduled-rescan-mount.ts",
    "lib/scheduled-rescan-ui.ts"
  ]) {
    assert.equal(existsSync(path.join(root, retired)), false, `${retired} must remain removed`);
  }
  const app = readFileSync(path.join(root, "app", "site-behavior-app.tsx"), "utf8");
  assert.doesNotMatch(app, /scheduled-rescans|LazyScheduledRescans|<ScheduledRescans/);
});
