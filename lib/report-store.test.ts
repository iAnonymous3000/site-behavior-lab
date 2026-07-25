import assert from "node:assert/strict";
import { R2_LIST_MAX_HEAD_CANDIDATES } from "./report-store-r2";
import { access, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BoundedUtf8FileReadError } from "./bounded-utf8-file";
import { createComparisonReport, createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, matchProvenance } from "./redaction-provenance";
import { REDACTION_VERSION } from "./redaction-v2";
import {
  DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS,
  REPORT_MIN_SURVIVAL_MS_ENV,
  REPORT_STORE_OPERATION_TIMEOUT_MS_ENV,
  commitPreparedScanReportBundle,
  isScanReportPublicationManifest,
  maintainReportStoreRetention,
  prepareScanReportBundle,
  pruneStoredReports,
  reportStoreRetentionStatus,
  readStoredScanReportById,
  reconcilePreparedScanReportBundle,
  reportStoreStatus,
  saveScanReport
} from "./report-store";
import { makeGpcInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";
import { redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";

const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const R2_ENV_NAMES = [
  "SITE_BEHAVIOR_LAB_R2_BUCKET",
  "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
  "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
  "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY",
  "SITE_BEHAVIOR_LAB_R2_PREFIX"
] as const;
const originalFetch = globalThis.fetch;

/**
 * The clock these fixtures publish under, anchored to the current run.
 *
 * It used to be the fixed literal 2026-07-18T12:00:00.000Z. These bundles are
 * committed through the REAL retention policy, whose default max age is seven
 * days, so the fixture quietly became a time bomb: at 2026-07-25T12:00Z the
 * pinned date aged out of the window, every commit-and-read test began
 * resolving "not-found", and CI went red on the wall clock with no code change.
 * The same failure mode took the 2026-07-06 Brave-list refresh red at its
 * "Run unit tests against the new snapshot" step.
 *
 * One minute ago is inside every retention window, and staying a single
 * constant keeps each test deterministic within its own run.
 */
const FIXTURE_NOW = new Date(Date.now() - 60_000);

// Every test runs against its own temp directory via the store-dir env var.
// Never write to (or worse, delete) the repo's real `.site-behavior-lab`
// default store: a developer running the tests next to a dev server would
// lose their actual saved reports.
let reportDir = "";

beforeEach(async () => {
  reportDir = await mkdtemp(path.join(tmpdir(), "sbl-report-store-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;
});

afterEach(async () => {
  delete process.env[REPORT_MAX_COUNT_ENV];
  delete process.env[REPORT_MIN_SURVIVAL_MS_ENV];
  delete process.env[REPORT_STORE_BACKEND_ENV];
  delete process.env[REPORT_STORE_OPERATION_TIMEOUT_MS_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  for (const name of R2_ENV_NAMES) delete process.env[name];
  globalThis.fetch = originalFetch;
  await rm(reportDir, { recursive: true, force: true });
});

// The old v1-narrowing readScanReport wrapper is gone (no production callers);
// these tests read through the typed accessor and narrow the same way.
async function readV1Report(id: string) {
  const result = await readStoredScanReportById(id);
  return result.outcome === "found" && result.stored.schemaVersion === 1 ? result.stored.report : null;
}

test("the stored-report read rejects invalid report IDs", async () => {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "20260618-12345678.json"), "{}\n");

  assert.equal(await readV1Report("../escape"), null);
  assert.equal(await readV1Report("20260618-not-hex"), null);
  assert.equal(await readV1Report("20260618-12345678"), null);
});

test("the stored-report read rejects malformed persisted reports", async () => {
  await mkdir(reportDir, { recursive: true });

  const malformedShapeId = "20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const malformedJsonId = "20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeFile(path.join(reportDir, `${malformedShapeId}.json`), "{}\n");
  await writeFile(path.join(reportDir, `${malformedJsonId}.json`), "{\n");

  assert.equal(await readV1Report(malformedShapeId), null);
  assert.equal(await readV1Report(malformedJsonId), null);
});

test("the stored-report read rejects malformed comparison reports", async () => {
  await mkdir(reportDir, { recursive: true });

  const malformedComparisonId = "20260618-cccccccccccccccccccccccccccccccc";
  await writeFile(
    path.join(reportDir, `${malformedComparisonId}.json`),
    `${JSON.stringify({
      ok: true,
      schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
      reportType: "comparison",
      comparisonType: "gpc",
      warnings: [],
      baseline: {},
      variant: {}
    })}\n`
  );

  assert.equal(await readV1Report(malformedComparisonId), null);
});

test("readStoredScanReportById answers typed outcomes instead of silent null", async () => {
  await mkdir(reportDir, { recursive: true });

  // Missing and expired reads are "not-found"; malformed bytes and deep-shape
  // violations are "unreadable", so callers can answer 404 vs 500 honestly.
  const missing = await readStoredScanReportById("20260618-dddddddddddddddddddddddddddddddd");
  assert.deepEqual(missing, { outcome: "not-found" });

  const corruptId = "20260618-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  await writeFile(path.join(reportDir, `${corruptId}.json`), "{\n");
  assert.deepEqual(await readStoredScanReportById(corruptId), { outcome: "unreadable", error: "invalid" });

  // The exact shallow-validator escape that used to crash the request table:
  // arrays exist but an entry is null. The deep reader rejects it as typed.
  const nullEntryId = "20260618-ffffffffffffffffffffffffffffffff";
  const nullEntryReport = { ...makeScanResult(), requests: [null] };
  await writeFile(path.join(reportDir, `${nullEntryId}.json`), `${JSON.stringify(nullEntryReport)}\n`);
  const nullEntryRead = await readStoredScanReportById(nullEntryId);
  assert.equal(nullEntryRead.outcome, "unreadable");
  if (nullEntryRead.outcome !== "unreadable") throw new Error("expected unreadable");
  assert.equal(nullEntryRead.error, "invalid");

  const saved = await saveScanReport(makeScanResult());
  const found = await readStoredScanReportById(saved.share?.id || "");
  assert.equal(found.outcome, "found");
  if (found.outcome !== "found") throw new Error("expected found");
  assert.equal(found.stored.schemaVersion, 1);
  // The wire is the stored bytes verbatim, so API responses never re-serialize.
  assert.deepEqual(JSON.parse(found.wire), JSON.parse(JSON.stringify({ ...saved, screenshot: null })));
});

test("saveScanReport creates strongly random share IDs", async () => {
  const saved = await saveScanReport(makeScanResult());
  assert.match(saved.share?.id || "", /^[0-9]{8}-[0-9a-f]{32}$/);
});

test("saveScanReport writes a matched report, sidecar, and immutable retention clock", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const report = JSON.parse(await readFile(path.join(reportDir, `${id}.json`), "utf8")) as unknown;
  const sidecar = JSON.parse(await readFile(path.join(reportDir, `${id}.provenance.json`), "utf8")) as {
    reportId: string;
    createdAt: string;
    expiresAt: string;
  };
  const retention = JSON.parse(await readFile(path.join(reportDir, `${id}.retention.json`), "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };

  assert.equal(matchProvenance(report, sidecar, id).status, "matched");
  assert.deepEqual(retention, { createdAt: sidecar.createdAt, expiresAt: sidecar.expiresAt });
  assert.equal(Date.parse(retention.expiresAt) - Date.parse(retention.createdAt), 7 * 24 * 60 * 60 * 1_000);
});

test("prepareScanReportBundle freezes a strict content-free manifest and exact public wires", () => {
  const shareId = `20260718-${"1".repeat(32)}`;
  const prepared = prepareScanReportBundle(
    makeScanResult({ screenshot: "data:image/png;base64,PRIVATE_SCREENSHOT" }),
    { shareId, now: FIXTURE_NOW }
  );
  const roundTripped = JSON.parse(JSON.stringify(prepared.manifest)) as unknown;

  assert.equal(isScanReportPublicationManifest(roundTripped), true);
  assert.deepEqual(roundTripped, prepared.manifest);
  assert.equal(prepared.report.share?.id, shareId);
  assert.equal(prepared.report.screenshot, "data:image/png;base64,PRIVATE_SCREENSHOT");
  assert.equal(prepared.reportWire.includes("PRIVATE_SCREENSHOT"), false);
  assert.equal(prepared.sidecarWire, prepared.manifest.sidecarWire);
  assert.deepEqual(prepared.retention, prepared.manifest.retention);
  assert.equal(prepared.manifest.reportBytes, Buffer.byteLength(prepared.reportWire, "utf8"));
  assert.match(prepared.manifest.reportWireSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(prepared.manifest).includes("example.com"), false);
  assert.deepEqual(Object.keys(prepared.manifest).sort(), [
    "canonicalizationVersion",
    "manifestVersion",
    "publicDigest",
    "redactionVersion",
    "reportBytes",
    "reportId",
    "reportWireSha256",
    "retention",
    "sidecarWire"
  ]);
  assert.equal(
    isScanReportPublicationManifest({ ...prepared.manifest, target: "https://example.com/" }),
    false
  );
  assert.equal(
    isScanReportPublicationManifest({ ...prepared.manifest, sidecarWire: "{}\n" }),
    false
  );
});

test("commit and reconcile preserve the exact prepared report bundle", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"2".repeat(32)}`,
    now: FIXTURE_NOW
  });

  const saved = await commitPreparedScanReportBundle(prepared);
  const reconciled = await reconcilePreparedScanReportBundle(prepared.manifest);

  assert.equal(saved.share?.id, prepared.manifest.reportId);
  assert.equal(reconciled.outcome, "found");
  if (reconciled.outcome !== "found") throw new Error("expected found");
  assert.equal(reconciled.wire, prepared.reportWire);
  assert.deepEqual(reconciled.report, JSON.parse(prepared.reportWire));
  assert.equal(
    await readFile(path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`), "utf8"),
    prepared.sidecarWire
  );
});

