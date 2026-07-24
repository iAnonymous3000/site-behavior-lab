import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildCorpusStats } from "./corpus-stats-builder";
import { acquireReportCorpusLock, ReportCorpusLockedError } from "./report-corpus-lock";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  inspectReportPublicationArtifact,
  prepareReportPublicationArtifact,
  publishReportPublicationArtifact
} from "./report-publication-artifact";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { buildStaticReportManifest } from "./static-report-manifest";
import type { ScanResult } from "./types";

const SOURCE_COMMIT = "a".repeat(40);
const BASE_ID = `20260709-${"1".repeat(32)}`;
const NEW_ID = `20260710-${"2".repeat(32)}`;
const EXTRA_ID = `20260711-${"3".repeat(32)}`;
const GENERATED_AT = new Date("2026-07-12T00:00:00.000Z");
const WRITTEN_AT = "2026-07-12T00:00:00.000Z";

let testRoot = "";

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "sbl-report-publication-"));
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("prepares, inspects, and publishes a bounded canonical report snapshot", async () => {
  const checkoutRoot = path.join(testRoot, "checkout");
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  const baseReport = makeReport("base.example.com", "2026-07-09T10:00:00.000Z");
  const newReport = makeReport("new.example.com", "2026-07-10T10:00:00.000Z");
  await writeCanonicalSnapshot(checkoutRoot, new Map([[BASE_ID, baseReport]]));
  await writeCanonicalSnapshot(acquisitionRoot, new Map([[BASE_ID, baseReport], [NEW_ID, newReport]]));

  const prepared = await prepareReportPublicationArtifact({
    sourceRoot: acquisitionRoot,
    artifactDir,
    sourceCommit: SOURCE_COMMIT,
    publicationKind: "single",
    reportMode: "v1",
    expectedReportIds: [NEW_ID]
  });

  assert.deepEqual(prepared.reportIds, [BASE_ID, NEW_ID]);
  assert.deepEqual(prepared.manifest.expectedReportIds, [NEW_ID]);
  assert.equal(prepared.manifest.files.length, 6);
  assert.ok(prepared.totalBytes > 0);

  const inspected = await inspectReportPublicationArtifact({
    artifactDir,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedPublicationKind: "single",
    expectedReportMode: "v1"
  });
  assert.deepEqual(inspected.reportIds, [BASE_ID, NEW_ID]);
  assert.deepEqual(inspected.manifest, prepared.manifest);

  const published = await publishReportPublicationArtifact({
    checkoutRoot,
    artifactDir,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedPublicationKind: "single",
    expectedReportMode: "v1",
    expectedRequest: {
      targets: ["https://new.example.com/"],
      device: "desktop",
      comparisonAxis: null,
      gpcEnabled: false
    }
  });
  assert.deepEqual(published, {
    newReportIds: [NEW_ID],
    artifactReportIds: [BASE_ID, NEW_ID]
  });
  assert.deepEqual(
    await readFile(path.join(checkoutRoot, "public", "reports", `${NEW_ID}.json`)),
    await readFile(path.join(acquisitionRoot, "public", "reports", `${NEW_ID}.json`))
  );
  assert.deepEqual(
    await readFile(path.join(checkoutRoot, "public", "reports", committedSidecarFilename(NEW_ID))),
    await readFile(path.join(acquisitionRoot, "public", "reports", committedSidecarFilename(NEW_ID)))
  );
});

test("rejects an artifact whose declared report bytes were tampered with", async () => {
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  const reportPath = path.join(artifactDir, "reports", `${NEW_ID}.json`);
  await writeFile(reportPath, Buffer.concat([await readFile(reportPath), Buffer.from(" \n")]));

  await assert.rejects(
    () => inspectSingle(artifactDir),
    new RegExp(`digest or length mismatch for reports/${NEW_ID}\\.json`)
  );
});

test("rejects a v1 report artifact whose untrusted manifest declares r2 mode", async () => {
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  const manifestPath = path.join(artifactDir, "publication.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { reportMode: string };
  manifest.reportMode = "r2";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    () =>
      inspectReportPublicationArtifact({
        artifactDir,
        expectedSourceCommit: SOURCE_COMMIT,
        expectedPublicationKind: "single",
        expectedReportMode: "r2"
      }),
    new RegExp(`Expected report ${NEW_ID} is v1, not declared mode r2`)
  );
});

