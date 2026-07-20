import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("CI requires the deployable Docker image and public-v2/R2 smoke before promotion", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const dockerJob = workflow.slice(workflow.indexOf("\n  docker:"), workflow.indexOf("\n  promote:"));
  const promoteJob = workflow.slice(workflow.indexOf("\n  promote:"));

  assert.match(dockerJob, /npm run test:smoke:docker/);
  assert.match(dockerJob, /DOCKER_SMOKE_PUBLIC_R2: "1"/);
  assert.match(promoteJob, /needs:\n(?:\s+- [^\n]+\n)*\s+- docker\n/);
});

test("Docker smoke preserves v1 and explicitly proves public v2/r2 bundles", () => {
  const smoke = readFileSync(path.join(root, "scripts", "smoke-docker.mjs"), "utf8");
  const seccomp = JSON.parse(
    readFileSync(path.join(root, "scripts", "playwright-seccomp-profile.json"), "utf8")
  ) as { defaultAction?: string; syscalls?: Array<{ names?: string[]; action?: string }> };

  assert.match(smoke, /await runV1ImageSmoke\(\)/);
  assert.match(smoke, /"--init"/);
  assert.match(smoke, /"--ipc=host"/);
  assert.match(smoke, /`seccomp=\$\{seccompProfile\}`/);
  assert.doesNotMatch(smoke, /seccomp=unconfined|chromiumSandbox: false/);
  assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
  const userNamespaceRule = seccomp.syscalls?.find(
    (entry) => entry.action === "SCMP_ACT_ALLOW" && ["clone", "setns", "unshare"].every((name) => entry.names?.includes(name))
  );
  assert.ok(userNamespaceRule, "Chromium sandbox user-namespace syscalls must remain explicitly allowed");
  assert.match(smoke, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1/);
  assert.match(smoke, /SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2/);
  assert.match(smoke, /scripts\/smoke-deployed-scanner\.mjs/);
  assert.match(smoke, /report\.schemaVersion !== 2 \|\| report\.schemaRevision !== 2/);
  assert.match(smoke, /missing its provenance sidecar/);

  const deployedSmoke = readFileSync(path.join(root, "scripts", "smoke-deployed-scanner.mjs"), "utf8");
  assert.match(deployedSmoke, /https:\/\/www\.iana\.org\/domains\/reserved/);
  assert.doesNotMatch(deployedSmoke, /SMOKE_SHIELDS_URL=https:\/\/example\.com/);
});
