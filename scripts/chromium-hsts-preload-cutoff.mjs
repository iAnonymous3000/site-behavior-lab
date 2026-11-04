#!/usr/bin/env node

// Warns, and never fails, before the pinned Chromium stops applying its
// built-in HSTS preload list.
//
// Chromium stops applying the list 70 days after its build (IsBuildTimely() in
// net/http/transport_security_state.cc), whatever the scanner does. From then
// on a page's http:// request to a preloaded name goes out as http, where a
// current Chrome would send https (docs/limitations.md), and
// lib/scan-browser-hsts-preload.test.ts fails by name. On 2026-11-03 the owner
// delegated the choice, and the recommendation taken was to keep the scan
// browser within its 70 days, with a warning rather than a block, so a
// toolchain epoch has to land before that date. This prints a GitHub `::warning::` annotation when fewer than 21
// days remain, or once the date has passed, and exits 0 on every path: the
// date is an estimate, and a calendar must never block CI.
//
// The Chromium is the one the installed playwright-core bundles
// (node_modules/playwright-core/browsers.json): the headless shell the scanner
// launches, and the full build beside it. Each one's build time comes from
// scripts/chromium-build-times.json, its version tag's commit time, which is
// an assumption one lapse has confirmed so far. A version with no entry gets a
// warning here; lib/chromium-build-times.test.ts is what fails on it.
//
// Usage: node scripts/chromium-hsts-preload-cutoff.mjs [--now <ISO time>] [--browsers <browsers.json>]
// --now and --browsers exist for that test; CI passes neither.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRELOAD_LIFETIME_DAYS = 70;
export const WARNING_DAYS = 21;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_TIMES = path.join(ROOT, "scripts", "chromium-build-times.json");
const INSTALLED_BROWSERS = path.join(ROOT, "node_modules", "playwright-core", "browsers.json");
const SCAN_BROWSERS = ["chromium-headless-shell", "chromium"];

/** The estimated cutoff: the tag's commit time plus 70 days. */
export function estimatedCutoff(committedAt) {
  const built = Date.parse(committedAt);
  if (!Number.isFinite(built)) throw new Error(`unreadable build time ${JSON.stringify(committedAt)}`);
  return new Date(built + PRELOAD_LIFETIME_DAYS * MS_PER_DAY);
}

/** One line for one Chromium version at one instant. */
export function assess(version, builds, now) {
  const build = Object.hasOwn(builds, version) ? builds[version] : undefined;
  if (!build) {
    return {
      warning: true,
      title: "Chromium build time unrecorded",
      message: `Chromium ${version} has no entry in scripts/chromium-build-times.json, so its HSTS preload cutoff cannot be estimated. Add its version tag's commit time (lib/chromium-build-times.test.ts fails until then).`
    };
  }
  const cutoff = estimatedCutoff(build.committedAt);
  const remaining = (cutoff.getTime() - now.getTime()) / MS_PER_DAY;
  const estimate = `estimated as its version tag's commit time (${build.committedAt}) plus ${PRELOAD_LIFETIME_DAYS} days`;
  if (remaining <= 0) {
    return {
      warning: true,
      title: "Chromium HSTS preload list lapsed",
      message: `Chromium ${version} passed its HSTS preload cutoff at ${cutoff.toISOString()} (${estimate}). If the estimate holds, scans now send http:// requests to preloaded names as http, and lib/scan-browser-hsts-preload.test.ts fails. The next toolchain epoch is due.`
    };
  }
  const days = Math.floor(remaining);
  const inDays = `${days} ${days === 1 ? "day" : "days"}`;
  if (remaining < WARNING_DAYS) {
    return {
      warning: true,
      title: "Chromium HSTS preload cutoff in under three weeks",
      message: `Chromium ${version} stops applying its HSTS preload list in ${inDays}, at ${cutoff.toISOString()} (${estimate}). Land the next toolchain epoch before then.`
    };
  }
  return { warning: false, message: `Chromium ${version} applies its HSTS preload list until ${cutoff.toISOString()}, ${inDays} from now (${estimate}).` };
}

function annotation(title, message) {
  const property = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
  const data = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::warning title=${property(title)}::${data(message)}`;
}

function readOptions(argv) {
  const options = { now: new Date(), browsers: INSTALLED_BROWSERS };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--now" && value) {
      options.now = new Date(value);
      index += 1;
    } else if (argv[index] === "--browsers" && value) {
      options.browsers = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argv[index])}`);
    }
  }
  if (!Number.isFinite(options.now.getTime())) throw new Error("--now is not a time");
  return options;
}

function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    const builds = JSON.parse(readFileSync(BUILD_TIMES, "utf8")).builds;
    const bundled = JSON.parse(readFileSync(options.browsers, "utf8")).browsers;
    const versions = [...new Set(
      bundled.filter((browser) => SCAN_BROWSERS.includes(browser.name)).map((browser) => browser.browserVersion)
    )];
    if (versions.length === 0) throw new Error(`${options.browsers} names no Chromium`);
    for (const version of versions) {
      const result = assess(version, builds, options.now);
      process.stdout.write(`${result.warning ? annotation(result.title, result.message) : result.message}\n`);
    }
  } catch (error) {
    process.stdout.write(`${annotation("Chromium HSTS preload cutoff unchecked", `The cutoff check could not run: ${error instanceof Error ? error.message : String(error)}`)}\n`);
  }
  process.exitCode = 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
