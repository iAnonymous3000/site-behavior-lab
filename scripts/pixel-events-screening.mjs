#!/usr/bin/env node

/**
 * Feasibility screen for a `pixel-events` calibration study.
 *
 * NOT A STUDY AND NOT A FRAME. This runs before any preregistration exists, to
 * answer one question: is a study worth collecting at all? It is allowed to see
 * detector output precisely because nothing it produces may become the frame.
 * The pre-qualification sweep that selects a SEALED frame is a different pass.
 *
 *   npx tsc -p tsconfig.test.json --outDir .unit-test-dist
 *   SITE_BEHAVIOR_LAB_BUILD_COMMIT=$(git rev-parse HEAD) \
 *   SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1 \
 *     node scripts/pixel-events-screening.mjs candidates.json out.json
 *
 * TWO THINGS THAT WILL WASTE AN HOUR IF YOU CHANGE THEM.
 *
 * It drives the CALIBRATION RUNTIME, not /api/scan. The public single-scan path
 * never passes a consent mode (lib/scan-api.ts), so an accept-all request over
 * HTTP silently runs `observe`; accept-all exists only as one arm of a two-arm
 * comparison. A screen posted to the API measures the wrong arm and reports a
 * base rate no study could ever collect.
 *
 * It is plain JS over the COMPILED build, never tsx. esbuild wraps serialized
 * functions with __name, which breaks the bounded page collector injected into
 * the page. Under tsx every case fails as capture-loss:page-subject-validity,
 * which reads exactly like "the open web refuses this scanner" and is not.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { scanCalibrationCase } from "../.unit-test-dist/lib/calibration-scan-runtime.js";

// Plain JS over the COMPILED runtime on purpose. Running this through tsx makes
// esbuild wrap serialized functions with __name, which breaks the bounded page
// collector injected into the page and surfaced here as
// capture-loss:page-subject-validity on every single case -- a harness bug that
// would have been read as "the open web refuses this scanner".

const [, , candidatesPath, outPath] = process.argv;
const candidates = JSON.parse(readFileSync(candidatesPath, "utf8"));
const ARM = { device: "desktop", gpcEnabled: false, consentMode: "accept-all" };

const rows = [];
for (const [index, candidate] of candidates.entries()) {
  process.stdout.write(`[${index + 1}/${candidates.length}] ${candidate.url} ... `);
  const started = Date.now();
  let row;
  try {
    const scanned = await scanCalibrationCase({ url: candidate.url, ...ARM }, "pixel-events");
    row = classify(candidate, scanned.report, Date.now() - started);
  } catch (error) {
    row = {
      url: candidate.url,
      stratum: candidate.stratum ?? "?",
      elapsedMs: Date.now() - started,
      served: false,
      notServedReason: `threw:${error instanceof Error ? error.message.slice(0, 70) : "unknown"}`,
      armed: false,
      notArmedReason: null,
      scoreable: false,
      fired: null,
      platforms: [],
      httpStatus: null,
      qualityReasons: []
    };
  }
  rows.push(row);
  console.log(
    row.served
      ? `served | ${row.armed ? "ARMED" : `not armed (${row.notArmedReason})`}` +
          (row.scoreable ? ` | ${row.fired ? `FIRED ${row.platforms.join(",")}` : "no pixel"}` : "")
      : `NOT SERVED (${row.notServedReason})`
  );
  writeFileSync(outPath, `${JSON.stringify({ arm: ARM, rows }, null, 2)}\n`);
}
report(rows);

function classify(candidate, report, elapsedMs) {
  const run = report?.run ?? null;
  const outcome = run?.quality?.run?.outcome ?? null;
  const served = run !== null && outcome === "complete";
  const consent = run?.evidence?.consent ?? null;
  const choiceState = consent?.choiceState ?? null;
  const clicked = consent?.interaction?.clicked ?? null;
  const armed = served && choiceState === "verified";
  const pixels = run?.evidence?.pixelEvents ?? [];
  return {
    url: candidate.url,
    stratum: candidate.stratum ?? "?",
    elapsedMs,
    served,
    notServedReason: served ? null : run === null ? "no-run" : `run-${outcome ?? "unknown"}`,
    armed,
    notArmedReason: armed
      ? null
      : consent === null
        ? "no-consent-evidence"
        : clicked === false
          ? "no-control-activated"
          : `choice-${choiceState ?? "null"}`,
    scoreable: served && armed,
    fired: served && armed ? pixels.length > 0 : null,
    platforms: pixels.map((entry) => entry.platform ?? "?"),
    httpStatus: run?.conditions?.httpStatus ?? null,
    qualityReasons: run?.quality?.run?.reasons ?? []
  };
}

function report(all) {
  const served = all.filter((r) => r.served);
  const armed = all.filter((r) => r.armed);
  const scoreable = all.filter((r) => r.scoreable);
  const fired = scoreable.filter((r) => r.fired);
  const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

  console.log("\n=== screening result ===");
  console.log(`candidates          ${all.length}`);
  console.log(`served a page       ${served.length}  ${pct(served.length, all.length)}`);
  console.log(`accept-all verified ${armed.length}  ${pct(armed.length, served.length)} of served`);
  console.log(`scoreable           ${scoreable.length}  ${pct(scoreable.length, all.length)} of candidates`);
  console.log(`fired a pixel       ${fired.length}  ${pct(fired.length, scoreable.length)} of scoreable`);

  const tally = (key, list) => {
    const counts = new Map();
    for (const row of list) counts.set(row[key] ?? "?", (counts.get(row[key] ?? "?") ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");
  };
  const reasons = new Map();
  for (const row of all.filter((r) => !r.served)) {
    for (const reason of row.qualityReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  console.log(`\nnot served: ${tally("notServedReason", all.filter((r) => !r.served))}`);
  console.log(`  reasons:  ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
  console.log(`not armed:  ${tally("notArmedReason", served.filter((r) => !r.armed))}`);

  // Pixels seen regardless of the consent gate, to separate "the arm could not
  // complete" from "the detector had nothing to find".
  const firedAnywhere = served.filter((r) => r.platforms.length > 0);
  console.log(`\npixels present on served pages (ignoring the consent gate): ${firedAnywhere.length} / ${served.length}`);
  for (const row of firedAnywhere) console.log(`   ${row.url}  ${row.platforms.join(",")}`);

  console.log("\n=== what a study would need ===");
  if (scoreable.length === 0) {
    console.log("No case was scoreable. The binding gate is above, not the detector.");
    return;
  }
  if (fired.length === 0) {
    console.log("No pixel fired in a scoreable case: referencePresent >= 100 is unreachable here.");
    return;
  }
  const fireRate = fired.length / scoreable.length;
  const surviveRate = scoreable.length / all.length;
  console.log(`positive rate among scoreable: ${pct(fired.length, scoreable.length)}`);
  console.log(`scoreable cases needed for referencePresent >= 100: ~${Math.ceil(100 / fireRate)}`);
  console.log(`candidates to yield them:                          ~${Math.ceil(100 / fireRate / surviveRate)}`);
}
