/**
 * The development-exclusion set for calibration candidate universes
 * (scripts/calibration-candidate-universe-build.mjs applies it;
 * scripts/calibration-candidate-universe-lib.mjs only ever REMOVES with it).
 *
 * A confirmatory frame must not contain a site this project's development
 * already visited: the censoring analysis's boundary requires development
 * sites to be excluded or the frame fixed from an independent universe. The
 * derivation therefore reads every repository surface that RECORDS a visit
 * by this project's scanner or its studies, and nothing else ranks, admits,
 * or orders a candidate.
 *
 * Three rules, each learned from a way the earlier derivation leaked:
 *
 * 1. CLOSED SURFACE LIST, FAIL CLOSED. Every surface below must exist and
 *    must parse; every report and every catalog entry must name at least one
 *    domain. The earlier builder skipped a missing path in silence (it read
 *    a config/ directory that never existed and never read the featured
 *    catalog, the corpus seed, or the screening rows) and swallowed an
 *    unreadable report as "nothing to exclude", so a surface could vanish
 *    and the build still succeeded. A wrong exclusion costs one source slot;
 *    a missed one contaminates the frame.
 * 2. REGISTRABLE DOMAINS. Candidates are registrable domains, matched
 *    exactly, so a visit recorded as en.wikipedia.org or
 *    {label}.clevelandclinic.org (a redacted public label) excluded nothing.
 *    Each recorded host contributes its www-stripped form (as before) plus
 *    its registrable domain with and without the PSL private section, via
 *    the same tldts the scanner's registrableDomain uses. Leading redaction
 *    placeholders are dropped first.
 * 3. NEVER THIS STUDY'S OWN ARTIFACTS. A pilot set or provenance under
 *    calibration/cname-uncloaking-* is the frame itself, not development.
 *    Reading it would make a rebuild exclude its own pilot, so the rebuild
 *    that proves determinism would fail. No surface below is a glob over
 *    calibration/.
 *
 * NOT_DEVELOPMENT_VISIT_RECORDS classifies every other entry under the
 * scoped roots with the reason it is not read; the test suite requires that
 * every entry there is either a surface or classified, so a new collection
 * cannot land unread without someone deciding.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getDomain } from "tldts";

const HOST_GRAMMAR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const REDACTION_PLACEHOLDER = /^\{[a-z-]+\}$/;

function fail(message) {
  throw new Error(`development exclusions: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every domain one recorded value names: the www-stripped host and its
 * registrable domain (PSL private section included, as the scanner computes
 * it, and ICANN-only, which is the broader of the two). A value that is not
 * a host or URL names nothing.
 */
export function developmentDomainsOf(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  let host = value.trim().toLowerCase();
  const scheme = host.indexOf("://");
  if (scheme !== -1) host = host.slice(scheme + 3);
  host = host.split(/[/?#]/, 1)[0];
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  host = host.replace(/:\d+$/, "").replace(/\.$/, "");
  const labels = host.split(".");
  while (labels.length > 0 && REDACTION_PLACEHOLDER.test(labels[0])) labels.shift();
  host = labels.join(".");
  if (!HOST_GRAMMAR.test(host)) return [];
  const names = new Set([host.replace(/^www\./, "")]);
  for (const options of [{ allowPrivateDomains: true }, {}]) {
    const registrable = getDomain(host, options);
    if (typeof registrable === "string" && registrable.length > 0) names.add(registrable);
  }
  return [...names];
}

function readJson(rootDir, relativePath) {
  const file = path.join(rootDir, relativePath);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`${relativePath} cannot be read (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${relativePath} is not JSON (${error.message})`);
  }
}

function arrayAt(value, key, where) {
  const array = key === null ? value : isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(array) || array.length === 0) {
    fail(`${where} has no ${key === null ? "entries" : `"${key}" entries`}; the surface changed shape`);
  }
  return array;
}

