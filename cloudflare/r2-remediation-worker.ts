import { readManagedReport, type ManagedReportClock } from "../lib/managed-report-reader";
import {
  historicalR2MaxAgeDays,
  planR2RemediationInventory,
  planR2ReportRemediation,
  r2ReportRetentionSource
} from "../lib/r2-report-remediation";

type Env = {
  REPORTS: R2Bucket;
  /** Local `wrangler dev` secret. Never commit this value. */
  SITE_BEHAVIOR_LAB_R2_REMEDIATION_APPLY_TOKEN?: string;
  /** Exact max age used by the legacy writer; omitted means its historical default (7). */
  SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS?: string;
};

type R2StorageClass = "Standard" | "InfrequentAccess";

type ObjectSnapshot = {
  etag: string;
  uploadedAt: string;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  storageClass: R2StorageClass;
};

type PreflightRecord = {
  reportId: string;
  reportKey: string;
  sidecarKey: string;
  action: "current" | "rewrite" | "expired";
  reportChanged: boolean;
  reportWriteRequired: boolean;
  retentionOrigin: "metadata" | "legacy-uploaded";
  retention: { createdAt: string; expiresAt: string };
  report: ObjectSnapshot;
  sidecar: ObjectSnapshot | null;
};

type PreflightIssue = { reportId?: string; key?: string; issue: string; detail?: string };

type Preflight = {
  writtenAt: string;
  inventoryKeys: string[];
  records: PreflightRecord[];
  issues: PreflightIssue[];
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const apply = request.method === "POST" && url.pathname === "/apply";
    const dryRun = request.method === "GET" && (url.pathname === "/" || url.pathname === "/dry-run");
    if (!apply && !dryRun) return json({ error: "Use GET / for a dry run or authenticated POST /apply." }, 405);

    if (apply) {
      const auth = await authorizeApply(request, env);
      if (auth !== null) return auth;
    }

    // One clock drives the complete run. It is reused when apply re-reads and
    // re-plans each object, so no report can receive a different provenance
    // timestamp because of processing order.
    const writtenAt = new Date().toISOString();
    let maxAgeDays: number;
    let preflight: Preflight;
    try {
      maxAgeDays = historicalR2MaxAgeDays(env.SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS);
      preflight = await preflightAll(env.REPORTS, writtenAt, maxAgeDays);
    } catch (error) {
      return json({ mode: apply ? "apply" : "dry-run", ready: false, error: safeError(error) }, 500);
    }
    const summary = summarize(preflight);
    if (!apply) return json({ mode: "dry-run", ready: preflight.issues.length === 0, ...summary });
    if (preflight.issues.length > 0) {
      return json({ mode: "apply", ready: false, applied: 0, ...summary }, 409);
    }

    let applied = 0;
    try {
      // The runbook requires scanner writes to stay gated throughout apply.
      // This second full-prefix barrier detects a missed in-flight write or
      // metadata mutation before the first remediation PUT is attempted.
      await confirmPreflightUnchanged(env.REPORTS, preflight);
      for (const record of preflight.records) {
        if (record.action !== "rewrite") continue;
        await applyOne(env.REPORTS, record, writtenAt, maxAgeDays);
        applied += 1;
      }
      // Per-object readback proves every rewrite. A complete postflight also
      // closes the prefix-level preflight race: no newly arrived legacy share
      // or unfinished record may hide outside the original worklist.
      const postflight = await preflightAll(env.REPORTS, writtenAt, maxAgeDays);
      if (
        postflight.issues.length > 0 ||
        postflight.records.some((record) => record.action === "rewrite") ||
        !sameReportSet(preflight, postflight)
      ) {
        throw new RemediationConflictError("postflight");
      }
    } catch (error) {
      // A report is always written before its sidecar. Any interruption or
      // conflict therefore leaves that share unattested (or with an old
      // digest), which the production managed reader rejects fail-closed.
      return json(
        { mode: "apply", ready: false, applied, error: safeError(error), ...summary },
        error instanceof RemediationConflictError ? 409 : 500
      );
    }
    return json({ mode: "apply", ready: true, applied, readbacks: applied, ...summary });
  }
};

