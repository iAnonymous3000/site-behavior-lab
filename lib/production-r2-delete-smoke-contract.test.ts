import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("production health wires a separately authenticated fixed-prefix R2 deletion proof", async () => {
  const [workflow, smoke] = await Promise.all([
    readFile(".github/workflows/production-health.yml", "utf8"),
    readFile("scripts/smoke-production-r2-delete.mjs", "utf8")
  ]);

  assert.match(workflow, /PRODUCTION_R2_DELETE_CANARY_URL: \$\{\{ vars\.PRODUCTION_R2_DELETE_CANARY_URL \}\}/);
  assert.match(workflow, /PRODUCTION_R2_DELETE_CANARY_TOKEN: \$\{\{ secrets\.PRODUCTION_R2_DELETE_CANARY_TOKEN \}\}/);
  assert.match(workflow, /node scripts\/smoke-production-r2-delete\.mjs/);
  assert.match(workflow, /R2 write\/read\/delete canary/);

  assert.match(smoke, /endpoint\.protocol !== "https:"/);
  assert.match(smoke, /authorization: `Bearer \$\{token\}`/);
  assert.match(smoke, /result\?\.keyPrefix !== "health\/r2-delete-canary\/"/);
  assert.match(smoke, /result\?\.deleted !== true/);
  assert.doesNotMatch(smoke, /console\.(?:log|error)\([^\n]*token/);
});