test("reconciliation completes an exact report-only crash window", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"3".repeat(32)}`,
    now: FIXTURE_NOW
  });
  await writePrimaryOnly(prepared.manifest.reportId, prepared.reportWire, prepared.retention);

  const reconciled = await reconcilePreparedScanReportBundle(prepared.manifest);

  assert.equal(reconciled.outcome, "found");
  if (reconciled.outcome !== "found") throw new Error("expected found");
  assert.equal(reconciled.wire, prepared.reportWire);
  assert.equal(
    await readFile(path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`), "utf8"),
    prepared.sidecarWire
  );
});

test("reconciliation distinguishes missing storage and fails a stable exact sidecar orphan closed", async () => {
  const missing = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"4".repeat(32)}`,
    now: FIXTURE_NOW
  });
  assert.deepEqual(await reconcilePreparedScanReportBundle(missing.manifest), { outcome: "missing" });

  const orphan = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"5".repeat(32)}`,
    now: FIXTURE_NOW
  });
  const orphanPath = path.join(reportDir, `${orphan.manifest.reportId}.provenance.json`);
  await writeFile(orphanPath, orphan.sidecarWire);

  assert.deepEqual(await reconcilePreparedScanReportBundle(orphan.manifest), {
    outcome: "integrity-error",
    reason: "sidecar-without-report"
  });
  assert.equal(await readFile(orphanPath, "utf8"), orphan.sidecarWire);
});

test("commit adopts an exact preexisting sidecar only after the primary makes the full bundle valid", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"d".repeat(32)}`,
    now: FIXTURE_NOW
  });
  await writeFile(
    path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`),
    prepared.sidecarWire
  );

  const saved = await commitPreparedScanReportBundle(prepared);

  assert.equal(saved.share?.id, prepared.manifest.reportId);
  const stored = await readStoredScanReportById(prepared.manifest.reportId);
  assert.equal(stored.outcome, "found");
  if (stored.outcome !== "found") throw new Error("expected adopted report");
  assert.equal(stored.wire, prepared.reportWire);
});

