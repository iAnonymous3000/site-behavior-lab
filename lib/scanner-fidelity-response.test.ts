import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type Tagged =
  | { kind: "answered"; report: unknown }
  | { kind: "refused"; reason: string }
  | { kind: "scanner-failure"; reason: string };

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const helpers = nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/scanner-fidelity-response.mjs")).href) as Promise<{
  readScannerFidelityResponse(response: Response, label: string): Promise<Tagged>;
  attemptScanRequest(scan: () => Promise<Tagged>): Promise<Tagged>;
  attemptRecord(
    site: { url: string; shape: string },
    repetition: number,
    result: Tagged,
    evaluation?: { failures: string[]; censored: string[]; observation?: unknown } | null
  ): Record<string, unknown>;
}>;
const sweepCauses = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts/calibration-reliability-sweep-response-lib.mjs")).href
) as Promise<{ SWEEP_TARGET_FAILURE_CAUSES: readonly string[]; SWEEP_SCAN_CAUSE_DISPOSITIONS: Record<string, string> }>;

const refusal = (status: number, cause?: string, error = "The scanner refused this scan.") =>
  Response.json({ ok: false, error, ...(cause === undefined ? {} : { cause }) }, { status });

async function classify(response: Response): Promise<Tagged> {
  const { attemptScanRequest, readScannerFidelityResponse } = await helpers;
  return attemptScanRequest(() => readScannerFidelityResponse(response, "scan"));
}

test("a refusal is the target's only when its declared cause is a ruled target cause, whatever the status", async () => {
  // The service answers a page that did not load with 504 and a failed page
  // load with 502. A status rule would turn third-party downtime into a red
  // gate; the declared cause is what the owner ruled on.
  assert.equal((await classify(refusal(504, "page-load-timeout"))).kind, "refused");
  assert.equal((await classify(refusal(502, "page-load-failed"))).kind, "refused");
  assert.equal((await classify(refusal(400, "private-target"))).kind, "refused");

  // Every ruled target cause, read from the sweep module rather than restated
  // here, is a refusal at a 5xx status.
  const { SWEEP_TARGET_FAILURE_CAUSES } = await sweepCauses;
  assert.ok(SWEEP_TARGET_FAILURE_CAUSES.length > 0, "the ruled target causes must not be empty");
  for (const cause of SWEEP_TARGET_FAILURE_CAUSES) {
    assert.equal((await classify(refusal(503, cause))).kind, "refused", cause);
  }
});

test("every other refusal, and every throw, is a scanner failure", async () => {
  assert.equal((await classify(refusal(503, "scanner-busy"))).kind, "scanner-failure", "a busy scanner");
  assert.equal((await classify(refusal(429, "request-limit"))).kind, "scanner-failure", "the scanner's own limit");
  assert.equal((await classify(refusal(500, "service-error"))).kind, "scanner-failure", "a service error");
  assert.equal(
    (await classify(refusal(500, "report-redaction-unstable"))).kind,
    "scanner-failure",
    "the scanner losing its own measurement"
  );
  assert.equal((await classify(refusal(502))).kind, "scanner-failure", "a cause-less 502");
  assert.equal(
    (await classify(refusal(400, undefined, "Host does not resolve."))).kind,
    "scanner-failure",
    "a cause-less 4xx"
  );
  assert.equal(
    (await classify(new Response("<html>bad gateway</html>", { status: 500 }))).kind,
    "scanner-failure",
    "an unreadable 5xx body"
  );
  assert.equal(
    (await classify(new Response("<html>not a report</html>"))).kind,
    "scanner-failure",
    "an unreadable 200 body"
  );

  // Every declared cause the sweep does not rule a target cause.
  const { SWEEP_SCAN_CAUSE_DISPOSITIONS, SWEEP_TARGET_FAILURE_CAUSES } = await sweepCauses;
  const others = Object.keys(SWEEP_SCAN_CAUSE_DISPOSITIONS).filter((cause) => !SWEEP_TARGET_FAILURE_CAUSES.includes(cause));
  assert.ok(others.length > 0);
  for (const cause of others) {
    assert.equal((await classify(refusal(503, cause))).kind, "scanner-failure", cause);
  }
});

test("a driver timeout or a transport error is a scanner failure, never a skipped target", async () => {
  const { attemptScanRequest } = await helpers;
  const timeout = await attemptScanRequest(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.equal(timeout.kind, "scanner-failure");
  const transport = await attemptScanRequest(async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(transport.kind, "scanner-failure");
  assert.match((transport as { reason: string }).reason, /fetch failed/);
});

test("fidelity keeps a site's failed visit report distinct from an admission refusal", async () => {
  const { readScannerFidelityResponse: read } = await helpers;
  const report = { run: { qualityFacts: { status: 403 }, quality: { run: { outcome: "failed" } } } };
  assert.deepEqual(await read(Response.json(report), "scan"), { kind: "answered", report });
  assert.deepEqual(await read(refusal(400, "target-unreachable", "Host does not resolve."), "scan"), {
    kind: "refused",
    reason: "Host does not resolve."
  });
});

test("each tagged result maps to its ledger outcome", async () => {
  const { attemptRecord } = await helpers;
  const site = { url: "https://example.com/", shape: "fixture" };
  assert.equal(attemptRecord(site, 1, { kind: "refused", reason: "gone" }).outcome, "scan-failure");
  assert.equal(attemptRecord(site, 1, { kind: "scanner-failure", reason: "HTTP 502" }).outcome, "scanner-failure");
  const answered = { kind: "answered", report: {} } as const;
  assert.equal(attemptRecord(site, 1, answered, { failures: [], censored: ["requests"] }).outcome, "pass");
  const failed = attemptRecord(site, 1, answered, { failures: ["a", "b"], censored: [] });
  assert.equal(failed.outcome, "invariant-failure");
  assert.equal(failed.reason, "a | b");
  assert.throws(() => attemptRecord(site, 1, answered));
});
