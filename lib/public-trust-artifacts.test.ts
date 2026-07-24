import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020";
import {
  assertCorrectionsLedgerHistory,
  CORRECTIONS_FUTURE_TOLERANCE_MS,
  correctionsLedgerReportIds,
  isCorrectionsDateTime,
  isCorrectionsDetailsUrl,
  parseCorrectionsLedger,
  reportCorrections
} from "./corrections-ledger";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("the public corrections ledger validates against its published schema", () => {
  const schema = JSON.parse(read("public/corrections.schema.json"));
  const ledger = JSON.parse(read("public/corrections.json"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", isCorrectionsDateTime);
  ajv.addFormat("uri", isCorrectionsDetailsUrl);
  const validate = ajv.compile(schema);

  assert.equal(validate(ledger), true, JSON.stringify(validate.errors));
  const referencedReports = correctionsLedgerReportIds(ledger);
  for (const reportId of referencedReports) {
    assert.equal(existsSync(path.join(root, "public", "reports", `${reportId}.json`)), true, `${reportId} is missing`);
    assert.equal(
      existsSync(path.join(root, "public", "reports", `${reportId}.provenance.json`)),
      true,
      `${reportId} is missing its provenance sidecar`
    );
  }
  assert.equal(ledger.policy, "https://sitebehavior.org/corrections/");

  const validEvent = {
    eventId: "SBL-CORR-2026-001",
    publishedAt: "2026-07-21T12:30:00.000Z",
    state: "corrected",
    reportIds: ["20260720-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    replacementReportIds: ["20260721-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    summary: "A reviewed presentation claim was corrected.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/123"
  };
  const fixture = { ...ledger, entries: [validEvent] };
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  const now = { now: Date.parse("2026-07-21T12:35:00.000Z") };
  const parsed = parseCorrectionsLedger(fixture, now);
  assert.equal(parsed.entries[0]?.state, "corrected");
  assert.deepEqual(parsed.entries[0]?.replacementReportIds, validEvent.replacementReportIds);
  assert.equal(reportCorrections(parsed, validEvent.reportIds[0]).suppressIndexing, true);
  assert.equal(reportCorrections(parsed, validEvent.replacementReportIds[0]).suppressIndexing, false);
  assert.equal(reportCorrections(parsed, validEvent.replacementReportIds[0]).replacementEvents[0]?.eventId, validEvent.eventId);
  assert.deepEqual(
    [...correctionsLedgerReportIds(fixture, now)],
    validEvent.reportIds.concat(validEvent.replacementReportIds)
  );

  assert.equal(validate({ ...fixture, entries: [{ ...validEvent, publishedAt: "2026-02-30T12:30:00Z" }] }), false);
  assert.equal(validate({ ...fixture, entries: [{ ...validEvent, detailsUrl: "https://" }] }), false);
  assert.equal(validate({ ...fixture, entries: [{ ...validEvent, reportIds: ["not-a-report-id"] }] }), false);
});

test("correction dispositions are visible on the ledger and affected report pages", () => {
  const correctionsPage = read("app/corrections/page.tsx");
  const reportPage = read("app/reports/[id]/page.tsx");
  const reportContext = read("app/_components/report-page-context.tsx");
  assert.match(correctionsPage, /Published correction events/);
  assert.match(correctionsPage, /Read the public review record/);
  assert.match(reportPage, /reportCorrections\(correctionsLedger, id\)/);
  assert.match(reportPage, /STATIC_EXPORT && !correction\.suppressIndexing/);
  assert.match(reportPage, /correction\.suppressIndexing[\s\S]*\? null[\s\S]*buildReportDataset/);
  assert.match(reportContext, /Public corrections ledger/);
});

test("corrections ledger semantic validation is ordered, unique, and append-only safe", () => {
  const first = {
    eventId: "SBL-CORR-2026-001",
    publishedAt: "2026-07-21T12:30:00.000Z",
    state: "active",
    reportIds: ["20260720-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    summary: "The original evidence remains active with a clarification.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/123"
  };
  const second = {
    ...first,
    eventId: "SBL-CORR-2026-002",
    publishedAt: "2026-07-22T12:30:00.000Z",
    state: "superseded",
    reportIds: ["20260721-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    supersedesEventId: first.eventId
  };
  const ledger = {
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [first, second]
  };
  const options = { now: Date.parse("2026-07-23T00:00:00.000Z") };

  assert.doesNotThrow(() => correctionsLedgerReportIds(ledger, options));
  assert.throws(
    () => correctionsLedgerReportIds({ ...ledger, entries: [first, { ...second, eventId: "SBL-CORR-2026-003" }] }, options),
    /next sequential ID/
  );
  assert.throws(
    () => correctionsLedgerReportIds({ ...ledger, entries: [second, first] }, options),
    /next sequential ID|earlier than/
  );
  assert.throws(
    () => correctionsLedgerReportIds({ ...ledger, entries: [{ ...first, reportIds: [first.reportIds[0], first.reportIds[0]] }] }, options),
    /must not contain duplicates/
  );
  assert.throws(
    () => correctionsLedgerReportIds({ ...ledger, entries: [{ ...first, unreviewedField: true }] }, options),
    /is not allowed/
  );
  assert.throws(
    () => correctionsLedgerReportIds({
      ...ledger,
      entries: [{ ...first, replacementReportIds: [second.reportIds[0]] }, second]
    }, options),
    /already a replacement report/
  );
  assert.throws(
    () => correctionsLedgerReportIds({
      ...ledger,
      entries: [first, { ...second, replacementReportIds: [first.reportIds[0]] }]
    }, options),
    /already an original report/
  );

  const exactlyAtTolerance = Date.parse(first.publishedAt) - CORRECTIONS_FUTURE_TOLERANCE_MS;
  assert.doesNotThrow(() => parseCorrectionsLedger({ ...ledger, entries: [first] }, { now: exactlyAtTolerance }));
  assert.throws(
    () => parseCorrectionsLedger({ ...ledger, entries: [first] }, { now: exactlyAtTolerance - 1 }),
    /materially in the future/
  );
});

test("corrections history preserves the exact event prefix and pinned bundle bytes", () => {
  const originalId = "20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const replacementId = "20250102-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const first = {
    eventId: "SBL-CORR-2025-001",
    publishedAt: "2025-01-01T12:00:00.000Z",
    state: "corrected",
    reportIds: [originalId],
    replacementReportIds: [replacementId],
    summary: "The first reviewed claim was corrected.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/123"
  };
  const second = {
    eventId: "SBL-CORR-2025-002",
    publishedAt: "2025-01-02T12:00:00.000Z",
    state: "active",
    reportIds: ["20250103-cccccccccccccccccccccccccccccccc"],
    summary: "A separate reviewed clarification was published.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/124"
  };
  const envelope = {
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/"
  };
  const previous = { ...envelope, entries: [first] };
  const current = { ...envelope, entries: [first, second] };
  const originalBundle = { report: Buffer.from("original-report\n"), sidecar: Buffer.from("original-sidecar\n") };
  const replacementBundle = { report: Buffer.from("replacement-report\n"), sidecar: Buffer.from("replacement-sidecar\n") };
  const newBundle = { report: Buffer.from("new-report\n"), sidecar: Buffer.from("new-sidecar\n") };
  const previousBundles = new Map([
    [originalId, originalBundle],
    [replacementId, replacementBundle]
  ]);
  const currentBundles = new Map([
    [originalId, originalBundle],
    [replacementId, replacementBundle],
    [second.reportIds[0], newBundle]
  ]);
  const options = { now: Date.parse("2025-01-03T00:00:00.000Z") };

  assert.doesNotThrow(() =>
    assertCorrectionsLedgerHistory(previous, current, previousBundles, currentBundles, options)
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      { ...current, entries: [{ ...first, summary: "Rewritten history." }, second] },
      previousBundles,
      currentBundles,
      options
    ),
    /entries\[0\] changed/
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(previous, { ...current, entries: [] }, previousBundles, currentBundles, options),
    /entries were removed/
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map(currentBundles).set(originalId, { ...originalBundle, report: Buffer.from("changed-report\n") }),
      options
    ),
    /\.json changed/
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map(currentBundles).set(replacementId, { ...replacementBundle, sidecar: Buffer.from("changed-sidecar\n") }),
      options
    ),
    /\.provenance\.json changed/
  );
  const withoutNewBundle = new Map(currentBundles);
  withoutNewBundle.delete(second.reportIds[0]);
  assert.throws(
    () => assertCorrectionsLedgerHistory(previous, current, previousBundles, withoutNewBundle, options),
    /Current correction-linked report .* is missing/
  );
});

test("the Git history gate fails closed without a base and catches pinned-byte rewrites", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sbl-corrections-history-"));
  const reportId = "20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ledger = {
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [{
      eventId: "SBL-CORR-2025-001",
      publishedAt: "2025-01-01T12:00:00.000Z",
      state: "active",
      reportIds: [reportId],
      summary: "The reviewed evidence remains active.",
      detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/123"
    }]
  };
  const reportPath = path.join(repo, "public", "reports", `${reportId}.json`);
  const ledgerPath = path.join(repo, "public", "corrections.json");
  const cliPath = path.join(root, ".unit-test-dist", "lib", "corrections-ledger-history-cli.js");

  try {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(reportPath, "original-report-bytes\n");
    writeFileSync(path.join(repo, "public", "reports", `${reportId}.provenance.json`), "original-sidecar-bytes\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "public"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Site Behavior Lab", "-c", "user.email=ci@sitebehavior.org", "commit", "-qm", "base"],
      { cwd: repo }
    );

    assert.equal(runHistoryCli(cliPath, repo, "HEAD").status, 0);
    writeFileSync(reportPath, "rewritten-report-bytes\n");
    const rewritten = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(rewritten.status, 1);
    assert.match(rewritten.stderr, /\.json changed/);

    writeFileSync(reportPath, "original-report-bytes\n");
    writeFileSync(ledgerPath, `${JSON.stringify({
      ...ledger,
      entries: [{ ...ledger.entries[0], summary: "Rewritten history." }]
    }, null, 2)}\n`);
    const changedEntry = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(changedEntry.status, 1);
    assert.match(changedEntry.stderr, /entries\[0\] changed/);

    const missingBase = runHistoryCli(cliPath, repo, "does-not-exist");
    assert.equal(missingBase.status, 1);
    assert.match(missingBase.stderr, /refusing to verify because repository or ledger history exists/);

    writeFileSync(ledgerPath, `${JSON.stringify({ ...ledger, entries: [] }, null, 2)}\n`);
    const missingBaseWithEmptyLedger = runHistoryCli(cliPath, repo, "does-not-exist");
    assert.equal(missingBaseWithEmptyLedger.status, 1);
    assert.match(missingBaseWithEmptyLedger.stderr, /repository or ledger history exists/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function runHistoryCli(cliPath: string, cwd: string, base: string) {
  const result = spawnSync(process.execPath, [cliPath, base], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

test("security.txt exposes a direct, canonical, non-expired private reporting path", () => {
  const securityTxt = read("public/.well-known/security.txt");
  assert.match(
    securityTxt,
    /^Contact: https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab\/security\/advisories\/new$/m
  );
  assert.match(securityTxt, /^Canonical: https:\/\/sitebehavior\.org\/\.well-known\/security\.txt$/m);
  assert.match(
    securityTxt,
    /^Policy: https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab\/security\/policy$/m
  );

  const expires = securityTxt.match(/^Expires: (.+)$/m)?.[1] ?? "";
  assert.ok(Number.isFinite(Date.parse(expires)), "security.txt Expires must be an ISO timestamp");
  assert.ok(Date.parse(expires) > Date.now(), "security.txt must be renewed before it expires");
});

test("repository metadata points contributors to the canonical public project", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.homepage, "https://sitebehavior.org");
  assert.equal(packageJson.repository?.url, "git+https://github.com/iAnonymous3000/site-behavior-lab.git");
  assert.equal(packageJson.bugs?.url, "https://github.com/iAnonymous3000/site-behavior-lab/issues");
  assert.ok(read("CONTRIBUTING.md").includes("npm run check"));
  assert.ok(read(".github/CODEOWNERS").includes("@iAnonymous3000"));
});

test("runtime status reads the Pages receipt from the public library, not scanner same-origin", () => {
  const status = read("app/status/live-deployment-status.tsx");
  const nextConfig = read("next.config.mjs");
  const pagesHeaders = read("public/_headers");
  assert.match(status, /STATIC_EXPORT[\s\S]*staticAssetPath\("\/deployment\.json"\)/);
  assert.match(status, /publicLibraryUrl\("\/deployment\.json"\)/);
  assert.match(status, /pagesReceiptUrl: PAGES_RECEIPT_URL/);
  assert.match(status, /runLiveDeploymentStatusCheck/);
  assert.doesNotMatch(status, /fetch\(staticAssetPath\("\/deployment\.json"\)/);
  assert.match(nextConfig, /connect-src 'self' \$\{publicLibraryOrigin\}/);
  assert.match(pagesHeaders, /\/deployment\.json\s+Access-Control-Allow-Origin: \*/);
});
