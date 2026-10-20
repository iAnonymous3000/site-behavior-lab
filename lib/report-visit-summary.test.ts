import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { CONSENT_RELOAD_DISCLOSURE } from "./consent-verification";
import { loadCommittedCorpusStats } from "./current-scan-cohort";
import { publicStringPolicyInputs, redactScanReportV1, redactScanResultV1 } from "./redact-scan-report-v1";
import { consentVerificationSummary } from "./report-consent-copy";
import { findingCardDomId, renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts, REPORT_CLAIM_REQUIREMENTS } from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import {
  AFTER_FURTHER_INTERACTION_CLAUSE,
  AFTER_INTERACTION_CLAUSE,
  CATALOG_BIAS_CLAUSE,
  CLOUDFLARE_NO_INTERACTION_CLAUSE,
  FIXED_PROFILE_CLAUSE,
  LOWER_BOUND_SENTENCE_START,
  NO_INTERACTION_CLAUSE,
  OTHER_VISITORS_CLAUSE,
  POLICY_READ_DISCLOSURE,
  SCANNER_EGRESS_READER_PHRASES,
  SCRIPTED_CHOICE_CLAUSES,
  TYPED_FIELDS_DISCLOSURE,
  VISIT_CHECK_LABELS,
  buildReportVisitSummary,
  visitLimitText,
  type ReportVisitSummary
} from "./report-visit-summary";
import { readStoredScanReport } from "./scan-report-reader";
import { makeConsentInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { toReportView, viewFromV1Report, viewFromV2, type ReportView } from "./scan-report-views";
import { PUBLIC_SCANNER_EGRESS_LABELS } from "./scanner-egress";
import type { ScanReport, ScanResult } from "./types";

/**
 * The lists a report's board states directly after its bottom line. Inputs
 * are built the way the scanner writes them and pass through the real public
 * sanitizer, which replaces any warning it does not admit, so a test that
 * hand-wrote a sentence the scanner never produces would read "[redacted
 * warning]" and fail here.
 */

const FIXED_WARNINGS: readonly string[] = publicStringPolicyInputs().fixedWarnings;

function fixedWarning(start: string): string {
  const warning = FIXED_WARNINGS.find((candidate) => candidate.startsWith(start));
  if (!warning) throw new Error(`no admitted warning starts with ${JSON.stringify(start)}`);
  return warning;
}

const OBSERVE_LIMITS = fixedWarning(
  "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking, or consent interaction."
);
const OBSERVE_COUNTS = fixedWarning("Counts are a lower bound: trackers that load only after interaction or consent are not observed;");
const FINGERPRINT_FRAME_LOSS = fixedWarning("The in-page fingerprint observer could not read one or more frames");

/** The scanner's current typing disclosure (lib/scanner.ts addKeystrokeProbeDisclosure). */
function typingDisclosure(fields: number): string {
  return `This scan typed a synthetic test value into ${fields === 1 ? "1 form field" : `${fields} form fields`} with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured.`;
}

/** The older disclosure committed v1 reports carry. */
function legacyTypingDisclosure(fields: number): string {
  return `This scan typed a synthetic test value into ${fields === 1 ? "1 form field" : `${fields} form fields`} (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored.`;
}

function v1Result(warnings: string[], overrides: { gpcEnabled?: boolean; status?: number; scannerEgress?: string } = {}): ScanResult {
  const result = makeScanReportV1() as ScanResult;
  result.warnings = [...warnings];
  result.conditions = {
    ...result.conditions,
    gpcEnabled: overrides.gpcEnabled ?? false,
    scannerEgress: overrides.scannerEgress ?? "github-actions-ubuntu"
  };
  if (overrides.status !== undefined) result.summary.status = overrides.status;
  return result;
}

/** Through the sanitizer, as every published v1 report went. */
function publishedV1View(report: ScanReport): ReportView {
  return viewFromV1Report(redactScanReportV1(report).report);
}

function shieldsPair(baseline: ScanResult, variant: ScanResult) {
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00.000Z" };
  baseline.conditions = { ...baseline.conditions, shieldsMode: "classification" as const, adblock: { ...adblock } };
  variant.conditions = { ...variant.conditions, shieldsMode: "block-simulation" as const, adblock: { ...adblock } };
  return createShieldsComparisonReport(baseline, variant);
}

/** The summary the permalink renders for this view. */
function summaryFor(view: ReportView): ReportVisitSummary {
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  const evidenceArm = renderedEvidenceArm(view, headline);
  return buildReportVisitSummary({ view, facts, findings: buildFindings(view, null, facts, evidenceArm), evidenceArm });
}

function fact(summary: ReportVisitSummary, term: string): string {
  const row = summary.checked.find((entry) => entry.term === term);
  assert.ok(row, `no ${term} fact`);
  return row.text;
}

function limitIds(summary: ReportVisitSummary): string[] {
  return summary.limits.map((limit) => limit.id);
}

test("a single report states its setup, visits, interactions and outcome from what it recorded", () => {
  const summary = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS, OBSERVE_COUNTS, typingDisclosure(2)])));
  assert.equal(summary.checkedTitle, "What was checked");
  assert.deepEqual(summary.checked.map((entry) => entry.term), ["Page", "When", "Setup", "Visits", "Interactions", "Outcome"]);
  assert.equal(fact(summary, "Page"), "https://example.com/");
  assert.equal(fact(summary, "When"), "Jul 9, 2026, 10:00 AM UTC");
  assert.equal(
    fact(summary, "Setup"),
    "Headless Chromium in a desktop window of 1440 × 980, with en-US language and UTC time zone. " +
      "It ran from a GitHub Actions Ubuntu runner; the network region was not recorded. " +
      "It did not send the Global Privacy Control (GPC) signal."
  );
  assert.equal(fact(summary, "Visits"), "One visit.");
  assert.equal(
    fact(summary, "Interactions"),
    "Typed a made-up test value into 2 form fields, never submitting the form. No scrolling, clicking or consent interaction."
  );
  assert.equal(fact(summary, "Outcome"), "The visit completed.");
  assert.equal(summary.limitsTitle, "What this visit could not see");
  assert.deepEqual(limitIds(summary), ["other-pages", "other-visitors", "after-interaction", "catalog"]);
});