async function preflightAll(bucket: R2Bucket, writtenAt: string, maxAgeDays: number): Promise<Preflight> {
  const keys = await listReportKeys(bucket);
  const inventory = planR2RemediationInventory(keys);
  const issues: PreflightIssue[] = inventory.issues.map((entry) => ({ key: entry.key, issue: entry.issue }));
  const records: PreflightRecord[] = [];

  // Deliberately sequential and lightweight: the generated report/sidecar
  // wires exist only for this iteration and are discarded. Apply re-reads and
  // re-plans with the same clock, then uses the preflight ETags as conditions.
  for (const entry of inventory.reports) {
    const report = await bucket.get(entry.reportKey);
    if (!report) {
      issues.push({ reportId: entry.reportId, issue: "report-disappeared-during-preflight" });
      continue;
    }
    const retentionSource = r2ReportRetentionSource(report.customMetadata, uploadedAt(report), maxAgeDays);
    const reportContents = await report.text();

    let sidecar: R2ObjectBody | null = null;
    let sidecarContents: string | null = null;
    if (entry.sidecarExists) {
      sidecar = await bucket.get(entry.sidecarKey);
      if (!sidecar) {
        issues.push({ reportId: entry.reportId, issue: "sidecar-disappeared-during-preflight" });
        continue;
      }
      sidecarContents = await sidecar.text();
    }

    const plan = planR2ReportRemediation({
      reportId: entry.reportId,
      reportContents,
      sidecarContents,
      retentionSource,
      writtenAt,
      now: writtenAt
    });
    if (!plan.ok) {
      issues.push({ reportId: plan.reportId, issue: plan.issue, ...(plan.detail ? { detail: plan.detail } : {}) });
      continue;
    }
    records.push({
      reportId: entry.reportId,
      reportKey: entry.reportKey,
      sidecarKey: entry.sidecarKey,
      action: plan.action,
      reportChanged: plan.action === "rewrite" ? plan.reportChanged : false,
      reportWriteRequired: plan.action === "rewrite" ? plan.reportWriteRequired : false,
      retentionOrigin: plan.retentionOrigin,
      retention: plan.retention,
      report: snapshot(report),
      sidecar: sidecar ? snapshot(sidecar) : null
    });
  }
  return { writtenAt, inventoryKeys: keys, records, issues };
}

async function listReportKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "reports/", ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

async function confirmPreflightUnchanged(bucket: R2Bucket, expected: Preflight): Promise<void> {
  const keys = await listReportKeys(bucket);
  if (JSON.stringify(keys) !== JSON.stringify(expected.inventoryKeys)) {
    throw new RemediationConflictError("inventory");
  }
  for (const record of expected.records) {
    const [report, sidecar] = await Promise.all([bucket.get(record.reportKey), bucket.get(record.sidecarKey)]);
    if (!report || !matchesSnapshot(report, record.report)) throw new RemediationConflictError(record.reportId);
    if (
      (sidecar === null) !== (record.sidecar === null) ||
      (sidecar !== null && record.sidecar !== null && !matchesSnapshot(sidecar, record.sidecar))
    ) {
      throw new RemediationConflictError(record.reportId);
    }
  }
}

function sameReportSet(left: Preflight, right: Preflight): boolean {
  const ids = (preflight: Preflight): string[] => preflight.records.map((record) => record.reportId).sort();
  return JSON.stringify(ids(left)) === JSON.stringify(ids(right));
}

