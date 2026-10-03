#!/usr/bin/env node
/**
 * Reliability-sweep driver: the caller the step-3 decision requires
 * (docs/calibration-censoring-policy-decision.md, step-4 item 4).
 *
 *   node scripts/calibration-reliability-sweep-run.mjs collect <round> \
 *     <candidates.json> <round-N-out.json>
 *   ... rounds are disjoint sessions at least 24h apart; rounds 1 and 2 are
 *   the eligibility pair (48h apart); rounds 3 and up are the sizing clusters
 *   the preregistered loss bound requires (minimum 4 usable) ...
 *   node scripts/calibration-reliability-sweep-run.mjs receipt \
 *     <candidates.json> <round1.json> [round2.json ...] <receipt-out.json>
 *   node scripts/calibration-reliability-sweep-run.mjs bound \
 *     <candidates.json> <round1.json> [round2.json ...] <receipt.json> \
 *     <bound-out.json>
 *
 * Scans run through a locally running server's /api/scan, never through tsx
 * or an in-process import: the server is the producer whose r2 quality ledger
 * the projection reads, and driving it any other way reads a different
 * instrument. The server must run with SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1
 * plus its prerequisites, from the build SITE_BEHAVIOR_LAB_BUILD_COMMIT names.
 *
 * collect also requires SWEEP_EGRESS_PROBE_URL, an http(s) URL whose host is
 * a name: the egress probe (calibration-reliability-sweep-instrument-lib.mjs)
 * requests it on a fresh connection before case 1 and after every answer. It
 * has no default, so nothing in this file contacts a host on its own.
 *
 * COLLECT FAILS CLOSED. Before case 1 the driver refuses unless its own git
 * checkout is at SITE_BEHAVIOR_LAB_BUILD_COMMIT with no tracked change, and
 * unless the egress probe answers. Then every answer goes through
 * classifyScanResponse (calibration-reliability-sweep-response-lib.mjs), and
 * is recorded only while the instrument was sound for that scan: the egress
 * probe after the answer succeeded, and the scan's wall-clock and monotonic
 * durations agree and stay inside the driver's deadline. Under the 2026-10-03
 * owner rulings a row is one of three kinds, named by its `answer`:
 *
 *   - a report row, read from an r2 single report from the declared build
 *     under the declared condition that carries its quality ledger;
 *   - a site row, the all-ineligible record under the scanner's declared
 *     reason it could not measure the target (unreachable, private, too slow
 *     to load, a failed page load the scanner attributes to the site, a page
 *     address the site answers with a file to download, a name lookup that
 *     ran out of time, or a subject the report format cannot
 *     name: a public suffix, a generalized tenant, a host with more than 64
 *     addresses, or a requested or redirected-to address found unnameable
 *     after the visit);
 *   - a lost row, the all-ineligible record for a measurement the scanner
 *     made and then lost (a finished report it would not publish because its
 *     redaction is not a fixed point): instrument loss, not valid, counted
 *     against completeness, never a site outcome.
 *
 * Anything else stops the round: a failed probe or a scan that spanned a
 * sleep (whatever the answer, reports included), a transport failure to the
 * local server, a scanner-side refusal (access gate, our own rate limit, a
 * misconfigured r2 producer, any other persistence or internal failure, a
 * busy or async/durable deployment, a resolver failure, any cause-less
 * refusal, the 502 navigation failure the scanner could not attribute to
 * the site among them, any cause this driver does not know), a malformed
 * body, and any report that is not an r2 single report
 * from the declared build under the declared condition, or whose projection
 * finds no quality ledger. Every case is checked, not only the first. The
 * stop prints the server's own error and declared cause and the probe's
 * result, exits non-zero, and leaves the artifact as written through the
 * previous case: a partial round is re-run in full, never resumed or
 * assembled.
 *
 * The full report exists in this process only between the response and the
 * projection on the next line. Nothing but the closed bare-load record is
 * retained, persisted, or printed, so the artifact this produces can be
 * committed beside the frame without the frame inheriting detector output.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { bareLoadOutcome, unmeasuredOutcome } from "./calibration-reliability-sweep-lib.mjs";
import { classifyScanResponse } from "./calibration-reliability-sweep-response-lib.mjs";
import {
  caseClockVerdict,
  checkoutBindingVerdict,
  parseEgressProbeUrl,
  probeEgress,
  readDriverCheckout
} from "./calibration-reliability-sweep-instrument-lib.mjs";
import {
  assembleReceiptFromRounds,
  buildPassArtifact,
  computeClusterLossBound,
  parseCandidateSet,
  summarizeSweepOutcomes,
  validatePassArtifact
} from "./calibration-reliability-sweep-run-lib.mjs";
import { serializeReliabilitySweepReceipt } from "./calibration-reliability-sweep-lib.mjs";

const BASE = process.env.SWEEP_BASE_URL?.trim() || "http://127.0.0.1:3000";
const SCAN_TIMEOUT_MS = 180_000;
const SCAN_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
// The declared calibration arm. Deliberately not configurable: a sweep under
// another condition would screen a frame for a study that will not run there.
const CONDITION = { device: "desktop", consentMode: "observe", gpcEnabled: false };

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function identityFromEnv() {
  const buildCommit = requiredEnv("SITE_BEHAVIOR_LAB_BUILD_COMMIT").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(buildCommit)) {
    fail("SITE_BEHAVIOR_LAB_BUILD_COMMIT must be a full 40-character git sha");
  }
  return {
    buildCommit,
    runtime: `node-${process.versions.node}-${process.platform}-${process.arch}`,
    runnerLabel: requiredEnv("SWEEP_RUNNER_LABEL"),
    egress: requiredEnv("SWEEP_EGRESS")
  };
}

function egressProbeFromEnv() {
  try {
    return parseEgressProbeUrl(requiredEnv("SWEEP_EGRESS_PROBE_URL"));
  } catch (error) {
    fail(error.message);
  }
}

/**
 * The checkout this file runs from must be the build the round artifact will
 * name. Resolved from this module's own location, never from the working
 * directory: a driver run from another checkout is the defect being refused.
 */