/** The fields a committed report names its subject by, across v1 and v2. */
function reportSubjectValues(report) {
  const values = [];
  for (const side of [report, report?.run, report?.baseline, report?.variant]) {
    if (!isRecord(side)) continue;
    values.push(
      side.requestedUrl,
      side.summary?.firstPartyDomain,
      side.conditions?.requestedUrl,
      side.conditions?.finalUrl,
      side.subject?.requested?.origin,
      side.subject?.requested?.registrableDomain,
      side.subject?.observed?.origin,
      side.subject?.observed?.registrableDomain
    );
  }
  return values;
}

function reportDirectory(relativePath, { indexFile = null } = {}) {
  return {
    path: relativePath,
    kind: "report-directory",
    items(rootDir) {
      const dir = path.join(rootDir, relativePath);
      if (!statSync(dir).isDirectory()) fail(`${relativePath} is not a directory`);
      const items = [];
      for (const name of readdirSync(dir).sort()) {
        // A provenance sidecar carries ids and digests, never a subject; the
        // keep file only holds the directory open.
        if (name.endsWith(".provenance.json") || name === ".gitkeep") continue;
        // The index is its own declared surface, read by its own fields.
        if (name === indexFile) continue;
        if (!name.endsWith(".json")) fail(`${relativePath}/${name} is not a report; classify it`);
        const where = `${relativePath}/${name}`;
        items.push({ where, values: reportSubjectValues(readJson(rootDir, where)) });
      }
      if (items.length === 0) fail(`${relativePath} holds no reports`);
      return items;
    }
  };
}

function jsonEntries(relativePath, key, fields) {
  return {
    path: relativePath,
    kind: "json-entries",
    items(rootDir) {
      const entries = arrayAt(readJson(rootDir, relativePath), key, relativePath);
      return entries.map((entry, index) => ({
        where: `${relativePath} ${key ?? ""}[${index}]`,
        values: typeof entry === "string" ? [entry] : fields.map((field) => entry?.[field])
      }));
    }
  };
}

/**
 * Every repository surface that records a visit by this project's scanner or
 * studies. Paths are exact: each must exist, and the test suite pins that.
 */
