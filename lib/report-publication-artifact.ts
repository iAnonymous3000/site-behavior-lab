import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJson } from "./canonical-json";
import { buildCorpusStats } from "./corpus-stats-builder";
import { writeNewFileDurably } from "./exact-atomic-file";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import {
  assertReportPublicationRequest,
  type ReportPublicationRequest
} from "./report-publication-request";
import {
  CORPUS_STATS_JSON_MAX_BYTES,
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES,
  STATIC_REPORT_MANIFEST_JSON_MAX_BYTES
} from "./report-resource-limits";
import { REPORT_ID_PATTERN } from "./report-validation";
import { buildStaticReportManifest } from "./static-report-manifest";
import { parseStrictJson, StrictJsonError } from "./strict-json";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  StaticReportBundleError
} from "./static-report-files";

/**
 * Bounded data-only handoff between the hostile-site acquisition job and the
 * trusted repository publisher. The acquisition job never receives a write
 * token. The publisher treats every downloaded byte as untrusted JSON, proves
 * the complete snapshot with the canonical managed readers/builders, and then
 * copies only genuinely new report + sidecar pairs into a clean exact-SHA
 * checkout. Retention, the public manifest, and corpus statistics are rebuilt
 * independently by the publisher after this boundary.
 */

export const REPORT_PUBLICATION_ARTIFACT_SCHEMA_VERSION = 1;
export const REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS = 10_000;
export const REPORT_PUBLICATION_ARTIFACT_MAX_FILES = REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS * 2 + 2;
export const REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES = SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES;
export const REPORT_PUBLICATION_ARTIFACT_MAX_INDEX_BYTES = STATIC_REPORT_MANIFEST_JSON_MAX_BYTES;
export const REPORT_PUBLICATION_ARTIFACT_MAX_STATS_BYTES = CORPUS_STATS_JSON_MAX_BYTES;
export const REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPORT_FILE = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const SIDECAR_FILE = /^([0-9]{8}-[0-9a-f]{32})\.provenance\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type ReportPublicationKind = "single" | "featured";
export type ReportPublicationMode = "v1" | "r2";

export type ReportPublicationArtifactFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ReportPublicationArtifactManifest = {
  schemaVersion: 1;
  sourceCommit: string;
  publicationKind: ReportPublicationKind;
  reportMode: ReportPublicationMode;
  expectedReportIds: string[];
  files: ReportPublicationArtifactFile[];
};

export type InspectedReportPublicationArtifact = {
  manifest: ReportPublicationArtifactManifest;
  reportIds: string[];
  totalBytes: number;
};

export async function prepareReportPublicationArtifact(input: {
  sourceRoot: string;
  artifactDir: string;
  sourceCommit: string;
  publicationKind: ReportPublicationKind;
  reportMode: ReportPublicationMode;
  expectedReportIds: readonly string[];
}): Promise<InspectedReportPublicationArtifact> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const artifactDir = path.resolve(input.artifactDir);
  await assertArtifactOutsideCheckout(sourceRoot, artifactDir);
  assertSourceIdentity(input.sourceCommit, input.publicationKind, input.reportMode);

  const expectedReportIds = normalizedReportIds(input.expectedReportIds, "expected report ids");
  if (input.publicationKind === "single" && expectedReportIds.length !== 1) {
    throw new Error("A single-report publication artifact must identify exactly one new report.");
  }

  const sourceReportsDir = path.join(sourceRoot, "public", "reports");
  const sourceStatsPath = path.join(sourceRoot, "public", "corpus-stats.json");
  const lock = await acquireReportCorpusLock(sourceReportsDir, "prepare-report-publication-artifact");
  try {
    const reportIds = await validateReportSnapshot(sourceReportsDir, sourceStatsPath);
    for (const id of expectedReportIds) {
      if (!reportIds.includes(id)) throw new Error(`Expected report ${id} is absent from the acquisition snapshot.`);
      await assertReportMode(sourceReportsDir, id, input.reportMode);
    }

    await mkdir(artifactDir, { recursive: false, mode: 0o700 });
    // Re-resolve after creation so a symlinked ancestor cannot make the
    // artifact land inside the acquisition checkout despite a lexical path
    // that appears to be outside it.
    await assertArtifactOutsideCheckout(sourceRoot, artifactDir);
    await mkdir(path.join(artifactDir, "reports"), { recursive: false, mode: 0o700 });

    const relativeFiles = [
      "corpus-stats.json",
      "reports/index.json",
      ...reportIds.flatMap((id) => [`reports/${id}.json`, `reports/${id}.provenance.json`])
    ].sort();
    assertFileCount(relativeFiles.length);

    const files: ReportPublicationArtifactFile[] = [];
    let totalBytes = 0;
    for (const relative of relativeFiles) {
      const limit = publicationFileLimit(relative);
      const source = relative === "corpus-stats.json"
        ? sourceStatsPath
        : path.join(sourceReportsDir, relative.slice("reports/".length));
      const contents = await readRegularFileNoFollow(source, limit);
      totalBytes += contents.byteLength;
      assertTotalBytes(totalBytes);
      const destination = path.join(artifactDir, ...relative.split("/"));
      await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
      files.push({ path: relative, bytes: contents.byteLength, sha256: sha256(contents) });
    }

    const manifest: ReportPublicationArtifactManifest = {
      schemaVersion: REPORT_PUBLICATION_ARTIFACT_SCHEMA_VERSION,
      sourceCommit: input.sourceCommit,
      publicationKind: input.publicationKind,
      reportMode: input.reportMode,
      expectedReportIds,
      files
    };
    const manifestWire = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestWire.byteLength > REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES) {
      throw new Error("Publication artifact manifest exceeds its byte limit.");
    }
    await writeFile(path.join(artifactDir, "publication.json"), manifestWire, { flag: "wx", mode: 0o600 });

    return { manifest, reportIds, totalBytes };
  } finally {
    await lock.release();
  }
}

