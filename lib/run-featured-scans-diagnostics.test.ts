import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type FeaturedScanDiagnosticHelpers = {
  failureDiagnosticFromStderr(stderr: unknown): string | null;
  publicFeaturedScanSummary(value: unknown): {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
    requiredSuccessRate: number;
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

// Preserve native import() after this test is compiled to CommonJS; TypeScript
// would otherwise lower a direct dynamic import to require(), which cannot load
// the source .mjs helper exercised by the actual featured-scan script.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<FeaturedScanDiagnosticHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-featured-scans-diagnostics.mjs")).href
);

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
    total: 81,
    succeeded: 69,
    failed: 12,
    successRate: 69 / 81,
    requiredSuccessRate: 0.9
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
  assert.match(report, /Required success rate: \*\*90%\*\*/);
  assert.match(report, /https:\/\/github\.com\/example\/site-behavior-lab\/actions\/runs\/12345/);
  assert.equal(report.includes("private-target.example"), false);
  assert.equal(report.includes("token=secret"), false);
  assert.equal(publicFeaturedScanSummary({ ...detailed, failed: 11 }), null);
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
  assert.equal(isAuthoritativeFeaturedRefresh({ ...fullRefresh, GITHUB_REF_NAME: "experiment" }), false);
});
