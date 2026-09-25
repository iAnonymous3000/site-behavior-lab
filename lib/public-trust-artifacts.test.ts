import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initFixtureRepo, runFixtureGit } from "./git-fixture";
import Ajv2020 from "ajv/dist/2020";
import {
  assertCorrectionsLedgerHistory,
  CORRECTIONS_FUTURE_TOLERANCE_MS,
  correctionsLedgerReportIds,
  parsedCorrectionsLedgerPrivacyRemovedReportIds,
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
  // A privacy-superseded original is removed from publication. This set is
  // empty until the first such event is appended; the check is then live.
  for (const reportId of parsedCorrectionsLedgerPrivacyRemovedReportIds(parseCorrectionsLedger(ledger))) {
    assert.equal(referencedReports.has(reportId), false, `${reportId} is removed for privacy and must not be pinned`);
    for (const suffix of [".json", ".provenance.json"]) {
      assert.equal(existsSync(path.join(root, "public", "reports", `${reportId}${suffix}`)), false, `${reportId}${suffix} is still published`);
    }
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

test("every committed correction event links a review record this site builds", () => {
  // An event is permanent once published, so its record must be a stable
  // project page. A file view on a branch can change under the link, and a
  // renamed file or heading breaks it.
  const ledger = parseCorrectionsLedger(JSON.parse(read("public/corrections.json")));
  assert.ok(ledger.entries.length > 0);
  for (const event of ledger.entries) {
    const url = new URL(event.detailsUrl);
    assert.equal(url.origin, "https://sitebehavior.org", event.eventId);
    assert.match(url.pathname, /^\/corrections\/(?:[a-z0-9-]+\/)?$/, event.eventId);
    assert.equal(url.search + url.hash, "", event.eventId);
    const page = path.join("app", ...url.pathname.split("/").filter(Boolean), "page.tsx");
    assert.equal(existsSync(path.join(root, page)), true, `${event.eventId}: ${page}`);
  }
  // The privacy record names its event and the defect class, never a value.
  const privacyPage = read("app/corrections/privacy-replacement/page.tsx");
  for (const event of ledger.entries.filter(entry => entry.state === "privacy-superseded")) {
    assert.equal(event.detailsUrl, "https://sitebehavior.org/corrections/privacy-replacement/");
    assert.ok(privacyPage.includes(event.eventId), event.eventId);
  }
});

test("reports removed for privacy are named as plain IDs, never linked to a page that no longer exists", () => {
  const correctionsPage = read("app/corrections/page.tsx");
  const reportContext = read("app/_components/report-page-context.tsx");
  // Every report link on the ledger page goes through the one reference that
  // checks the removed set, and the new state has its own label rather than
  // falling through to "Evidence withdrawn".
  assert.equal(correctionsPage.match(/href=\{`\/reports\//g)?.length, 1);
  assert.match(correctionsPage, /removedReportIds\.has\(id\)\s*\?\s*<span><code>\{id\}<\/code> \(removed\)<\/span>/);
  assert.match(correctionsPage, /event\.reportIds\.map\(\(id\) => <ReportIdReference/);
  assert.match(correctionsPage, /event\.replacementReportIds\?\.map\(\(id\) => <ReportIdReference/);
  assert.match(correctionsPage, /state === "privacy-superseded"\s*\?\s*"Replaced for privacy"/);
  // A replacement page explains why its original's events apply, naming the
  // removed original as plain text.
  assert.match(reportContext, /corrections\.privacyReplacementOf/);
  assert.match(reportContext, /<code>\{corrections\.privacyReplacementOf\}<\/code>/);
  assert.doesNotMatch(reportContext, /href=\{`\/reports\/\$\{corrections\.privacyReplacementOf/);
});

test("the corrections process and the permalink promise name privacy replacement as the one removal", () => {
  // The process list must not promise that every referenced report stays
  // available while the ledger names two removed originals.
  const correctionsPage = read("app/corrections/page.tsx");
  assert.match(correctionsPage, /active, corrected, superseded, withdrawn, or replaced for privacy/);
  assert.match(correctionsPage, /to remain available, except an original replaced for privacy, which is removed\./);
  assert.match(read("docs/compatibility-promise.md"), /privacy replacement is the one removal of a report the corrections ledger\s+names/);
  // Git history and archives keep the removed bytes, not only digests.
  assert.match(read("docs/corrections-ledger.md"), /Git history and archived releases keep the original's bytes/);
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

const PRIVACY_ORIGINAL_ID = "20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRIVACY_SIBLING_ID = "20250101-cccccccccccccccccccccccccccccccc";
const PRIVACY_REPLACEMENT_ID = "20250101-dddddddddddddddddddddddddddddddd";

/** One clarification over two reports, then a privacy replacement of the first. */
function privacyLedgerFixture() {
  const clarification = {
    eventId: "SBL-CORR-2025-001",
    publishedAt: "2025-01-01T12:00:00.000Z",
    state: "active",
    reportIds: [PRIVACY_ORIGINAL_ID, PRIVACY_SIBLING_ID],
    summary: "A reviewed clarification applies to both reports.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/123"
  };
  const privacy = {
    eventId: "SBL-CORR-2025-002",
    publishedAt: "2025-01-02T12:00:00.000Z",
    state: "privacy-superseded",
    reportIds: [PRIVACY_ORIGINAL_ID],
    replacementReportIds: [PRIVACY_REPLACEMENT_ID],
    summary: "A redacted copy replaced a report that exposed a scanner network address.",
    detailsUrl: "https://github.com/iAnonymous3000/site-behavior-lab/issues/124"
  };
  const envelope = {
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/"
  };
  return { clarification, privacy, envelope, options: { now: Date.parse("2025-01-03T00:00:00.000Z") } };
}

test("a privacy-superseded event pairs each removed original with one redacted replacement", () => {
  const { clarification, privacy, envelope, options } = privacyLedgerFixture();
  const schema = JSON.parse(read("public/corrections.schema.json"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", isCorrectionsDateTime);
  ajv.addFormat("uri", isCorrectionsDetailsUrl);
  const validate = ajv.compile(schema);
  const ledger = { ...envelope, entries: [clarification, privacy] };
  const { replacementReportIds: _omitted, ...unreplaced } = privacy;

  assert.equal(validate(ledger), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...ledger, entries: [clarification, unreplaced] }), false);
  assert.equal(validate({ ...ledger, entries: [clarification, { ...privacy, replacementReportIds: [] }] }), false);
  assert.doesNotThrow(() => parseCorrectionsLedger(ledger, options));

  // The pin set drops the removed original and keeps its replacement.
  assert.deepEqual(
    [...correctionsLedgerReportIds(ledger, options)].sort(),
    [PRIVACY_SIBLING_ID, PRIVACY_REPLACEMENT_ID].sort()
  );
  assert.deepEqual([...parsedCorrectionsLedgerPrivacyRemovedReportIds(parseCorrectionsLedger(ledger, options))], [PRIVACY_ORIGINAL_ID]);

  assert.throws(
    () => parseCorrectionsLedger({ ...ledger, entries: [clarification, unreplaced] }, options),
    /must pair one replacement with each privacy-superseded report/
  );
  assert.throws(
    () => parseCorrectionsLedger({
      ...ledger,
      entries: [clarification, { ...privacy, reportIds: [PRIVACY_ORIGINAL_ID, PRIVACY_SIBLING_ID] }]
    }, options),
    /must pair one replacement with each privacy-superseded report/
  );
  const second = {
    ...privacy,
    eventId: "SBL-CORR-2025-003",
    publishedAt: "2025-01-02T13:00:00.000Z",
    replacementReportIds: ["20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]
  };
  assert.throws(
    () => parseCorrectionsLedger({ ...ledger, entries: [clarification, privacy, second] }, options),
    /already removed for privacy/
  );
  assert.throws(
    () => parseCorrectionsLedger({
      ...ledger,
      entries: [clarification, privacy, { ...second, reportIds: [PRIVACY_SIBLING_ID], replacementReportIds: [PRIVACY_REPLACEMENT_ID] }]
    }, options),
    /a privacy replacement belongs to one event only/
  );
  assert.throws(
    () => parseCorrectionsLedger({
      ...ledger,
      entries: [clarification, privacy, { ...second, state: "corrected", reportIds: [PRIVACY_SIBLING_ID], replacementReportIds: [PRIVACY_REPLACEMENT_ID] }]
    }, options),
    /a privacy replacement belongs to one event only/
  );
  const earlierReplacement = {
    ...clarification,
    state: "corrected",
    reportIds: [PRIVACY_SIBLING_ID],
    replacementReportIds: [PRIVACY_REPLACEMENT_ID]
  };
  assert.throws(
    () => parseCorrectionsLedger({ ...ledger, entries: [earlierReplacement, privacy] }, options),
    /a privacy replacement belongs to one event only/
  );
});

test("a privacy replacement inherits the correction events recorded against its removed original", () => {
  const { clarification, privacy, envelope, options } = privacyLedgerFixture();
  const ledger = parseCorrectionsLedger({ ...envelope, entries: [clarification, privacy] }, options);

  const replacement = reportCorrections(ledger, PRIVACY_REPLACEMENT_ID);
  assert.deepEqual(replacement.subjectEvents.map(event => event.eventId), [clarification.eventId]);
  assert.equal(replacement.currentSubjectEvent?.eventId, clarification.eventId);
  assert.deepEqual(replacement.replacementEvents.map(event => event.eventId), [privacy.eventId]);
  assert.equal(replacement.suppressIndexing, false);
  assert.equal(replacement.privacyReplacementOf, PRIVACY_ORIGINAL_ID);

  // The removed original's own latest disposition is the privacy removal.
  const original = reportCorrections(ledger, PRIVACY_ORIGINAL_ID);
  assert.equal(original.currentSubjectEvent?.eventId, privacy.eventId);
  assert.equal(original.suppressIndexing, true);
  assert.equal("privacyReplacementOf" in original, false);

  // Every other report keeps its exact exported correction context bytes: the
  // new key appears only on a privacy replacement.
  const sibling = reportCorrections(ledger, PRIVACY_SIBLING_ID);
  assert.deepEqual(Object.keys(sibling), ["subjectEvents", "replacementEvents", "currentSubjectEvent", "suppressIndexing"]);
  assert.deepEqual(Object.keys(reportCorrections(ledger, "")), ["subjectEvents", "replacementEvents", "currentSubjectEvent", "suppressIndexing"]);
  assert.equal(JSON.parse(JSON.stringify(replacement)).privacyReplacementOf, PRIVACY_ORIGINAL_ID);

  // A later event naming the original still follows the measurement, in
  // ledger order, and moves the replacement's current disposition.
  const withdrawal = {
    ...clarification,
    eventId: "SBL-CORR-2025-003",
    publishedAt: "2025-01-02T13:00:00.000Z",
    state: "withdrawn",
    reportIds: [PRIVACY_ORIGINAL_ID],
    summary: "The measurement no longer supports its claim."
  };
  const withdrawn = reportCorrections(
    parseCorrectionsLedger({ ...envelope, entries: [clarification, privacy, withdrawal] }, options),
    PRIVACY_REPLACEMENT_ID
  );
  assert.deepEqual(withdrawn.subjectEvents.map(event => event.eventId), [clarification.eventId, withdrawal.eventId]);
  assert.equal(withdrawn.currentSubjectEvent?.state, "withdrawn");
  assert.equal(withdrawn.suppressIndexing, true);

  // A corrected replacement is new evidence, not the same measurement, and
  // inherits nothing.
  const corrected = { ...privacy, state: "corrected" };
  const correctedReplacement = reportCorrections(
    parseCorrectionsLedger({ ...envelope, entries: [clarification, corrected] }, options),
    PRIVACY_REPLACEMENT_ID
  );
  assert.deepEqual(correctedReplacement.subjectEvents, []);
  assert.equal("privacyReplacementOf" in correctedReplacement, false);
});

test("corrections history accepts only the privacy removal of a pinned bundle", () => {
  const { clarification, privacy, envelope, options } = privacyLedgerFixture();
  const previous = { ...envelope, entries: [clarification] };
  const current = { ...envelope, entries: [clarification, privacy] };
  const originalBundle = { report: Buffer.from("original-report\n"), sidecar: Buffer.from("original-sidecar\n") };
  const siblingBundle = { report: Buffer.from("sibling-report\n"), sidecar: Buffer.from("sibling-sidecar\n") };
  const replacementBundle = { report: Buffer.from("redacted-report\n"), sidecar: Buffer.from("redacted-sidecar\n") };
  const previousBundles = new Map([
    [PRIVACY_ORIGINAL_ID, originalBundle],
    [PRIVACY_SIBLING_ID, siblingBundle]
  ]);
  const currentBundles = new Map([
    [PRIVACY_SIBLING_ID, siblingBundle],
    [PRIVACY_REPLACEMENT_ID, replacementBundle]
  ]);

  assert.doesNotThrow(() => assertCorrectionsLedgerHistory(previous, current, previousBundles, currentBundles, options));
  // Once the removal is history, the next change verifies without the original.
  assert.doesNotThrow(() => assertCorrectionsLedgerHistory(
    current,
    current,
    new Map([[PRIVACY_SIBLING_ID, siblingBundle], [PRIVACY_REPLACEMENT_ID, replacementBundle]]),
    currentBundles,
    options
  ));

  // A privacy event never admits a changed bundle (M12), report or sidecar.
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map(currentBundles).set(PRIVACY_ORIGINAL_ID, { ...originalBundle, report: Buffer.from("redacted-in-place\n") }),
      options
    ),
    new RegExp(`Correction-linked report ${PRIVACY_ORIGINAL_ID}\\.json changed`)
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map(currentBundles).set(PRIVACY_ORIGINAL_ID, { ...originalBundle, sidecar: Buffer.from("rewritten-sidecar\n") }),
      options
    ),
    new RegExp(`Correction-linked report ${PRIVACY_ORIGINAL_ID}\\.provenance\\.json changed`)
  );
  // Nor does it leave the original published, even byte-identical.
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map(currentBundles).set(PRIVACY_ORIGINAL_ID, originalBundle),
      options
    ),
    new RegExp(`Privacy-superseded report ${PRIVACY_ORIGINAL_ID} is still published`)
  );
  // A removal with no replacement: the event is refused, and so is an event
  // whose replacement bundle is absent.
  const { replacementReportIds: _omitted, ...unreplaced } = privacy;
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      { ...current, entries: [clarification, unreplaced] },
      previousBundles,
      currentBundles,
      options
    ),
    /must pair one replacement with each privacy-superseded report/
  );
  const withoutReplacement = new Map(currentBundles);
  withoutReplacement.delete(PRIVACY_REPLACEMENT_ID);
  assert.throws(
    () => assertCorrectionsLedgerHistory(previous, current, previousBundles, withoutReplacement, options),
    new RegExp(`Current correction-linked report ${PRIVACY_REPLACEMENT_ID} is missing`)
  );
  // A removal with no privacy event, including one covered only by an
  // ordinary superseded event that also names a replacement: the original is
  // still pinned, so its absence is refused.
  assert.throws(
    () => assertCorrectionsLedgerHistory(previous, previous, previousBundles, new Map([[PRIVACY_SIBLING_ID, siblingBundle]]), options),
    new RegExp(`Current correction-linked report ${PRIVACY_ORIGINAL_ID} is missing`)
  );
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      { ...current, entries: [clarification, { ...privacy, state: "superseded" }] },
      previousBundles,
      currentBundles,
      options
    ),
    new RegExp(`Current correction-linked report ${PRIVACY_ORIGINAL_ID} is missing`)
  );
  // The event covers only the ids it names: removing another pinned report in
  // the same change is still refused.
  assert.throws(
    () => assertCorrectionsLedgerHistory(
      previous,
      current,
      previousBundles,
      new Map([[PRIVACY_REPLACEMENT_ID, replacementBundle]]),
      options
    ),
    new RegExp(`Current correction-linked report ${PRIVACY_SIBLING_ID} is missing`)
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
    initFixtureRepo(repo, {
      name: "Site Behavior Lab",
      email: "ci@sitebehavior.org"
    });
    runFixtureGit(repo, ["add", "public"]);
    runFixtureGit(repo, ["commit", "-qm", "base"]);

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

test("the Git history gate accepts a privacy replacement's removal and still catches a rewritten original", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sbl-corrections-privacy-"));
  const { clarification, privacy, envelope } = privacyLedgerFixture();
  const reportsDir = path.join(repo, "public", "reports");
  const ledgerPath = path.join(repo, "public", "corrections.json");
  const cliPath = path.join(root, ".unit-test-dist", "lib", "corrections-ledger-history-cli.js");
  const bundlePath = (reportId: string, suffix: string) => path.join(reportsDir, `${reportId}${suffix}`);
  const writeLedger = (entries: readonly object[]) =>
    writeFileSync(ledgerPath, `${JSON.stringify({ ...envelope, entries }, null, 2)}\n`);

  try {
    mkdirSync(reportsDir, { recursive: true });
    writeLedger([clarification]);
    for (const reportId of [PRIVACY_ORIGINAL_ID, PRIVACY_SIBLING_ID]) {
      writeFileSync(bundlePath(reportId, ".json"), `${reportId}-report\n`);
      writeFileSync(bundlePath(reportId, ".provenance.json"), `${reportId}-sidecar\n`);
    }
    initFixtureRepo(repo, {
      name: "Site Behavior Lab",
      email: "ci@sitebehavior.org"
    });
    runFixtureGit(repo, ["add", "public"]);
    runFixtureGit(repo, ["commit", "-qm", "base"]);

    writeLedger([clarification, privacy]);
    rmSync(bundlePath(PRIVACY_ORIGINAL_ID, ".json"));
    rmSync(bundlePath(PRIVACY_ORIGINAL_ID, ".provenance.json"));
    writeFileSync(bundlePath(PRIVACY_REPLACEMENT_ID, ".json"), "redacted-report\n");
    writeFileSync(bundlePath(PRIVACY_REPLACEMENT_ID, ".provenance.json"), "redacted-sidecar\n");
    const replaced = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /1 pinned bundle is unchanged; 1 privacy-superseded bundle was removed\./);

    // The CLI still reads an original the event removed from the pin set.
    writeFileSync(bundlePath(PRIVACY_ORIGINAL_ID, ".json"), "redacted-in-place\n");
    writeFileSync(bundlePath(PRIVACY_ORIGINAL_ID, ".provenance.json"), `${PRIVACY_ORIGINAL_ID}-sidecar\n`);
    const rewritten = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(rewritten.status, 1);
    assert.match(rewritten.stderr, new RegExp(`${PRIVACY_ORIGINAL_ID}\\.json changed`));

    writeFileSync(bundlePath(PRIVACY_ORIGINAL_ID, ".json"), `${PRIVACY_ORIGINAL_ID}-report\n`);
    const stillPublished = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(stillPublished.status, 1);
    assert.match(stillPublished.stderr, /is still published/);

    rmSync(bundlePath(PRIVACY_ORIGINAL_ID, ".json"));
    const halfRemoved = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(halfRemoved.status, 1);
    assert.match(halfRemoved.stderr, new RegExp(`ENOENT.*${PRIVACY_ORIGINAL_ID}\\.json`));

    // Without the privacy event the original is still pinned, so its absence
    // fails the working-tree read.
    rmSync(bundlePath(PRIVACY_ORIGINAL_ID, ".provenance.json"));
    writeLedger([clarification]);
    const unexplained = runHistoryCli(cliPath, repo, "HEAD");
    assert.equal(unexplained.status, 1);
    assert.match(unexplained.stderr, new RegExp(`ENOENT.*${PRIVACY_ORIGINAL_ID}\\.json`));
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

// CONTRIBUTING.md told contributors to run `npm install`. With npm 11.11.0 that
// rewrites package-lock.json without its root packageManager field, so the
// release-evidence and toolchain-provenance tests went red on an otherwise
// clean tree, while the README and every workflow install with `npm ci`.
test("the contributor guide installs with npm ci on the pinned toolchain", () => {
  const contributing = read("CONTRIBUTING.md");
  const engines = JSON.parse(read("package.json")).engines as { node: string; npm: string };
  assert.ok(contributing.includes(`Node.js ${engines.node}`), "CONTRIBUTING must name the pinned Node version");
  assert.ok(contributing.includes(`npm ${engines.npm}`), "CONTRIBUTING must name the pinned npm version");
  assert.match(contributing, /Install dependencies with `npm ci`/);
  assert.doesNotMatch(
    contributing.split("Do not use `npm install`").join(""),
    /\bnpm install\b/,
    "CONTRIBUTING may name npm install only to warn against it"
  );
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
