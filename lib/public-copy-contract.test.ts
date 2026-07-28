import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("public corpus copy describes current retention and correction-ledger pins", () => {
  const files = [
    "README.md",
    "app/_components/report-page-context.tsx",
    "app/directory/directory-index.tsx",
    "app/categories/[category]/page.tsx",
    "app/privacy/page.tsx",
    "app/methodology/page.tsx"
  ];
  const combined = files.map(source).join("\n");
  assert.doesNotMatch(combined, /permanent public evidence|permanent site artifacts|complete published evidence timeline|complete report history|deliberately permanent evidence/i);
  assert.match(combined, /currently retained/i);
  assert.match(source("README.md"), /reports cited by the corrections ledger are retention-pinned/i);
  assert.match(source("app/privacy/page.tsx"), /reports cited by[\s\S]*the corrections ledger are pinned/i);
});

test("catalog copy scopes official references to entity identity, not suffixes or categories", () => {
  const page = source("app/catalog/page.tsx");
  const provenance = source("lib/tracker-catalog-provenance.ts");
  assert.match(page, /identifies the named entity or product only/);
  assert.match(page, /not presented as a[\s\S]*citation for every suffix/);
  assert.match(provenance, /may not list this suffix, prove the domain mapping, or support the functional category/);
});

test("catalog and project trust surfaces are linked from both primary footers", () => {
  const trustLinks = source("app/_components/trust-links.tsx");
  const home = source("app/site-behavior-app.tsx");
  const report = source("app/reports/[id]/saved-report-client.tsx");
  for (const route of ["catalog", "status", "security", "corrections"]) {
    assert.match(trustLinks, new RegExp(`href="/${route}/"`));
    assert.match(home, new RegExp(`staticAssetPath\\("/${route}/"\\)`));
    assert.match(report, new RegExp(`staticAssetPath\\("/${route}/"\\)`));
  }
});

test("a rejected URL stays a field problem instead of erasing the homepage", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const home = source("app/site-behavior-app.tsx");
  const submit = hook.slice(hook.indexOf("function handleSubmit"), hook.indexOf("function useExample"));

  // The corpus hero is gated on `!error`, and clearUrlNotice only clears urlError, so
  // mirroring a typo into `error` announced it twice and deleted the hero until the
  // next successful scan.
  assert.match(home, /!loaded && !loading && !error && !pendingScanAdmission && \(\s*<CorpusHero/);
  assert.match(submit, /setUrlError\("Enter a public URL to scan/);
  assert.match(submit, /setUrlError\("Enter a valid public URL/);
  assert.doesNotMatch(submit, /setError\(/, "URL validation must not raise the scan-recovery banner");
});

test("a completed cancellation reads as done, not as a failure", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const banner = source("app/_components/scan-recovery-banner.tsx");

  // cancelRuntimeScan resolves with "Scan cancelled."; routing that through setError
  // rendered a successful cancel as a red warning-triangle alert.
  const cancel = hook.slice(hook.indexOf("async function cancelActiveScan"), hook.indexOf("function dismissActiveScan"));
  assert.match(cancel, /setScanNotice\(message\)/);
  assert.doesNotMatch(cancel, /setError\(message\)/);
  assert.match(banner, /const settled = Boolean\(notice\) && !failed/);
});

test("the pre-admission escape does not claim a cancellation it cannot perform", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const home = source("app/site-behavior-app.tsx");

  assert.match(hook, /function stopWaitingForAdmission\(\): void/);
  assert.match(hook, /Stopped waiting for the scanner\. The request may already have been accepted/);
  assert.match(home, /cancelLabel=\{activeScanJob \? "Cancel scan" : "Stop waiting"\}/);
});

test("methodology dates never render a broken Date object", () => {
  const renderer = source("app/_components/report-renderer.tsx");
  // adblockLists.fetchedAt carries the literal "unknown" sentinel when list metadata
  // was unreadable, and imported report files can carry anything.
  assert.match(renderer, /function formatListSnapshot\(value: string\): string/);
  assert.match(renderer, /if \(Number\.isNaN\(date\.getTime\(\)\)\) return "date not recorded"/);
  assert.match(renderer, /fetched\{" "\}\s*\{formatListSnapshot\(displayedRun\.conditions\.adblockLists\.fetchedAt\)\}/);
});
