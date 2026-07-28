import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type FeaturedScanDiagnosticHelpers = {
  FEATURED_CATALOG_VERSION_FLOOR: number;
  FEATURED_CATALOG_COVERAGE_FLOOR: number;
  FEATURED_ACTIVE_SITE_FLOOR: number;
  FEATURED_UNAVAILABILITY_MAX_DAYS: number;
  featuredMinimumSuccessRate(raw: unknown, fallback?: number, floor?: number): number;
  featuredTransientRetryLimit(raw: unknown, fallback?: number, maximum?: number): number;
  featuredScanRetryReason(diagnostic: unknown): string | null;
  featuredSiteUnavailability(site: unknown, today?: string): {
    status: string;
    reason: string;
    observedAt: string;
    reviewAfter: string;
    workflowRunIds: string[];
  } | null;
  featuredCatalogVersion(value: unknown): number;
  featuredCatalogEligibility(catalogTotal: unknown, eligibleTotal: unknown, enforceFloor?: boolean): {
    catalogCoverage: number;
    requiredCatalogCoverage: number;
    minimumEligibleSites: number;
    meetsFloor: boolean;
  };
  isFullFeaturedCatalogSelection(environment: Record<string, string | undefined>): boolean;
  isScheduledCorpusCatalogSelection(environment: Record<string, string | undefined>): boolean;
  failureDiagnosticFromStderr(stderr: unknown): string | null;
  publicFeaturedScanSummary(value: unknown): {
    catalogVersion: number | null;
    fullCatalog: boolean;
    catalogTotal: number;
    unavailable: number;
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    requiredSuccessRate: number;
    catalogCoverage: number;
    requiredCatalogCoverage: number;
    minimumEligibleSites: number;
    meetsFloor: boolean;
  } | null;
  featuredPublicationDecision(value: unknown, scanOutcome: unknown): {
    publishable: boolean;
    healthy: boolean;
  };
  buildFeaturedRefreshIssueReport(input: {
    failed: boolean;
    summary: unknown;
    branch?: string;
    serverUrl?: string;
    repository?: string;
    runId?: string;
  }): string;
  isAuthoritativeFeaturedRefresh(environment: Record<string, string | undefined>): boolean;
};

type FeaturedScanRunnerHelpers = {
  selectSites(
    config: { version: unknown; sites: Array<Record<string, unknown>> },
    environment?: Record<string, string | undefined>,
    today?: string
  ): {
    sites: Array<Record<string, unknown>>;
    unavailable: Array<Record<string, unknown>>;
    catalogTotal: number;
    catalogVersion: number | null;
    fullCatalog: boolean;
    eligibility: {
      catalogCoverage: number;
      requiredCatalogCoverage: number;
      minimumEligibleSites: number;
      meetsFloor: boolean;
    };
  };
};

// Preserve native import() after this test is compiled to CommonJS; TypeScript
// would otherwise lower a direct dynamic import to require(), which cannot load
// the source .mjs helper exercised by the actual featured-scan script.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<FeaturedScanDiagnosticHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-featured-scans-diagnostics.mjs")).href
);
const runnerHelpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-featured-scans.mjs")).href
) as unknown as Promise<FeaturedScanRunnerHelpers>;

test("featured success-rate overrides can raise but never lower the 80% workflow floor", async () => {
  const { featuredMinimumSuccessRate } = await helpers;
  assert.equal(featuredMinimumSuccessRate(undefined), 0.9);
  assert.equal(featuredMinimumSuccessRate("0.8"), 0.8);
  assert.equal(featuredMinimumSuccessRate("0.95"), 0.95);
  assert.throws(() => featuredMinimumSuccessRate("0.79"), /from 0\.8 to 1/);
  assert.throws(() => featuredMinimumSuccessRate("0"), /from 0\.8 to 1/);
  assert.throws(() => featuredMinimumSuccessRate("not-a-rate"), /from 0\.8 to 1/);
});

