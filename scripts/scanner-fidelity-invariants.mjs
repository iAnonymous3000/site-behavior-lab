// Version-aware invariant evaluation for the scanner-fidelity smoke.
//
// There are two wire generations. A schemaVersion 1 report is flat: the counts
// sit directly on `summary` (summary.totalRequests). A schemaVersion 2 report
// wraps runs (report.run, or baseline/variant for comparisons) and nests its
// counts one level deeper, at run.summary.counts.totalRequests. The 2026-07
// accuracy audit found the count invariant reading the v1 path against r2
// reports: every missing value coerced to 0, `0 > 0` is false, and the check
// could never fail. Field access is therefore versioned in exactly one place
// here (runsOf/countsOf), and a v2 run whose counts block is missing is itself
// a FAILURE, never a silent zero.
//
// This module also renders every report the way the site would: transport
// reader, public-wire round-trip, view, headline, findings board, and JSON-LD
// dataset, asserting only self-consistency (the rendered numbers are the
// report's numbers; a failed or truncated visit never renders calm). The rule
// from the smoke applies here unchanged: assert what must hold no matter what
// the sites do, never a fact about a site.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

const HEADLINE_TONES = new Set(["alarm", "warn", "info", "calm"]);

/**
 * `budget-unavailable` covers both elapsed-time exhaustion and bounded
 * evidence collection. A short run contradicts the former, but not the latter.
 * Require each bounded detector to carry its detector-specific capture loss so
 * an ordinary timeout cannot borrow this exception.
 */
export function detectorBudgetIsEvidenceBound(id, entry, losses) {
  const hasLoss = (kind, detail) =>
    losses.some(
      (loss) =>
        loss?.family === "detector-output" &&
        loss?.kind === kind &&
        loss?.detail === detail
    );

  if (id === "cname-uncloaking") {
    return entry?.status === "partial" && hasLoss("cap", "cname-lookups");
  }
  if (id === "keystroke-exfiltration") {
    return (
      entry?.status === "partial" &&
      hasLoss("truncated", "keystroke-probe-capture")
    );
  }
  if (id === "privacy-policy") {
    return (
      entry?.status === "skipped" &&
      hasLoss("truncated", "policy-link-candidates") &&
      hasLoss("cap", "policy-visit")
    );
  }
  return false;
}

/**
 * Compile dist/schema (unless an orchestrator already did, same env contract
 * as run-schema-cli.mjs) and load the exact render modules the site uses. A
 * bridge that fails to build must throw: a fidelity gate that silently skips
 * its render checks is the inert-invariant defect all over again.
 */
export function ensureRenderBridge() {
  if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
    execFileSync(
      process.execPath,
      [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"],
      { cwd: rootDir, stdio: "inherit" }
    );
    process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY = "1";
  }
  const dist = (name) => requireFromHere(path.join(rootDir, "dist", "schema", "lib", `${name}.js`));
  const view = dist("scan-report-view");
  const views = dist("scan-report-views");
  const reader = dist("scan-report-reader");
  return {
    readScanTransportPayload: view.readScanTransportPayload,
    publicWireForExportOrPersistence: view.publicWireForExportOrPersistence,
    readStoredScanReport: reader.readStoredScanReport,
    toReportView: views.toReportView,
    buildReportHeadline: dist("report-headline").buildReportHeadline,
    buildFindings: dist("report-findings").buildFindings,
    validateReportPresentation: dist("report-consistency").validateReportPresentation,
    buildReportDataset: dist("report-jsonld").buildReportDataset,
    serializeJsonLd: dist("jsonld-script").serializeJsonLd
  };
}

function runsOf(wire) {
  if (wire?.schemaVersion === 2) {
    if (wire.reportType === "comparison") {
      return [
        { run: wire.baseline, tag: "baseline" },
        { run: wire.variant, tag: "variant" }
      ];
    }
    return [{ run: wire.run, tag: "run" }];
  }
  // A v1 comparison nests two complete flat v1 reports; the original smoke
  // never descended into them, so every comparison scan passed unexamined.
  if (wire?.reportType === "comparison") {
    return [
      { run: wire.baseline, tag: "baseline" },
      { run: wire.variant, tag: "variant" }
    ];
  }
  return [{ run: wire, tag: "report" }];
}

