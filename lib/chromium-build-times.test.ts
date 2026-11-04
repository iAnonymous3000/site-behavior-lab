import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";

/**
 * The Chromium build-time table behind the CI warning that the scan browser is
 * near its HSTS preload cutoff (scripts/chromium-hsts-preload-cutoff.mjs).
 *
 * Chromium stops applying its built-in HSTS preload list 70 days after its
 * build. On 2026-11-03 the owner delegated the choice of what to do about it,
 * and the recommendation taken was to keep the scan browser inside those days,
 * with a warning ahead of each cutoff rather than a block, so a toolchain epoch
 * must land before each cutoff. The table records each build's
 * version tag commit; the cutoff is estimated from it, an assumption one lapse
 * has confirmed so far (153.0.8010.12 on 2026-11-03).
 *
 * These tests check consistency, never the calendar: the table is well formed,
 * the Chromium the installed playwright-core bundles has an entry, CI runs the
 * warning, and the warning exits 0 on every path. They pass the instant under
 * test to the script, so none reads the clock. A Playwright move whose
 * browsers.json names a Chromium without an entry fails here until its
 * version tag's commit time is recorded. What fails on the date itself is
 * lib/scan-browser-hsts-preload.test.ts, once the browser stops applying the
 * list.
 */

type Build = { tagCommit: string; committedAt: string; bundledBy: string };
type BrowsersJson = { browsers: Array<{ name: string; revision: string; browserVersion?: string }> };

const ROOT = process.cwd();
const SCRIPT = path.join("scripts", "chromium-hsts-preload-cutoff.mjs");
const builds = (JSON.parse(readFileSync(path.join(ROOT, "scripts", "chromium-build-times.json"), "utf8")) as {
  builds: Record<string, Build>;
}).builds;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}