test("R2 reconciliation never deletes a concurrent exact commit after a missing-primary snapshot", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"e".repeat(32)}`,
    now: FIXTURE_NOW
  });
  let reportPresent = false;
  let sidecarPresent = false;
  let primaryReads = 0;
  const methods: string[] = [];
  configureFakeR2(async (request) => {
    methods.push(request.method);
    const isSidecar = request.url.endsWith(".json.provenance.json");
    if (request.method === "GET" && !isSidecar) {
      primaryReads += 1;
      if (primaryReads === 1) {
        // The GET observed 404, then another container completed both PUTs
        // before reconciliation could read the sidecar.
        reportPresent = true;
        sidecarPresent = true;
        return new Response(null, { status: 404 });
      }
      return reportPresent ? r2ReportResponse(prepared) : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && isSidecar) {
      return sidecarPresent
        ? new Response(prepared.sidecarWire, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (request.method === "DELETE" && isSidecar) {
      sidecarPresent = false;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fake R2 request: ${request.method} ${request.url}`);
  });

  const reconciled = await reconcilePreparedScanReportBundle(prepared.manifest);

  assert.equal(reconciled.outcome, "found");
  assert.equal(reportPresent, true);
  assert.equal(sidecarPresent, true);
  assert.equal(methods.includes("DELETE"), false);
});

test("commit adopts an exact R2 sidecar whose successful PUT response was lost", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"f".repeat(32)}`,
    now: FIXTURE_NOW
  });
  let reportPresent = false;
  let sidecarPresent = false;
  let sidecarPuts = 0;
  const methods: string[] = [];
  configureFakeR2(async (request) => {
    methods.push(request.method);
    const isSidecar = request.url.endsWith(".json.provenance.json");
    const isList = request.url.includes("list-type=2");
    if (request.method === "PUT" && !isSidecar) {
      reportPresent = true;
      return new Response(null, { status: 200 });
    }
    if (request.method === "PUT" && isSidecar) {
      sidecarPuts += 1;
      if (sidecarPuts === 1) {
        sidecarPresent = true;
        throw new Error("response lost after sidecar commit");
      }
      return new Response("denied", { status: 403 });
    }
    if (request.method === "GET" && isList) {
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", {
        status: 200
      });
    }
    if (request.method === "GET" && isSidecar) {
      return sidecarPresent
        ? new Response(prepared.sidecarWire, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (request.method === "GET" && !isSidecar) {
      return reportPresent ? r2ReportResponse(prepared) : new Response(null, { status: 404 });
    }
    if (request.method === "DELETE") {
      throw new Error("An outcome-unknown sidecar write must never trigger cleanup.");
    }
    throw new Error(`Unexpected fake R2 request: ${request.method} ${request.url}`);
  });

  const saved = await commitPreparedScanReportBundle(prepared);

  assert.equal(saved.share?.id, prepared.manifest.reportId);
  assert.equal(reportPresent, true);
  assert.equal(sidecarPresent, true);
  assert.equal(methods.includes("DELETE"), false);
});

test("an aborted publication waiting on the mutation lock rejects promptly and never reaches R2", async () => {
  const blocking = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"a".repeat(32)}`,
    now: FIXTURE_NOW
  });
  const queued = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"b".repeat(32)}`,
    now: FIXTURE_NOW
  });
  let releaseFirstRead: () => void = () => undefined;
  let announceFirstRead: () => void = () => undefined;
  const firstReadStarted = new Promise<void>((resolve) => {
    announceFirstRead = resolve;
  });
  const heldFirstRead = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const requestedIds: string[] = [];
  configureFakeR2(async (request) => {
    const id = request.url.includes(blocking.manifest.reportId)
      ? blocking.manifest.reportId
      : queued.manifest.reportId;
    requestedIds.push(id);
    if (id === queued.manifest.reportId) {
      throw new Error("An aborted queued publication must never reach R2.");
    }
    if (request.method !== "GET") throw new Error(`Unexpected ${request.method} while holding the lock.`);
    if (!request.url.endsWith(".json.provenance.json")) {
      announceFirstRead();
      await heldFirstRead;
    }
    return new Response(null, { status: 404 });
  });

  const holder = reconcilePreparedScanReportBundle(blocking.manifest);
  await firstReadStarted;
  const controller = new AbortController();
  const reason = new DOMException("publication deadline", "TimeoutError");
  const waiting = commitPreparedScanReportBundle(queued, { signal: controller.signal });
  controller.abort(reason);

  await assert.rejects(() => waiting, (error) => error === reason);
  releaseFirstRead();
  assert.deepEqual(await holder, { outcome: "missing" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requestedIds, [blocking.manifest.reportId, blocking.manifest.reportId]);
});

test("reconciliation never mutates contradictory report, retention, or sidecar state", async (t) => {
  await t.test("report digest mismatch", async () => {
    const prepared = prepareScanReportBundle(makeScanResult(), {
      shareId: `20260718-${"6".repeat(32)}`,
      now: FIXTURE_NOW
    });
    const contradictoryWire = prepared.reportWire.replace("example.com", "example.net");
    assert.equal(Buffer.byteLength(contradictoryWire), prepared.manifest.reportBytes);
    await writePrimaryOnly(prepared.manifest.reportId, contradictoryWire, prepared.retention);

    assert.deepEqual(await reconcilePreparedScanReportBundle(prepared.manifest), {
      outcome: "integrity-error",
      reason: "report-digest-mismatch"
    });
    assert.equal(
      await readFile(path.join(reportDir, `${prepared.manifest.reportId}.json`), "utf8"),
      contradictoryWire
    );
    await assert.rejects(
      () => access(path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`)),
      /ENOENT/
    );
  });

  await t.test("retention mismatch", async () => {
    const prepared = prepareScanReportBundle(makeScanResult(), {
      shareId: `20260718-${"7".repeat(32)}`,
      now: FIXTURE_NOW
    });
    const contradictoryRetention = {
      createdAt: new Date(FIXTURE_NOW.getTime() + 1_000).toISOString(),
      expiresAt: new Date(FIXTURE_NOW.getTime() + 1_000 + 7 * 24 * 60 * 60 * 1_000).toISOString()
    };
    await writePrimaryOnly(prepared.manifest.reportId, prepared.reportWire, contradictoryRetention);

    assert.deepEqual(await reconcilePreparedScanReportBundle(prepared.manifest), {
      outcome: "integrity-error",
      reason: "retention-mismatch"
    });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(reportDir, `${prepared.manifest.reportId}.retention.json`), "utf8")),
      contradictoryRetention
    );
    await assert.rejects(
      () => access(path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`)),
      /ENOENT/
    );
  });

  await t.test("malformed sidecar", async () => {
    const prepared = prepareScanReportBundle(makeScanResult(), {
      shareId: `20260718-${"8".repeat(32)}`,
      now: FIXTURE_NOW
    });
    await writePrimaryOnly(prepared.manifest.reportId, prepared.reportWire, prepared.retention);
    const sidecarPath = path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`);
    await writeFile(sidecarPath, "{}\n");

    assert.deepEqual(await reconcilePreparedScanReportBundle(prepared.manifest), {
      outcome: "integrity-error",
      reason: "sidecar-mismatch"
    });
    assert.equal(await readFile(sidecarPath, "utf8"), "{}\n");
    assert.equal(
      await readFile(path.join(reportDir, `${prepared.manifest.reportId}.json`), "utf8"),
      prepared.reportWire
    );
  });
});

