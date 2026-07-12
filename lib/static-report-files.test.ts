import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  listDanglingStaticSidecarIds,
  listStaticReportIds,
  readStaticReportBundle,
  removeStaticReportBundle
} from "./static-report-files";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

const CREATED_AT = "2026-07-01T00:00:00.000Z";
let rootDir = "";
let reportsDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "sbl-static-report-files-"));
  reportsDir = path.join(rootDir, "public", "reports");
  await mkdir(reportsDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

test("static report ids include only current, matched managed bundles", async () => {
  const validId = "20260701-" + "a".repeat(32);
  const missingSidecarId = "20260701-" + "b".repeat(32);
  const wrongDigestId = "20260701-" + "c".repeat(32);
  await writeManagedReport(validId);
  assert.deepEqual(await listStaticReportIds(rootDir), [validId]);

  await writeReportOnly(missingSidecarId);
  await assert.rejects(() => listStaticReportIds(rootDir), /no-sidecar/);
  await rm(path.join(reportsDir, `${missingSidecarId}.json`));

  await writeManagedReport(wrongDigestId);
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(wrongDigestId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { publicDigest: string };
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, publicDigest: "0".repeat(64) })}\n`);
  await writeFile(path.join(reportsDir, "index.json"), "{}\n");

  await assert.rejects(() => listStaticReportIds(rootDir), /digest-mismatch/);
  const wrongDigest = await readStaticReportBundle(reportsDir, wrongDigestId);
  assert.equal(wrongDigest.outcome, "unreadable");
  if (wrongDigest.outcome === "unreadable") assert.equal(wrongDigest.reason, "digest-mismatch");
});

test("a dangling provenance sidecar fails the managed directory audit", async () => {
  const id = "20260701-" + "9".repeat(32);
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), "{}\n");

  assert.deepEqual(await listDanglingStaticSidecarIds(reportsDir), [id]);
  await assert.rejects(() => listStaticReportIds(rootDir), /dangling-sidecar/);
});

test("committed bundles require null expiry and exact report identity", async () => {
  const id = "20260701-" + "d".repeat(32);
  const report = await writeManagedReport(id);
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(id));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  const expiresAt = "2026-07-08T00:00:00.000Z";
  await writeFile(
    sidecarPath,
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: report,
        writtenAt: CREATED_AT,
        createdAt: CREATED_AT,
        expiresAt
      })
    )}\n`
  );

  const runtimeClock = await readStaticReportBundle(reportsDir, id);
  assert.equal(runtimeClock.outcome, "unreadable");
  if (runtimeClock.outcome === "unreadable") assert.equal(runtimeClock.reason, "retention-metadata-mismatch");

  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, reportId: "20260701-" + "e".repeat(32) })}\n`);
  const wrongId = await readStaticReportBundle(reportsDir, id);
  assert.equal(wrongId.outcome, "unreadable");
  if (wrongId.outcome === "unreadable") assert.equal(wrongId.reason, "report-id-mismatch");
});

test("bundle removal deletes and verifies both the sidecar and report", async () => {
  const id = "20260701-" + "f".repeat(32);
  await writeManagedReport(id);

  await removeStaticReportBundle(reportsDir, id);
  await assert.rejects(() => access(path.join(reportsDir, `${id}.json`)), /ENOENT/);
  await assert.rejects(() => access(path.join(reportsDir, committedSidecarFilename(id))), /ENOENT/);
  assert.deepEqual(await readStaticReportBundle(reportsDir, id), { outcome: "not-found" });
});

async function writeReportOnly(id: string) {
  const report = redactScanReportV1(makeScanReportV1()).report;
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function writeManagedReport(id: string) {
  const report = await writeReportOnly(id);
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: CREATED_AT,
    createdAt: CREATED_AT,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
  return report;
}