test("the older typing disclosure reads the same, and a GPC visit says it sent the signal", () => {
  const summary = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS, legacyTypingDisclosure(1)], { gpcEnabled: true })));
  assert.match(fact(summary, "Interactions"), /^Typed a made-up test value into 1 form field, never submitting the form\./);
  assert.match(fact(summary, "Setup"), /It sent the Global Privacy Control \(GPC\) signal\.$/);
});

test("a visit with no typing disclosure says no typing was recorded, never that the page had no form fields", () => {
  // The scanner writes the disclosure only when it typed into a field: a zero
  // count writes nothing, and reports from before the probe carry no line.
  // Absence of the line is therefore not evidence about the page's fields.
  const summary = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS, OBSERVE_COUNTS])));
  const interactions = fact(summary, "Interactions");
  assert.match(interactions, /^No typing was recorded\./);
  for (const text of [...summary.checked.map((entry) => entry.text), ...summary.limits.map(visitLimitText)]) {
    assert.doesNotMatch(text, /no (?:form )?fields?|had no form|without form fields/i, text);
  }
});

test("each standing limit renders only when every visit carries the warning that states it", () => {
  const bare = summaryFor(publishedV1View(v1Result([])));
  assert.deepEqual(limitIds(bare), ["other-pages"], "no warning, no borrowed limit");
  assert.doesNotMatch(fact(bare, "Interactions"), /No scrolling/, "no restraint sentence without the scanner's own");

  const limitsOnly = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS])));
  assert.deepEqual(limitIds(limitsOnly), ["other-pages", "other-visitors"]);
  const other = limitsOnly.limits.find((limit) => limit.id === "other-visitors")!;
  assert.equal(
    visitLimitText(other),
    "Signed-in visitors, other browsers and other regions. This was one automated visit from a fixed en-US / UTC profile. " +
      "Sites can behave differently for real users, browsers, regions, accounts, or network locations."
  );

  const countsOnly = summaryFor(publishedV1View(v1Result([OBSERVE_COUNTS])));
  assert.deepEqual(limitIds(countsOnly), ["other-pages", "after-interaction", "catalog"]);
});