test("reconciliation propagates backend transport faults", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"9".repeat(32)}`,
    now: FIXTURE_NOW
  });
  await mkdir(path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`));

  await assert.rejects(
    () => reconcilePreparedScanReportBundle(prepared.manifest),
    (error) => error instanceof BoundedUtf8FileReadError && error.reason === "not-regular-file"
  );
});

test("a contradictory sidecar conflict never deletes bytes this save did not create", async () => {
  const shareId = `20260712-${"c".repeat(32)}`;
  const sidecarPath = path.join(reportDir, `${shareId}.provenance.json`);
  await writeFile(sidecarPath, "{}\n");

  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId }), /EEXIST/);
  assert.equal(await readFile(sidecarPath, "utf8"), "{}\n");
  assert.equal((await readStoredScanReportById(shareId)).outcome, "unreadable");
  assert.deepEqual((await readdir(reportDir)).sort(), [
    `${shareId}.json`,
    `${shareId}.provenance.json`,
    `${shareId}.retention.json`
  ]);
});

test("a retention-file conflict rolls back the filesystem primary it created", async () => {
  // A filesystem report write is itself two create-only files. If the report
  // lands but retention creation conflicts, the backend owns and rolls back
  // that report rather than leaving a permanently uncommitted object.
  const retentionConflictId = `20260712-${"f".repeat(32)}`;
  await writeFile(path.join(reportDir, `${retentionConflictId}.retention.json`), "{}\n");
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: retentionConflictId }), /EEXIST/);
  assert.deepEqual(await readdir(reportDir), []);
});

test("missing provenance or retention metadata makes an existing report unreadable", async () => {
  const withoutSidecar = await saveScanReport(makeScanResult());
  const sidecarId = withoutSidecar.share?.id || "";
  await unlink(path.join(reportDir, `${sidecarId}.provenance.json`));
  assert.deepEqual(await readStoredScanReportById(sidecarId), { outcome: "unreadable", error: "invalid" });

  const withoutRetention = await saveScanReport(makeScanResult());
  const retentionId = withoutRetention.share?.id || "";
  await unlink(path.join(reportDir, `${retentionId}.retention.json`));
  assert.deepEqual(await readStoredScanReportById(retentionId), { outcome: "unreadable", error: "invalid" });
});

test("saveScanReport can persist under a caller-supplied strong share ID", async () => {
  const shareId = "20260619-0123456789abcdef0123456789abcdef";
  const saved = await saveScanReport(makeScanResult(), { shareId });

  assert.equal(saved.share?.id, shareId);
  assert.equal(saved.share?.path, `/reports/${shareId}`);
  assert.deepEqual(await readV1Report(shareId), saved);
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: "20260619-12345678" }), /Invalid report share id/);
});

