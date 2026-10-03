import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { PRODUCTION_SYNTHETIC_TARGETS } from "../lib/production-synthetic.ts";
import {
  DEVELOPMENT_EXCLUSION_SCOPE,
  DEVELOPMENT_EXCLUSION_SURFACES,
  NOT_DEVELOPMENT_VISIT_RECORDS,
  deriveDevelopmentExclusions,
  developmentDomainsOf
} from "./calibration-development-exclusions-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const BUILD_CLI = path.join(moduleDir, "calibration-candidate-universe-build.mjs");

// ---------------------------------------------------------------------------
// END-TO-END against the real tree. The defect these pin: the builder read a
// config/ directory that never existed and never read the featured catalog,
// the corpus seed, or the screening rows, so development-visited news sites
// were admitted to the 2026-08 frame. These spawn the REAL build CLI with a
// synthetic external source whose first lines are domains the repository
// records as visited; every one must come back in excludedDomains.
//
// Two kinds of probe. The catalogs and the production synthetic are edited
// on purpose, so their probes are DERIVED here, by a reader independent of
// the library's (a plain JSON field, the real exported constant): a
// deliberate edit changes the probes instead of turning an unrelated suite
// red. The committed research records do not change, and the restart's named
// domains are a finding, so those stay pinned, each with what to decide if a
// deliberate edit ever drops one.
// ---------------------------------------------------------------------------

function catalogDomains(relativePath) {
  const sites = JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")).sites;
  assert.ok(Array.isArray(sites) && sites.length > 0, `${relativePath} lists no sites`);
  return sites.map((site, index) => {
    assert.equal(typeof site?.domain, "string", `${relativePath} sites[${index}] names no domain`);
    return site.domain;
  });
}

function derivedProbes() {
  return {
    // Every catalog entry, eligible or deferred by scanAvailability: the
    // featured refresh scans the eligible ones every run, and a deferral
    // records a refused visit. Deferral itself is pinned on the synthetic
    // tree below (featured-deferred.example).
    featured: catalogDomains("public/featured-sites.json"),
    corpusSeed: catalogDomains("public/corpus-seed-sites.json"),
    // The hosts the hourly production synthetic scans, read from the real
    // constant rather than by the library's own literal parser.
    synthetic: PRODUCTION_SYNTHETIC_TARGETS.map((target) => new URL(target).hostname.replace(/^www\./, "")),
    screening: ["forbes.com"],
    screeningTcf: ["spiegel.de", "elpais.com", "telegraph.co.uk", "dailymail.co.uk"],
    pixelPilot: ["gap.com", "lowes.com"],
    registrable: ["ycombinator.com", "clevelandclinic.org", "europa.eu"],
    // The seven frame domains the 2026-10 restart analysis found admitted.
    restartNamed: [
      "cnn.com",
      "forbes.com",
      "spiegel.de",
      "elpais.com",
      "telegraph.co.uk",
      "dailymail.co.uk",
      "washingtonpost.com"
    ]
  };
}

let PROBES = null;
let cliRun = null;

before(() => {
  PROBES = derivedProbes();
  for (const [kind, domains] of Object.entries(PROBES)) {
    assert.ok(domains.length > 0, `no ${kind} probe could be derived`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "universe-exclusions-"));
  const probes = [...new Set(Object.values(PROBES).flat())];
  const filler = Array.from({ length: 101 }, (_, index) => `filler-${index}.example`);
  // Probes FIRST: the frame fills in source order, so a probe that is not
  // excluded becomes a frame member instead of being skipped unseen.
  const bytes = [...probes, ...filler].map((domain, index) => `${index + 1},${domain}`).join("\n") + "\n";
  const sourcePath = path.join(dir, "source.csv");
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(sourcePath, bytes);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      provider: "fixture-rank-provider",
      permanentId: "FIXTURE-EXCLUSIONS-1",
      url: "https://ranks.fixture.example/list/FIXTURE-EXCLUSIONS-1",
      retrievedAt: "2026-10-02T00:00:00.000Z",
      sha256: createHash("sha256").update(bytes).digest("hex")
    })
  );
  const out = (name) => path.join(dir, name);
  const result = spawnSync(
    process.execPath,
    [
      BUILD_CLI,
      "fixture-exclusions",
      sourcePath,
      manifestPath,
      "1",
      out("candidates.json"),
      out("provenance.json"),
      "--pilot",
      "100",
      out("pilot.json")
    ],
    { encoding: "utf8", cwd: repoRoot }
  );
  assert.equal(result.status, 0, `build CLI failed: ${result.stderr}`);
  const provenance = JSON.parse(readFileSync(out("provenance.json"), "utf8"));
  cliRun = { provenance, excluded: new Set(provenance.excludedDomains), stdout: result.stdout };
  rmSync(dir, { recursive: true, force: true });
});