function runCutoff(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSyncBounded(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("every recorded Chromium build names its version tag's commit and commit time, in version order", () => {
  const versions = Object.keys(builds);
  assert.ok(versions.length > 0);
  for (const [version, build] of Object.entries(builds)) {
    assert.match(version, /^\d+\.\d+\.\d+\.\d+$/, version);
    assert.deepEqual(Object.keys(build).sort(), ["bundledBy", "committedAt", "tagCommit"], version);
    assert.match(build.tagCommit, /^[0-9a-f]{40}$/, version);
    assert.match(build.committedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, version);
    assert.equal(new Date(build.committedAt).toISOString().replace(".000Z", "Z"), build.committedAt, version);
    assert.ok(build.bundledBy.trim().length > 0, version);
  }
  const sorted = [...versions].sort((a, b) => {
    const [left, right] = [versionParts(a), versionParts(b)];
    for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  });
  assert.deepEqual(versions, sorted);
  assert.equal(new Set(Object.values(builds).map((build) => build.tagCommit)).size, versions.length);
});

test("the Chromium the installed playwright-core bundles has a recorded build time", () => {
  const installed = JSON.parse(
    readFileSync(path.join(ROOT, "node_modules", "playwright-core", "browsers.json"), "utf8")
  ) as BrowsersJson;
  const chromium = installed.browsers.filter((browser) => browser.name === "chromium" || browser.name === "chromium-headless-shell");
  assert.deepEqual(chromium.map((browser) => browser.name).sort(), ["chromium", "chromium-headless-shell"]);
  for (const browser of chromium) {
    assert.ok(browser.browserVersion, `${browser.name} names no browserVersion`);
    assert.ok(
      Object.hasOwn(builds, browser.browserVersion),
      `scripts/chromium-build-times.json has no entry for ${browser.name} ${browser.browserVersion}; record its version tag's commit and commit time (gh api repos/chromium/chromium/git/ref/tags/${browser.browserVersion}, then the commit)`
    );
  }
});

test("CI runs the cutoff warning in the Chromium smoke job on every push to main, after its install, under no condition", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  // The workflow runs on every push to main: no path, tag or branch filter
  // beside the branch.
  const triggers = ci.slice(ci.indexOf("\non:\n") + 1, ci.indexOf("\npermissions:"));
  const push = triggers.slice(triggers.indexOf("\n  push:\n") + 1).split(/\n(?= {2}[\w-]+:)/)[0];
  assert.equal(push.trimEnd(), "  push:\n    branches:\n      - main");
  const start = ci.indexOf("\n  smoke:\n");
  assert.notEqual(start, -1);
  const rest = ci.slice(start + 1);
  const end = rest.search(/\n  [\w-]+:\n/);
  const smoke = end < 0 ? rest : rest.slice(0, end);
  // Every job-level key, wherever it sits in the block (YAML key order is
  // free, so one after the last step counts too), must be one this test knows
  // cannot keep the job from running. A job-level if:, needs:, strategy: or any
  // key not listed fails, and so does a line at that indent that is not a bare
  // key, such as a quoted "if": or if :.
  const allowed = ["name", "runs-on", "timeout-minutes", "steps", "permissions", "env", "defaults", "outputs"];
  const jobLines = smoke.split("\n").slice(1).filter((line) => /^ {4}\S/.test(line) && !/^ {4}#/.test(line));
  const jobKeys = jobLines.map((line) => {
    const key = /^ {4}([\w-]+):(?:\s|$)/.exec(line)?.[1];
    assert.ok(key, `the smoke job's line ${JSON.stringify(line)} is not a bare key, so this test cannot tell whether it keeps the job from running`);
    return key;
  });
  assert.ok(jobKeys.includes("runs-on") && jobKeys.includes("steps"), jobKeys.join(", "));
  for (const key of jobKeys) {
    assert.ok(allowed.includes(key), `the smoke job's ${key}: is not on this test's list of job keys that cannot keep the job from running (${allowed.join(", ")}); review it before extending the list`);
  }
  assert.equal(new Set(jobKeys).size, jobKeys.length, `a repeated job key: ${jobKeys.join(", ")}`);
  const step = smoke.indexOf("        run: node scripts/chromium-hsts-preload-cutoff.mjs\n");
  assert.ok(step > smoke.indexOf("        run: npm ci\n"), "the warning must run after npm ci installs playwright-core");
  const block = smoke.slice(smoke.lastIndexOf("      - name:", step), smoke.indexOf("\n\n", step));
  assert.doesNotMatch(block, /\n\s+if:|continue-on-error/);
});

test("the warning prints under three weeks before the estimated cutoff and after it, and always exits 0", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "chromium-cutoff-"));
  try {
    const browsersFor = (version: string, shellVersion = version): string => {
      const file = path.join(directory, `browsers-${version}-${shellVersion}.json`);
      writeFileSync(file, JSON.stringify({
        browsers: [
          { name: "chromium", revision: "1", browserVersion: version },
          { name: "chromium-headless-shell", revision: "1", browserVersion: shellVersion },
          { name: "firefox", revision: "2", browserVersion: "1.0" }
        ]
      }));
      return file;
    };
    const version = "156.0.8078.4";
    const cutoff = Date.parse(builds[version].committedAt) + 70 * MS_PER_DAY;
    const at = (offsetDays: number): string => new Date(cutoff + offsetDays * MS_PER_DAY).toISOString();
    const cases: Array<[string, string, RegExp]> = [
      ["22 days before", at(-22), /^Chromium 156\.0\.8078\.4 applies its HSTS preload list until 2026-12-08T23:57:21\.000Z, 22 days from now/],
      ["21 days before", at(-21), /^Chromium 156\.0\.8078\.4 applies its HSTS preload list until/],
      ["just under 21 days before", at(-20.99), /^::warning title=Chromium HSTS preload cutoff in under three weeks::Chromium 156\.0\.8078\.4 stops applying its HSTS preload list in 20 days/],
      ["one day before", at(-1), /^::warning title=Chromium HSTS preload cutoff in under three weeks::.* in 1 day, at/],
      ["at the cutoff", at(0), /^::warning title=Chromium HSTS preload list lapsed::/],
      ["a day after", at(1), /^::warning title=Chromium HSTS preload list lapsed::/]
    ];
    for (const [label, now, expected] of cases) {
      const result = runCutoff(["--now", now, "--browsers", browsersFor(version)]);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.equal(result.stderr, "", label);
      const lines = result.stdout.trimEnd().split("\n");
      assert.equal(lines.length, 1, `${label}: one Chromium version, one line: ${result.stdout}`);
      assert.match(lines[0], expected, label);
    }
    // The headless shell the scanner launches and the full build are read
    // apart: when they differ, each gets its own line.
    const split = runCutoff(["--now", at(-22), "--browsers", browsersFor(version, "156.0.8078.80")]);
    assert.equal(split.status, 0, split.stderr);
    assert.deepEqual(
      split.stdout.trimEnd().split("\n").map((line) => /^Chromium (\S+) applies/.exec(line)?.[1]).sort(),
      ["156.0.8078.4", "156.0.8078.80"]
    );
    // A version with no entry, and a run that cannot read its input, warn and exit 0.
    const unrecorded = runCutoff(["--now", at(-40), "--browsers", browsersFor("999.0.0.1")]);
    assert.equal(unrecorded.status, 0);
    assert.match(unrecorded.stdout, /^::warning title=Chromium build time unrecorded::Chromium 999\.0\.0\.1 has no entry/);
    const unreadable = runCutoff(["--now", at(-40), "--browsers", path.join(directory, "missing.json")]);
    assert.equal(unreadable.status, 0);
    assert.match(unreadable.stdout, /^::warning title=Chromium HSTS preload cutoff unchecked::/);
    const malformed = runCutoff(["--now", "not a time"]);
    assert.equal(malformed.status, 0);
    assert.match(malformed.stdout, /^::warning title=Chromium HSTS preload cutoff unchecked::/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