test("saveScanReport keeps returned screenshots but strips persisted screenshots", async () => {
  const savedSingle = await saveScanReport(makeScanResult({ screenshot: "data:image/jpeg;base64,single" }));
  const persistedSingle = await readV1Report(savedSingle.share?.id || "");

  assert.equal(savedSingle.screenshot, "data:image/jpeg;base64,single");
  assert.ok(persistedSingle && persistedSingle.reportType !== "comparison");
  assert.equal(persistedSingle.screenshot, null);

  const comparison = createGpcComparisonReport(
    makeScanResult({ gpcEnabled: false, screenshot: "data:image/jpeg;base64,off" }),
    makeScanResult({ gpcEnabled: true, screenshot: "data:image/jpeg;base64,on" })
  );
  const savedComparison = await saveScanReport(comparison);
  const persistedComparison = await readV1Report(savedComparison.share?.id || "");

  assert.equal(savedComparison.baseline.screenshot, "data:image/jpeg;base64,off");
  assert.equal(savedComparison.variant.screenshot, "data:image/jpeg;base64,on");
  assert.equal(persistedComparison?.reportType, "comparison");
  if (persistedComparison?.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(persistedComparison.baseline.screenshot, null);
  assert.equal(persistedComparison.variant.screenshot, null);
});

test("saveScanReport attaches shares to ephemeral r2 responses and persists only public projections", async () => {
  const singleFixture = makePublicSingleReportV2R2();
  singleFixture.run.privacy.redactionVersion = REDACTION_VERSION;
  const singlePublic = redactPublicScanReportV2R2(singleFixture);
  if (singlePublic.reportType !== "single") throw new Error("expected single r2 fixture");
  const single: EphemeralSingleReportR2 = {
    ...singlePublic,
    ephemeral: { screenshot: "data:image/png;base64,R2_SINGLE_PRIVATE" }
  };
  const savedSingle = await saveScanReport(single);
  assert.match(savedSingle.share?.id ?? "", /^[0-9]{8}-[0-9a-f]{32}$/);
  assert.equal(savedSingle.ephemeral.screenshot, "data:image/png;base64,R2_SINGLE_PRIVATE");

  const storedSingle = await readStoredScanReportById(savedSingle.share?.id ?? "");
  assert.equal(storedSingle.outcome, "found");
  if (storedSingle.outcome !== "found") throw new Error("expected stored r2 single");
  assert.equal(storedSingle.stored.schemaVersion, 2);
  assert.equal(storedSingle.wire.includes("R2_SINGLE_PRIVATE"), false);
  assert.equal("ephemeral" in JSON.parse(storedSingle.wire), false);
  assert.equal(storedSingle.stored.report.share?.id, savedSingle.share?.id);

  const comparisonFixture = makeGpcInterventionReportV2R2();
  comparisonFixture.baseline.privacy.redactionVersion = REDACTION_VERSION;
  comparisonFixture.variant.privacy.redactionVersion = REDACTION_VERSION;
  const comparisonPublic = redactPublicScanReportV2R2(comparisonFixture);
  if (comparisonPublic.reportType !== "comparison") throw new Error("expected comparison r2 fixture");
  const comparison: EphemeralComparisonReportR2 = {
    ...comparisonPublic,
    ephemeral: {
      baselineScreenshot: "data:image/png;base64,R2_BASELINE_PRIVATE",
      variantScreenshot: "data:image/png;base64,R2_VARIANT_PRIVATE"
    }
  };
  const savedComparison = await saveScanReport(comparison);
  assert.equal(savedComparison.ephemeral.baselineScreenshot, "data:image/png;base64,R2_BASELINE_PRIVATE");
  assert.equal(savedComparison.ephemeral.variantScreenshot, "data:image/png;base64,R2_VARIANT_PRIVATE");
  assert.match(savedComparison.share?.id ?? "", /^[0-9]{8}-[0-9a-f]{32}$/);

  const storedComparison = await readStoredScanReportById(savedComparison.share?.id ?? "");
  assert.equal(storedComparison.outcome, "found");
  if (storedComparison.outcome !== "found") throw new Error("expected stored r2 comparison");
  assert.equal(storedComparison.stored.schemaVersion, 2);
  assert.equal(storedComparison.wire.includes("R2_BASELINE_PRIVATE"), false);
  assert.equal(storedComparison.wire.includes("R2_VARIANT_PRIVATE"), false);
  assert.equal("ephemeral" in JSON.parse(storedComparison.wire), false);
  assert.equal(storedComparison.stored.report.share?.id, savedComparison.share?.id);
});

test("saveScanReport rejects an ephemeral r2 shell that only relabels unsafe bytes as current", async () => {
  const publicReport = makePublicSingleReportV2R2();
  publicReport.run.privacy.redactionVersion = REDACTION_VERSION;
  assert.notEqual(publicReport.run.summary.pageTitle, "");
  const report: EphemeralSingleReportR2 = {
    ...publicReport,
    ephemeral: { screenshot: "data:image/png;base64,PRIVATE" }
  };
  await assert.rejects(() => saveScanReport(report), /redaction-not-idempotent/);
  assert.deepEqual(await readdir(reportDir), []);
});

test("saveScanReport enforces the r2 byte cap after attaching a share and writes nothing", async () => {
  const publicReport = makePublicSingleReportV2R2();
  publicReport.run.privacy.redactionVersion = REDACTION_VERSION;
  publicReport.run.warnings = [""];
  const report: EphemeralSingleReportR2 = {
    ...publicReport,
    ephemeral: { screenshot: null }
  };
  const emptyWarningBytes = Buffer.byteLength(
    `${JSON.stringify(toPublicScanReportR2(report), null, 2)}\n`,
    "utf8"
  );
  report.run.warnings = ["x".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES - emptyWarningBytes - 16)];
  const preShareBytes = Buffer.byteLength(
    `${JSON.stringify(toPublicScanReportR2(report), null, 2)}\n`,
    "utf8"
  );
  assert.ok(preShareBytes <= NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);

  await assert.rejects(
    () => saveScanReport(report),
    new RegExp(`larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes after attaching its share`)
  );
  assert.deepEqual(await readdir(reportDir), []);
});

test("the stored-report read accepts non-GPC comparison reports", async () => {
  const comparison = createComparisonReport({
    comparisonType: "shields",
    title: "Shields off/on comparison",
    runLabels: {
      baseline: "Shields off",
      variant: "Shields on"
    },
    baseline: makeScanResult(),
    variant: makeScanResult(),
    warningPrefix: "Sequential Shields comparison."
  });

  const saved = await saveScanReport(comparison);
  const persisted = await readV1Report(saved.share?.id || "");

  assert.equal(persisted?.reportType, "comparison");
  if (persisted?.reportType !== "comparison") throw new Error("expected comparison report");
  assert.equal(persisted.comparisonType, "shields");
  assert.deepEqual(persisted.runLabels, {
    baseline: "Shields off",
    variant: "Shields on"
  });
});

