import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CURRENT_MEASUREMENT_LINE_METHODOLOGY, REVIEWED_MEASUREMENT_LINES } from "./corpus-cohort";
import {
  FIRST_WORKER_READING_OBSERVER,
  NEWEST_REVIEWED_OBSERVER,
  PAGE_ONLY_V1_METHODOLOGIES,
  WORKER_READING_SURFACE,
  fingerprintWorkerScope
} from "./fingerprint-worker-scope";
import { NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import type { DetectorLedgerView } from "./scan-report-views";

type ScopeInput = Parameters<typeof fingerprintWorkerScope>[0];
const v2Run = (version: string | null): ScopeInput => ({
  detectors: (version === null
    ? {}
    : { "fingerprint-heuristics": { version, status: "complete", reason: null, phaseId: null } }) as DetectorLedgerView,
  conditions: { disclosure: null } as ScopeInput["conditions"]
});
const v1Run = (disclosure: string | null): ScopeInput => ({
  detectors: null,
  conditions: { disclosure } as ScopeInput["conditions"]
});
const withToken = (token: string) =>
  `Automated Chromium scan from test with browser test, timezone UTC, locale en-US, the listed viewport, and Brave Shields classification only under methodology ${token}; treat results as reproducible evidence for this scan configuration.`;

test("a v2 arm is classed by its own observer version", () => {
  const cases: Array<[string | null, string]> = [
    ["fingerprint-observer@1", "page-only"],
    ["fingerprint-observer@4", "page-only"],
    ["fingerprint-observer@5", "workers-read"],
    ["fingerprint-observer@9", "workers-read"],
    ["fingerprint-observer@10", "workers-read"],
    ["fingerprint-observer@15", "workers-read"],
    [null, "unknown"],
    ["fingerprint-observer@0", "unknown"],
    ["fingerprint-observer@05", "unknown"],
    ["fingerprint-observer@5x", "unknown"],
    ["observer@5", "unknown"]
  ];
  for (const [version, scope] of cases) {
    assert.equal(fingerprintWorkerScope(v2Run(version)), scope, `observer ${version}: its class`);
  }
  assert.equal(FIRST_WORKER_READING_OBSERVER, 5, "worker reading began with observer @5");
});

test("a newer observer fails closed until it is reviewed", () => {
  assert.equal(
    fingerprintWorkerScope(v2Run(`fingerprint-observer@${NEWEST_REVIEWED_OBSERVER + 1}`)),
    "unknown",
    "an observer newer than the reviewed one is unknown"
  );
});

test("the current measurement line classifies as worker reading", () => {
  // A kernel or toolchain bump that forgets this module would move every new
  // scan to the unknown sentence. Both current lines must read as workers-read.
  assert.equal(
    DETECTOR_VERSIONS["fingerprint-heuristics"],
    `fingerprint-observer@${NEWEST_REVIEWED_OBSERVER}`,
    "the reviewed newest observer is the kernel's current observer"
  );
  assert.equal(
    fingerprintWorkerScope(v2Run(DETECTOR_VERSIONS["fingerprint-heuristics"])),
    "workers-read",
    "the kernel's current observer classifies as worker reading"
  );
  assert.equal(CURRENT_MEASUREMENT_LINE_METHODOLOGY, NODE_SCANNER_METHODOLOGY_VERSION, "the current line is the producer's token");
  assert.equal(
    fingerprintWorkerScope(v1Run(withToken(CURRENT_MEASUREMENT_LINE_METHODOLOGY))),
    "workers-read",
    "the current v1 measurement line classifies as worker reading"
  );
});

test("a v1 arm is classed by its methodology token alone", () => {
  for (const token of REVIEWED_MEASUREMENT_LINES) {
    const expected = token.split("+").includes(WORKER_READING_SURFACE) ? "workers-read" : "page-only";
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), expected, `reviewed line ${token}: its class`);
  }
  for (const token of [
    "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0",
    "shields-request-context-v2-adblock-rust-0.13.1-request-method-v1"
  ]) {
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), "page-only", `older shape ${token}: page-only`);
  }
  assert.equal(fingerprintWorkerScope(v1Run(null)), "unknown", "a v1 arm with no disclosure is unknown");
  assert.equal(fingerprintWorkerScope(v1Run("test")), "unknown", "a v1 arm with no token is unknown");
  assert.equal(
    fingerprintWorkerScope(v1Run("Methodology metadata was invalid and was removed at the public boundary.")),
    "unknown",
    "the removed-metadata sentinel is unknown"
  );
});

