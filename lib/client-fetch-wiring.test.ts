import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("report, archive, comparison and corpus JSON reads use the bounded shared policy", () => {
  for (const file of [
    "app/reports/[id]/saved-report-client.tsx",
    "app/site-behavior-app.tsx",
    "app/_components/static-gallery.tsx",
    "app/_components/report-overview.tsx"
  ]) {
    const contents = source(file);
    assert.match(contents, /fetch(?:Json|BytesResponse)WithPolicy/);
    assert.doesNotMatch(contents, /\bfetch\s*\(/, `${file} contains an unbounded direct fetch`);
    assert.doesNotMatch(contents, /response\.json\s*\(/, `${file} parses a response outside the bounded policy`);
  }

  assert.match(source("app/reports/[id]/saved-report-client.tsx"), /maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES/);
  assert.match(source("app/site-behavior-app.tsx"), /maxBytes: MAX_DIRECTORY_JSON_BYTES/);
  assert.match(source("app/_components/static-gallery.tsx"), /maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES/);
  assert.match(source("app/_components/report-overview.tsx"), /maxBytes: MAX_CORPUS_STATS_JSON_BYTES/);
});

test("archive reports authenticate exact manifest bytes before they render", () => {
  const gallery = source("app/_components/static-gallery.tsx");
  assert.match(gallery, /bytes\.byteLength !== entry\.reportWireBytes/);
  assert.match(gallery, /parseDigestBoundReportJson\([\s\S]*entry\.reportWireSha256/);
  assert.match(gallery, /read\.loaded\.wire\.share\?\.id !== entry\.id/);
  assert.ok(gallery.indexOf("parseDigestBoundReportJson(") < gallery.indexOf("readLoadedReport(payload"));
});

test("browser file, response, and recovery JSON boundaries reject duplicate keys", () => {
  assert.match(source("lib/client-fetch-policy.ts"), /parseStrictJson\(text\)/);
  assert.match(source("app/site-behavior-app.tsx"), /parseJsonTextWithPolicy\(contents/);
  assert.match(source("app/_components/static-gallery.tsx"), /parseJsonTextWithPolicy\(contents/);
  assert.match(source("lib/pagegraph-client-import.ts"), /parseJsonTextWithPolicy\(metadataText/);

  const recovery = source("lib/active-scan-session.ts");
  assert.match(recovery, /ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES = 2_048/);
  assert.match(recovery, /parseStrictJson\(raw, ACTIVE_SCAN_SESSION_MAX_STORAGE_BYTES\)/);
  assert.doesNotMatch(recovery, /JSON\.parse/);
});

test("mutable report and comparison reads are fenced by latest-operation ownership", () => {
  const permalink = source("app/reports/[id]/saved-report-client.tsx");
  const app = source("app/site-behavior-app.tsx");
  const gallery = source("app/_components/static-gallery.tsx");

  assert.match(permalink, /evidenceOperation\.run\(/);
  assert.match(permalink, /return \(\) => evidenceOperation\.cancel\(\)/);
  assert.match(app, /archiveOperation\.run\(/);
  assert.match(app, /reportOpenOperation\.run\(/);
  assert.match(gallery, /archiveComparisonOperation\.run\(/);
  assert.match(gallery, /beforeUploadOperation/);
  assert.match(gallery, /afterUploadOperation/);
  assert.match(gallery, /comparisonIntentEpochRef/);
});

test("a failed archive read remains retryable instead of becoming an empty success", () => {
  const app = source("app/site-behavior-app.tsx");
  const gallery = source("app/_components/static-gallery.tsx");

  assert.doesNotMatch(app, /onError:[\s\S]{0,300}setStaticReports\(\[\]\)/);
  assert.match(app, /onError:[\s\S]{0,300}setStaticReports\(null\)/);
  assert.match(gallery, /<span role="alert">\{error\}<\/span>/);
  assert.match(gallery, /Retry saved-report tools/);
  assert.match(gallery, /onClick=\{onRetry\}/);
});

test("the server-rendered directory does not add a redundant client fetch layer", () => {
  const controls = source("app/directory/directory-controls.tsx");
  assert.doesNotMatch(controls, /\bfetch\s*\(/);
  assert.doesNotMatch(controls, /fetchJsonWithPolicy/);
});

test("public deployment status uses one bounded latest-operation owner and aborts it on cleanup", () => {
  const status = source("app/status/live-deployment-status.tsx");
  const client = source("lib/live-deployment-status-client.ts");

  assert.match(status, /statusOperationRef/);
  assert.match(status, /runLiveDeploymentStatusCheck\(\s*statusOperation/);
  assert.match(status, /statusOperation\.cancel\(\)/);
  assert.doesNotMatch(status, /\bfetch\s*\(/);
  assert.doesNotMatch(status, /response\.json\s*\(/);
  assert.match(client, /PAGES_DEPLOYMENT_RECEIPT_MAX_BYTES = 16 \* 1024/);
  assert.match(client, /SCANNER_HEALTH_RESPONSE_MAX_BYTES = 64 \* 1024/);
  assert.match(client, /fetchJsonWithPolicy/);
});

test("a shared evidence fragment opens the explorer that reads it", () => {
  const permalink = source("app/reports/[id]/saved-report-client.tsx");
  const navigation = source("lib/report-evidence-navigation.ts");
  const renderer = source("app/_components/report-renderer.tsx");
  const tables = source("app/_components/report-tables.tsx");

  // buildEvidenceHash advertises these links as same-page and reload-free, but
  // every reader of the fragment ships inside the lazily imported renderer, which
  // this page mounts only on request. Without consulting the fragment here a
  // copied "#evidence=..." URL renders no table, no filter, and no scroll.
  assert.match(navigation, /A same-page, reload-free report evidence link/);
  for (const lazyReader of [renderer, tables]) {
    assert.match(lazyReader, /parseEvidenceHash\(/);
  }
  assert.match(permalink, /import \{ parseEvidenceHash \} from "@\/lib\/report-evidence-navigation"/);
  assert.match(permalink, /if \(autoOpenedRef\.current \|\| !parseEvidenceHash\(window\.location\.hash\)\) return/);
  assert.match(permalink, /void loadEvidenceRef\.current\(\)/);
  assert.match(permalink, /addEventListener\("hashchange", openWhenEvidenceLinked\)/);
  assert.match(permalink, /removeEventListener\("hashchange", openWhenEvidenceLinked\)/);
  // Opening must stay one-shot per report identity, or a failed read would retry
  // itself on every hashchange.
  assert.match(permalink, /autoOpenedRef\.current = false/);
});

test("a Turnstile failure cannot tear down a scan that is still running", () => {
  const controls = source("app/_components/scan-controls.tsx");
  const app = source("app/site-behavior-app.tsx");

  // The widget's error and script-load paths used to reach the shell's
  // surfaceReportOperationError, which sets loading=false. Mid-scan that unmounted
  // the progress region while EmptyState stayed suppressed by activeScanJob, so the
  // results area rendered nothing and the retained job kept polling unseen.
  assert.match(controls, /const \[turnstileError, setTurnstileError\] = useState<string \| null>\(null\)/);
  assert.match(controls, /onError=\{setTurnstileError\}/);
  assert.match(controls, /\{turnstileError && \(/);
  assert.doesNotMatch(app, /onError=\{surfaceReportOperationError\}/);
  // surfaceReportOperationError is the report-open path and keeps that job.
  assert.match(app, /onUploadError=\{surfaceReportOperationError\}/);
});

test("resuming status checks explains a lost lease instead of doing nothing", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const resume = hook.slice(
    hook.indexOf("async function resumeActiveScan"),
    hook.indexOf("async function cancelActiveScan")
  );

  // The banner renders this control whenever an accepted job is retained, so the
  // claim can lose to an in-flight request. It used to return silently, leaving an
  // enabled button that provably could not work.
  assert.match(resume, /if \(operation === null\) \{/);
  assert.match(resume, /Another scan request from this tab is still in flight/);
});