test("saveScanReport prunes persisted reports by max count", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "2";
  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = "0";

  const saved = [
    await saveScanReport(makeScanResult()),
    await saveScanReport(makeScanResult()),
    await saveScanReport(makeScanResult())
  ];

  const files = await readdir(reportDir);
  assert.equal(files.filter(isReportFile).length, 2);
  assert.equal(files.filter((file) => file.endsWith(".provenance.json")).length, 2);
  assert.equal(files.filter((file) => file.endsWith(".retention.json")).length, 2);

  let completeBundles = 0;
  let removedBundles = 0;
  for (const report of saved) {
    const id = report.share?.id || "";
    const bundle = [
      `${id}.json`,
      `${id}.provenance.json`,
      `${id}.retention.json`
    ].map((file) => files.includes(file));
    assert.ok(bundle.every((present) => present === bundle[0]), `partial report bundle for ${id}`);
    if (bundle[0]) completeBundles += 1;
    else removedBundles += 1;
  }
  assert.equal(completeBundles, 2);
  assert.equal(removedBundles, 1);
});

test("concurrent successful saves remain live through a bounded max-count survival grace", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "1";
  const firstId = `20260714-${"a".repeat(32)}`;
  const secondId = `20260714-${"b".repeat(32)}`;

  const [first, second] = await Promise.all([
    saveScanReport(makeScanResult(), { shareId: firstId }),
    saveScanReport(makeScanResult(), { shareId: secondId })
  ]);

  assert.equal(first.share?.id, firstId);
  assert.equal(second.share?.id, secondId);
  assert.equal((await readStoredScanReportById(firstId)).outcome, "found");
  assert.equal((await readStoredScanReportById(secondId)).outcome, "found");
  assert.deepEqual((await readdir(reportDir)).sort(), [
    `${firstId}.json`,
    `${firstId}.provenance.json`,
    `${firstId}.retention.json`,
    `${secondId}.json`,
    `${secondId}.provenance.json`,
    `${secondId}.retention.json`
  ]);

  // The max-count cap converges after the short return-safety window.
  await pruneStoredReports(Date.now() + 10 * 60 * 1_000);
  assert.equal((await readStoredScanReportById(firstId)).outcome, "not-found");
  assert.equal((await readStoredScanReportById(secondId)).outcome, "found");
});

test("count pruning honors a configured 75-minute durable-job recovery window", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "1";
  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = String(DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);
  const base = Date.now();
  const first = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"a".repeat(32)}`,
    now: base
  });
  const second = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260718-${"b".repeat(32)}`,
    now: base
  });
  await commitPreparedScanReportBundle(first);
  await commitPreparedScanReportBundle(second);

  await pruneStoredReports(base + DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS - 1);
  assert.equal((await readStoredScanReportById(first.manifest.reportId)).outcome, "found");
  assert.equal((await readStoredScanReportById(second.manifest.reportId)).outcome, "found");

  await pruneStoredReports(base + DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);
  assert.equal((await readStoredScanReportById(first.manifest.reportId)).outcome, "not-found");
  assert.equal((await readStoredScanReportById(second.manifest.reportId)).outcome, "found");
});