function assertExcluded(domains, ifDropped = null) {
  const admitted = domains.filter((domain) => !cliRun.excluded.has(domain));
  assert.deepEqual(
    admitted,
    [],
    `development-visited domains admitted to the frame: ${admitted.join(", ")}` +
      (ifDropped === null ? "" : `. ${ifDropped}`)
  );
}

const PINNED_RECORD =
  "This probe is pinned to a committed record. If a deliberate edit removed that record, the visit it recorded still " +
  "happened: decide whether the domain still needs exclusion (a surface that records it) before changing the probe";

test("every featured catalog site is excluded, eligible or deferred", () => {
  assertExcluded(PROBES.featured);
});

test("every corpus seed catalog site is excluded", () => {
  assertExcluded(PROBES.corpusSeed);
});

test("the pixel-events screening rows are excluded, both the main and the TCF set", () => {
  assertExcluded(PROBES.screening, PINNED_RECORD);
  assertExcluded(PROBES.screeningTcf, PINNED_RECORD);
});

test("the pixel-events calibration pilot's frame is excluded", () => {
  assertExcluded(PROBES.pixelPilot, PINNED_RECORD);
});

test("a visit recorded under a subdomain or a redacted label excludes its registrable domain", () => {
  // news.ycombinator.com, {label}.clevelandclinic.org, {label}.europa.eu:
  // matched exactly, none of these ever removed a registrable candidate.
  assertExcluded(PROBES.registrable, PINNED_RECORD);
});

test("every production synthetic target is excluded", () => {
  assertExcluded(PROBES.synthetic);
});

test("the seven frame domains the restart analysis found admitted are excluded", () => {
  // washingtonpost.com is an eligible featured entry (no scanAvailability)
  // that the featured refresh scans on every run; no committed report has
  // ever named it, so the featured catalog is its only record. cnn.com is a
  // deferred featured entry; the other five are screening rows.
  assertExcluded(PROBES.restartNamed, PINNED_RECORD);
});

test("the build prints every surface it read", () => {
  for (const surface of DEVELOPMENT_EXCLUSION_SURFACES) {
    assert.match(cliRun.stdout, new RegExp(`exclusion surface ${surface.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+ records`));
  }
});

// ---------------------------------------------------------------------------
// The real tree: every declared surface exists, and every entry under the
// scoped roots is either read or classified with a reason.
// ---------------------------------------------------------------------------

test("every path the builder claims to read exists in the repository", () => {
  for (const surface of DEVELOPMENT_EXCLUSION_SURFACES) {
    assert.ok(existsSync(path.join(repoRoot, surface.path)), `${surface.path} is declared but absent`);
  }
  assert.equal(existsSync(path.join(repoRoot, "config")), false, "config/ never existed; nothing may claim to read it");
});

function walk(rootDir, relativeDir) {
  const absolute = path.join(rootDir, relativeDir);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [relativeDir];
  return readdirSync(absolute)
    .sort()
    .flatMap((name) => walk(rootDir, path.posix.join(relativeDir, name)));
}