export const DEVELOPMENT_EXCLUSION_SURFACES = Object.freeze([
  // The published corpus, every report shape (v1 single and comparison, v2
  // single and comparison). The earlier reader knew only the v1 fields.
  reportDirectory("public/reports", { indexFile: "index.json" }),
  // The corpus index: one row per published report, by domain and URL.
  jsonEntries("public/reports/index.json", "reports", ["domain", "requestedUrl"]),
  // Real scanner reports kept as test fixtures (two are no longer published).
  reportDirectory("test-fixtures/reports"),
  // The featured gallery catalog, including entries deferred by
  // scanAvailability: a deferral means the scanner visited and was refused.
  jsonEntries("public/featured-sites.json", "sites", ["domain", "url"]),
  // The corpus de-bias seed catalog.
  jsonEntries("public/corpus-seed-sites.json", "sites", ["domain", "url"]),
  // The scanner-fidelity frame.
  jsonEntries("public/scanner-fidelity-sites.json", "sites", ["url"]),
  // The featured readjudication receipt: per-domain scan outcomes, kept even
  // after a domain leaves the catalog.
  {
    path: "research/ops-receipts/featured-readjudication.json",
    kind: "json-entries",
    items(rootDir) {
      const where = "research/ops-receipts/featured-readjudication.json";
      const receipt = readJson(rootDir, where);
      const items = [];
      for (const [cycleIndex, cycle] of arrayAt(receipt, "cycles", where).entries()) {
        for (const [index, outcome] of arrayAt(cycle, "outcomes", `${where} cycles[${cycleIndex}]`).entries()) {
          items.push({ where: `${where} cycles[${cycleIndex}].outcomes[${index}]`, values: [outcome?.domain] });
        }
      }
      for (const [index, disposition] of arrayAt(receipt, "dispositions", where).entries()) {
        items.push({ where: `${where} dispositions[${index}]`, values: [disposition?.domain] });
      }
      return items;
    }
  },
  // Repeatability study 1: the frame and the rows actually visited.
  jsonEntries("research/repeatability/urls.json", null, []),
  jsonEntries("research/repeatability/results.json", "rows", ["url"]),
  // The 2026-08-13 pixel-events screening: both candidate lists and both
  // result sets (rows record the visit; candidates the intended frame).
  jsonEntries("research/pixel-events-screening-2026-08-13/candidates.json", null, ["url"]),
  jsonEntries("research/pixel-events-screening-2026-08-13/results.json", "rows", ["url"]),
  jsonEntries("research/pixel-events-screening-2026-08-13/tcf-candidates.json", null, ["url"]),
  jsonEntries("research/pixel-events-screening-2026-08-13/tcf-results.json", "rows", ["url"]),
  // The 2026-07-28 pixel-events calibration pilot: its frame and scan rows.
  jsonEntries("calibration/pixel-events-pilot-2026-07-28/frame.json", "sites", ["url"]),
  jsonEntries("calibration/pixel-events-pilot-2026-07-28/scan-results.json", "results", ["url"]),
  // The monthly toolchain canary panel, scanned on staging every epoch.
  jsonEntries("scripts/fixtures/toolchain-canary-panel.json", "cases", ["domain", "url"]),
  // The real PageGraph capture kept as a parser fixture.
  {
    path: "lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json",
    kind: "json-entries",
    items(rootDir) {
      const where = "lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json";
      const meta = readJson(rootDir, where);
      return [{ where, values: [meta?.capture?.requestedUrl, meta?.capture?.finalUrl] }];
    }
  },
  // The production synthetic's fixed targets, scanned every hour.
  {
    path: "lib/production-synthetic.ts",
    kind: "typescript-literal",
    items(rootDir) {
      const where = "lib/production-synthetic.ts";
      let text;
      try {
        text = readFileSync(path.join(rootDir, where), "utf8");
      } catch (error) {
        fail(`${where} cannot be read (${error.code ?? error.message})`);
      }
      const block = /PRODUCTION_SYNTHETIC_TARGETS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
      if (block === null) fail(`${where} no longer declares PRODUCTION_SYNTHETIC_TARGETS as a frozen literal`);
      const targets = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      if (targets.length === 0) fail(`${where} declares no synthetic targets`);
      return targets.map((target, index) => ({ where: `${where} target[${index}]`, values: [target] }));
    }
  }
]);

/**
 * Every other entry under the scoped roots, with the reason it is not read.
 * A key ending in "/" covers everything under that directory and a key
 * ending in "*" everything that starts with the rest. The scoped roots are
 * DEVELOPMENT_EXCLUSION_SCOPE; a test requires every entry there to be a
 * surface or listed here, and every key here to exist.
 */
export const DEVELOPMENT_EXCLUSION_SCOPE = Object.freeze([
  "public",
  "research",
  "calibration",
  "test-fixtures",
  "scripts/fixtures",
  "lib/__fixtures__"
]);