test("featured transient retries stay bounded and classify only explicit transient failures", async () => {
  const { featuredScanRetryReason, featuredTransientRetryLimit } = await helpers;
  assert.equal(featuredTransientRetryLimit(undefined), 1);
  assert.equal(featuredTransientRetryLimit("0"), 0);
  assert.equal(featuredTransientRetryLimit("2"), 2);
  assert.throws(() => featuredTransientRetryLimit("3"), /integer from 0 to 2/);
  assert.throws(() => featuredTransientRetryLimit("1.5"), /integer from 0 to 2/);

  assert.equal(featuredScanRetryReason("The page did not load before the scan timeout."), "scan deadline");
  assert.equal(featuredScanRetryReason("Scan endpoint returned HTTP 503."), "HTTP 503");
  assert.equal(
    featuredScanRetryReason("Expected JSON from https://scanner.example/api/scan/jobs/123, got 503."),
    "HTTP 503"
  );
  assert.equal(featuredScanRetryReason("Skipping scan target: primary arm returned HTTP 429."), "HTTP 429");
  assert.equal(featuredScanRetryReason("fetch failed: UND_ERR_SOCKET"), "transport failure");
  assert.equal(featuredScanRetryReason("Scanner queue is full. Try again shortly."), "scanner capacity");

  assert.equal(featuredScanRetryReason("Skipping scan target: landing page title matches a bot-block/challenge page."), null);
  assert.equal(featuredScanRetryReason("Skipping scan target: only 1 request observed, navigation likely failed or was blocked."), null);
  assert.equal(featuredScanRetryReason("Request-capped evidence cannot be published."), null);
  assert.equal(featuredScanRetryReason("Completed scan job did not include a publishable report."), null);
  assert.equal(featuredScanRetryReason("Skipping scan target: main navigation returned HTTP 403."), null);
  assert.equal(
    featuredScanRetryReason("Expected JSON from https://scanner.example/api/scan/jobs/123, got 404."),
    null,
    "a permanent non-JSON HTTP response must not be retried"
  );
  assert.equal(
    featuredScanRetryReason("The page could not be loaded. The site may be down, unreachable, or blocking automated visits."),
    null,
    "an ambiguous load failure may be an automation block and must not be retried"
  );
});

test("featured catalog unavailability is versioned, evidenced, and review-bounded", async () => {
  const { featuredSiteUnavailability } = await helpers;
  const site = {
    domain: "blocked.example",
    scanAvailability: {
      status: "temporarily-unavailable",
      reason: "automation-blocked",
      observedAt: "2026-07-21",
      reviewAfter: "2026-08-18",
      workflowRunIds: ["29796314322", "29799463993"]
    }
  };
  assert.deepEqual(featuredSiteUnavailability(site, "2026-07-21"), site.scanAvailability);
  assert.equal(featuredSiteUnavailability({ domain: "active.example" }, "2026-07-21"), null);
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, reviewAfter: "2026-07-20" } }, "2026-07-21"),
    /Invalid scanAvailability metadata/
  );
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, workflowRunIds: ["29799463993"] } }, "2026-07-21"),
    /Invalid scanAvailability metadata/
  );
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, workflowRunIds: ["29799463993", "29799463993"] } }, "2026-07-21"),
    /Invalid scanAvailability metadata/
  );
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, reason: "misc" } }, "2026-07-21"),
    /Invalid scanAvailability metadata/
  );
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, observedAt: "2026-07-22" } }, "2026-07-21"),
    /Invalid scanAvailability metadata/,
    "an observation date cannot come from the future"
  );
  assert.throws(
    () => featuredSiteUnavailability({ ...site, scanAvailability: { ...site.scanAvailability, reviewAfter: "2026-08-19" } }, "2026-07-21"),
    /Invalid scanAvailability metadata/,
    "a deferral cannot run longer than 28 days"
  );
});

test("full featured-catalog coverage has fixed, non-overridable floors", async () => {
  const {
    FEATURED_ACTIVE_SITE_FLOOR,
    FEATURED_CATALOG_COVERAGE_FLOOR,
    featuredCatalogEligibility,
    featuredCatalogVersion
  } = await helpers;

  assert.equal(FEATURED_ACTIVE_SITE_FLOOR, 50);
  assert.equal(FEATURED_CATALOG_COVERAGE_FLOOR, 0.8);
  assert.equal(featuredCatalogVersion(2), 2);
  assert.throws(() => featuredCatalogVersion("2"), /integer version of 2 or newer/);
  assert.throws(() => featuredCatalogVersion(2.5), /integer version of 2 or newer/);

  assert.deepEqual(featuredCatalogEligibility(81, 68, true), {
    catalogCoverage: 68 / 81,
    requiredCatalogCoverage: 0.8,
    minimumEligibleSites: 50,
    meetsFloor: true
  });
  assert.throws(
    () => featuredCatalogEligibility(81, 64, true),
    /64\/81[\s\S]*at least 50 eligible sites and 80% whole-catalog coverage/
  );
  assert.throws(
    () => featuredCatalogEligibility(60, 49, true),
    /at least 50 eligible sites/
  );
});

