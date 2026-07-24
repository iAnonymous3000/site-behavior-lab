import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BoundedUtf8FileReadError } from "./bounded-utf8-file";
import { createFilesystemReportStoreBackend } from "./report-store-backend";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES,
  SERVER_STORED_RETENTION_METADATA_MAX_BYTES
} from "./report-resource-limits";

const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const ID = `20260721-${"a".repeat(32)}`;
const RETENTION = {
  createdAt: "2026-07-21T00:00:00.000Z",
  expiresAt: "2026-07-28T00:00:00.000Z"
};

let reportDir = "";

beforeEach(async () => {
  reportDir = await mkdtemp(path.join(tmpdir(), "sbl-report-store-backend-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;
  await mkdir(reportDir, { recursive: true });
});

afterEach(async () => {
  delete process.env[REPORT_STORE_DIR_ENV];
  await rm(reportDir, { recursive: true, force: true });
});

test("filesystem report and sidecar reads reject malformed UTF-8 without replacement decoding", async () => {
  const backend = createFilesystemReportStoreBackend();
  const malformed = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  await writeFile(reportPath(), malformed);
  await assert.rejects(
    () => backend.read(ID),
    (error) => error instanceof BoundedUtf8FileReadError && error.reason === "invalid-utf8"
  );

  await writeFile(reportPath(), "{}\n");
  await writeFile(sidecarPath(), malformed);
  await assert.rejects(
    () => backend.readSidecar(ID),
    (error) => error instanceof BoundedUtf8FileReadError && error.reason === "invalid-utf8"
  );
});

test("filesystem report and sidecar reads reject objects beyond their shared server caps", async () => {
  const backend = createFilesystemReportStoreBackend();
  await writeFile(reportPath(), "");
  await truncate(reportPath(), SERVER_STORED_REPORT_JSON_MAX_BYTES + 1);
  await assert.rejects(
    () => backend.read(ID),
    (error) => error instanceof BoundedUtf8FileReadError && error.reason === "too-large"
  );

  await writeFile(sidecarPath(), "");
  await truncate(sidecarPath(), SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES + 1);
  await assert.rejects(
    () => backend.readSidecar(ID),
    (error) => error instanceof BoundedUtf8FileReadError && error.reason === "too-large"
  );
});

test("filesystem retention reads treat invalid UTF-8, duplicate keys, and oversized metadata as absent", async () => {
  const backend = createFilesystemReportStoreBackend();
  await writeFile(reportPath(), "{}\n");

  await writeFile(retentionPath(), new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  assert.equal((await backend.read(ID))?.retention, null);

  await writeFile(
    retentionPath(),
    `{"createdAt":"${RETENTION.createdAt}","cr\\u0065atedAt":"${RETENTION.createdAt}","expiresAt":"${RETENTION.expiresAt}"}\n`
  );
  assert.equal((await backend.read(ID))?.retention, null);

  await writeFile(retentionPath(), "");
  await truncate(retentionPath(), SERVER_STORED_RETENTION_METADATA_MAX_BYTES + 1);
  assert.equal((await backend.read(ID))?.retention, null);
});

test("filesystem reads preserve a leading BOM so strict JSON cannot attest normalized bytes", async () => {
  const backend = createFilesystemReportStoreBackend();
  const wire = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]);
  await writeFile(reportPath(), wire);
  assert.equal((await backend.read(ID))?.contents, "\uFEFF{}\n");
});

test("filesystem report, sidecar, and retention readers never follow symbolic links", async () => {
  const backend = createFilesystemReportStoreBackend();
  const outside = path.join(path.dirname(reportDir), `${path.basename(reportDir)}-outside.json`);
  await writeFile(outside, "{}\n");
  try {
    await symlink(outside, reportPath());
    await assert.rejects(
      () => backend.read(ID),
      (error) => error instanceof BoundedUtf8FileReadError && error.reason === "symlink"
    );

    await rm(reportPath());
    await writeFile(reportPath(), "{}\n");
    await symlink(outside, sidecarPath());
    await assert.rejects(
      () => backend.readSidecar(ID),
      (error) => error instanceof BoundedUtf8FileReadError && error.reason === "symlink"
    );

    await symlink(outside, retentionPath());
    assert.equal((await backend.read(ID))?.retention, null);
  } finally {
    await rm(outside, { force: true });
  }
});

function reportPath(): string {
  return path.join(reportDir, `${ID}.json`);
}

function sidecarPath(): string {
  return path.join(reportDir, `${ID}.provenance.json`);
}

function retentionPath(): string {
  return path.join(reportDir, `${ID}.retention.json`);
}