test("the privacy-policy read is disclosed beside the one-page limit only when the scanner recorded one", () => {
  const policy =
    "Read the site's privacy policy (https://example.com/privacy) and compared its text against this visit's observed behavior. Policy checks are an automated text match with the matched sentences quoted, not a legal reading.";
  const read = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS, policy])));
  const pages = read.limits.find((limit) => limit.id === "other-pages")!;
  assert.match(visitLimitText(pages), /The privacy policy was opened only to read its text, and none of its activity was recorded\.$/);
  const unread = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS])));
  assert.doesNotMatch(visitLimitText(unread.limits.find((limit) => limit.id === "other-pages")!), /privacy policy/);
});

test("a comparison names what differed and words setup and typing per visit where the visits differ", () => {
  const view = publishedV1View(
    shieldsPair(
      v1Result([OBSERVE_LIMITS, OBSERVE_COUNTS, typingDisclosure(2)], { gpcEnabled: true }),
      v1Result([OBSERVE_LIMITS, OBSERVE_COUNTS, typingDisclosure(1)], { gpcEnabled: true })
    )
  );
  const summary = summaryFor(view);
  assert.equal(summary.limitsTitle, "What these visits could not see");
  assert.equal(fact(summary, "Visits"), "Two visits configured to differ in Brave-list blocking: No blocking and Brave-list blocking.");
  assert.match(fact(summary, "Setup"), /^Both visits used headless Chromium in a desktop window of 1440 × 980/);
  assert.match(fact(summary, "Setup"), /Both sent the Global Privacy Control \(GPC\) signal\.$/);
  assert.equal(
    fact(summary, "Interactions"),
    "Typed a made-up test value into 2 form fields in the No blocking visit and 1 form field in the Brave-list blocking visit, never submitting the form. " +
      "No scrolling, clicking or consent interaction."
  );
  assert.equal(fact(summary, "Outcome"), "Both visits completed.");
  // The visit-order line stays in the headline footer; stating it here too
  // would print it twice once the explorer opens beside this block.
  for (const entry of summary.checked) assert.doesNotMatch(entry.text, /Ran first|Started first/);

  const oneTyped = summaryFor(
    publishedV1View(shieldsPair(v1Result([OBSERVE_LIMITS, typingDisclosure(3)]), v1Result([OBSERVE_LIMITS])))
  );
  assert.match(
    fact(oneTyped, "Interactions"),
    /^Typed a made-up test value into 3 form fields in the No blocking visit, never submitting the form; no typing was recorded in the Brave-list blocking visit\./
  );
});

test("a GPC comparison states the signal as what differed, not as setup", () => {
  const baseline = v1Result([OBSERVE_LIMITS], { gpcEnabled: false });
  const variant = v1Result([OBSERVE_LIMITS], { gpcEnabled: true });
  const summary = summaryFor(publishedV1View(createGpcComparisonReport(baseline, variant)));
  assert.equal(
    fact(summary, "Visits"),
    "Two visits configured to differ in the Global Privacy Control (GPC) signal: GPC off and GPC on."
  );
  assert.doesNotMatch(fact(summary, "Setup"), /GPC/);
});

test("a consent visit says it clicked only where a control was activated", () => {
  const verified = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const [accept, reject] = verified.runs.map((run) => run.consent!);
  assert.ok(accept.controlActivated && reject.controlActivated && accept.cmp === reject.cmp, "fixture invariant");
  const banner = accept.cmp ? `the ${accept.cmp} banner` : "the cookie banner";
  assert.ok(
    fact(summaryFor(verified), "Interactions").includes(
      `Clicked "Accept all" on ${banner} in one visit and "Reject all" in the other (${consentVerificationSummary(accept)} in both).`
    ),
    fact(summaryFor(verified), "Interactions")
  );

  const unactivated = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  for (const run of unactivated.runs) run.consent!.controlActivated = false;
  const asked = fact(summaryFor(unactivated), "Interactions");
  assert.doesNotMatch(asked, /Clicked/);
  assert.match(
    asked,
    /Asked to choose "Accept all" on a cookie banner in one visit and "Reject all" in the other; no activated choice was recorded in either\./
  );

  // Different outcomes are stated per visit, and only the activated one clicks.
  const mixed = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  mixed.runs[1].consent!.controlActivated = false;
  const perVisit = fact(summaryFor(mixed), "Interactions");
  assert.match(perVisit, /Clicked "Accept all" on [^.]+ in the [^.]+ visit \([^)]+\)\./);
  assert.match(perVisit, /Asked to choose "Reject all" on a cookie banner in the [^.;]+ visit; no activated choice was recorded\./);
  assert.doesNotMatch(perVisit, /Clicked "Reject all"/);
});