export async function inspectReportPublicationArtifact(input: {
  artifactDir: string;
  expectedSourceCommit: string;
  expectedPublicationKind: ReportPublicationKind;
  expectedReportMode: ReportPublicationMode;
}): Promise<InspectedReportPublicationArtifact> {
  assertSourceIdentity(input.expectedSourceCommit, input.expectedPublicationKind, input.expectedReportMode);
  const artifactDir = path.resolve(input.artifactDir);
  const actualPaths = await exactArtifactPaths(artifactDir);
  const manifestWire = await readRegularFileNoFollow(
    path.join(artifactDir, "publication.json"),
    REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES
  );
  const manifest = parseManifest(manifestWire);
  if (manifest.sourceCommit !== input.expectedSourceCommit) {
    throw new Error(`Publication artifact source ${manifest.sourceCommit} does not match ${input.expectedSourceCommit}.`);
  }
  if (manifest.publicationKind !== input.expectedPublicationKind) {
    throw new Error(`Publication artifact kind ${manifest.publicationKind} does not match ${input.expectedPublicationKind}.`);
  }
  if (manifest.reportMode !== input.expectedReportMode) {
    throw new Error(`Publication artifact mode ${manifest.reportMode} does not match ${input.expectedReportMode}.`);
  }

  const declaredPaths = ["publication.json", ...manifest.files.map((file) => file.path)].sort();
  if (canonicalJson(actualPaths) !== canonicalJson(declaredPaths)) {
    throw new Error("Publication artifact contains an undeclared, missing, or non-regular path.");
  }
  assertFileCount(manifest.files.length);

  let totalBytes = 0;
  for (const file of manifest.files) {
    const contents = await readRegularFileNoFollow(
      path.join(artifactDir, ...file.path.split("/")),
      publicationFileLimit(file.path)
    );
    totalBytes += contents.byteLength;
    assertTotalBytes(totalBytes);
    if (contents.byteLength !== file.bytes || sha256(contents) !== file.sha256) {
      throw new Error(`Publication artifact digest or length mismatch for ${file.path}.`);
    }
  }

  const reportsDir = path.join(artifactDir, "reports");
  const reportIds = await validateReportSnapshot(reportsDir, path.join(artifactDir, "corpus-stats.json"));
  const declaredReportIds = reportIdsFromFileManifest(manifest.files);
  if (canonicalJson(reportIds) !== canonicalJson(declaredReportIds)) {
    throw new Error("Publication artifact report ids do not match its file manifest.");
  }
  for (const id of manifest.expectedReportIds) {
    if (!reportIds.includes(id)) throw new Error(`Expected report ${id} is absent from the publication artifact.`);
    await assertReportMode(reportsDir, id, manifest.reportMode);
  }
  if (manifest.publicationKind === "single" && manifest.expectedReportIds.length !== 1) {
    throw new Error("A single-report publication artifact must identify exactly one new report.");
  }

  return { manifest, reportIds, totalBytes };
}