function coveredBy(file) {
  for (const surface of DEVELOPMENT_EXCLUSION_SURFACES) {
    if (file === surface.path) return "surface";
    if (surface.kind === "report-directory" && file.startsWith(`${surface.path}/`)) return "surface";
  }
  for (const key of Object.keys(NOT_DEVELOPMENT_VISIT_RECORDS)) {
    if (file === key) return key;
    if (key.endsWith("/") && file.startsWith(key)) return key;
    if (key.endsWith("*") && file.startsWith(key.slice(0, -1))) return key;
  }
  return null;
}

test("every entry under the scoped roots is read or classified, and no classification is stale", () => {
  const files = DEVELOPMENT_EXCLUSION_SCOPE.flatMap((root) => walk(repoRoot, root));
  assert.ok(files.length > 1000, "the scope walk found the corpus");
  const unclassified = files.filter((file) => coveredBy(file) === null);
  assert.deepEqual(
    unclassified,
    [],
    "a file under a scoped root is neither a declared surface nor classified: decide whether it records a development visit"
  );
  const used = new Set(files.map(coveredBy));
  const stale = Object.keys(NOT_DEVELOPMENT_VISIT_RECORDS).filter((key) => !used.has(key));
  assert.deepEqual(stale, [], "a classification names nothing in the tree");
});

// ---------------------------------------------------------------------------
// The derivation on a synthetic tree: one unique domain per surface, so
// dropping ANY surface from the declared list turns this red.
// ---------------------------------------------------------------------------

const SURFACE_PROBES = {
  "public/reports": "v1-comparison-subject.example",
  "public/reports/index.json": "index-row.example",
  "test-fixtures/reports": "fixture-report.example",
  "public/featured-sites.json": "featured-deferred.example",
  "public/corpus-seed-sites.json": "seed-entry.example",
  "public/scanner-fidelity-sites.json": "fidelity-entry.example",
  "research/ops-receipts/featured-readjudication.json": "readjudicated.example",
  "research/repeatability/urls.json": "repeat-frame.example",
  "research/repeatability/results.json": "repeat-row.example",
  "research/pixel-events-screening-2026-08-13/candidates.json": "screen-candidate.example",
  "research/pixel-events-screening-2026-08-13/results.json": "screen-row.example",
  "research/pixel-events-screening-2026-08-13/tcf-candidates.json": "tcf-candidate.example",
  "research/pixel-events-screening-2026-08-13/tcf-results.json": "tcf-row.example",
  "calibration/pixel-events-pilot-2026-07-28/frame.json": "pilot-frame.example",
  "calibration/pixel-events-pilot-2026-07-28/scan-results.json": "pilot-row.example",
  "scripts/fixtures/toolchain-canary-panel.json": "canary.example",
  "lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json": "pagegraph-capture.example",
  "lib/production-synthetic.ts": "synthetic-target.example"
};