function bindCheckout(buildCommit) {
  let checkout;
  try {
    checkout = readDriverCheckout(path.dirname(fileURLToPath(import.meta.url)));
  } catch (error) {
    fail(`collect refused: ${error.message}`);
  }
  const refusal = checkoutBindingVerdict({ ...checkout, buildCommit });
  if (refusal !== null) fail(`collect refused: ${refusal}`);
  return checkout;
}

/**
 * One synchronous scan. Returns the HTTP status and the exact body text, or
 * throws: a refused connection, a reset, a redirect, the deadline, or a body
 * over the byte limit are all transport failures, and the caller stops the
 * round on them rather than filing them against the site. The deadline is a
 * monotonic timer, which does not advance while the machine sleeps; the
 * caller's clock verdict covers that.
 */
async function scanOnce(url) {
  const response = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, ...CONDITION }),
    redirect: "error",
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS)
  });
  const bodyText = await readResponseTextWithinLimit(response, {
    maxBytes: SCAN_RESPONSE_MAX_BYTES,
    label: `sweep scan ${url}`
  });
  return { httpStatus: response.status, bodyText };
}

function describeTransportError(error) {
  const message = String(error?.message ?? error);
  const code = error?.cause?.code ?? error?.code;
  const detail = error?.cause?.message;
  return [message, code ? `code ${code}` : null, detail && detail !== message ? detail : null]
    .filter(Boolean)
    .join("; ");
}

/**
 * Stop the round. Nothing is recorded for the failing case and the artifact
 * on disk is left exactly as the previous case wrote it. The exit code is set
 * rather than forcing process.exit, so stderr drains completely first.
 */
function stopRound({ index, total, caseId, pass, outPath, persisted, httpStatus, error, cause, reason, egress }) {
  process.stdout.write("STOPPED\n");
  const lines = [
    "",
    `ROUND ${pass} STOPPED at case ${index + 1}/${total} (${caseId}): the answer is not a site outcome, so it cannot be recorded as one.`,
    `  HTTP status:   ${httpStatus === null ? "none (transport failure to the local server)" : httpStatus}`,
    `  server error:  ${error === null ? "none" : JSON.stringify(error)}`,
    `  server cause:  ${cause === null ? "none declared" : cause}`,
    `  egress probe:  ${egress}`,
    `  reason:        ${reason}`,
    persisted > 0
      ? `  persisted:     ${persisted} of ${total} outcomes in ${outPath}, written through case ${persisted}; this case recorded nothing`
      : `  persisted:     nothing; this invocation wrote no artifact (any file already at ${outPath} is from an earlier invocation)`,
    "A partial round is re-run in full as a fresh session; it is never resumed, and receipt assembly refuses it."
  ];
  console.error(lines.join("\n"));
  process.exitCode = 1;
}