export async function publishReportPublicationArtifact(input: {
  checkoutRoot: string;
  artifactDir: string;
  expectedSourceCommit: string;
  expectedPublicationKind: ReportPublicationKind;
  expectedReportMode: ReportPublicationMode;
  expectedRequest: ReportPublicationRequest;
}): Promise<{ newReportIds: string[]; artifactReportIds: string[] }> {
  const checkoutRoot = path.resolve(input.checkoutRoot);
  const artifactDir = path.resolve(input.artifactDir);
  await assertArtifactOutsideCheckout(checkoutRoot, artifactDir);

  const inspected = await inspectReportPublicationArtifact({
    artifactDir,
    expectedSourceCommit: input.expectedSourceCommit,
    expectedPublicationKind: input.expectedPublicationKind,
    expectedReportMode: input.expectedReportMode
  });
  await assertReportPublicationRequest({
    reportsDir: path.join(artifactDir, "reports"),
    reportIds: inspected.manifest.expectedReportIds,
    sourceCommit: input.expectedSourceCommit,
    request: input.expectedRequest
  });
  const checkoutReportsDir = path.join(checkoutRoot, "public", "reports");
  const lock = await acquireReportCorpusLock(checkoutReportsDir, "publish-report-artifact");
  try {
    const baseReportIds = await validateReportSnapshot(
      checkoutReportsDir,
      path.join(checkoutRoot, "public", "corpus-stats.json")
    );
    const baseIds = new Set(baseReportIds);
    const newReportIds: string[] = [];

    for (const id of inspected.reportIds) {
      const reportRelative = `reports/${id}.json`;
      const sidecarRelative = `reports/${id}.provenance.json`;
      if (baseIds.has(id)) {
        await assertSameContents(
          await readDeclaredArtifactFile(artifactDir, reportRelative, inspected.manifest),
          path.join(checkoutReportsDir, `${id}.json`),
          SERVER_STORED_REPORT_JSON_MAX_BYTES
        );
        await assertSameContents(
          await readDeclaredArtifactFile(artifactDir, sidecarRelative, inspected.manifest),
          path.join(checkoutReportsDir, `${id}.provenance.json`),
          REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES
        );
        continue;
      }
      newReportIds.push(id);
    }

    if (canonicalJson(newReportIds) !== canonicalJson(inspected.manifest.expectedReportIds)) {
      throw new Error(
        `Publication artifact new-report set does not match its declaration (found ${newReportIds.length}, declared ${inspected.manifest.expectedReportIds.length}).`
      );
    }

    // Report first, sidecar second. A partial local write cannot be committed by
    // the later fail-closed checks and therefore never becomes managed evidence.
    for (const id of newReportIds) {
      // Recheck the parsed manifest against the exact Buffer instances that are
      // written. Inspection and request binding intentionally precede checkout
      // mutation; this second digest closes an inspect-to-copy race if the
      // artifact directory changes concurrently on the trusted runner.
      const report = await readDeclaredArtifactFile(
        artifactDir,
        `reports/${id}.json`,
        inspected.manifest
      );
      const sidecar = await readDeclaredArtifactFile(
        artifactDir,
        `reports/${id}.provenance.json`,
        inspected.manifest
      );
      const reportPath = path.join(checkoutReportsDir, `${id}.json`);
      const sidecarPath = path.join(checkoutReportsDir, `${id}.provenance.json`);
      await writeNewFileDurably(reportPath, report);
      await writeNewFileDurably(sidecarPath, sidecar);

      // Prove the exact durable pair before moving to the next report. The
      // manifest/stats rebuild intentionally happens later in the workflow,
      // so pair-level managed validation is the correct publication readback.
      await assertSameContents(report, reportPath, SERVER_STORED_REPORT_JSON_MAX_BYTES);
      await assertSameContents(sidecar, sidecarPath, REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES);
      const readback = await readStaticReportBundle(checkoutReportsDir, id);
      if (readback.outcome !== "found") {
        const reason = readback.outcome === "not-found" ? "missing-report" : readback.reason;
        throw new StaticReportBundleError(id, reason);
      }
    }

    return { newReportIds, artifactReportIds: inspected.reportIds };
  } finally {
    await lock.release();
  }
}

