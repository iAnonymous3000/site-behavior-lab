/**
 * The admission gate between the local scan server's /api/scan answer and the
 * reliability sweep's bare-load projection.
 *
 * WHY THIS EXISTS. The first driver turned every answer that was not a report
 * into the all-ineligible "unavailable" row: our own access gate, our own rate
 * limit, a misconfigured r2 producer, a persistence refusal, an internal
 * error, an unreachable server. Each of those is a statement about the
 * SCANNER, and recording it as a statement about the SITE drops that site
 * from the eligible pool for a reason the site never caused, while the round
 * still validated and the reason was printed nowhere. A sweep that cannot
 * tell "the site could not be loaded" from "our instrument refused to try"
 * selects its frame on the instrument's own failures.
 *
 * So every answer is put in exactly one of three dispositions, and the
 * default is the one that stops:
 *
 *   - "report": HTTP 200 whose strict-JSON body IS a ScanReport v2 r2 single
 *     report, produced by the build the round declares
 *     (run.provenance.buildCommit equal to SITE_BEHAVIOR_LAB_BUILD_COMMIT),
 *     under the declared condition. Only this disposition reaches
 *     bareLoadOutcome as a report.
 *   - "target": the scan was attempted and the TARGET could not be measured,
 *     declared by the server as one of SWEEP_TARGET_FAILURE_CAUSES, or the
 *     scanner's navigation-failure answer (HTTP 502, no declared cause). The
 *     sweep records these as observations: bareLoadOutcome(null) yields the
 *     all-ineligible row, exactly as before.
 *   - "stop": everything else. A declared scanner-side cause, an unknown
 *     cause, a cause-less refusal other than the navigation failure, a job
 *     submission, a redirect, a malformed body, a non-r2 report, a report
 *     from another build or condition. The driver stops the round on it.
 *
 * Classification reads the declared `cause`, never the message: matching
 * prose is the defect lib/scan-failure-causes.ts exists to remove. The one
 * status-only rule (502 without a cause) is pinned to its single producer in
 * lib/scanner.ts by a guard in this module's test, and the cause map is
 * pinned to the ScanFailureCause union there, so a new cause or a second 502
 * producer fails a test instead of being silently filed as a site outcome.
 *
 * This module reads envelope and identity fields only (schema version and
 * revision, report type, run.provenance.buildCommit, run.conditions). It
 * never reads evidence, and it returns the report object untouched; the
 * narrowing to load facts stays in calibration-reliability-sweep-lib.mjs.
 */

import { parseStrictJson } from "../lib/strict-json.ts";

/**
 * Every declared cause, classified. Closed: a cause missing from this map is
 * a stop, and the test requires the key set to equal the ScanFailureCause
 * union in lib/scan-failure-causes.ts in both directions.
 *
 * "target" is reserved for causes that are a statement about the address the
 * sweep asked for: its name does not resolve, it resolves somewhere private,
 * or its page did not load inside the scan's budget. Everything else is the
 * scanner, its deployment, or the request the driver sent, and says nothing
 * about the site. invalid-url is deliberately a stop: the candidate grammar
 * admits only https URLs the server should accept, so a refusal means the
 * candidate set and the server's URL policy disagree, which is a tooling
 * defect to adjudicate, not a site that failed to load.
 */
export const SWEEP_SCAN_CAUSE_DISPOSITIONS = Object.freeze({
  "invalid-url": "stop",
  "private-target": "target",
  "target-unreachable": "target",
  "page-load-timeout": "target",
  "scanner-busy": "stop",
  "request-limit": "stop",
  "challenge-required": "stop",
  "access-key-required": "stop",
  "request-rejected": "stop",
  "feature-unavailable": "stop",
  "scan-conflict": "stop",
  "service-error": "stop"
});

export const SWEEP_TARGET_FAILURE_CAUSES = Object.freeze(
  Object.entries(SWEEP_SCAN_CAUSE_DISPOSITIONS)
    .filter(([, disposition]) => disposition === "target")
    .map(([cause]) => cause)
    .sort()
);

/**
 * The scanner's answer when page navigation itself failed for a reason other
 * than a timeout or a private address (TLS and HTTP/2 errors, resets, sites
 * refusing automated browsers): lib/scanner.ts throws it with this status and
 * no declared cause. It is the only cause-less answer the sweep records as a
 * site outcome.
 */
export const SWEEP_NAVIGATION_FAILURE_STATUS = 502;

const REPORT_SCHEMA_VERSION = 2;
const REPORT_SCHEMA_REVISION = 2;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stop(httpStatus, reason, { cause = null, error = null } = {}) {
  return { disposition: "stop", httpStatus, cause, error, reason };
}