export const NOT_DEVELOPMENT_VISIT_RECORDS = Object.freeze({
  "public/.well-known/": "this site's own security.txt",
  "public/_headers": "this site's own response headers",
  "public/schemas/": "JSON schemas; example hosts only",
  "public/corpus-stats.json": "aggregates over public/reports, which is read",
  "public/corrections.json": "names report ids, never a domain",
  "public/corrections.schema.json": "schema",
  "public/metric-contract.v1.json": "metric definitions",
  "public/scan-report.schema.json": "schema",
  "public/service-role-taxonomy.v1.json": "third-party service roles, not visited sites",
  "public/transparency-log.json": "names report ids and digests, never a domain",
  "public/transparency-log.schema.json": "schema",
  "research/calibration-censoring/": "analysis code and findings over public/reports, which is read",
  "research/measurement-candidate/": "policy and definition artifacts; no site list",
  "research/ops-evidence/": "operations notes; no site list",
  "research/ops-receipts/r2-lifecycle-readback.json": "storage lifecycle receipt; no site",
  "research/ops-receipts/durable-replay/": "durable-job replay receipts; no site",
  "research/ops-receipts/release-tag-governance/": "release governance receipt; no site",
  "research/ops-receipts/waf-admission-probe-2026-07-31.txt": "probe of this project's own scan host only",
  "research/repeatability/PREREGISTRATION.md": "prose; its frame is urls.json, which is read",
  "research/repeatability/RESULT.md": "prose over results.json, which is read",
  "research/repeatability-2/": "preregistration only; its sites file was never committed or collected",
  "calibration/cname-uncloaking-*": "this study's own frame artifacts: reading them would make a rebuild exclude its own pilot",
  "calibration/pixel-events-pilot-2026-07-28/REPORT.md": "prose over frame.json, which is read",
  "calibration/pixel-events-pilot-2026-07-28/analysis.json": "rates; no site",
  "calibration/pixel-events-pilot-2026-07-28/artifacts.tar.gz": "per-case evidence keyed by frame.json case ids",
  "calibration/pixel-events-pilot-2026-07-28/assemble-study.mjs": "assembly code",
  "calibration/pixel-events-pilot-2026-07-28/labeling-workflow.js": "labeling code",
  "calibration/pixel-events-pilot-2026-07-28/labels.json": "labels keyed by frame.json case ids",
  "calibration/pixel-events-pilot-2026-07-28/packets/": "per-case evidence keyed by frame.json case ids",
  "calibration/pixel-events-pilot-2026-07-28/run-scans.mjs": "the code that scanned frame.json",
  "calibration/pixel-events-pilot-2026-07-28/study.json": "study keyed by frame.json case ids",
  "test-fixtures/admission-attempt-runtime.test.ts": "runtime test; synthetic hosts",
  "test-fixtures/durable-scan-job-runtime.test.ts": "runtime test; synthetic hosts",
  "test-fixtures/encrypted-watch-flag-runtime.test.ts": "runtime test; synthetic hosts",
  "scripts/fixtures/smoke-single-report.json": "synthetic report of the reserved example.com",
  "scripts/fixtures/smoke-single-report-rescan.json": "synthetic report of the reserved example.com",
  "lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.graphml": "graph of the capture whose meta.json is read",
  "lib/__fixtures__/pagegraph/schema-current.graphml": "synthetic schema fixture",
  "lib/__fixtures__/pagegraph/schema-provenance.expected.json": "synthetic schema fixture",
  "lib/__fixtures__/pagegraph/schema-provenance.graphml": "synthetic schema fixture",
  "lib/__fixtures__/pagegraph/schema-provenance.meta.json": "synthetic schema fixture"
});

/**
 * Derive the exclusion set from the tree at rootDir. Returns the sorted
 * domains and, per surface, how many records it held and how many domains
 * it contributed, so the build can print what it read.
 */
export function deriveDevelopmentExclusions({ rootDir }) {
  if (typeof rootDir !== "string" || rootDir.length === 0) fail("rootDir is required");
  const domains = new Set();
  const surfaces = [];
  for (const surface of DEVELOPMENT_EXCLUSION_SURFACES) {
    if (!existsSync(path.join(rootDir, surface.path))) {
      fail(`${surface.path} does not exist; a declared surface that vanished must be removed by a reviewed change, never skipped`);
    }
    const contributed = new Set();
    const items = surface.items(rootDir);
    for (const item of items) {
      const named = item.values.flatMap((value) => developmentDomainsOf(value));
      if (named.length === 0) fail(`${item.where} names no domain; the surface changed shape`);
      for (const domain of named) {
        contributed.add(domain);
        domains.add(domain);
      }
    }
    surfaces.push({ path: surface.path, records: items.length, domains: contributed.size });
  }
  return { domains: [...domains].sort(), surfaces };
}
