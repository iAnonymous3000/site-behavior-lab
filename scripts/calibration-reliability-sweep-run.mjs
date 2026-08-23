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
 *     <receipt.json> <bound-out.json>
 *
 * Scans run through a locally running server's /api/scan, never through tsx
 * or an in-process import: the server is the producer whose r2 quality ledger
 * the projection reads, and driving it any other way reads a different
 * instrument. The server must run with SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1
 * plus its prerequisites; a v1 body has no per-family quality ledger, so
 * every projection would come out unverified while the run exits clean. The
 * driver refuses that shape loudly on the first case instead.
 *
 * The full report exists in this process only between the response and the
 * projection on the next line. Nothing but the closed bare-load record is
 * retained, persisted, or printed, so the artifact this produces can be
 * committed beside the frame without the frame inheriting detector output.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { bareLoadOutcome } from "./calibration-reliability-sweep-lib.mjs";
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

async function scanOnce(url) {
  const response = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, ...CONDITION, gpcEnabled: CONDITION.gpcEnabled }),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS)
  });
  const text = await readResponseTextWithinLimit(response, {
    maxBytes: SCAN_RESPONSE_MAX_BYTES,
    label: `sweep scan ${url}`
  });
  const body = JSON.parse(text);
  if (!response.ok || body.ok === false) {
    return { ok: false, reason: body.error ?? `HTTP ${response.status}` };
  }
  return { ok: true, report: body.report ?? body };
}

async function collect(pass, candidatesPath, outPath) {
  const bytes = readFileSync(candidatesPath, "utf8");
  const { studyId, candidates, candidateSetDigest } = parseCandidateSet(bytes);
  const identity = identityFromEnv();
  const outcomes = [];
  for (const [index, candidate] of candidates.entries()) {
    process.stdout.write(
      `[${index + 1}/${candidates.length}] pass ${pass} ${candidate.caseId} ... `
    );
    const observedAt = new Date().toISOString();
    let outcome;
    try {
      const result = await scanOnce(candidate.url);
      // A refused or failed scan still yields a row: bareLoadOutcome projects
      // an absent report to the all-ineligible record, which is the correct
      // statement ("unverified"), and the planned denominator stays whole.
      outcome = bareLoadOutcome(candidate.caseId, result.ok ? result.report : null, {
        pass,
        observedAt
      });
      if (result.ok && index === 0 && outcome.runOutcome === "unavailable") {
        fail(
          "first scan returned a body with no per-family quality ledger; the server is not producing r2 reports, so every projection would read unverified. Start the server with SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1 and its prerequisites."
        );
      }
      console.log(
        `${outcome.loaded ? "loaded" : "not-loaded"} status=${outcome.status} censoredFamilies=${outcome.censoredFamilies.join(",") || "none"}`
      );
    } catch (error) {
      outcome = bareLoadOutcome(candidate.caseId, null, { pass, observedAt });
      console.log(`unverified (${String(error?.message ?? error).slice(0, 80)})`);
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

function bound(receiptPath, outPath) {
  const receiptBytes = readFileSync(receiptPath, "utf8");
  const artifact = computeClusterLossBound({
    receipt: JSON.parse(receiptBytes),
    receiptBytes
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
  const [receiptPath, outPath] = rest;
  if (!receiptPath || !outPath) {
    fail("usage: bound <receipt.json> <bound-out.json>");
  }
  bound(receiptPath, outPath);
} else {
  fail(
    "usage: calibration-reliability-sweep-run.mjs collect <round 1..12> ... | receipt <candidates> <round1> [round2 ...] <out> | bound <receipt> <out>"
  );
}