async function collect(pass, candidatesPath, outPath) {
  const bytes = readFileSync(candidatesPath, "utf8");
  const { studyId, candidates, candidateSetDigest } = parseCandidateSet(bytes);
  const identity = identityFromEnv();
  const egressProbeUrl = egressProbeFromEnv();
  const checkout = bindCheckout(identity.buildCommit);
  const preflight = await probeEgress(egressProbeUrl);
  if (!preflight.ok) {
    console.error(
      `ROUND ${pass} NOT STARTED: the egress probe to ${egressProbeUrl.href} failed before case 1 (${preflight.detail}). ` +
        "Without working name resolution and egress every scan would be filed as an unreachable site. Nothing was scanned and no artifact was written."
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `checkout ${checkout.root} at ${checkout.head}, no tracked changes; egress probe ${egressProbeUrl.href}: ${preflight.detail}`
  );
  const outcomes = [];
  for (const [index, candidate] of candidates.entries()) {
    process.stdout.write(
      `[${index + 1}/${candidates.length}] pass ${pass} ${candidate.caseId} ... `
    );
    const observedAt = new Date().toISOString();
    const stopHere = (details) =>
      stopRound({
        index,
        total: candidates.length,
        caseId: candidate.caseId,
        pass,
        outPath,
        persisted: outcomes.length,
        ...details
      });

    // The scan's window, on both clocks. Read before the request and after
    // the body, so the window is the server's whole answer and nothing else.
    const wallStart = Date.now();
    const monotonicStart = performance.now();
    let response = null;
    let transportError = null;
    try {
      response = await scanOnce(candidate.url);
    } catch (error) {
      transportError = error;
    }
    const clock = caseClockVerdict({
      wallElapsedMs: Date.now() - wallStart,
      monotonicElapsedMs: performance.now() - monotonicStart,
      deadlineMs: SCAN_TIMEOUT_MS
    });
    // Egress right after the answer, on a fresh lookup and connection: an
    // answer the instrument's own outage could have produced is never
    // recorded while the probe fails.
    const probe = await probeEgress(egressProbeUrl);
    const egress = probe.ok ? `ok (${probe.detail})` : `FAILED (${probe.detail})`;
    const verdict =
      response === null
        ? null
        : classifyScanResponse({
            ...response,
            expectedBuildCommit: identity.buildCommit,
            condition: CONDITION
          });
    const answer = {
      httpStatus: response?.httpStatus ?? null,
      error: verdict?.error ?? null,
      cause: verdict?.cause ?? null,
      egress
    };

    if (clock !== null) {
      stopHere({ ...answer, reason: clock });
      return;
    }
    if (transportError !== null) {
      stopHere({
        ...answer,
        reason: `transport failure talking to ${BASE}/api/scan: ${describeTransportError(transportError)}`
      });
      return;
    }
    if (!probe.ok) {
      stopHere({
        ...answer,
        reason:
          `the egress probe to ${egressProbeUrl.href} failed right after this answer, so the instrument's own resolver ` +
          "or network may have been down, and that produces the same answers as an unreachable site; this answer cannot be attributed to the site"
      });
      return;
    }
    if (verdict.disposition === "stop") {
      stopHere({ ...verdict, egress });
      return;
    }

    let outcome;
    if (verdict.disposition === "report") {
      outcome = bareLoadOutcome(candidate.caseId, verdict.report, { pass, observedAt });
      // An r2 report always carries the per-family quality ledger. A report
      // that passed the envelope checks and still projects to "unavailable"
      // is malformed, and filing it as the site's row would be the fail-open
      // this driver exists to refuse. Checked on every case.
      if (outcome.runOutcome === "unavailable") {
        stopHere({
          ...answer,
          reason:
            "the r2 report carries no per-family quality ledger, so its projection is unverified; that is a producer defect, not a site outcome"
        });
        return;
      }
      console.log(
        `${outcome.loaded ? "loaded" : "not-loaded"} status=${outcome.status} censoredFamilies=${outcome.censoredFamilies.join(",") || "none"}`
      );
    } else if (verdict.disposition === "target") {
      // The scanner declared it could not measure the target, and the egress
      // probe and both clocks say the instrument was sound for this scan. The
      // site row is the all-ineligible record under the declared reason, and
      // the planned denominator stays whole.
      outcome = unmeasuredOutcome(candidate.caseId, verdict.answer, { pass, observedAt });
      console.log(
        `not-loaded target ${verdict.cause ?? `${verdict.answer} (HTTP ${verdict.httpStatus})`}: ${verdict.error}`
      );
    } else if (verdict.disposition === "lost") {
      // The scanner measured the target and lost the measurement itself.
      // Instrument loss: recorded so the round stays whole and the case
      // counts as neither valid nor complete, under its own answer so it is
      // never read as a site outcome.
      outcome = unmeasuredOutcome(candidate.caseId, verdict.answer, { pass, observedAt });
      console.log(`lost ${verdict.answer} (instrument loss, not a site outcome): ${verdict.error}`);
    } else {
      // classifyScanResponse returns four dispositions; a fifth is a defect
      // here, and filing it as anything would be the fail-open this refuses.
      stopHere({ ...answer, reason: `unknown classifier disposition ${JSON.stringify(verdict.disposition)}` });
      return;
    }
    outcomes.push(outcome);
    // Persist after every case so an interrupted pass loses one scan, not the
    // session. A partial artifact is refused at receipt time by construction.
    const artifact = buildPassArtifact({
      studyId,
      pass,
      candidateSetDigest,
      measurementCondition: CONDITION,
      identity,
      outcomes
    });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  const summary = summarizeSweepOutcomes(outcomes);
  console.log(
    `\npass ${pass}: observed ${summary.observed}, loaded ${summary.loaded} (${(100 * summary.loadedFraction).toFixed(1)}%), ` +
      `bare-load valid ${summary.valid} (${(100 * summary.validFraction).toFixed(1)}%), ` +
      `all-families-complete ${summary.allFamiliesComplete} (${(100 * summary.allFamiliesCompleteFraction).toFixed(1)}%)`
  );
  console.log(`per-family censor counts: ${JSON.stringify(summary.familyCensorCounts)}`);
  console.log(
    `rows by answer: ${JSON.stringify(summary.byAnswer)}; lost to the instrument: ${summary.lost} of ${summary.observed}, counted as neither valid nor complete`
  );
  console.log(
    "eligibility is bare-load validity; input losses are reported for sizing, never screened on. Sizing reads the receipt, not this console line"
  );
}

function receipt(candidatesPath, roundPaths, outPath) {
  const candidateSetBytes = readFileSync(candidatesPath, "utf8");
  const rounds = roundPaths.map((roundPath, index) => {
    const bytes = readFileSync(roundPath, "utf8");
    return { artifact: validatePassArtifact(JSON.parse(bytes), index + 1), bytes };
  });
  const assembled = assembleReceiptFromRounds({
    rounds,
    candidateSetBytes,
    sweptAt: new Date().toISOString()
  });
  writeFileSync(outPath, serializeReliabilitySweepReceipt(assembled));
  console.log(
    `receipt: ${rounds.length} rounds, ${assembled.observedCandidates} candidates, ${assembled.eligibleCandidates} eligible (${(100 * assembled.eligibleFraction).toFixed(1)}%)`
  );
  console.log(`written to ${outPath}`);
}

function bound(candidatesPath, roundPaths, receiptPath, outPath) {
  const artifact = computeClusterLossBound({
    candidateSetBytes: readFileSync(candidatesPath, "utf8"),
    roundEntries: roundPaths.map((roundPath) => ({ bytes: readFileSync(roundPath, "utf8") })),
    receiptBytes: readFileSync(receiptPath, "utf8")
  });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `loss bound over ${artifact.rounds} rounds: all-families-complete [${artifact.bounds.allFamiliesComplete.lo.toFixed(3)}, ${artifact.bounds.allFamiliesComplete.hi.toFixed(3)}]`
  );
  console.log(
    "cluster-bootstrap percentiles; the frame producer sizes from this artifact and nothing else"
  );
  console.log(`written to ${outPath}`);
}

const [, , command, ...rest] = process.argv;
if (command === "collect") {
  const [roundRaw, candidatesPath, outPath] = rest;
  const round = Number(roundRaw);
  if (!Number.isSafeInteger(round) || round < 1 || round > 12 || !candidatesPath || !outPath) {
    fail("usage: collect <round 1..12> <candidates.json> <out.json>");
  }
  await collect(round, candidatesPath, outPath);
} else if (command === "receipt") {
  if (rest.length < 4) {
    fail("usage: receipt <candidates.json> <round1.json> [round2.json ...] <out.json>");
  }
  const [candidatesPath, ...tail] = rest;
  const outPath = tail.pop();
  receipt(candidatesPath, tail, outPath);
} else if (command === "bound") {
  if (rest.length < 5) {
    fail(
      "usage: bound <candidates.json> <round1.json> [round2.json ...] <receipt.json> <bound-out.json>"
    );
  }
  const [candidatesPath, ...tail] = rest;
  const outPath = tail.pop();
  const receiptPath = tail.pop();
  bound(candidatesPath, tail, receiptPath, outPath);
} else {
  fail(
    "usage: calibration-reliability-sweep-run.mjs collect <round 1..12> ... | receipt <candidates> <round1> [round2 ...] <out> | bound <candidates> <round1> [round2 ...] <receipt> <out>"
  );
}