test("rejects malformed UTF-8 in every artifact JSON control file", async (context) => {
  const cases = [
    { path: "publication.json", needle: SOURCE_COMMIT },
    { path: "reports/index.json", needle: GENERATED_AT.toISOString() },
    { path: "corpus-stats.json", needle: GENERATED_AT.toISOString() }
  ] as const;

  for (const [index, target] of cases.entries()) {
    await context.test(target.path, async () => {
      const artifactDir = await prepareArtifactCase(`invalid-utf8-${index}`);
      const targetPath = path.join(artifactDir, ...target.path.split("/"));
      const contents = await readFile(targetPath);
      const needleOffset = contents.indexOf(Buffer.from(target.needle));
      assert.notEqual(needleOffset, -1, `fixture must contain ${target.needle}`);
      const malformed = Buffer.from(contents);
      malformed[needleOffset] = 0x80;
      await writeArtifactDataFile(artifactDir, target.path, malformed);

      await assert.rejects(() => inspectSingle(artifactDir), /UTF-8/i);
    });
  }
});

test("rejects escaped duplicate keys in every artifact JSON control file", async (context) => {
  const cases = [
    { path: "publication.json", key: "schemaVersion", escapedKey: "\\u0073chemaVersion", value: 1 },
    {
      path: "reports/index.json",
      key: "generatedAt",
      escapedKey: "\\u0067eneratedAt",
      value: GENERATED_AT.toISOString()
    },
    {
      path: "corpus-stats.json",
      key: "generatedAt",
      escapedKey: "\\u0067eneratedAt",
      value: GENERATED_AT.toISOString()
    }
  ] as const;

  for (const [index, target] of cases.entries()) {
    await context.test(target.path, async () => {
      const artifactDir = await prepareArtifactCase(`duplicate-key-${index}`);
      const targetPath = path.join(artifactDir, ...target.path.split("/"));
      const contents = await readFile(targetPath, "utf8");
      const parsed = JSON.parse(contents) as Record<string, unknown>;
      assert.deepEqual(parsed[target.key], target.value);
      const duplicate = contents.replace(
        "{\n",
        `{\n  "${target.escapedKey}": ${JSON.stringify(target.value)},\n`
      );
      assert.notEqual(duplicate, contents);
      await writeArtifactDataFile(artifactDir, target.path, Buffer.from(duplicate, "utf8"));

      await assert.rejects(() => inspectSingle(artifactDir), /duplicate (?:JSON )?(?:field|key)/i);
    });
  }
});

test("rejects undeclared paths and symbolic links in an artifact", async () => {
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  const extraPath = path.join(artifactDir, "unexpected.json");
  await writeFile(extraPath, "{}\n");
  await assert.rejects(() => inspectSingle(artifactDir), /root must contain only/);
  await unlink(extraPath);

  const linkPath = path.join(artifactDir, "reports", `${EXTRA_ID}.json`);
  await symlink(`${NEW_ID}.json`, linkPath);
  await assert.rejects(() => inspectSingle(artifactDir), /contains a symbolic link/);
});

test("rejects an artifact path whose symlinked ancestor aliases the source checkout", async () => {
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const alias = path.join(testRoot, "apparently-external");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await symlink(acquisitionRoot, alias, "dir");

  await assert.rejects(
    () => prepareSingle(acquisitionRoot, path.join(alias, "artifact"), NEW_ID),
    /outside the Git checkout/
  );
  await assert.rejects(() => access(path.join(acquisitionRoot, "artifact")));
});

