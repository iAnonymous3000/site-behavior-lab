import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES } from "./report-resource-limits";
import {
  listDanglingStaticSidecarIds,
  listStaticReportIds,
  readStaticReportBundle,
  removeStaticReportBundleUnderLock
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

test("static managed reads reject malformed UTF-8 before report or sidecar JSON validation", async () => {
  const reportId = "20260701-" + "1".repeat(32);
  await writeFile(
    path.join(reportsDir, `${reportId}.json`),
    new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])
  );
  assert.deepEqual(await readStaticReportBundle(reportsDir, reportId), {
    outcome: "unreadable",
    error: "invalid",
    reason: "invalid-report-json"
  });

  const sidecarId = "20260701-" + "2".repeat(32);
  await writeManagedReport(sidecarId);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(sidecarId)),
    new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])
  );
  assert.deepEqual(await readStaticReportBundle(reportsDir, sidecarId), {
    outcome: "unreadable",
    error: "invalid",
    reason: "invalid-sidecar-json"
  });
});

test("static managed reads bound sidecars and reject nested duplicate keys", async () => {
  const oversizedId = "20260701-" + "3".repeat(32);
  await writeManagedReport(oversizedId);
  await truncate(
    path.join(reportsDir, committedSidecarFilename(oversizedId)),
    SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES + 1
  );
  const oversized = await readStaticReportBundle(reportsDir, oversizedId);
  assert.equal(oversized.outcome, "unreadable");
  if (oversized.outcome === "unreadable") assert.equal(oversized.reason, "invalid-sidecar-json");

  const duplicateId = "20260701-" + "4".repeat(32);
  await writeManagedReport(duplicateId);
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(duplicateId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  const duplicate = JSON.stringify(sidecar).replace(
    '"publicDigest":',
    '"audit":{"nested":1,"n\\u0065sted":2},"publicDigest":'
  );
  await writeFile(sidecarPath, `${duplicate}\n`);
  const read = await readStaticReportBundle(reportsDir, duplicateId);
  assert.equal(read.outcome, "unreadable");
  if (read.outcome === "unreadable") assert.equal(read.reason, "invalid-sidecar-json");
});

test("static managed reads reject report and sidecar symlinks without following them", async () => {
  const reportId = "20260701-" + "5".repeat(32);
  const reportTarget = path.join(rootDir, "outside-report.json");
  await writeFile(reportTarget, `${JSON.stringify(redactScanReportV1(makeScanReportV1()).report)}\n`);
  await symlink(reportTarget, path.join(reportsDir, `${reportId}.json`));
  const reportRead = await readStaticReportBundle(reportsDir, reportId);
  assert.equal(reportRead.outcome, "unreadable");
  if (reportRead.outcome === "unreadable") assert.equal(reportRead.reason, "invalid-report-json");
  await assert.rejects(() => listStaticReportIds(rootDir), /invalid-report-json/);
  await rm(path.join(reportsDir, `${reportId}.json`));

  const sidecarId = "20260701-" + "6".repeat(32);
  await writeManagedReport(sidecarId);
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(sidecarId));
  const sidecarTarget = path.join(rootDir, "outside-sidecar.json");
  await writeFile(sidecarTarget, await readFile(sidecarPath));
  await rm(sidecarPath);
  await symlink(sidecarTarget, sidecarPath);
  const sidecarRead = await readStaticReportBundle(reportsDir, sidecarId);
  assert.equal(sidecarRead.outcome, "unreadable");
  if (sidecarRead.outcome === "unreadable") assert.equal(sidecarRead.reason, "invalid-sidecar-json");
  await assert.rejects(() => listStaticReportIds(rootDir), /invalid-sidecar-json/);
});

test("bundle removal deletes and verifies both the sidecar and report", async () => {
  const id = "20260701-" + "f".repeat(32);
  await writeManagedReport(id);

  await removeStaticReportBundleUnderLock(reportsDir, id);
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