function writeTreeFile(rootDir, relativePath, content) {
  const file = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function syntheticTree() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "exclusion-tree-"));
  const p = SURFACE_PROBES;
  const w = (relativePath, content) => writeTreeFile(rootDir, relativePath, content);
  // Every report shape the corpus carries; the v1 comparison holds the
  // surface's unique probe, the others their own subjects.
  w("public/reports/20260625-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json", {
    schemaVersion: 1,
    reportType: "comparison",
    requestedUrl: `https://www.${p["public/reports"]}/`,
    baseline: { summary: { firstPartyDomain: `www.${p["public/reports"]}` }, conditions: { finalUrl: `https://www.${p["public/reports"]}/` } }
  });
  w("public/reports/20260625-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.provenance.json", { reportId: "x", publicDigest: "y" });
  w("public/reports/20260714-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json", {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "comparison",
    baseline: { subject: { requested: { origin: "https://v2-comparison.example", registrableDomain: "v2-comparison.example" }, observed: { origin: "https://{label}.v2-comparison.example", registrableDomain: "v2-comparison.example" } } },
    variant: { subject: { requested: { origin: "https://v2-comparison.example", registrableDomain: "v2-comparison.example" } } }
  });
  w("public/reports/20260928-cccccccccccccccccccccccccccccccc.json", {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: { subject: { requested: { origin: "https://news.v2-single.example", registrableDomain: "v2-single.example" } } }
  });
  w("public/reports/20260730-dddddddddddddddddddddddddddddddd.json", {
    schemaVersion: 1,
    reportType: "single",
    summary: { firstPartyDomain: "v1-single.example" },
    conditions: { requestedUrl: "https://v1-single.example/", finalUrl: "https://v1-single.example/" }
  });
  // A v1 redirect: the requested host differs from the landing host, and the
  // scanner visited both.
  w("public/reports/20260702-ffffffffffffffffffffffffffffffff.json", {
    schemaVersion: 1,
    reportType: "comparison",
    requestedUrl: "https://redirect-source.example/",
    baseline: { summary: { firstPartyDomain: "landing.example" } }
  });
  w("public/reports/.gitkeep", "");
  w("public/reports/index.json", { reports: [{ domain: p["public/reports/index.json"], requestedUrl: `https://${p["public/reports/index.json"]}/` }] });
  w("test-fixtures/reports/20260625-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json", {
    schemaVersion: 1,
    reportType: "comparison",
    requestedUrl: `https://${p["test-fixtures/reports"]}/`,
    baseline: { summary: { firstPartyDomain: p["test-fixtures/reports"] } }
  });
  w("public/featured-sites.json", {
    sites: [
      {
        domain: p["public/featured-sites.json"],
        url: `https://www.${p["public/featured-sites.json"]}/`,
        scanAvailability: { status: "temporarily-unavailable" }
      }
    ]
  });
  w("public/corpus-seed-sites.json", { sites: [{ domain: p["public/corpus-seed-sites.json"], url: `https://${p["public/corpus-seed-sites.json"]}/` }] });
  w("public/scanner-fidelity-sites.json", { sites: [{ url: `https://www.${p["public/scanner-fidelity-sites.json"]}/international` }] });
  w("research/ops-receipts/featured-readjudication.json", {
    cycles: [{ outcomes: [{ domain: p["research/ops-receipts/featured-readjudication.json"], status: "unavailable" }] }],
    dispositions: [{ domain: p["research/ops-receipts/featured-readjudication.json"], status: "deferred" }]
  });
  w("research/repeatability/urls.json", [`https://${p["research/repeatability/urls.json"]}/`]);
  w("research/repeatability/results.json", { rows: [{ url: `https://${p["research/repeatability/results.json"]}/` }] });
  for (const name of ["candidates", "tcf-candidates"]) {
    const key = `research/pixel-events-screening-2026-08-13/${name}.json`;
    w(key, [{ url: `https://www.${p[key]}/`, stratum: "s" }]);
  }
  for (const name of ["results", "tcf-results"]) {
    const key = `research/pixel-events-screening-2026-08-13/${name}.json`;
    w(key, { arm: {}, rows: [{ url: `https://www.${p[key]}/` }] });
  }
  w("calibration/pixel-events-pilot-2026-07-28/frame.json", { sites: [{ caseId: "pos-01", url: `https://www.${p["calibration/pixel-events-pilot-2026-07-28/frame.json"]}/` }] });
  w("calibration/pixel-events-pilot-2026-07-28/scan-results.json", { results: [{ caseId: "pos-01", url: `https://${p["calibration/pixel-events-pilot-2026-07-28/scan-results.json"]}/` }] });
  w("scripts/fixtures/toolchain-canary-panel.json", { cases: [{ id: "c", domain: p["scripts/fixtures/toolchain-canary-panel.json"], url: `https://www.${p["scripts/fixtures/toolchain-canary-panel.json"]}/` }] });
  w("lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json", { capture: { requestedUrl: `https://www.${p["lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json"]}/`, finalUrl: `https://www.${p["lib/__fixtures__/pagegraph/real-wikipedia-2026-07-19.meta.json"]}/` } });
  w(
    "lib/production-synthetic.ts",
    `export const PRODUCTION_SYNTHETIC_TARGETS: readonly string[] = Object.freeze([\n  "https://www.${p["lib/production-synthetic.ts"]}/domains/reserved",\n  "https://www.second-synthetic-target.example/TR/"\n]);\n`
  );
  return rootDir;
}

