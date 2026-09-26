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
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const [, afterDeps] = dockerfile.split("FROM playwright-base AS deps\n");
  assert.ok(afterDeps, "the reusable dependency layers must form the deps stage");
  const [deps, build] = afterDeps.split("FROM deps AS build\n");
  assert.ok(build, "the build stage must start from exactly those dependency layers");
  assert.ok(deps.indexOf("COPY package.json package-lock.json ./") < deps.indexOf("RUN npm ci && npx playwright install chromium"));
  for (const sourceBound of ["ARG ", "COPY . .", "SITE_BEHAVIOR_LAB_BUILD_COMMIT", "RUN npm run check"]) {
    assert.ok(!deps.includes(sourceBound), `the cached deps stage must not depend on ${sourceBound.trim()}`);
  }
  const identity = build.indexOf("ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT");
  const source = build.indexOf("COPY . .");
  const checks = build.indexOf("RUN npm run check");
  assert.ok(identity >= 0 && identity < source && source < checks);
  assert.ok(build.indexOf("ENV SITE_BEHAVIOR_LAB_BUILD_COMMIT=") < checks);
  assert.match(build, /must be a full lowercase Git SHA/);
  assert.match(dockerfile, /^COPY --from=build \/app\/node_modules \.\/node_modules$/m);
});

test("Docker cache reuse still builds and exercises the exact checkout before recording evidence", () => {
  const docker = job("docker");
  const build = docker.indexOf("- name: Build exact deployable Docker image");
  const smoke = docker.indexOf("- name: Smoke deployable Docker image");
  const evidence = docker.indexOf("- name: Record exact-SHA container build evidence");
  assert.ok(build > 0 && smoke > build && evidence > smoke);
  assert.match(docker, /test "\$commit" = "\$GITHUB_SHA"/);
  assert.match(docker, /proof=\$\(node scripts\/measurement-candidate-build-proof\.mjs\)/);
  const buildStep = docker.slice(build, docker.indexOf("- name: Finish installing host Chromium"));
  assert.ok(buildStep.length > 0 && docker.indexOf("- name: Finish installing host Chromium") < smoke);
  assert.match(buildStep, /context: \.\n/);
  assert.match(buildStep, /load: true\n\s+push: false/);
  assert.match(buildStep, /SITE_BEHAVIOR_LAB_BUILD_COMMIT=\$\{\{ steps\.container_inputs\.outputs\.commit \}\}/);
  assert.match(buildStep, /SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=\$\{\{ steps\.container_inputs\.outputs\.proof \}\}/);
  assert.match(buildStep, /cache-from: type=gha,scope=scanner-amd64-v1,version=2\n/);
  // Every layer of this build after COPY . . is specific to one commit, so the
  // exact image never exports cache; only the deps stage refresh below does.
  assert.doesNotMatch(buildStep, /cache-to:|target:/);
  assert.doesNotMatch(buildStep, /continue-on-error|\n\s+if:/);
  const refresh = docker.slice(docker.indexOf("- name: Refresh the dependency-layer cache"), build);
  assert.ok(docker.indexOf("- name: Refresh the dependency-layer cache") > 0, "the deps cache refresh must precede the exact build");
  assert.match(refresh, /target: deps\n/);
  assert.match(refresh, /push: false\n/);
  assert.doesNotMatch(refresh, /load: true|build-args:|tags:/);
  assert.match(refresh, /cache-from: type=gha,scope=scanner-amd64-v1,version=2\n/);
  assert.match(refresh, /cache-to: type=gha,scope=scanner-amd64-v1,version=2,mode=max\n/);
  assert.doesNotMatch(refresh, /continue-on-error|\n\s+if:/);
  // The smoke step's host browser installs in the background during the
  // build; the smoke cannot start until that exact install has succeeded.
  const start = docker.slice(docker.indexOf("- name: Start installing host Chromium"), docker.indexOf("- name: Set up Docker layer caching"));
  assert.match(start, /npx playwright install --with-deps chromium > "\$RUNNER_TEMP\/host-chromium-install\.log" 2>&1; echo "\$\?" > "\$RUNNER_TEMP\/host-chromium-install\.status"/);
  const finish = docker.slice(docker.indexOf("- name: Finish installing host Chromium"), smoke);
  assert.match(finish, /exit "\$\(cat "\$RUNNER_TEMP\/host-chromium-install\.status"\)"/);
  for (const step of [start, finish]) assert.doesNotMatch(step, /continue-on-error|\n\s+if:/);
  const smokeStep = docker.slice(smoke, docker.indexOf("- name: Scan smoke-tested container image with Trivy"));
  assert.match(smokeStep, /DOCKER_SMOKE_SKIP_BUILD: "1"/);
  assert.match(smokeStep, /DOCKER_SMOKE_PUBLIC_R2: "1"/);
  assert.doesNotMatch(smokeStep, /continue-on-error|\n\s+if:/);
});