async function validateReportSnapshot(reportsDir: string, corpusStatsPath: string): Promise<string[]> {
  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");
  const reportIds = await listStaticReportCandidateIds(reportsDir);
  if (reportIds.length > REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS) {
    throw new Error(`Publication snapshot has ${reportIds.length} reports; limit is ${REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS}.`);
  }
  for (const id of reportIds) {
    parseJson(
      await readRegularFileNoFollow(path.join(reportsDir, `${id}.json`), SERVER_STORED_REPORT_JSON_MAX_BYTES),
      `report ${id}`
    );
    parseJson(
      await readRegularFileNoFollow(
        path.join(reportsDir, `${id}.provenance.json`),
        REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES
      ),
      `report provenance ${id}`
    );
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      throw new StaticReportBundleError(id, read.outcome === "not-found" ? "missing-report" : read.reason);
    }
  }

  const index = parseJson(
    await readRegularFileNoFollow(path.join(reportsDir, "index.json"), REPORT_PUBLICATION_ARTIFACT_MAX_INDEX_BYTES),
    "report manifest"
  );
  const indexTimestamp = generatedAt(index, "report manifest");
  const rebuiltManifest = await buildStaticReportManifest(reportsDir, new Date(indexTimestamp));
  if (canonicalJson(index) !== canonicalJson(rebuiltManifest.manifest)) {
    throw new Error("Publication snapshot report manifest is not canonical for its report bundles.");
  }

  const stats = parseJson(
    await readRegularFileNoFollow(corpusStatsPath, REPORT_PUBLICATION_ARTIFACT_MAX_STATS_BYTES),
    "corpus stats"
  );
  const statsTimestamp = generatedAt(stats, "corpus stats");
  const rebuiltStats = await buildCorpusStats(reportsDir, new Date(statsTimestamp));
  if (canonicalJson(stats) !== canonicalJson(rebuiltStats.stats)) {
    throw new Error("Publication snapshot corpus stats are not canonical for its report bundles.");
  }
  return reportIds;
}

async function assertReportMode(
  reportsDir: string,
  reportId: string,
  expectedMode: ReportPublicationMode
): Promise<void> {
  const bundle = await readStaticReportBundle(reportsDir, reportId);
  if (bundle.outcome !== "found") {
    throw new Error(`Expected report ${reportId} became unreadable while checking its schema.`);
  }
  const modeMatches = expectedMode === "v1"
    ? bundle.stored.schemaVersion === 1
    : bundle.stored.schemaVersion === 2 && bundle.stored.schemaRevision === 2;
  if (!modeMatches) {
    const actual = bundle.stored.schemaVersion === 1
      ? "v1"
      : `v2-r${bundle.stored.schemaRevision}`;
    throw new Error(`Expected report ${reportId} is ${actual}, not declared mode ${expectedMode}.`);
  }
}

async function exactArtifactPaths(artifactDir: string): Promise<string[]> {
  const root = await directoryEntriesNoSymlinks(artifactDir);
  const rootNames = root.map((entry) => entry.name).sort();
  if (canonicalJson(rootNames) !== canonicalJson(["corpus-stats.json", "publication.json", "reports"])) {
    throw new Error("Publication artifact root must contain only publication.json, corpus-stats.json, and reports/.");
  }
  const reportsEntry = root.find((entry) => entry.name === "reports");
  if (!reportsEntry?.isDirectory()) throw new Error("Publication artifact reports path is not a directory.");
  for (const entry of root) {
    if (entry.name !== "reports" && !entry.isFile()) {
      throw new Error(`Publication artifact root path ${entry.name} is not a regular file.`);
    }
  }

  const reports = await directoryEntriesNoSymlinks(path.join(artifactDir, "reports"));
  for (const entry of reports) {
    if (!entry.isFile() || (entry.name !== "index.json" && !REPORT_FILE.test(entry.name) && !SIDECAR_FILE.test(entry.name))) {
      throw new Error(`Publication artifact report path ${entry.name} is not an allowed regular JSON file.`);
    }
  }
  return [
    "corpus-stats.json",
    "publication.json",
    ...reports.map((entry) => `reports/${entry.name}`)
  ].sort();
}