test("two visits that lost every check say so once", () => {
  // The scanner's own cap line (lib/scan-runtime.ts); a capped v1 visit
  // censors every evidence family.
  const capped = () => v1Result([OBSERVE_LIMITS, "The scan stopped recording or loading additional requests after 1000 requests."]);
  const summary = summaryFor(publishedV1View(shieldsPair(capped(), capped())));
  const item = summary.limits.find((limit) => limit.id === "incomplete-checks");
  assert.ok(item);
  assert.equal(
    visitLimitText(item),
    "Checks with incomplete evidence. In both visits: every check. Every card below states only what was retained."
  );
  assert.equal(fact(summary, "Outcome"), "Both visits completed, but some evidence was cut short.");
});

test("the consent reload is stated only from the scanner's own disclosure", () => {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  for (const run of view.runs) run.warnings = run.warnings.filter((warning) => warning !== CONSENT_RELOAD_DISCLOSURE);
  assert.doesNotMatch(fact(summaryFor(view), "Interactions"), /Reloaded/);
  for (const run of view.runs) run.warnings.push(CONSENT_RELOAD_DISCLOSURE);
  assert.match(fact(summaryFor(view), "Interactions"), /Reloaded the page once after each click to read the registered choice\./);
});

test("the page names where the visit landed when that is not the address it requested", () => {
  const stayed = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS])));
  assert.equal(fact(stayed, "Page"), "https://example.com/");

  const redirected = v1Result([OBSERVE_LIMITS]);
  redirected.conditions = { ...redirected.conditions, finalUrl: "https://example.com/en" };
  assert.equal(
    fact(summaryFor(publishedV1View(redirected)), "Page"),
    "Requested https://example.com/; the visit landed on https://example.com/en"
  );

  // Both visits of a pair landing alike state it once; otherwise per visit.
  const moved = () => {
    const result = v1Result([OBSERVE_LIMITS]);
    result.conditions = { ...result.conditions, finalUrl: "https://example.com/en" };
    return result;
  };
  assert.equal(
    fact(summaryFor(publishedV1View(shieldsPair(moved(), moved()))), "Page"),
    "Requested https://example.com/; both visits landed on https://example.com/en"
  );
  assert.equal(
    fact(summaryFor(publishedV1View(shieldsPair(moved(), v1Result([OBSERVE_LIMITS])))), "Page"),
    "Requested https://example.com/; the No blocking visit landed on https://example.com/en and the Brave-list blocking visit stayed on it"
  );

  // A landing the sanitizer redacted reads in the header's reader form, never
  // as its stored "{seg}" tokens.
  const sanitized = () => {
    const result = v1Result([OBSERVE_LIMITS]);
    result.conditions = { ...result.conditions, finalUrl: "https://example.com/session/9f8e7d6c5b4a39281706f5e4d3c2b1a0" };
    return result;
  };
  assert.equal(
    fact(summaryFor(publishedV1View(sanitized())), "Page"),
    "Requested https://example.com/; the visit landed on https://example.com/…"
  );
  assert.equal(
    fact(summaryFor(publishedV1View(shieldsPair(sanitized(), sanitized()))), "Page"),
    "Requested https://example.com/; both visits landed on https://example.com/…"
  );
});

test("the outcome says when a visit failed or was cut short", () => {
  assert.equal(fact(summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS], { status: 403 }))), "Outcome"), "The visit did not complete (HTTP 403).");
  const cutShort = summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS, FINGERPRINT_FRAME_LOSS])));
  assert.equal(fact(cutShort, "Outcome"), "The visit completed, but some evidence was cut short.");
  // A single visit names its checks the way a pair names each visit's.
  const item = cutShort.limits.find((limit) => limit.id === "incomplete-checks");
  assert.ok(item);
  assert.match(visitLimitText(item), /^Checks with incomplete evidence\. In this visit: [^.]*fingerprinting/);
});