test("the public featured catalog keeps every current deferral explicit and valid", async () => {
  const { featuredSiteUnavailability } = await helpers;
  const catalog = JSON.parse(
    readFileSync(path.join(process.cwd(), "public", "featured-sites.json"), "utf8")
  ) as {
    version: number;
    sites: Array<{ domain: string; scanAvailability?: unknown }>;
  };
  const deferred = catalog.sites.filter((site) => site.scanAvailability !== undefined);

  assert.equal(catalog.version, 2);
  assert.equal(deferred.length, 13);
  for (const site of deferred) {
    assert.ok(featuredSiteUnavailability(site), site.domain);
  }
});

test("full-catalog selection keeps 68 of 81 active and refuses 17 or more deferrals", async () => {
  const { selectSites } = await runnerHelpers;
  const catalog = JSON.parse(
    readFileSync(path.join(process.cwd(), "public", "featured-sites.json"), "utf8")
  ) as { version: number; sites: Array<Record<string, unknown>> };
  const environment = {
    FEATURED_SITES_FILE: "public/featured-sites.json",
    FEATURED_CATEGORIES: "",
    FEATURED_LIMIT: "",
    FEATURED_INCLUDE_UNAVAILABLE: "false"
  };
  const selected = selectSites(catalog, environment, "2026-07-21");

  assert.equal(selected.fullCatalog, true);
  assert.equal(selected.catalogVersion, 2);
  assert.equal(selected.catalogTotal, 81);
  assert.equal(selected.sites.length, 68);
  assert.equal(selected.unavailable.length, 13);
  assert.equal(selected.eligibility.meetsFloor, true);

  const extraDeferral = {
    status: "temporarily-unavailable",
    reason: "navigation-incomplete",
    observedAt: "2026-07-21",
    reviewAfter: "2026-08-18",
    workflowRunIds: ["29796314322", "29799463993"]
  };
  let added = 0;
  const overDeferred = {
    ...catalog,
    sites: catalog.sites.map((site) => {
      if (site.scanAvailability !== undefined || added >= 4) return site;
      added += 1;
      return { ...site, scanAvailability: extraDeferral };
    })
  };
  assert.throws(
    () => selectSites(overDeferred, environment, "2026-07-21"),
    /64\/81[\s\S]*80% whole-catalog coverage/
  );
  assert.throws(
    () => selectSites({ ...catalog, version: "2" }, environment, "2026-07-21"),
    /integer version of 2 or newer/
  );
  assert.throws(
    () => selectSites(
      { ...catalog, version: "2" },
      { ...environment, FEATURED_CATEGORIES: "gov" },
      "2026-07-21"
    ),
    /integer version of 2 or newer/,
    "filtering deferred entries out of a versioned catalog must not bypass version validation"
  );

  const manualReview = selectSites(
    catalog,
    { ...environment, FEATURED_INCLUDE_UNAVAILABLE: "true" },
    "2026-07-21"
  );
  assert.equal(manualReview.fullCatalog, false);
  assert.equal(manualReview.sites.length, 81);
  assert.equal(manualReview.unavailable.length, 0);
});

test("featured-scan diagnostics retain the final child failure reason", async () => {
  const { failureDiagnosticFromStderr } = await helpers;

  assert.equal(
    failureDiagnosticFromStderr(
      "setup detail\nSkipping scan target: primary baseline arm: landing page title matches a bot-block/challenge page.\n"
    ),
    "Skipping scan target: primary baseline arm: landing page title matches a bot-block/challenge page."
  );
  assert.equal(
    failureDiagnosticFromStderr("\nThe page could not be loaded. The site may be down, unreachable, or blocking automated visits.\n"),
    "The page could not be loaded. The site may be down, unreachable, or blocking automated visits."
  );
  assert.equal(failureDiagnosticFromStderr("\n\t\n"), null);
});