function countsOf(wire, run) {
  return wire?.schemaVersion === 2 ? run?.summary?.counts : run?.summary;
}

function armObservation(wire, run) {
  const counts = countsOf(wire, run);
  const requests = wire?.schemaVersion === 2 ? run?.evidence?.requests : run?.requests;
  const thirdPartyDomains = [
    ...new Set(
      (Array.isArray(requests) ? requests : [])
        .filter((request) => request?.thirdParty === true && typeof request.domain === "string")
        .map((request) => request.domain)
    )
  ].sort();
  return {
    schemaVersion: wire?.schemaVersion ?? null,
    reportType: wire?.reportType ?? null,
    runOutcome: run?.quality?.run?.outcome ?? null,
    requestOutcome: run?.quality?.byFamily?.requests?.outcome ?? null,
    counts: {
      totalRequests: counts?.totalRequests ?? null,
      thirdPartyRequests: counts?.thirdPartyRequests ?? null,
      knownTrackerRequests: counts?.knownTrackerRequests ?? null,
      thirdPartyDomains: counts?.thirdPartyDomains ?? null
    },
    thirdPartyDomains,
    producerRuntime: {
      buildCommit: run?.provenance?.buildCommit ?? null,
      observer: run?.provenance?.observer ?? null,
      methodologyVersion: run?.provenance?.methodologyVersion ?? null,
      detectorRegistry: run?.provenance?.detectorRegistry ?? null,
      fingerprints: {
        execution: run?.fingerprints?.execution ?? null,
        measurementEnvironment: run?.fingerprints?.measurementEnvironment ?? null,
        condition: run?.fingerprints?.condition ?? null
      },
      runtime: {
        automation: run?.conditions?.automation ?? null,
        browser: run?.conditions?.browser ?? null,
        device: run?.conditions?.device ?? null,
        locale: run?.conditions?.locale ?? null,
        language: run?.conditions?.language ?? null,
        timezone: run?.conditions?.timezone ?? null,
        egress: run?.conditions?.egress ?? null,
        headless: run?.conditions?.headless ?? null
      }
    }
  };
}

/** Privacy-reduced, two-arm-aware observation used by the fidelity receipt. */
export function fidelityObservationOf(wire) {
  const comparison = wire?.reportType === "comparison";
  const arms = Object.fromEntries(
    runsOf(wire).map(({ run, tag }) => [comparison ? tag : "run", armObservation(wire, run)])
  );
  return {
    schemaVersion: wire?.schemaVersion ?? null,
    reportType: comparison ? "comparison" : "single",
    arms,
    order:
      wire?.schemaVersion === 2 && wire?.experiment?.kind === "intervention"
        ? wire.experiment.order
        : null
  };
}

/**
 * Evaluate one scan payload (the API response body's report, or a stored
 * report file). Returns the list of invariant failures (empty = pass) and the
 * censored families observed, for the caller's tally.
 */