async function applyOne(
  bucket: R2Bucket,
  expected: PreflightRecord,
  writtenAt: string,
  maxAgeDays: number
): Promise<void> {
  const report = await bucket.get(expected.reportKey);
  if (!report || !matchesSnapshot(report, expected.report)) throw new RemediationConflictError(expected.reportId);
  const reportContents = await report.text();

  const sidecar = await bucket.get(expected.sidecarKey);
  if (
    (sidecar === null) !== (expected.sidecar === null) ||
    (sidecar !== null && expected.sidecar !== null && !matchesSnapshot(sidecar, expected.sidecar))
  ) {
    throw new RemediationConflictError(expected.reportId);
  }
  const sidecarContents = sidecar ? await sidecar.text() : null;
  const plan = planR2ReportRemediation({
    reportId: expected.reportId,
    reportContents,
    sidecarContents,
    retentionSource: r2ReportRetentionSource(report.customMetadata, uploadedAt(report), maxAgeDays),
    writtenAt,
    now: writtenAt
  });
  if (
    !plan.ok ||
    plan.action !== "rewrite" ||
    expected.action !== "rewrite" ||
    plan.reportChanged !== expected.reportChanged ||
    plan.reportWriteRequired !== expected.reportWriteRequired ||
    plan.retentionOrigin !== expected.retentionOrigin ||
    !sameClock(plan.retention, expected.retention)
  ) {
    throw new RemediationConflictError(expected.reportId);
  }

  if (plan.reportWriteRequired) {
    const customMetadata =
      plan.retentionOrigin === "legacy-uploaded"
        ? withRetentionMetadata(expected.report.customMetadata, plan.retention)
        : expected.report.customMetadata;
    const reportWrite = await bucket.put(expected.reportKey, plan.reportWire, {
      onlyIf: { etagMatches: expected.report.etag },
      httpMetadata: expected.report.httpMetadata,
      customMetadata,
      storageClass: expected.report.storageClass
    });
    if (reportWrite === null) throw new RemediationConflictError(expected.reportId);
  }

  // Report first, sidecar second. The create path is also conditional so a
  // sidecar that appeared after preflight cannot be overwritten.
  const sidecarOptions: R2PutOptions = expected.sidecar
    ? {
        onlyIf: { etagMatches: expected.sidecar.etag },
        httpMetadata: expected.sidecar.httpMetadata,
        customMetadata: expected.sidecar.customMetadata,
        storageClass: expected.sidecar.storageClass
      }
    : {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      };
  const sidecarWrite = await bucket.put(expected.sidecarKey, plan.sidecarWire, sidecarOptions);
  if (sidecarWrite === null) throw new RemediationConflictError(expected.reportId);

  await verifyReadback(bucket, expected, writtenAt, maxAgeDays);
}

async function verifyReadback(
  bucket: R2Bucket,
  expected: PreflightRecord,
  writtenAt: string,
  maxAgeDays: number
): Promise<void> {
  const report = await bucket.get(expected.reportKey);
  const sidecar = await bucket.get(expected.sidecarKey);
  if (!report || !sidecar) throw new Error(`Readback failed for ${expected.reportId}.`);
  const expectedReportMetadata =
    expected.retentionOrigin === "legacy-uploaded"
      ? withRetentionMetadata(expected.report.customMetadata, expected.retention)
      : expected.report.customMetadata;
  if (
    !httpMetadataEqual(report.httpMetadata, expected.report.httpMetadata) ||
    !customMetadataEqual(report.customMetadata, expectedReportMetadata)
  ) {
    throw new Error(`Report object metadata changed for ${expected.reportId}.`);
  }
  const expectedSidecarHttp = expected.sidecar?.httpMetadata ?? { contentType: "application/json; charset=utf-8" };
  if (
    !httpMetadataEqual(sidecar.httpMetadata, expectedSidecarHttp) ||
    !customMetadataEqual(sidecar.customMetadata, expected.sidecar?.customMetadata)
  ) {
    throw new Error(`Sidecar object metadata changed for ${expected.reportId}.`);
  }
  const retentionSource = r2ReportRetentionSource(report.customMetadata, uploadedAt(report), maxAgeDays);
  if (retentionSource.kind !== "metadata" || !sameClock(retentionSource.retention, expected.retention)) {
    throw new Error(`Retention clock changed for ${expected.reportId}.`);
  }
  const retention = expected.retention;
  const reportContents = await report.text();
  const sidecarContents = await sidecar.text();
  const managed = readManagedReport({ reportId: expected.reportId, reportContents, sidecarContents, retention });
  if (!managed.ok) throw new Error(`Managed-reader readback failed for ${expected.reportId}: ${managed.reason}.`);

  // The planner performs the explicit redaction fixed-point proof. Seeing
  // `current` on readback also proves the newly stored sidecar/clock unit.
  const fixedPoint = planR2ReportRemediation({
    reportId: expected.reportId,
    reportContents,
    sidecarContents,
    retentionSource,
    writtenAt,
    now: writtenAt
  });
  if (!fixedPoint.ok || fixedPoint.action !== "current") {
    throw new Error(`Fixed-point readback failed for ${expected.reportId}.`);
  }
}