test("featured-scan diagnostics strip terminal controls, redact URLs, and cap output", async () => {
  const { failureDiagnosticFromStderr } = await helpers;
  const diagnostic = failureDiagnosticFromStderr(
    `old line\n\u001b[31mRequest failed for https://private.example/path\u001b[0m\u0000 ${"x".repeat(600)}\n`
  );

  assert.ok(diagnostic);
  assert.equal(diagnostic.includes("\u001b"), false);
  assert.equal(diagnostic.includes("private.example"), false);
  assert.equal(diagnostic.includes("[redacted URL]"), true);
  assert.equal(diagnostic.length, 500);
  assert.equal(diagnostic.endsWith("..."), true);
});

test("featured refresh issue reports expose aggregates but omit per-target diagnostics", async () => {
  const { buildFeaturedRefreshIssueReport, publicFeaturedScanSummary } = await helpers;
  const detailed = {
    total: 81,
    succeeded: 69,
    failed: 12,
    successRate: 69 / 81,
    requiredSuccessRate: 0.9,
    failures: [
      {
        site: "private-target.example",
        message: "Request failed for https://private-target.example/path?token=secret"
      }
    ]
  };

  assert.deepEqual(publicFeaturedScanSummary(detailed), {
    catalogVersion: null,
    fullCatalog: false,
    catalogTotal: 81,
    unavailable: 0,
    total: 81,
    succeeded: 69,
    failed: 12,
    successRate: 69 / 81,
    requiredSuccessRate: 0.9,
    catalogCoverage: 1,
    requiredCatalogCoverage: 0.8,
    minimumEligibleSites: 50,
    meetsFloor: true
  });
  const report = buildFeaturedRefreshIssueReport({
    failed: true,
    summary: detailed,
    branch: "main",
    serverUrl: "https://github.com",
    repository: "example/site-behavior-lab",
    runId: "12345"
  });

  assert.match(report, /site-behavior-lab:featured-corpus-refresh/);
  assert.match(report, /69\/81/);
  assert.match(report, /Required eligible success rate: \*\*90%\*\*/);
  assert.match(report, /Active eligible catalog coverage: \*\*81\/81\*\*/);
  assert.match(report, /does not mean every catalog entry was freshly scanned/);
  assert.match(report, /https:\/\/github\.com\/example\/site-behavior-lab\/actions\/runs\/12345/);
  assert.equal(report.includes("private-target.example"), false);
  assert.equal(report.includes("token=secret"), false);
  assert.equal(publicFeaturedScanSummary({ ...detailed, failed: 11 }), null);

  const withUnavailable = {
    ...detailed,
    catalogTotal: 94,
    unavailable: 13
  };
  assert.deepEqual(publicFeaturedScanSummary(withUnavailable), {
    catalogVersion: null,
    fullCatalog: false,
    catalogTotal: 94,
    unavailable: 13,
    total: 81,
    succeeded: 69,
    failed: 12,
    successRate: 69 / 81,
    requiredSuccessRate: 0.9,
    catalogCoverage: 81 / 94,
    requiredCatalogCoverage: 0.8,
    minimumEligibleSites: 50,
    meetsFloor: true
  });
  assert.equal(publicFeaturedScanSummary({ ...withUnavailable, unavailable: 12 }), null);
});

test("below-threshold batches publish valid successes while remaining unhealthy", async () => {
  const { featuredPublicationDecision } = await helpers;
  const partial = {
    total: 81,
    succeeded: 68,
    failed: 13,
    successRate: 68 / 81,
    requiredSuccessRate: 0.9
  };
  const healthy = {
    total: 81,
    succeeded: 73,
    failed: 8,
    successRate: 73 / 81,
    requiredSuccessRate: 0.9
  };

  assert.deepEqual(featuredPublicationDecision(partial, "failure"), {
    publishable: true,
    healthy: false
  });
  assert.deepEqual(featuredPublicationDecision(healthy, "success"), {
    publishable: true,
    healthy: true
  });
  assert.deepEqual(featuredPublicationDecision(healthy, "failure"), {
    publishable: true,
    healthy: false
  });
  assert.deepEqual(
    featuredPublicationDecision(
      { total: 81, succeeded: 0, failed: 81, successRate: 0, requiredSuccessRate: 0.9 },
      "failure"
    ),
    { publishable: false, healthy: false }
  );
  assert.deepEqual(featuredPublicationDecision({ ...partial, failed: 12 }, "failure"), {
    publishable: false,
    healthy: false
  });

  const fullCatalogBelowCoverage = {
    catalogVersion: 2,
    fullCatalog: true,
    catalogTotal: 81,
    unavailable: 17,
    total: 64,
    succeeded: 64,
    failed: 0,
    successRate: 1,
    requiredSuccessRate: 0.8,
    catalogCoverage: 64 / 81,
    requiredCatalogCoverage: 0.8,
    minimumEligibleSites: 50
  };
  assert.deepEqual(featuredPublicationDecision(fullCatalogBelowCoverage, "success"), {
    publishable: true,
    healthy: false
  });
  assert.deepEqual(
    featuredPublicationDecision(
      {
        ...fullCatalogBelowCoverage,
        unavailable: 13,
        total: 68,
        succeeded: 68,
        catalogCoverage: 68 / 81
      },
      "success"
    ),
    { publishable: true, healthy: true }
  );
});