function parseBody(bodyText) {
  try {
    return { ok: true, value: parseStrictJson(bodyText) };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

function describeErrorBody(body) {
  return isRecord(body) && typeof body.error === "string" ? body.error : null;
}

function reportMismatch(body, expectedBuildCommit, condition) {
  if (!isRecord(body)) return "the body is not a JSON object";
  if (
    body.schemaVersion !== REPORT_SCHEMA_VERSION ||
    body.schemaRevision !== REPORT_SCHEMA_REVISION
  ) {
    return `the body is not a ScanReport v2 r2 (schemaVersion ${JSON.stringify(body.schemaVersion)}, schemaRevision ${JSON.stringify(body.schemaRevision)}); start the server with SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1 and its prerequisites`;
  }
  if (body.reportType !== "single") {
    return `the report type is ${JSON.stringify(body.reportType)}, not the single report the sweep requested`;
  }
  const run = body.run;
  if (!isRecord(run) || !isRecord(run.provenance)) {
    return "the report carries no run provenance";
  }
  const reported = run.provenance.buildCommit;
  if (reported !== expectedBuildCommit) {
    return `the report was produced by build ${JSON.stringify(reported)}, not the declared SITE_BEHAVIOR_LAB_BUILD_COMMIT ${expectedBuildCommit}; the round would attribute another build's measurements to this one`;
  }
  const conditions = run.conditions;
  if (
    !isRecord(conditions) ||
    !isRecord(conditions.device) ||
    conditions.device.kind !== condition.device ||
    conditions.consent !== condition.consentMode ||
    conditions.gpc !== condition.gpcEnabled
  ) {
    const reportedCondition = isRecord(conditions)
      ? {
          device: isRecord(conditions.device) ? conditions.device.kind : undefined,
          consent: conditions.consent,
          gpc: conditions.gpc
        }
      : null;
    return `the report was measured under ${JSON.stringify(reportedCondition)}, not the declared condition ${JSON.stringify(condition)}`;
  }
  return null;
}

/**
 * Classify one /api/scan answer. Pure: takes the HTTP status and the exact
 * body text, returns a disposition record, throws only on a programming error
 * in its own arguments. Transport failures never reach it; the driver stops on
 * those before there is a body to classify.
 */
export function classifyScanResponse({ httpStatus, bodyText, expectedBuildCommit, condition }) {
  if (!Number.isSafeInteger(httpStatus)) {
    throw new TypeError("classifyScanResponse requires the integer HTTP status");
  }
  if (typeof bodyText !== "string") {
    throw new TypeError("classifyScanResponse requires the response body text");
  }
  if (typeof expectedBuildCommit !== "string" || !/^[0-9a-f]{40}$/.test(expectedBuildCommit)) {
    throw new TypeError("classifyScanResponse requires the declared 40-character build commit");
  }
  if (
    !isRecord(condition) ||
    typeof condition.device !== "string" ||
    typeof condition.consentMode !== "string" ||
    typeof condition.gpcEnabled !== "boolean"
  ) {
    throw new TypeError("classifyScanResponse requires the declared measurement condition");
  }

  const parsed = parseBody(bodyText);

  if (httpStatus === 200) {
    if (!parsed.ok) {
      return stop(httpStatus, `HTTP 200 with a body that is not strict JSON (${parsed.detail})`);
    }
    const mismatch = reportMismatch(parsed.value, expectedBuildCommit, condition);
    if (mismatch !== null) {
      return stop(httpStatus, `HTTP 200 refused as a sweep report: ${mismatch}`, {
        cause: isRecord(parsed.value) && typeof parsed.value.cause === "string" ? parsed.value.cause : null,
        error: describeErrorBody(parsed.value)
      });
    }
    return { disposition: "report", report: parsed.value };
  }

  if (httpStatus < 400) {
    return stop(
      httpStatus,
      httpStatus === 202
        ? "HTTP 202 is a scan-job submission: the server runs asynchronous or durable admission, and the sweep reads only the synchronous report route"
        : `HTTP ${httpStatus} is neither a report nor a refusal`,
      { error: parsed.ok ? describeErrorBody(parsed.value) : null }
    );
  }

  if (!parsed.ok) {
    return stop(httpStatus, `HTTP ${httpStatus} with a body that is not strict JSON (${parsed.detail})`);
  }
  const body = parsed.value;
  if (
    !isRecord(body) ||
    body.ok !== false ||
    typeof body.error !== "string" ||
    ("cause" in body && typeof body.cause !== "string")
  ) {
    return stop(httpStatus, `HTTP ${httpStatus} with a body that is not the scanner's error shape`, {
      error: describeErrorBody(body)
    });
  }
  const cause = "cause" in body ? body.cause : null;
  const error = body.error;

  if (cause !== null) {
    const disposition = Object.hasOwn(SWEEP_SCAN_CAUSE_DISPOSITIONS, cause)
      ? SWEEP_SCAN_CAUSE_DISPOSITIONS[cause]
      : null;
    if (disposition === "target") {
      return { disposition: "target", httpStatus, cause, error };
    }
    return stop(
      httpStatus,
      disposition === null
        ? `the server declared cause "${cause}", which this driver does not know; an unclassified refusal is never filed as a site outcome`
        : `the server refused the scan itself (cause "${cause}"); that is a statement about the scanner or its deployment, not about the site`,
      { cause, error }
    );
  }

  if (httpStatus === SWEEP_NAVIGATION_FAILURE_STATUS) {
    return { disposition: "target", httpStatus, cause: null, error };
  }
  return stop(
    httpStatus,
    httpStatus === 500
      ? "HTTP 500 without a declared cause is the server's unexpected-error branch; the underlying error is only in the server's own log"
      : `HTTP ${httpStatus} without a declared cause: the server refused without measuring, and nothing in the answer attributes the refusal to the site`,
    { error }
  );
}