test("incomplete checks link only to cards the board renders, for the visit the board describes", () => {
  // The board describes the No blocking visit of a Shields pair.
  const baselineLoss = publishedV1View(
    shieldsPair(v1Result([OBSERVE_LIMITS, FINGERPRINT_FRAME_LOSS]), v1Result([OBSERVE_LIMITS]))
  );
  const facts = buildReportFacts(baselineLoss);
  const headline = buildReportHeadline(baselineLoss, facts);
  const evidenceArm = renderedEvidenceArm(baselineLoss, headline);
  assert.equal(evidenceArm, "baseline", "fixture invariant");
  const findings = buildFindings(baselineLoss, null, facts, evidenceArm);
  const onBoard = buildReportVisitSummary({ view: baselineLoss, facts, findings, evidenceArm });
  const item = onBoard.limits.find((limit) => limit.id === "incomplete-checks");
  assert.ok(item, "a cut-short visit lists its incomplete checks");
  assert.match(visitLimitText(item), /^Checks with incomplete evidence\. In the No blocking visit only: [^.]*fingerprinting/);
  const linked = item.body.filter((segment) => segment.cardId);
  assert.ok(linked.length > 0, "the affected card on the board is linked");
  for (const segment of linked) {
    const findingId = segment.cardId!.replace(/^finding-/, "");
    assert.ok(findings.some((finding) => finding.id === findingId), `${segment.cardId} is not a card on this board`);
    assert.equal(segment.cardId, findingCardDomId(findingId));
  }
  assert.match(visitLimitText(item), /Each linked card states what was retained\.$/);

  // The same loss in the other visit names the checks but links no card:
  // the cards describe the No blocking visit, which lost nothing.
  const variantLoss = publishedV1View(
    shieldsPair(v1Result([OBSERVE_LIMITS]), v1Result([OBSERVE_LIMITS, FINGERPRINT_FRAME_LOSS]))
  );
  const offBoard = summaryFor(variantLoss).limits.find((limit) => limit.id === "incomplete-checks");
  assert.ok(offBoard);
  assert.match(visitLimitText(offBoard), /In the Brave-list blocking visit only: /);
  assert.equal(offBoard.body.filter((segment) => segment.cardId).length, 0);
  assert.doesNotMatch(visitLimitText(offBoard), /linked card/);

  // A clean visit lists none.
  assert.equal(
    summaryFor(publishedV1View(v1Result([OBSERVE_LIMITS]))).limits.some((limit) => limit.id === "incomplete-checks"),
    false
  );
});

test("the clauses the summary restates are the scanner's admitted words", () => {
  for (const clause of [
    NO_INTERACTION_CLAUSE,
    ...SCRIPTED_CHOICE_CLAUSES,
    CLOUDFLARE_NO_INTERACTION_CLAUSE,
    FIXED_PROFILE_CLAUSE,
    OTHER_VISITORS_CLAUSE,
    AFTER_INTERACTION_CLAUSE,
    AFTER_FURTHER_INTERACTION_CLAUSE,
    CATALOG_BIAS_CLAUSE,
    CONSENT_RELOAD_DISCLOSURE
  ]) {
    assert.ok(FIXED_WARNINGS.some((warning) => warning.includes(clause)), `no admitted warning carries ${JSON.stringify(clause)}`);
  }
  assert.ok(FIXED_WARNINGS.some((warning) => warning.startsWith(LOWER_BOUND_SENTENCE_START)));
  for (const disclosure of [typingDisclosure(1), typingDisclosure(4), legacyTypingDisclosure(2)]) {
    const [published] = (redactScanResultV1(v1Result([disclosure])).report as ScanResult).warnings;
    assert.equal(published, disclosure, "the sanitizer admits the disclosure as written");
    assert.match(published, TYPED_FIELDS_DISCLOSURE);
  }
  assert.match(
    "Read the site's privacy policy (https://example.com/{seg}) and compared its text against this visit's observed behavior. Policy checks are an automated text match with the matched sentences quoted, not a legal reading.",
    POLICY_READ_DISCLOSURE
  );
});

test("where a visit ran from is named in words for every admitted egress label", () => {
  const admitted = publicStringPolicyInputs().scannerEgress;
  assert.deepEqual([...admitted].sort(), [...PUBLIC_SCANNER_EGRESS_LABELS].sort());
  for (const label of admitted) {
    assert.ok(Object.hasOwn(SCANNER_EGRESS_READER_PHRASES, label), `${label} has no reader phrase`);
    const summary = summaryFor(publishedV1View(v1Result([], { scannerEgress: label })));
    const setup = fact(summary, "Setup");
    assert.ok(setup.includes(`It ran from ${SCANNER_EGRESS_READER_PHRASES[label as keyof typeof SCANNER_EGRESS_READER_PHRASES]};`), setup);
    if (label.includes("-")) assert.ok(!setup.includes(label), `${label} rendered raw`);
  }
});