test("only an unfiltered default-mode full featured refresh is authoritative", async () => {
  const { isAuthoritativeFeaturedRefresh } = await helpers;
  const fullRefresh: Record<string, string> = {
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: "main",
    FEATURED_DEFAULT_BRANCH: "main",
    FEATURED_SITES_FILE: "public/featured-sites.json",
    FEATURED_CATEGORIES: "",
    FEATURED_LIMIT: "",
    FEATURED_COMPARE_SHIELDS: "true",
    FEATURED_COMPARE_CONSENT: "false",
    FEATURED_COMPARE_GPC: "false",
    FEATURED_DEVICE: "desktop"
  };

  assert.equal(isAuthoritativeFeaturedRefresh(fullRefresh), true);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, FEATURED_SITES_FILE: "" }), true);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, FEATURED_LIMIT: "10" }), false);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, FEATURED_CATEGORIES: "news" }), false);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, FEATURED_COMPARE_SHIELDS: "false" }), false);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, FEATURED_INCLUDE_UNAVAILABLE: "true" }), false);
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, GITHUB_REF_NAME: "experiment" }), false);
});

test("featured scans send GPC only when GPC is the measured axis", async () => {
  const harness = readFileSync(path.join(process.cwd(), "scripts", "run-featured-scans.mjs"), "utf8");

  // Held ON for every scan, GPC made the Shields lane claim a signal it was not
  // testing, and the worker injector blocks any non-http(s) Worker because it
  // cannot add the signal to a blob: realm without changing that realm's
  // origin. That block censors the request family, which pushes the site out of
  // the corpus aggregate entirely.
  assert.match(harness, /SCAN_GPC_ENABLED: compareGpc \? "true" : "false"/);
  assert.doesNotMatch(harness, /SCAN_GPC_ENABLED: "true"/);
  // The comparison axis flags stay mutually exclusive and unchanged.
  assert.match(harness, /SCAN_COMPARE_SHIELDS: compareShields \? "true" : "false"/);
  assert.match(harness, /SCAN_COMPARE_GPC: compareGpc \? "true" : "false"/);
});

test("a scheduled refresh of either corpus catalog is authoritative for alerting", async () => {
  const { isAuthoritativeFeaturedRefresh, isFullFeaturedCatalogSelection } = await helpers;
  const scheduled = (sitesFile: string) => ({
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: "main",
    FEATURED_DEFAULT_BRANCH: "main",
    FEATURED_SITES_FILE: sitesFile,
    FEATURED_CATEGORIES: "",
    FEATURED_LIMIT: "",
    FEATURED_COMPARE_SHIELDS: "true",
    FEATURED_COMPARE_CONSENT: "false",
    FEATURED_COMPARE_GPC: "false",
    FEATURED_DEVICE: "desktop"
  });

  // The corpus is two disjoint catalogs and the weekly refresh now walks both.
  // A failed de-bias run used to be silent, which is how that half could fall
  // an era behind without anyone being told.
  assert.equal(isAuthoritativeFeaturedRefresh(scheduled("")), true);
  assert.equal(isAuthoritativeFeaturedRefresh(scheduled("public/featured-sites.json")), true);
  assert.equal(isAuthoritativeFeaturedRefresh(scheduled("public/corpus-seed-sites.json")), true);
  assert.equal(isAuthoritativeFeaturedRefresh(scheduled("public/some-other-list.json")), false);

  // The completeness floor still belongs to the gallery alone: the seed list is
  // smaller by design and must not be measured against the gallery's size.
  assert.equal(isFullFeaturedCatalogSelection(scheduled("public/corpus-seed-sites.json")), false);
  assert.equal(isFullFeaturedCatalogSelection(scheduled("public/featured-sites.json")), true);
});