async function directoryEntriesNoSymlinks(directory: string) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error(`${directory} is not a directory.`);
  } finally {
    await handle.close();
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error(`Publication artifact contains a symbolic link in ${directory}.`);
  }
  return entries;
}

function parseManifest(contents: Buffer): ReportPublicationArtifactManifest {
  const value = parseJson(contents, "publication artifact manifest");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid publication artifact manifest.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (canonicalJson(keys) !== canonicalJson(["expectedReportIds", "files", "publicationKind", "reportMode", "schemaVersion", "sourceCommit"])) {
    throw new Error("Publication artifact manifest has an invalid field set.");
  }
  if (record.schemaVersion !== REPORT_PUBLICATION_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("Unsupported publication artifact schema version.");
  }
  if (typeof record.sourceCommit !== "string" || !FULL_SHA.test(record.sourceCommit)) {
    throw new Error("Publication artifact source commit is invalid.");
  }
  if (record.publicationKind !== "single" && record.publicationKind !== "featured") {
    throw new Error("Publication artifact kind is invalid.");
  }
  if (record.reportMode !== "v1" && record.reportMode !== "r2") {
    throw new Error("Publication artifact report mode is invalid.");
  }
  if (!Array.isArray(record.expectedReportIds) || !Array.isArray(record.files)) {
    throw new Error("Publication artifact report ids or file manifest is invalid.");
  }
  if (record.expectedReportIds.length > REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS) {
    throw new Error("Publication artifact declares too many expected report ids.");
  }
  // Enforce cardinality before mapping attacker-controlled entries. The byte
  // cap already bounds input size; this also bounds validation work directly.
  assertFileCount(record.files.length);
  const expectedReportIds = normalizedReportIds(record.expectedReportIds, "expected report ids");
  const files = record.files.map((entry): ReportPublicationArtifactFile => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid publication artifact file entry.");
    const file = entry as Record<string, unknown>;
    if (canonicalJson(Object.keys(file).sort()) !== canonicalJson(["bytes", "path", "sha256"])) {
      throw new Error("Publication artifact file entry has an invalid field set.");
    }
    if (typeof file.path !== "string" || !allowedRelativeFile(file.path)) {
      throw new Error("Publication artifact file path is invalid.");
    }
    if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Publication artifact byte length is invalid for ${file.path}.`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error(`Publication artifact digest is invalid for ${file.path}.`);
    }
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  const filePaths = files.map((file) => file.path);
  if (canonicalJson(filePaths) !== canonicalJson([...new Set(filePaths)].sort())) {
    throw new Error("Publication artifact file paths must be unique and sorted.");
  }
  return {
    schemaVersion: REPORT_PUBLICATION_ARTIFACT_SCHEMA_VERSION,
    sourceCommit: record.sourceCommit,
    publicationKind: record.publicationKind,
    reportMode: record.reportMode,
    expectedReportIds,
    files
  };
}

function reportIdsFromFileManifest(files: readonly ReportPublicationArtifactFile[]): string[] {
  const reports = new Set<string>();
  const sidecars = new Set<string>();
  for (const file of files) {
    const report = /^reports\/([0-9]{8}-[0-9a-f]{32})\.json$/.exec(file.path);
    if (report) reports.add(report[1]);
    const sidecar = /^reports\/([0-9]{8}-[0-9a-f]{32})\.provenance\.json$/.exec(file.path);
    if (sidecar) sidecars.add(sidecar[1]);
  }
  if (canonicalJson([...reports].sort()) !== canonicalJson([...sidecars].sort())) {
    throw new Error("Publication artifact report and sidecar ids do not pair exactly.");
  }
  return [...reports].sort();
}

function normalizedReportIds(values: readonly unknown[], label: string): string[] {
  const ids = values.map((value) => {
    if (typeof value !== "string" || !REPORT_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
    return value;
  });
  const sorted = [...new Set(ids)].sort();
  if (canonicalJson(ids) !== canonicalJson(sorted)) throw new Error(`${label} must be unique and sorted.`);
  return sorted;
}

function allowedRelativeFile(value: string): boolean {
  if (value === "corpus-stats.json" || value === "reports/index.json") return true;
  if (!value.startsWith("reports/") || value.includes("\\") || value.includes("..")) return false;
  const name = value.slice("reports/".length);
  return REPORT_FILE.test(name) || SIDECAR_FILE.test(name);
}

function publicationFileLimit(relative: string): number {
  if (!allowedRelativeFile(relative)) throw new Error(`Publication artifact path is not allowed: ${relative}`);
  if (relative === "corpus-stats.json") return REPORT_PUBLICATION_ARTIFACT_MAX_STATS_BYTES;
  if (relative === "reports/index.json") return REPORT_PUBLICATION_ARTIFACT_MAX_INDEX_BYTES;
  if (relative.endsWith(".provenance.json")) return REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES;
  return SERVER_STORED_REPORT_JSON_MAX_BYTES;
}

async function readRegularFileNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${file} is not a regular file.`);
    if (metadata.size > maxBytes) throw new Error(`${file} exceeds its ${maxBytes}-byte limit.`);
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      contents.byteLength !== metadata.size ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    ) {
      throw new Error(`${file} changed while it was being read.`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function readDeclaredArtifactFile(
  artifactDir: string,
  relative: string,
  manifest: ReportPublicationArtifactManifest
): Promise<Buffer> {
  const declaration = manifest.files.find((file) => file.path === relative);
  if (!declaration) throw new Error(`Publication artifact has no declaration for ${relative}.`);
  const contents = await readRegularFileNoFollow(
    path.join(artifactDir, ...relative.split("/")),
    publicationFileLimit(relative)
  );
  if (contents.byteLength !== declaration.bytes || sha256(contents) !== declaration.sha256) {
    throw new Error(`Publication artifact changed after inspection for ${relative}.`);
  }
  return contents;
}

async function assertSameContents(leftContents: Buffer, right: string, maxBytes: number): Promise<void> {
  const rightContents = await readRegularFileNoFollow(right, maxBytes);
  if (leftContents.byteLength !== rightContents.byteLength || sha256(leftContents) !== sha256(rightContents)) {
    throw new Error(`Publication artifact attempted to alter existing managed evidence ${path.basename(right)}.`);
  }
}

function parseJson(contents: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
  } catch {
    throw new Error(`Invalid UTF-8 in ${label}.`);
  }
  try {
    return parseStrictJson(text, contents.byteLength);
  } catch (error) {
    if (error instanceof StrictJsonError && error.reason === "duplicate-key") {
      throw new Error(`Duplicate JSON key in ${label}.`);
    }
    throw new Error(`Invalid JSON in ${label}.`);
  }
}

function generatedAt(value: unknown, label: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  const timestamp = (value as { generatedAt?: unknown }).generatedAt;
  if (typeof timestamp !== "string") throw new Error(`${label} has no generatedAt timestamp.`);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${label} generatedAt timestamp is not canonical.`);
  }
  return timestamp;
}

function assertSourceIdentity(sourceCommit: string, kind: string, mode: string): void {
  if (!FULL_SHA.test(sourceCommit)) throw new Error("Expected source commit must be a full lowercase Git SHA.");
  if (kind !== "single" && kind !== "featured") throw new Error("Publication kind must be single or featured.");
  if (mode !== "v1" && mode !== "r2") throw new Error("Publication report mode must be v1 or r2.");
}

async function assertArtifactOutsideCheckout(checkoutRoot: string, artifactDir: string): Promise<void> {
  const [canonicalCheckoutRoot, canonicalArtifactDir] = await Promise.all([
    canonicalPathAllowingMissingLeaf(checkoutRoot),
    canonicalPathAllowingMissingLeaf(artifactDir)
  ]);
  const relative = path.relative(canonicalCheckoutRoot, canonicalArtifactDir);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Publication artifacts must stay outside the Git checkout.");
  }
}

async function canonicalPathAllowingMissingLeaf(value: string): Promise<string> {
  let existing = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...missingSegments);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertFileCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 2 || count > REPORT_PUBLICATION_ARTIFACT_MAX_FILES) {
    throw new Error(`Publication artifact file count ${count} is outside the allowed bound.`);
  }
}

function assertTotalBytes(total: number): void {
  if (!Number.isSafeInteger(total) || total > REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES) {
    throw new Error(`Publication artifact exceeds the ${REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit.`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