export function evaluateScanBody(label, payload, bridge) {
  const failures = [];
  const censored = [];
  const fail = (message) => failures.push(`${label}: ${message}`);

  const transport = bridge.readScanTransportPayload(payload);
  if (transport.kind !== "report") {
    fail(
      transport.kind === "job-pending" || transport.kind === "job-ended"
        ? `scanner returned an async job envelope (${transport.kind}); the fidelity smoke requires synchronous scan mode`
        : `scanner produced a payload its own reader rejects (${transport.kind}${transport.kind === "unreadable" ? `: ${transport.error}` : ""})`
    );
    return { failures, censored };
  }

  // The reader accepted it; every wire-level check runs against the public
  // wire (ephemeral blocks projected off), exactly what would be persisted.
  let wire;
  try {
    wire = bridge.publicWireForExportOrPersistence(transport.loaded);
  } catch (error) {
    fail(`public-wire projection threw: ${String(error).slice(0, 200)}`);
    return { failures, censored };
  }
  const restored = bridge.readStoredScanReport(wire);
  if (!restored.ok) {
    fail(`public wire does not round-trip through the stored reader (${restored.error})`);
    return { failures, censored };
  }

  for (const { run, tag } of runsOf(wire)) {
    const where = wire.schemaVersion === 2 ? `${tag}` : "report";
    const byFamily = run?.quality?.byFamily ?? {};
    const losses = run?.qualityFacts?.captureLoss ?? [];
    const detectors = run?.detectors ?? {};

    for (const [family, entry] of Object.entries(byFamily)) {
      if (entry.outcome === "censored") censored.push(family);
    }

    // 1. A capture loss must name a family the schema knows, with a kind. An
    //    unnamed loss cannot be scoped, so it censors by accident.
    for (const loss of losses) {
      if (!loss.family || !loss.kind) {
        fail(`${where}: capture loss without a family or kind: ${JSON.stringify(loss)}`);
        return { failures, censored };
      }
      if (!byFamily[loss.family]) {
        fail(`${where}: capture loss names family "${loss.family}" that carries no quality entry`);
        return { failures, censored };
      }
    }

    // 2. Censoring is scoped. A family may only be censored if something was
    //    actually recorded as lost for it (or a run-wide budget was exhausted).
    const budgetExhausted = (run?.quality?.run?.reasons ?? []).some((reason) =>
      String(reason).startsWith("budget-exhausted:")
    );
    for (const [family, entry] of Object.entries(byFamily)) {
      if (entry.outcome !== "censored" || budgetExhausted) continue;
      if (!losses.some((loss) => loss.family === family)) {
        fail(`${where}: ${family} is censored with no recorded capture loss to justify it`);
        return { failures, censored };
      }
    }

    // 3. A detector may not report a budget failure on a run that did not come
    //    close to its budget. This is the codeberg.org defect: a 5-second scan
    //    told readers it had run out of time.
    //
    //    The detector vocabulary spends one code, `budget-unavailable`, on both
    //    an elapsed-time budget and fixed evidence caps. CNAME lookup,
    //    synthetic-field, and policy-link caps are bounded evidence
    //    collection, not elapsed-time claims. They are exempt only when the
    //    matching detector-specific capture loss proves that path. Every
    //    other budget claim on a short run still fails.
    const durationMs = Number(run?.summary?.durationMs ?? 0);
    if (durationMs > 0 && durationMs < 20_000) {
      for (const [id, entry] of Object.entries(detectors)) {
        if (entry.reason !== "budget-unavailable") continue;
        if (detectorBudgetIsEvidenceBound(id, entry, losses)) continue;
        fail(`${where}: detector ${id} reported budget-unavailable after only ${durationMs}ms`);
        return { failures, censored };
      }
    }

    // 4. Counts must exist where the report's own schema says they live, and
    //    complete request evidence must be self-consistent. A v2 run without
    //    summary.counts is a shape violation, never a run of zeroes.
    const counts = countsOf(wire, run);
    if (wire.schemaVersion === 2 && (counts === null || typeof counts !== "object")) {
      fail(`${where}: v2 run carries no summary.counts block`);
      return { failures, censored };
    }
    const requestsCensored = byFamily.requests?.outcome === "censored";
    const total = counts?.totalRequests;
    const third = counts?.thirdPartyRequests;
    const trackers = counts?.knownTrackerRequests;
    if (!Number.isFinite(total) || !Number.isFinite(third)) {
      fail(`${where}: request counts are not numbers (total=${String(total)}, thirdParty=${String(third)})`);
      return { failures, censored };
    }
    if (!requestsCensored) {
      if (third > total) {
        fail(`${where}: ${third} third-party requests exceeds ${total} total with complete request evidence`);
        return { failures, censored };
      }
      if (Number.isFinite(trackers) && trackers > total) {
        fail(`${where}: ${trackers} catalogued-service requests exceeds ${total} total with complete request evidence`);
        return { failures, censored };
      }
    }

    // 5. An instrument's limit is not a fact about the site. A detector may
    //    only report `unsupported` when nothing was found to work with, never
    //    while also publishing evidence it says it could not obtain.
    const policy = detectors["privacy-policy"];
    const policyEvidence = run?.evidence?.privacyPolicy ?? run?.privacyPolicy;
    if (policy?.status === "unsupported" && policyEvidence?.url) {
      fail(`${where}: privacy-policy reports unsupported while publishing ${policyEvidence.url}`);
      return { failures, censored };
    }
  }

  // 6. The report must RENDER: view, headline, findings board, and JSON-LD are
  //    the same functions the site runs, and a throw here is a blank page.
  let headline;
  let findings;
  let dataset;
  let serialized;
  let consistencyViolations = [];
  try {
    const view = bridge.toReportView(restored.stored);
    const presentation = bridge.validateReportPresentation(view, null);
    headline = presentation.headline;
    findings = presentation.findings;
    consistencyViolations = presentation.violations;
    dataset = bridge.buildReportDataset(view, {
      url: "https://sitebehavior.org/reports/fidelity-check",
      jsonUrl: "https://sitebehavior.org/reports/fidelity-check.json"
    });
    serialized = bridge.serializeJsonLd(dataset);
  } catch (error) {
    fail(`report does not render: ${String(error).slice(0, 200)}`);
    return { failures, censored };
  }

  if (!HEADLINE_TONES.has(headline.tone)) {
    fail(`headline tone "${String(headline.tone)}" is not in the tone vocabulary`);
  }
  if (typeof headline.subhead !== "string" || headline.subhead.length === 0) {
    fail("headline subhead is empty");
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    fail("findings board rendered empty");
  } else {
    for (const card of findings) {
      if (typeof card.title !== "string" || card.title.length === 0) {
        fail(`findings card ${JSON.stringify(card.id ?? null)} has no title`);
        break;
      }
    }
  }
  for (const violation of consistencyViolations) {
    fail(`report consistency ${violation.id}: ${violation.message}`);
  }

  // 7. The JSON-LD must parse and say what the page says: its description IS
  //    the headline subhead (report-jsonld reuses buildReportHeadline so they
  //    cannot drift; this pins the seam).
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail("serialized JSON-LD does not parse");
  }
  if (parsed && parsed.description !== headline.subhead) {
    fail("JSON-LD description disagrees with the headline subhead");
  }

  // 8. The rendered numbers are the report's numbers. For singles, the
  //    "Third-party requests" measurement (exact value or censored lower
  //    bound) must equal the wire count read version-aware; this is the check
  //    that catches a shape drift like summary.totalRequests vs
  //    summary.counts.totalRequests before it can zero an invariant.
  if (parsed && (wire.schemaVersion !== 2 || wire.reportType === "single")) {
    const [{ run }] = runsOf(wire);
    const counts = countsOf(wire, run);
    const measured = (Array.isArray(parsed.variableMeasured) ? parsed.variableMeasured : []).find(
      (entry) => entry?.name === "Third-party requests"
    );
    if (measured) {
      const rendered = Number.isFinite(measured.value) ? measured.value : measured.minValue;
      if (rendered !== counts?.thirdPartyRequests) {
        fail(
          `JSON-LD reports ${String(rendered)} third-party requests but the wire counts ${String(counts?.thirdPartyRequests)}`
        );
      }
    }
  }

  // 9. A failed or request-truncated visit must never render calm: low counts
  //    from a load that did not complete are an instrument artifact, not a
  //    clean bill of health (report-headline.ts guarantees both branches).
  if (wire.schemaVersion === 2 && wire.reportType === "single") {
    const [{ run }] = runsOf(wire);
    const outcomeFailed = run?.quality?.run?.outcome === "failed";
    const requestsCensored = run?.quality?.byFamily?.requests?.outcome === "censored";
    if ((outcomeFailed || requestsCensored) && headline.tone === "calm") {
      fail(
        `a ${outcomeFailed ? "failed" : "request-truncated"} visit rendered a calm headline: "${headline.headline}"`
      );
    }
  }

  return { failures, censored, observation: fidelityObservationOf(wire) };
}