test("rejects attacker-controlled manifest cardinality before mapping entries", async () => {
  const artifactDir = await prepareArtifactCase("manifest-cardinality");
  const manifestPath = path.join(artifactDir, "publication.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { expectedReportIds: string[] };
  manifest.expectedReportIds = Array.from({ length: 10_001 }, () => NEW_ID);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(() => inspectSingle(artifactDir), /too many expected report ids/);
});

test("rejects a canonical artifact that changes an existing managed report", async () => {
  const checkoutRoot = path.join(testRoot, "checkout");
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(
    checkoutRoot,
    new Map([[BASE_ID, makeReport("base.example.com", "2026-07-09T10:00:00.000Z")]])
  );
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([
      [BASE_ID, makeReport("changed.example.com", "2026-07-09T10:00:00.000Z", 204)],
      [NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]
    ])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  await assert.rejects(
    () =>
      publishReportPublicationArtifact({
        checkoutRoot,
        artifactDir,
        expectedSourceCommit: SOURCE_COMMIT,
        expectedPublicationKind: "single",
        expectedReportMode: "v1",
        expectedRequest: {
          targets: ["https://new.example.com/"],
          device: "desktop",
          comparisonAxis: null,
          gpcEnabled: false
        }
      }),
    /attempted to alter existing managed evidence/
  );
  await assert.rejects(
    () => access(path.join(checkoutRoot, "public", "reports", `${NEW_ID}.json`)),
    /ENOENT/
  );
});

test("rechecks manifest digests on the exact report and sidecar bytes copied", async () => {
  const checkoutRoot = path.join(testRoot, "checkout");
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  const original = makeReport("new.example.com", "2026-07-10T10:00:00.000Z");
  await writeCanonicalSnapshot(checkoutRoot, new Map());
  await writeCanonicalSnapshot(acquisitionRoot, new Map([[NEW_ID, original]]));
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  // The custom iterator runs after artifact inspection but immediately before
  // request binding. Replace the report with a different, internally valid
  // bundle that still matches the trusted target; without the copy-time
  // manifest check it would be accepted and written from stale inspection.
  const replacement = makeReport("new.example.com", "2026-07-10T10:00:00.000Z", 204);
  const replacementSidecar = buildProvenanceEntry({
    reportId: NEW_ID,
    publicReport: replacement,
    writtenAt: WRITTEN_AT,
    createdAt: replacement.conditions.scannedAt,
    expiresAt: null
  });
  const targets = ["https://new.example.com/"];
  let replaced = false;
  Object.defineProperty(targets, Symbol.iterator, {
    value: function* () {
      if (!replaced) {
        replaced = true;
        writeFileSync(
          path.join(artifactDir, "reports", `${NEW_ID}.json`),
          `${JSON.stringify(replacement, null, 2)}\n`
        );
        writeFileSync(
          path.join(artifactDir, "reports", committedSidecarFilename(NEW_ID)),
          `${JSON.stringify(replacementSidecar, null, 2)}\n`
        );
      }
      yield "https://new.example.com/";
    }
  });

  await assert.rejects(
    () => publishReportPublicationArtifact({
      checkoutRoot,
      artifactDir,
      expectedSourceCommit: SOURCE_COMMIT,
      expectedPublicationKind: "single",
      expectedReportMode: "v1",
      expectedRequest: {
        targets,
        device: "desktop",
        comparisonAxis: null,
        gpcEnabled: false
      }
    }),
    new RegExp(`changed after inspection for reports/${NEW_ID}\\.json`)
  );
  await assert.rejects(
    () => access(path.join(checkoutRoot, "public", "reports", `${NEW_ID}.json`)),
    /ENOENT/
  );
});

test("publication honors the shared corpus lock before mutating the checkout", async () => {
  const checkoutRoot = path.join(testRoot, "checkout");
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(checkoutRoot, new Map());
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);

  const reportsDir = path.join(checkoutRoot, "public", "reports");
  const lock = await acquireReportCorpusLock(reportsDir, "test-competing-writer");
  try {
    await assert.rejects(
      () => publishReportPublicationArtifact({
        checkoutRoot,
        artifactDir,
        expectedSourceCommit: SOURCE_COMMIT,
        expectedPublicationKind: "single",
        expectedReportMode: "v1",
        expectedRequest: {
          targets: ["https://new.example.com/"],
          device: "desktop",
          comparisonAxis: null,
          gpcEnabled: false
        }
      }),
      ReportCorpusLockedError
    );
  } finally {
    await lock.release();
  }

  await assert.rejects(
    () => access(path.join(reportsDir, `${NEW_ID}.json`)),
    /ENOENT/
  );
  await assert.rejects(
    () => access(path.join(reportsDir, committedSidecarFilename(NEW_ID))),
    /ENOENT/
  );
});