test("an unreviewed token fails closed", () => {
  const current = CURRENT_MEASUREMENT_LINE_METHODOLOGY;
  for (const token of [
    `${current}+x`,
    current.replace(`+${WORKER_READING_SURFACE}`, "+fingerprint-surface-v20"),
    current.replace("1.65.1", "1.99.0")
  ]) {
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), "unknown", `unreviewed token ${token}: unknown`);
  }
});

/**
 * The sanitizer's HISTORICAL_NODE_SCANNER_METHODOLOGIES is not exported and
 * stays out of the client bundle, so its literals are read from the source.
 * Every older token it keeps must be page-only here, and every page-only
 * literal here must be one it keeps: both ways, so neither list can gain or
 * lose a token alone.
 */
function sanitizerHistoricalMethodologies(): string[] {
  const source = readFileSync(path.join(process.cwd(), "lib", "redact-scan-report-v1.ts"), "utf8");
  const start = source.indexOf("const HISTORICAL_NODE_SCANNER_METHODOLOGIES");
  assert.ok(start !== -1, "the sanitizer still declares its historical methodologies");
  const end = source.indexOf("]);", start);
  assert.ok(end !== -1, "the sanitizer's historical methodologies end where expected");
  const literals = [...source.slice(start, end).matchAll(/^\s*"([^"]+)",?$/gm)].map((match) => match[1]);
  assert.ok(literals.length >= 5, "the sanitizer's historical methodologies were read");
  return literals;
}

test("every older token the sanitizer keeps is page-only, and only those", () => {
  const kept = sanitizerHistoricalMethodologies();
  const older = kept.filter((token) => !token.split("+").includes(WORKER_READING_SURFACE));
  assert.deepEqual([...PAGE_ONLY_V1_METHODOLOGIES].sort(), [...older].sort(), "the page-only list is the sanitizer's older list");
  for (const token of older) {
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), "page-only", `sanitizer's older token ${token}: page-only`);
  }
  for (const token of kept.filter((candidate) => candidate.split("+").includes(WORKER_READING_SURFACE))) {
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), "workers-read", `sanitizer's surface token ${token}: workers-read`);
  }
});

test("the older token shapes are the sanitizer's two patterns", () => {
  const source = readFileSync(path.join(process.cwd(), "lib", "redact-scan-report-v1.ts"), "utf8");
  assert.match(
    source,
    /String\.raw` methodology \(shields-request-context-v2-adblock-rust-\$\{CANONICAL_VERSION\}-request-method-v1-playwright-\(\$\{CANONICAL_VERSION\}\)\);`/,
    "the sanitizer still accepts the token that ends at the Playwright version"
  );
  assert.match(
    source,
    /String\.raw` methodology \(shields-request-context-v2-adblock-rust-\$\{CANONICAL_VERSION\}-request-method-v1\);`/,
    "the sanitizer still accepts the token that ends before it"
  );
  for (const [token, scope] of [
    ["shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0", "page-only"],
    ["shields-request-context-v2-adblock-rust-0.12.0-request-method-v1", "page-only"],
    ["shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-01.62.0", "unknown"],
    ["shields-request-context-v2-adblock-rust-0.13.2-request-method-v10", "unknown"],
    ["shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+x", "unknown"]
  ] as const) {
    assert.equal(fingerprintWorkerScope(v1Run(withToken(token))), scope, `shape ${token}: ${scope}`);
  }
});