test("every declared surface contributes its own domain, by the shape that surface really has", () => {
  const rootDir = syntheticTree();
  try {
    const { domains, surfaces } = deriveDevelopmentExclusions({ rootDir });
    const missing = Object.entries(SURFACE_PROBES)
      .filter(([, probe]) => !domains.includes(probe))
      .map(([surface]) => surface);
    assert.deepEqual(missing, [], "a surface this suite expects was not read");
    assert.deepEqual(
      DEVELOPMENT_EXCLUSION_SURFACES.map((surface) => surface.path).sort(),
      Object.keys(SURFACE_PROBES).sort(),
      "the declared surface list changed: give the new surface a probe here"
    );
    // Every synthetic target, not only the first: the real constant lists
    // more than one host.
    assert.ok(domains.includes("second-synthetic-target.example"), "a later synthetic target was not read");
    for (const subject of [
      "v2-comparison.example",
      "v2-single.example",
      "news.v2-single.example",
      "v1-single.example",
      "redirect-source.example",
      "landing.example"
    ]) {
      assert.ok(domains.includes(subject), `report subject ${subject} was not read`);
    }
    assert.deepEqual(
      surfaces.find((surface) => surface.path === "public/reports"),
      { path: "public/reports", records: 5, domains: 7 },
      "five reports read; the provenance sidecar, the keep file, and the index are not reports"
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("this study's own pilot artifacts never feed the exclusion set", () => {
  const rootDir = syntheticTree();
  try {
    const baseline = deriveDevelopmentExclusions({ rootDir });
    writeTreeFile(rootDir, "calibration/cname-uncloaking-2026-10-prevalence-pilot/pilot-set.json", {
      studyId: "cname-uncloaking-2026-10-prevalence-pilot",
      candidates: [{ caseId: "own-pilot.example", url: "https://own-pilot.example/" }]
    });
    writeTreeFile(rootDir, "calibration/cname-uncloaking-2026-10-prevalence-pilot/universe-provenance.json", {
      excludedDomains: ["own-provenance.example"]
    });
    assert.deepEqual(deriveDevelopmentExclusions({ rootDir }), baseline, "a rebuild would exclude its own pilot");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the derivation fails closed: a missing, unparseable, or reshaped surface refuses", () => {
  const cases = [
    {
      name: "missing declared surface",
      mutate: (rootDir) => rmSync(path.join(rootDir, "public/corpus-seed-sites.json")),
      refusal: /public\/corpus-seed-sites\.json does not exist/
    },
    {
      name: "unparseable report",
      mutate: (rootDir) => writeTreeFile(rootDir, "public/reports/20260701-ffffffffffffffffffffffffffffffff.json", "{not json"),
      refusal: /20260701-f+\.json is not JSON/
    },
    {
      name: "report naming no subject",
      mutate: (rootDir) => writeTreeFile(rootDir, "public/reports/20260701-ffffffffffffffffffffffffffffffff.json", { schemaVersion: 3, run: { target: "https://x.example/" } }),
      refusal: /20260701-f+\.json names no domain/
    },
    {
      name: "stray file in a report directory",
      mutate: (rootDir) => writeTreeFile(rootDir, "test-fixtures/reports/notes.txt", "x"),
      refusal: /test-fixtures\/reports\/notes\.txt is not a report/
    },
    {
      name: "catalog entry naming no domain",
      mutate: (rootDir) => writeTreeFile(rootDir, "public/featured-sites.json", { sites: [{ label: "renamed field", href: "https://x.example/" }] }),
      refusal: /public\/featured-sites\.json sites\[0\] names no domain/
    },
    {
      name: "catalog emptied",
      mutate: (rootDir) => writeTreeFile(rootDir, "public/corpus-seed-sites.json", { sites: [] }),
      refusal: /public\/corpus-seed-sites\.json has no "sites" entries/
    },
    {
      name: "catalog that lost its entries",
      mutate: (rootDir) => writeTreeFile(rootDir, "public/scanner-fidelity-sites.json", { targets: [] }),
      refusal: /public\/scanner-fidelity-sites\.json has no "sites" entries/
    },
    {
      name: "synthetic targets no longer a frozen literal",
      mutate: (rootDir) => writeTreeFile(rootDir, "lib/production-synthetic.ts", "export const TARGETS = [];\n"),
      refusal: /no longer declares PRODUCTION_SYNTHETIC_TARGETS/
    }
  ];
  for (const { name, mutate, refusal } of cases) {
    const rootDir = syntheticTree();
    try {
      mutate(rootDir);
      assert.throws(() => deriveDevelopmentExclusions({ rootDir }), refusal, name);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("a recorded value names its www-stripped host and its registrable domain, nothing else", () => {
  assert.deepEqual(developmentDomainsOf("https://www.bbc.com/news"), ["bbc.com"]);
  assert.deepEqual(developmentDomainsOf("https://news.ycombinator.com/"), ["news.ycombinator.com", "ycombinator.com"]);
  assert.deepEqual(developmentDomainsOf("{label}.clevelandclinic.org"), ["clevelandclinic.org"]);
  assert.deepEqual(developmentDomainsOf("https://{label}.europa.eu/{seg}"), ["europa.eu"]);
  assert.deepEqual(developmentDomainsOf("https://user@WWW2.HM.com:8443/x"), ["www2.hm.com", "hm.com"]);
  // The PSL private section is how the scanner keys parties; the ICANN-only
  // parent is broader, and this derivation errs toward exclusion.
  assert.deepEqual(developmentDomainsOf("https://someone.github.io/"), ["someone.github.io", "github.io"]);
  // www.gov.uk: the old www-strip (gov.uk) is kept and the registrable form added.
  assert.deepEqual(developmentDomainsOf("https://www.gov.uk/"), ["gov.uk", "www.gov.uk"]);
  for (const nothing of [null, undefined, "", "not a host", "https://{label}/", "localhost", 42]) {
    assert.deepEqual(developmentDomainsOf(nothing), [], String(nothing));
  }
});

// ---------------------------------------------------------------------------
// The 2026-10-03 owner ruling on the definition: "development-visited" means
// a site the scanner opened as the page under test. A host recorded only as a
// third party inside another subject's report, or named only in code or
// prose, is not one. Eight frame domains sit exactly there, and the ruling
// keeps them in the 2026-10 pool, so the universe does not change.
// ---------------------------------------------------------------------------

const BORDERLINE_POOL_DOMAINS = Object.freeze({
  thirdPartyOnly: Object.freeze(["outbrain.com", "bbc.co.uk", "foxbusiness.com", "ap.org"]),
  namedOnly: Object.freeze(["philly.com", "cbslocal.com", "inquirer.com", "cbsnews.com"])
});
const BORDERLINE = Object.freeze([...BORDERLINE_POOL_DOMAINS.thirdPartyOnly, ...BORDERLINE_POOL_DOMAINS.namedOnly]);

test("a host a report records only as a third party is not development-visited", () => {
  const rootDir = syntheticTree();
  try {
    // A v1 comparison and a v2 single, each carrying third-party hosts in the
    // places real reports carry them: request and initiator URLs, the domain
    // rows, cookies, trackers, the diff, and the v2 evidence.
    writeTreeFile(rootDir, "public/reports/20261003-11111111111111111111111111111111.json", {
      schemaVersion: 1,
      reportType: "comparison",
      requestedUrl: "https://page-under-test-v1.example/",
      baseline: {
        summary: { firstPartyDomain: "page-under-test-v1.example" },
        requests: [
          {
            url: "https://{label}.request-host.example/{seg}",
            domain: "{label}.request-host.example",
            provenance: {
              initiatorUrl: "https://initiator-host.example/{seg}",
              initiatorDomain: "initiator-host.example"
            },
            tracker: { domain: "tracker-host.example" }
          }
        ],
        domains: [{ domain: "domain-row-host.example", tracker: { domain: "tracker-host.example" } }],
        cookies: [{ domain: ".cookie-host.example" }, { domain: "host-only-cookie.example" }],
        frames: [{ url: "https://frame-host.example/embed" }]
      },
      diff: { removedDomains: [{ domain: "diff-host.example" }], removedCookies: [{ domain: ".diff-cookie-host.example" }] }
    });
    writeTreeFile(rootDir, "public/reports/20261003-22222222222222222222222222222222.json", {
      schemaVersion: 2,
      schemaRevision: 2,
      reportType: "single",
      run: {
        subject: {
          requested: { origin: "https://page-under-test-v2.example", registrableDomain: "page-under-test-v2.example" },
          observed: { origin: "https://page-under-test-v2.example", registrableDomain: "page-under-test-v2.example" }
        },
        evidence: {
          requests: [{ url: "https://v2-request-host.example/{seg}", domain: "v2-request-host.example" }],
          frames: [{ url: "https://v2-frame-host.example/" }],
          cookiesFinal: [{ domain: ".v2-cookie-host.example" }, { domain: "v2-host-only-cookie.example" }]
        }
      }
    });
    const { domains } = deriveDevelopmentExclusions({ rootDir });
    for (const subject of ["page-under-test-v1.example", "page-under-test-v2.example"]) {
      assert.ok(domains.includes(subject), `the page under test ${subject} was not excluded`);
    }
    const thirdParties = [
      "request-host.example",
      "initiator-host.example",
      "tracker-host.example",
      "domain-row-host.example",
      "cookie-host.example",
      "host-only-cookie.example",
      "frame-host.example",
      "diff-host.example",
      "diff-cookie-host.example",
      "v2-request-host.example",
      "v2-frame-host.example",
      "v2-cookie-host.example",
      "v2-host-only-cookie.example"
    ];
    assert.deepEqual(
      thirdParties.filter((host) => domains.includes(host)),
      [],
      "a host the scanner never opened as the page under test was excluded; the 2026-10-03 ruling defines development-visited by the page under test"
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the eight borderline frame domains stay in the 2026-10 universe", () => {
  const dir = path.join(repoRoot, "calibration", "cname-uncloaking-2026-10-prevalence-pilot");
  const provenance = JSON.parse(readFileSync(path.join(dir, "universe-provenance.json"), "utf8"));
  const pilot = JSON.parse(readFileSync(path.join(dir, "pilot-set.json"), "utf8"));
  assert.equal(provenance.studyId, "cname-uncloaking-2026-10");
  assert.ok(Array.isArray(provenance.excludedDomains) && provenance.excludedDomains.length === 20);
  assert.ok(Array.isArray(pilot.candidates) && pilot.candidates.length === 100);
  for (const domain of BORDERLINE) {
    assert.equal(provenance.excludedDomains.includes(domain), false, `${domain} is in the committed exclusion list`);
    assert.equal(
      pilot.candidates.some((candidate) => candidate.caseId === domain),
      false,
      `${domain} is in the committed pilot; the restart recorded all eight in the pool`
    );
  }
  // The committed files are fixed by their digests. This is the tripwire for
  // the tree: none of the eight may become a page under test while the study
  // runs, because each is a pool case.
  const { domains } = deriveDevelopmentExclusions({ rootDir: repoRoot });
  assert.deepEqual(
    BORDERLINE.filter((domain) => domains.includes(domain)),
    [],
    "a 2026-10 pool domain is now recorded as a page under test. The study's universe is fixed by its committed digests and keeps it, " +
      "so this is a development visit to a pool case during the study: report it to the owner instead of editing this list"
  );
});