test("the board states the summary right after its bottom line, and the header keeps its place", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const context = source("app/_components/report-page-context.tsx");
  const header = context.slice(context.indexOf('<header className="report-identity">'), context.indexOf("</header>"));
  // The verdict keeps the place it had: the header gains nothing, and loses
  // only its machine-worded quality line, whose "recorded by the scanner" or
  // "derived from status and warnings" is the receipt's to state, per visit.
  assert.doesNotMatch(context, /<ReportVisitSummaryBlock|buildReportVisitSummary\(|report-url-landed/);
  assert.doesNotMatch(header, /runQualitySummary|report-identity-quality/);
  assert.match(header, /<p className="report-identity-when">\{formatTimestamp\(run\.startedAt \?\? view\.scannedAt\)\}<\/p>/);
  assert.match(context, /<ReceiptFact term="Run quality"><span>\{runQualitySummary\(run\)\}<\/span><\/ReceiptFact>/);

  // The board renders it directly after the bottom-line card, before every
  // other card; a board with no bottom line takes it after its cards.
  const list = source("app/_components/findings-list.tsx");
  assert.match(list, /id=\{findingCardDomId\(finding\.id\)\}/);
  assert.match(list, /return finding\.id === "bottom-line" && afterBottomLine \? \(\s*<Fragment key=\{finding\.id\}>\s*\{card\}\s*\{afterBottomLine\}\s*<\/Fragment>\s*\) : card;/);
  assert.match(list, /\}\)\}\s*\{!hasBottomLine && afterBottomLine\}\s*<\/div>/);
  const block = source("app/_components/report-visit-summary-block.tsx");
  assert.match(block, /<a href=\{`#\$\{segment\.cardId\}`\} key=\{index\}>/);
  assert.match(block, /<h3 className="report-visit-heading">\{summary\.checkedTitle\}<\/h3>/);
  assert.match(block, /<h3 className="report-visit-heading">\{summary\.limitsTitle\}<\/h3>/);
  assert.doesNotMatch(block, /<details|<section|<h2/);

  // Both report routes hand the same server-built block to every board they
  // render: the permalink's summary and its explorer, and the printed board.
  const built = /<ReportVisitSummaryBlock summary=\{buildReportVisitSummary\(\{ view, facts, findings, evidenceArm \}\)\} \/>/;
  const permalink = source("app/reports/[id]/page.tsx");
  assert.match(permalink, new RegExp(`const visitSummary = \\(\\s*${built.source}\\s*\\);`));
  assert.match(permalink, /<ReportPageSummary[\s\S]*?visitSummary=\{visitSummary\}[\s\S]*?\/>\s*\}\s*visitSummary=\{visitSummary\}\s*\/>/);
  assert.match(permalink, /afterBottomLine=\{visitSummary\}/);
  assert.match(source("app/reports/[id]/print/page.tsx"), new RegExp(`<ReportRenderer[\\s\\S]*?visitSummary=\\{\\s*${built.source}\\s*\\}`));
  assert.match(source("app/reports/[id]/saved-report-client.tsx"), /<LazyReportRenderer[^>]*visitSummary=\{visitSummary\}/);
  assert.match(source("app/_components/report-renderer.tsx"), /<FindingsBoard [^>]*afterBottomLine=\{visitSummary\} \/>/);
  assert.match(source("app/_components/report-overview.tsx"), /afterBottomLine=\{afterBottomLine\}/);
});

