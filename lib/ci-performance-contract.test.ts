import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1);
  const next = ci.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

test("the existing required check fails for every unsuccessful parallel dependency", () => {
  const gate = job("app");
  assert.match(gate, /name: Typecheck, Unit Tests, Build\n/);
  assert.match(gate, /needs:\n\s+- tests\n\s+- pages\n/);
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(gate, /TEST_RESULT: \$\{\{ needs\.tests\.result \}\}/);
  assert.match(gate, /BUILD_RESULT: \$\{\{ needs\.pages\.result \}\}/);
  assert.doesNotMatch(gate, /continue-on-error/);
  const script = gate.split("        run: |\n")[1]?.replace(/^ {10}/gm, "").trim();
  assert.ok(script);
  for (const tests of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const builds of ["success", "failure", "cancelled", "skipped", ""]) {
      const result = spawnSync("bash", ["-c", script], {
        env: { ...process.env, TEST_RESULT: tests, BUILD_RESULT: builds }, encoding: "utf8"
      });
      assert.equal(result.status === 0, tests === "success" && builds === "success", `${tests}/${builds}: ${result.stderr}`);
    }
  }
});

test("tests and builds execute independently while preserving every validation step", () => {
  const tests = job("tests");
  const pages = job("pages");
  for (const lane of [tests, pages]) {
    assert.doesNotMatch(lane, /\n {4}(?:needs|if):|continue-on-error/);
    assert.match(lane, /fetch-depth: 0/);
    assert.match(lane, /run: npm ci\n/);
  }
  for (const command of ["typecheck", "cf:typecheck", "test:unit", "corrections:verify-history", "transparency:verify-history", "transparency:log:check", "verify:report", "calibration:pilot-carrier-gate"]) {
    assert.ok(tests.includes(`npm run ${command}`), command);
  }
  for (const command of ["build", "build:pages", "test:smoke:static", "release:evidence"]) {
    assert.ok(pages.includes(`npm run ${command}`), command);
  }
  assert.ok(pages.indexOf("npm run test:smoke:static") < pages.indexOf("npm run release:evidence"));
});

test("only superseded PR runs can be automatically cancelled", () => {
  const concurrency = ci.slice(ci.indexOf("\nconcurrency:"), ci.indexOf("\nenv:"));
  assert.match(concurrency, /github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id/);
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("Docker dependencies are independent of source identity while all source checks remain required", () => {
  const docker = readFileSync(path.join(root, "Dockerfile"), "utf8").split("FROM playwright-base AS build\n")[1];
  const install = docker.indexOf("RUN npm ci && npx playwright install chromium");
  const identity = docker.indexOf("ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT");
  const source = docker.indexOf("COPY . .");
  const checks = docker.indexOf("RUN npm run check");
  assert.ok(install > 0 && install < identity && identity < source && source < checks);
  assert.ok(docker.indexOf("ENV SITE_BEHAVIOR_LAB_BUILD_COMMIT=") < checks);
  assert.match(docker, /must be a full lowercase Git SHA/);
});