test("artifact preparation holds the shared corpus lock over snapshot copying", async () => {
  const acquisitionRoot = path.join(testRoot, "acquisition");
  const artifactDir = path.join(testRoot, "artifact");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  const reportsDir = path.join(acquisitionRoot, "public", "reports");
  const lock = await acquireReportCorpusLock(reportsDir, "test-competing-writer");
  try {
    await assert.rejects(
      () => prepareSingle(acquisitionRoot, artifactDir, NEW_ID),
      ReportCorpusLockedError
    );
  } finally {
    await lock.release();
  }
  await assert.rejects(() => access(artifactDir), /ENOENT/);
});

async function prepareSingle(acquisitionRoot: string, artifactDir: string, expectedReportId: string) {
  return prepareReportPublicationArtifact({
    sourceRoot: acquisitionRoot,
    artifactDir,
    sourceCommit: SOURCE_COMMIT,
    publicationKind: "single",
    reportMode: "v1",
    expectedReportIds: [expectedReportId]
  });
}

async function inspectSingle(artifactDir: string) {
  return inspectReportPublicationArtifact({
    artifactDir,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedPublicationKind: "single",
    expectedReportMode: "v1"
  });
}

async function prepareArtifactCase(caseName: string): Promise<string> {
  const acquisitionRoot = path.join(testRoot, caseName, "acquisition");
  const artifactDir = path.join(testRoot, caseName, "artifact");
  await writeCanonicalSnapshot(
    acquisitionRoot,
    new Map([[NEW_ID, makeReport("new.example.com", "2026-07-10T10:00:00.000Z")]])
  );
  await prepareSingle(acquisitionRoot, artifactDir, NEW_ID);
  return artifactDir;
}

async function writeArtifactDataFile(artifactDir: string, relativePath: string, contents: Buffer): Promise<void> {
  await writeFile(path.join(artifactDir, ...relativePath.split("/")), contents);
  if (relativePath === "publication.json") return;

  const manifestPath = path.join(artifactDir, "publication.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const entry = manifest.files.find((candidate) => candidate.path === relativePath);
  assert.ok(entry, `publication manifest must declare ${relativePath}`);
  entry.bytes = contents.byteLength;
  entry.sha256 = createHash("sha256").update(contents).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeReport(domain: string, scannedAt: string, status = 200): ScanResult {
  const fixture = makeScanReportV1();
  if (fixture.reportType !== "single") throw new Error("fixture must be a single report");
  const report: ScanResult = {
    ...fixture,
    summary: { ...fixture.summary, firstPartyDomain: domain, status },
    conditions: {
      ...fixture.conditions,
      requestedUrl: `https://${domain}/`,
      finalUrl: `https://${domain}/`,
      scannedAt
    }
  };
  return redactScanReportV1(report).report;
}

async function writeCanonicalSnapshot(root: string, reports: ReadonlyMap<string, ScanResult>): Promise<void> {
  const reportsDir = path.join(root, "public", "reports");
  await mkdir(reportsDir, { recursive: true });
  for (const [id, report] of reports) {
    await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const sidecar = buildProvenanceEntry({
      reportId: id,
      publicReport: report,
      writtenAt: WRITTEN_AT,
      createdAt: report.conditions.scannedAt,
      expiresAt: null
    });
    await writeFile(
      path.join(reportsDir, committedSidecarFilename(id)),
      `${JSON.stringify(sidecar, null, 2)}\n`
    );
  }

  const { manifest, warnings: manifestWarnings } = await buildStaticReportManifest(reportsDir, GENERATED_AT);
  assert.deepEqual(manifestWarnings, []);
  await writeFile(path.join(reportsDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const { stats, warnings: statsWarnings } = await buildCorpusStats(reportsDir, GENERATED_AT);
  assert.deepEqual(statsWarnings, []);
  await writeFile(path.join(root, "public", "corpus-stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
}