test("every committed report's summary is short, plain, and true to its own warnings", async () => {
  const dir = path.join(process.cwd(), "public", "reports");
  const corpus = await loadCommittedCorpusStats();
  const ids = readdirSync(dir)
    .filter((file) => /^\d{8}-[0-9a-f]{32}\.json$/.test(file))
    .map((file) => file.slice(0, -5));
  assert.ok(ids.length > 0, "the committed corpus is empty, so this guard checked nothing");
  // The card guard's splitter (lib/report-findings.test.ts).
  const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z"(])/).filter(Boolean);
  const words = (text: string) => (text.match(/\S+/g) ?? []).length;
  for (const id of ids) {
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(dir, `${id}.json`), "utf8")));
    assert.equal(read.ok, true, id);
    if (!read.ok) continue;
    const view = toReportView(read.stored);
    const facts = buildReportFacts(view);
    const headline = buildReportHeadline(view, facts);
    const evidenceArm = renderedEvidenceArm(view, headline);
    const findings = buildFindings(view, corpus, facts, evidenceArm);
    const summary = buildReportVisitSummary({ view, facts, findings, evidenceArm });
    assert.deepEqual(summary.checked.map((entry) => entry.term), ["Page", "When", "Setup", "Visits", "Interactions", "Outcome"], id);
    const texts = [...summary.checked.map((entry) => entry.text), ...summary.limits.map(visitLimitText)];
    for (const text of texts) {
      assert.doesNotMatch(text, /\{(?:label|seg|n)\}|\u2014|\u2013/, `${id}: ${text}`);
      for (const sentence of sentences(text)) {
        assert.ok(words(sentence) <= 30, `${id}: ${words(sentence)} words: ${sentence}`);
      }
    }
    const typed = view.runs.some((run) => run.warnings.some((warning) => TYPED_FIELDS_DISCLOSURE.test(warning)));
    assert.equal(/form field/.test(fact(summary, "Interactions")), typed, `${id}: typing stated without a disclosure, or dropped`);
    assert.equal(fact(summary, "Visits") === "One visit.", view.reportType === "single", id);
    const moved = view.runs.some((run) => run.conditions.finalUrl !== run.conditions.requestedUrl);
    assert.equal(/ landed on /.test(fact(summary, "Page")), moved, `${id}: landing ${moved ? "missing" : "stated without a redirect"}`);
    for (const limit of summary.limits) {
      for (const segment of limit.body) {
        if (!segment.cardId) continue;
        assert.ok(findings.some((finding) => findingCardDomId(finding.id) === segment.cardId), `${id}: ${segment.cardId} links no card`);
      }
    }
  }
});

test("every claim the board can withhold has a reader name", () => {
  assert.deepEqual(Object.keys(VISIT_CHECK_LABELS).sort(), Object.keys(REPORT_CLAIM_REQUIREMENTS).sort());
});

/**
 * The summary reads ReportFacts and the consent, censorship and egress
 * modules, and only the two server report routes build it; the explorer's
 * board receives the block as markup. In the App Router a "use client"
 * directive is inherited through imports, so grepping each file for the
 * directive cannot answer this; walk the graph from every client root, as the
 * claim-boundary guard does.
 */
test("the visit summary stays on the server, out of every client bundle", () => {
  const root = process.cwd();
  const sourceFiles = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.tsx?$/.test(entry.name) ? [relative] : [];
    });
  const files = new Set([...sourceFiles("app"), ...sourceFiles("lib")]);
  const source = (file: string) => readFileSync(path.join(root, file), "utf8");
  const resolve = (from: string, specifier: string): string | null => {
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith(".")
        ? path.posix.join(path.posix.dirname(from), specifier)
        : null;
    if (base === null) return null;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => files.has(candidate)) ?? null;
  };
  const importsOf = (file: string) =>
    [...source(file).matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)]
      .map((match) => resolve(file, match[1]))
      .filter((resolved): resolved is string => resolved !== null);
  const clientRoots = [...files].filter((file) => /^\s*["']use client["']/m.test(source(file)));
  assert.ok(clientRoots.length > 0, "the walk must start somewhere; no client components were found");
  const reached: string[] = [];
  for (const start of clientRoots) {
    const seen = new Set([start]);
    const queue = [[start]];
    while (queue.length > 0) {
      const trail = queue.shift()!;
      for (const next of importsOf(trail[trail.length - 1])) {
        if (seen.has(next)) continue;
        seen.add(next);
        if (next === "lib/report-visit-summary.ts" || next === "app/_components/report-visit-summary-block.tsx") {
          reached.push([...trail, next].join(" -> "));
        }
        queue.push([...trail, next]);
      }
    }
  }
  assert.deepEqual(reached, [], "a client component reaches the visit summary through its import graph");
  // The walk does reach the modules from their real server importers.
  for (const route of ["app/reports/[id]/page.tsx", "app/reports/[id]/print/page.tsx"]) {
    assert.match(source(route), /from "@\/lib\/report-visit-summary"/, route);
    assert.match(source(route), /from "@\/app\/_components\/report-visit-summary-block"/, route);
  }
});
