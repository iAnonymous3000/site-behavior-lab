import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listStaticReportCandidateIds } from "./static-report-files";

/**
 * Behavior tests for the reader-facing verifier, run as a subprocess because
 * that is how a reader runs it. A verifier is only worth publishing if it can
 * be shown to fail, so every check here pairs an honest bundle with a tampered
 * one.
 */

const root = process.cwd();
const cliPath = path.join(root, ".unit-test-dist", "lib", "verify-published-report-cli.js");
const reportsDir = path.join(root, "public", "reports");

function runCli(args: readonly string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function fixtureBundle(): Promise<{ dir: string; id: string }> {
  const ids = await listStaticReportCandidateIds(reportsDir);
  const id = ids[0];
  assert.ok(id, "the committed corpus must contain at least one report");
  const dir = mkdtempSync(path.join(tmpdir(), "verify-report-"));
  mkdirSync(dir, { recursive: true });
  for (const name of [`${id}.json`, `${id}.provenance.json`, "index.json"]) {
    copyFileSync(path.join(reportsDir, name), path.join(dir, name));
  }
  return { dir, id };
}

test("an untampered committed bundle verifies and exits zero", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Verified: these bytes are exactly what this project published/);
    assert.doesNotMatch(result.stdout, /FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed recorded value fails both the index and the canonical digest", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const reportPath = path.join(dir, `${id}.json`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    report.title = "TAMPERED";
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NOT VERIFIED/);
    assert.match(result.stdout, /FAIL {2}wire digest vs published index/);
    assert.match(result.stdout, /FAIL {2}managed report validation\s+digest-mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a whitespace-only edit still fails, because the index pins exact bytes", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    // Canonicalization is deliberately whitespace-insensitive, so the sidecar
    // digest still matches here. That is exactly why the published index is
    // checked independently: without it, a reformatted republish would pass.
    const reportPath = path.join(dir, `${id}.json`);
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8")}\n`);

    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL {2}wire digest vs published index/);
    assert.match(result.stdout, /ok {4}canonical digest vs sidecar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report absent from the published index is reported, not silently accepted", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ generatedAt: "", reports: [] }));
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not listed in reports\/index\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full report URL is accepted, since that is what a reader has in hand", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    const result = runCli([`https://sitebehavior.org/reports/${id}/`, "--from", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`Verifying ${id}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed ids, unknown options, and unsafe origins are refused before any read", () => {
  const badId = runCli(["not-a-report-id", "--from", reportsDir]);
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /is not a report id/);

  const unknownOption = runCli(["--wat"]);
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /Unknown option/);

  const noArgs = runCli([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /Usage/);

  const insecureOrigin = runCli([`20260101-${"a".repeat(32)}`, "--origin", "http://example.test"]);
  assert.equal(insecureOrigin.status, 1);
  assert.match(insecureOrigin.stderr, /must be https/);
});

test("the boundary is printed on success as well as failure", async () => {
  const { dir, id } = await fixtureBundle();
  try {
    // A verifier that prints only "verified" invites the reading that
    // everything about the report is settled. The limits ship with the result.
    const result = runCli([id, "--from", dir]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /This command does not prove:/);
    assert.match(result.stdout, /describe what the site actually did/);
    assert.match(result.stdout, /Sigstore attestation/);
    assert.match(result.stdout, /coverage-boundary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