test("count pruning never age-deletes a report while another process delays its sidecar", async () => {
  process.env[REPORT_MAX_COUNT_ENV] = "1";
  const existing = await saveScanReport(makeScanResult());
  const existingId = existing.share?.id || "";
  const retention = JSON.parse(await readFile(path.join(reportDir, `${existingId}.retention.json`), "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };
  // Keep both IDs in the same date partition so the all-`f` suffix is the
  // deterministic tie-break winner even when this test crosses UTC midnight.
  const inFlightId = `${existingId.slice(0, 9)}${"f".repeat(32)}`;
  const existingPublicReport = JSON.parse(
    await readFile(path.join(reportDir, `${existingId}.json`), "utf8")
  ) as Record<string, unknown>;
  const inFlightReport = {
    ...existingPublicReport,
    share: {
      id: inFlightId,
      path: `/reports/${inFlightId}`,
      jsonPath: `/api/reports/${inFlightId}`
    }
  };
  await writeFile(path.join(reportDir, `${inFlightId}.json`), `${JSON.stringify(inFlightReport, null, 2)}\n`);
  await writeFile(path.join(reportDir, `${inFlightId}.retention.json`), `${JSON.stringify(retention)}\n`);

  // A competing process that loses the create-only report race must not run
  // owned cleanup against the winner while its sidecar is deliberately held.
  await assert.rejects(() => saveScanReport(makeScanResult(), { shareId: inFlightId }), /EEXIST/);
  await access(path.join(reportDir, `${inFlightId}.json`));
  await access(path.join(reportDir, `${inFlightId}.retention.json`));

  // This is well beyond the old 15-minute foreground cleanup grace. Wall-clock
  // age cannot prove that another process crashed, so the report must survive.
  const now = Date.parse(retention.createdAt) + 24 * 60 * 60 * 1_000;
  await pruneStoredReports(now);
  assert.equal((await readStoredScanReportById(existingId)).outcome, "found");
  await access(path.join(reportDir, `${inFlightId}.json`));

  await writeFile(
    path.join(reportDir, `${inFlightId}.provenance.json`),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: inFlightId,
        publicReport: inFlightReport,
        writtenAt: retention.createdAt,
        createdAt: retention.createdAt,
        expiresAt: retention.expiresAt
      })
    )}\n`
  );
  await pruneStoredReports(now);

  assert.equal((await readStoredScanReportById(existingId)).outcome, "not-found");
  assert.equal((await readStoredScanReportById(inFlightId)).outcome, "found");
});

test("report-only bundles are retained while delayed and removed at immutable expiry", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const reportPath = path.join(reportDir, `${id}.json`);
  const retentionPath = path.join(reportDir, `${id}.retention.json`);
  const retention = JSON.parse(await readFile(retentionPath, "utf8")) as {
    createdAt: string;
    expiresAt: string;
  };
  await unlink(path.join(reportDir, `${id}.provenance.json`));

  await pruneStoredReports(Date.parse(retention.createdAt) + 24 * 60 * 60 * 1_000);
  await access(reportPath);
  await access(retentionPath);

  await pruneStoredReports(Date.parse(retention.expiresAt));
  await assert.rejects(() => access(reportPath), /ENOENT/);
  await assert.rejects(() => access(retentionPath), /ENOENT/);
});

test("pruning preserves a sidecar-only marker until its exact immutable expiry", async () => {
  const prepared = prepareScanReportBundle(makeScanResult(), {
    shareId: `20260714-${"e".repeat(32)}`,
    now: new Date("2026-07-14T12:00:00.000Z")
  });
  const orphanPath = path.join(reportDir, `${prepared.manifest.reportId}.provenance.json`);
  await writeFile(orphanPath, prepared.sidecarWire);

  await pruneStoredReports(Date.parse(prepared.retention.expiresAt) - 1);
  assert.equal(await readFile(orphanPath, "utf8"), prepared.sidecarWire);

  await pruneStoredReports(Date.parse(prepared.retention.expiresAt));
  await assert.rejects(() => access(orphanPath), /ENOENT/);
});

test("pruning preserves malformed sidecar-only state without inventing a deletion clock", async () => {
  const orphanId = `20260714-${"f".repeat(32)}`;
  const orphanPath = path.join(reportDir, `${orphanId}.provenance.json`);
  await writeFile(orphanPath, "{}\n");

  await pruneStoredReports(Date.parse("2036-07-14T12:00:00.000Z"));
  assert.equal(await readFile(orphanPath, "utf8"), "{}\n");
});

test("pruning uses immutable expiry metadata, never a rewritten report mtime", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const reportPath = path.join(reportDir, `${id}.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
  const retention = {
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-06-08T00:00:00.000Z"
  };
  await writeFile(path.join(reportDir, `${id}.retention.json`), `${JSON.stringify(retention)}\n`);
  await writeFile(
    path.join(reportDir, `${id}.provenance.json`),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: report,
        writtenAt: "2026-07-12T00:00:00.000Z",
        createdAt: retention.createdAt,
        expiresAt: retention.expiresAt
      })
    )}\n`
  );
  const rewrittenAt = new Date("2030-01-01T00:00:00.000Z");
  await utimes(reportPath, rewrittenAt, rewrittenAt);

  await pruneStoredReports(Date.parse("2026-07-12T00:00:00.000Z"));
  await assert.rejects(() => access(reportPath), /ENOENT/);
  await assert.rejects(() => access(path.join(reportDir, `${id}.provenance.json`)), /ENOENT/);
  await assert.rejects(() => access(path.join(reportDir, `${id}.retention.json`)), /ENOENT/);
});

test("delete-only failure leaves durable retention debt, refuses publication, and clears only after cleanup", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const sidecarPath = path.join(reportDir, `${id}.provenance.json`);
  await unlink(sidecarPath);
  await mkdir(sidecarPath);
  const expired = {
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-06-08T00:00:00.000Z"
  };
  await writeFile(path.join(reportDir, `${id}.retention.json`), `${JSON.stringify(expired)}\n`);

  await assert.rejects(
    () => pruneStoredReports(Date.parse("2026-07-01T00:00:00.000Z")),
    /EISDIR|operation not permitted|directory/i
  );
  assert.deepEqual(await reportStoreRetentionStatus(), {
    debtCount: 1,
    maintenanceRequired: true,
    healthy: false
  });
  await assert.rejects(
    () => saveScanReport(makeScanResult()),
    /EISDIR|operation not permitted|directory/i
  );

  await rm(sidecarPath, { recursive: true, force: true });
  await pruneStoredReports(Date.parse("2026-07-01T00:00:00.000Z"));
  assert.deepEqual(await reportStoreRetentionStatus(), {
    debtCount: 0,
    maintenanceRequired: false,
    healthy: true
  });
  const recovered = await saveScanReport(makeScanResult());
  assert.equal((await readStoredScanReportById(recovered.share?.id || "")).outcome, "found");
});

test("expired reads stay not-found when physical deletion fails and expose the debt", async () => {
  const saved = await saveScanReport(makeScanResult());
  const id = saved.share?.id || "";
  const sidecarPath = path.join(reportDir, `${id}.provenance.json`);
  await unlink(sidecarPath);
  await mkdir(sidecarPath);
  await writeFile(
    path.join(reportDir, `${id}.retention.json`),
    `${JSON.stringify({
      createdAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2026-06-08T00:00:00.000Z"
    })}\n`
  );

  assert.deepEqual(await readStoredScanReportById(id), { outcome: "not-found" });
  assert.equal((await reportStoreRetentionStatus()).debtCount, 1);
});

test("one prune pass bounds delete work and leaves a durable maintenance continuation", async () => {
  await mkdir(reportDir, { recursive: true });
  const retention = {
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2026-06-08T00:00:00.000Z"
  };
  for (let index = 0; index < 40; index += 1) {
    const id = `20260601-${index.toString(16).padStart(32, "0")}`;
    await writeFile(path.join(reportDir, `${id}.json`), "{}\n");
    await writeFile(path.join(reportDir, `${id}.retention.json`), `${JSON.stringify(retention)}\n`);
  }

  await pruneStoredReports(Date.parse("2026-07-01T00:00:00.000Z"));
  assert.equal((await readdir(reportDir)).filter(isReportFile).length, 8);
  assert.deepEqual(await reportStoreRetentionStatus(), {
    debtCount: 0,
    maintenanceRequired: true,
    healthy: false
  });

  await pruneStoredReports(Date.parse("2026-07-01T00:00:00.000Z"));
  assert.equal((await readdir(reportDir)).filter(isReportFile).length, 0);
  assert.equal((await reportStoreRetentionStatus()).healthy, true);
});

test("saveScanReport reports the configured report store directory in its status", async () => {
  const saved = await saveScanReport(makeScanResult());
  const files = (await readdir(reportDir)).filter(isReportFile);

  assert.equal(files.length, 1);
  assert.deepEqual(await readV1Report(saved.share?.id || ""), saved);
  assert.deepEqual(reportStoreStatus(), {
    kind: "filesystem",
    path: reportDir,
    configuredPath: true,
    maxAgeDays: 7,
    maxCount: 500,
    minSurvivalMs: 60_000
  });
});

test("reportStoreStatus exposes the effective count-pruning survival and its two-hour cap", () => {
  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = String(DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);
  assert.equal(reportStoreStatus().minSurvivalMs, DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);

  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = String(24 * 60 * 60 * 1_000);
  assert.equal(reportStoreStatus().minSurvivalMs, 2 * 60 * 60_000);
});

test("whole publication deadline rejects a noncooperative backend without an unhandled rejection", async () => {
  process.env[REPORT_STORE_OPERATION_TIMEOUT_MS_ENV] = "10";
  configureFakeR2(async () => new Promise<Response>(() => undefined));
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      () => saveScanReport(makeScanResult()),
      /whole-operation deadline|exceeded its 10 ms/i
    );
    assert.ok(Date.now() - startedAt < 1_000, "publication must not inherit a hung backend lifetime");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("active retention health fails when an expired R2 object exists but debt-marker PUT is denied", async () => {
  const id = `20260601-${"d".repeat(32)}`;
  let markerPutAttempts = 0;
  configureFakeR2(async (request) => {
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix");
    if (request.method === "GET" && prefix === "reports/_retention-debt/") {
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
        { status: 200 }
      );
    }
    if (request.method === "GET" && prefix === "reports/") {
      return new Response(
        `<ListBucketResult>
          <Contents><Key>reports/${id}.json</Key><LastModified>2026-06-01T00:00:00.000Z</LastModified></Contents>
          <Contents><Key>reports/${id}.json.provenance.json</Key><LastModified>2026-06-01T00:00:01.000Z</LastModified></Contents>
          <IsTruncated>false</IsTruncated>
        </ListBucketResult>`,
        { status: 200 }
      );
    }
    if (request.method === "HEAD" && url.pathname.endsWith(`${id}.json`)) {
      return new Response(null, {
        status: 200,
        headers: {
          "x-amz-meta-created-at": "2026-06-01T00:00:00.000Z",
          "x-amz-meta-expires-at": "2026-06-08T00:00:00.000Z"
        }
      });
    }
    if (request.method === "PUT" && url.pathname.includes("_retention-debt")) {
      markerPutAttempts += 1;
      return new Response("denied", { status: 403 });
    }
    throw new Error(`Unexpected retention-health request: ${request.method} ${request.url}`);
  });

  await assert.rejects(() => maintainReportStoreRetention(), /persist report retention marker.*403/i);
  assert.equal(markerPutAttempts, 1);
});

function isReportFile(file: string): boolean {
  return /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(file);
}

function configureFakeR2(handler: (request: Request) => Promise<Response>): void {
  process.env[REPORT_STORE_BACKEND_ENV] = "r2";
  process.env.SITE_BEHAVIOR_LAB_R2_BUCKET = "test-reports";
  process.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT = "https://r2.example.test";
  process.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.SITE_BEHAVIOR_LAB_R2_PREFIX = "reports/";
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  }) as typeof fetch;
}

function r2ReportResponse(prepared: ReturnType<typeof prepareScanReportBundle>): Response {
  return new Response(prepared.reportWire, {
    status: 200,
    headers: {
      "last-modified": "Sat, 18 Jul 2026 12:00:00 GMT",
      "x-amz-meta-created-at": prepared.retention.createdAt,
      "x-amz-meta-expires-at": prepared.retention.expiresAt
    }
  });
}

async function writePrimaryOnly(
  id: string,
  reportWire: string,
  retention: { createdAt: string; expiresAt: string }
): Promise<void> {
  await writeFile(path.join(reportDir, `${id}.json`), reportWire);
  await writeFile(path.join(reportDir, `${id}.retention.json`), `${JSON.stringify(retention)}\n`);
}

function makeScanResult(options: { gpcEnabled?: boolean; screenshot?: string | null } = {}): ScanResult {
  const payload: ScanRequestPayload = {
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: options.gpcEnabled ?? true,
    consentMode: "observe"
  };

  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "example.com",
      totalRequests: 0,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: payload.url,
      finalUrl: payload.url,
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: 1440,
        height: 980,
        isMobile: false
      },
      gpcEnabled: payload.gpcEnabled,
      consentMode: payload.consentMode,
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: {
        source: "test",
        version: "test",
        region: "test",
        entries: 0,
        curatedOverrides: 0,
        license: "test"
      },
      scannerDisclosure: "test"
    },
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: options.screenshot ?? null,
    warnings: []
  };
}

test("an operator report count above the backend listing ceiling is clamped, not accepted", async () => {
  // Prune walks HEAD candidates and refuses past R2_LIST_MAX_HEAD_CANDIDATES,
  // so a configured count above that ceiling produces a store that can never be
  // pruned back under its own limit: every maintenance pass refuses, retention
  // debt only grows, and the health check reports an unhealthy store with no
  // operator action that fixes it.
  const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
  const previous = process.env[REPORT_MAX_COUNT_ENV];
  try {
    process.env[REPORT_MAX_COUNT_ENV] = String(R2_LIST_MAX_HEAD_CANDIDATES + 5_000);
    assert.equal(reportStoreStatus().maxCount, R2_LIST_MAX_HEAD_CANDIDATES);
    process.env[REPORT_MAX_COUNT_ENV] = "25";
    assert.equal(reportStoreStatus().maxCount, 25);
    process.env[REPORT_MAX_COUNT_ENV] = "0";
    assert.equal(reportStoreStatus().maxCount >= 1, true);
  } finally {
    if (previous === undefined) delete process.env[REPORT_MAX_COUNT_ENV];
    else process.env[REPORT_MAX_COUNT_ENV] = previous;
  }
});
