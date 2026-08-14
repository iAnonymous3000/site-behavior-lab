#!/usr/bin/env node

/**
 * Instrument repeatability: does the same page, visited again immediately,
 * report the same thing?
 *
 * The design is fixed in research/repeatability/PREREGISTRATION.md and was
 * declared before this ran. This script only collects; it computes the
 * measures the preregistration named and nothing else.
 *
 * BACK TO BACK ON PURPOSE. The committed corpus already shows wide spread
 * between repeat visits of one site, but those repeats are weeks apart, so
 * real site change and instrument noise are inseparable in them. Consecutive
 * repeats bound real change to minutes, which is what lets the remainder be
 * attributed to the instrument.
 *
 *   npx tsc -p tsconfig.test.json --outDir .unit-test-dist
 *   SITE_BEHAVIOR_LAB_BUILD_COMMIT=$(git rev-parse HEAD) \
 *     node scripts/repeatability-run.mjs urls.json out.json
 *
 * Plain JS over the COMPILED build, never tsx: esbuild wraps serialized
 * functions with __name and breaks the injected page collector, which surfaces
 * as capture-loss on every case and reads exactly like a hostile web.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { scanSite } from "../.unit-test-dist/lib/scanner.js";

const [, , urlsPath, outPath] = process.argv;
const urls = JSON.parse(readFileSync(urlsPath, "utf8"));
const REPEATS = Number(process.env.REPEATS ?? 3);
const CONDITIONS = { device: "desktop", gpcEnabled: false, consentMode: "observe" };

const rows = [];
for (const [index, url] of urls.entries()) {
  const repeats = [];
  for (let k = 0; k < REPEATS; k += 1) {
    process.stdout.write(`[${index + 1}/${urls.length}] r${k + 1} ${url} ... `);
    const started = Date.now();
    try {
      const report = await scanSite({ url, ...CONDITIONS });
      const observation = observe(report, Date.now() - started);
      repeats.push(observation);
      console.log(
        observation.complete
          ? `${observation.thirdPartyRequests} 3p / ${observation.trackerRequests} tracker / ${observation.thirdPartyCookies} cookies`
          : `INCOMPLETE (${observation.reason})`
      );
    } catch (error) {
      repeats.push({ complete: false, reason: `threw:${(error?.message ?? "unknown").slice(0, 60)}` });
      console.log("THREW");
    }
  }
  rows.push({ url, repeats });
  writeFileSync(outPath, `${JSON.stringify({ conditions: CONDITIONS, repeats: REPEATS, rows }, null, 2)}\n`);
}

report(rows);

function observe(report, elapsedMs) {
  const run = report?.run ?? report ?? null;
  const summary = run?.summary ?? null;
  const outcome = run?.quality?.run?.outcome ?? (summary ? "complete" : null);
  // A request-capped run truncates the very counts being compared, so its
  // spread would measure the cap rather than the instrument.
  const capped = (run?.warnings ?? []).some((w) => /recording cap|request cap/i.test(String(w)));
  const detectors = {
    fingerprint: (run?.fingerprintDetections ?? []).length > 0,
    pixel: (run?.pixelEvents ?? []).length > 0,
    cname: (run?.cnameCloaks ?? []).length > 0
  };
  return {
    complete: outcome === "complete" || summary !== null,
    reason: outcome ?? "no-summary",
    capped,
    elapsedMs,
    thirdPartyRequests: summary?.thirdPartyRequests ?? null,
    trackerRequests: summary?.knownTrackerRequests ?? null,
    thirdPartyCookies: summary?.thirdPartyCookies ?? null,
    detectors
  };
}

function report(all) {
  const METRICS = ["thirdPartyRequests", "trackerRequests", "thirdPartyCookies"];
  // Preregistered eligibility: all k repeats complete, and no capped repeat.
  const eligible = all.filter(
    (row) => row.repeats.every((r) => r.complete) && !row.repeats.some((r) => r.capped)
  );
  console.log(`\n=== repeatability ===`);
  console.log(`urls attempted        ${all.length}`);
  console.log(`eligible (all repeats complete, none capped)  ${eligible.length}`);

  for (const metric of METRICS) {
    const spreads = [];
    let identical = 0;
    for (const row of eligible) {
      const values = row.repeats.map((r) => r[metric]).filter((v) => typeof v === "number");
      if (values.length !== row.repeats.length) continue;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      if (max === min) identical += 1;
      spreads.push(mean === 0 ? 0 : (max - min) / mean);
    }
    spreads.sort((a, b) => a - b);
    const q = (p) => (spreads.length ? spreads[Math.min(spreads.length - 1, Math.floor(p * spreads.length))] : NaN);
    const pct = (v) => (Number.isNaN(v) ? "n/a" : `${(100 * v).toFixed(1)}%`);
    console.log(`\n${metric}  (n=${spreads.length})`);
    console.log(`  identical across all repeats  ${identical}/${spreads.length}`);
    console.log(`  relative spread  median ${pct(q(0.5))}   p90 ${pct(q(0.9))}   max ${pct(spreads[spreads.length - 1])}`);
  }

  // A detector that disagrees with itself across repeats of one page is
  // unreliable at the single-visit level whatever its accuracy turns out to be.
  console.log("\ndetector agreement across repeats of the same page");
  for (const detector of ["fingerprint", "pixel", "cname"]) {
    let agreed = 0;
    let disagreed = 0;
    const flapping = [];
    for (const row of eligible) {
      const fired = row.repeats.map((r) => r.detectors?.[detector] === true);
      if (fired.every((v) => v === fired[0])) agreed += 1;
      else {
        disagreed += 1;
        flapping.push(row.url);
      }
    }
    console.log(`  ${detector.padEnd(12)} agreed ${agreed}/${agreed + disagreed}${flapping.length ? `   flapped: ${flapping.slice(0, 4).join(", ")}` : ""}`);
  }
}