function snapshot(object: R2Object): ObjectSnapshot {
  return {
    etag: object.etag,
    uploadedAt: uploadedAt(object) ?? "invalid",
    ...(object.httpMetadata ? { httpMetadata: { ...object.httpMetadata } } : {}),
    ...(object.customMetadata ? { customMetadata: { ...object.customMetadata } } : {}),
    storageClass: parseStorageClass(object.storageClass)
  };
}

function matchesSnapshot(object: R2Object, expected: ObjectSnapshot): boolean {
  return (
    object.etag === expected.etag &&
    uploadedAt(object) === expected.uploadedAt &&
    httpMetadataEqual(object.httpMetadata, expected.httpMetadata) &&
    customMetadataEqual(object.customMetadata, expected.customMetadata) &&
    parseStorageClass(object.storageClass) === expected.storageClass
  );
}

function uploadedAt(object: R2Object): string | null {
  const timestamp = object.uploaded.getTime();
  return Number.isFinite(timestamp) ? object.uploaded.toISOString() : null;
}

function withRetentionMetadata(
  metadata: Record<string, string> | undefined,
  retention: ManagedReportClock
): Record<string, string> {
  return { ...metadata, "created-at": retention.createdAt, "expires-at": retention.expiresAt ?? "" };
}

function sameClock(left: ManagedReportClock | null, right: ManagedReportClock): boolean {
  return left?.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}

function customMetadataEqual(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function httpMetadataEqual(left: R2HTTPMetadata | undefined, right: R2HTTPMetadata | undefined): boolean {
  return JSON.stringify(normalizeHttpMetadata(left)) === JSON.stringify(normalizeHttpMetadata(right));
}

function normalizeHttpMetadata(value: R2HTTPMetadata | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, item instanceof Date ? item.toISOString() : String(item)])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function parseStorageClass(value: string): R2StorageClass {
  if (value === "Standard" || value === "InfrequentAccess") return value;
  throw new Error("Unsupported R2 storage class.");
}

async function authorizeApply(request: Request, env: Env): Promise<Response | null> {
  const expected = env.SITE_BEHAVIOR_LAB_R2_REMEDIATION_APPLY_TOKEN?.trim() ?? "";
  if (expected.length < 32) return json({ error: "Apply token is not configured." }, 503);
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!(await constantTimeEqual(supplied, expected))) return json({ error: "Unauthorized." }, 401);
  return null;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let different = left.length === right.length ? 0 : 1;
  for (let index = 0; index < a.length; index += 1) different |= a[index] ^ b[index];
  return different === 0;
}

function summarize(preflight: Preflight) {
  const issueCounts = preflight.issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.issue] = (counts[issue.issue] ?? 0) + 1;
    return counts;
  }, {});
  return {
    writtenAt: preflight.writtenAt,
    reports: preflight.records.length + preflight.issues.filter((issue) => issue.reportId).length,
    current: preflight.records.filter((record) => record.action === "current").length,
    rewrites: preflight.records.filter((record) => record.action === "rewrite").length,
    legacy: preflight.records.filter((record) => record.retentionOrigin === "legacy-uploaded").length,
    legacyRewrites: preflight.records.filter(
      (record) => record.retentionOrigin === "legacy-uploaded" && record.action === "rewrite"
    ).length,
    legacyExpired: preflight.records.filter(
      (record) => record.retentionOrigin === "legacy-uploaded" && record.action === "expired"
    ).length,
    reportWrites: preflight.records.filter(
      (record) => record.action === "rewrite" && record.reportWriteRequired
    ).length,
    reportChanges: preflight.records.filter((record) => record.action === "rewrite" && record.reportChanged).length,
    expired: preflight.records.filter((record) => record.action === "expired").length,
    issues: preflight.issues.length,
    issueCounts
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function safeError(error: unknown): string {
  return error instanceof RemediationConflictError ? "r2-object-changed-after-preflight" : "remediation-operation-failed";
}

class RemediationConflictError extends Error {
  constructor(reportId: string) {
    super(`R2 object changed after preflight for ${reportId}; apply stopped.`);
    this.name = "RemediationConflictError";
  }
}
