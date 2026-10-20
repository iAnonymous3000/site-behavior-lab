import { consentChoiceLabel } from "./consent-interaction";
import { CONSENT_RELOAD_DISCLOSURE } from "./consent-verification";
import { findingCardDomId, type EvidenceArm } from "./report-evidence-navigation";
import { consentVerificationSummary } from "./report-consent-copy";
import type { ReportClaimId, ReportFacts, RunFacts } from "./report-facts";
import { runCensorshipNotes } from "./scan-report-censorship";
import {
  displayRunView,
  runUnsupportedEvidenceNotes,
  type ReportView,
  type RunConsentView,
  type RunView
} from "./scan-report-views";
import { DEFAULT_SCANNER_EGRESS_LABEL, PUBLIC_SCANNER_EGRESS_LABELS } from "./scanner-egress";
import { displayPublicUrl } from "./text-format";

/**
 * "What was checked" and "What this visit could not see": the two short lists
 * a report's findings board states directly after its bottom line, before
 * any card that counts or ranks what the visit recorded.
 *
 * A report page used to give the page, a UTC timestamp and a machine-worded
 * run-quality line, and nothing else about the visit: the device, the browser
 * profile, where it ran from, whether there were one or two visits, what the
 * scanner did to the page, and what one visit cannot show all lived in the
 * evidence explorer, about 16,000 px down a phone. The lists follow the
 * verdict rather than leading the page, so the banner and the bottom line
 * keep the place they had.
 *
 * Every sentence here is built from a fact the view already holds: the
 * recorded conditions, the scanner's admitted warnings, the consent facts,
 * and the claim eligibility ReportFacts derives from the r2 detector ledger
 * and the v1 quality reasons. Nothing is stated because the scanner usually
 * does it. Two consequences a reader can see:
 *
 * - The typing test is named only from the scanner's own disclosure, which it
 *   writes only when it typed into at least one field. A run without that
 *   line says "no typing was recorded", never that the page had no form
 *   fields: a zero count writes nothing, and reports from before the probe
 *   carry no line either.
 * - A standing limit renders only when the warning that states it is on
 *   every run, so a producer that words its limits differently (a Cloudflare
 *   or PageGraph share) never inherits the Node scanner's.
 *
 * Server-side only, like the report pages that build it and hand it to the
 * board as markup (app/_components/report-visit-summary-block.tsx): nothing
 * here may enter a client bundle.
 */

export type ReportVisitFact = {
  term: "Page" | "When" | "Setup" | "Visits" | "Interactions" | "Outcome";
  text: string;
};

/** A run of text, linked to a findings card when `cardId` is set. */
export type ReportVisitTextSegment = { text: string; cardId?: string };

export type ReportVisitLimitId =
  | "other-pages"
  | "other-visitors"
  | "after-interaction"
  | "catalog"
  | "incomplete-checks";

export type ReportVisitLimit = {
  id: ReportVisitLimitId;
  lead: string;
  body: ReportVisitTextSegment[];
};

export type ReportVisitSummary = {
  checkedTitle: string;
  checked: ReportVisitFact[];
  limitsTitle: string;
  limits: ReportVisitLimit[];
};

/** Plain text of a limit's body, for tests and the census. */
export function visitLimitText(limit: ReportVisitLimit): string {
  return `${limit.lead} ${limit.body.map((segment) => segment.text).join("")}`;
}

/**
 * The report's display timestamp in words, in UTC: "Oct 19, 2026, 3:02 PM UTC".
 * The receipt states each visit's start with the same formatter.
 */
export function formatReportTimestamp(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not recorded"
    : date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short"
      });
}

/**
 * Where a visit ran from, in reader words, for every label the public report
 * vocabulary admits. Keyed by that vocabulary, so a new admitted label fails
 * to compile here rather than rendering a raw identifier.
 */
export const SCANNER_EGRESS_READER_PHRASES: Readonly<Record<(typeof PUBLIC_SCANNER_EGRESS_LABELS)[number], string>> =
  Object.freeze({
    [DEFAULT_SCANNER_EGRESS_LABEL]: "a scanner host the report does not name",
    "cloudflare-containers": "Cloudflare Containers",
    "cloudflare-browser-run": "Cloudflare Browser Run",
    "github-actions-ubuntu": "a GitHub Actions Ubuntu runner",
    "docker-smoke": "a Docker smoke-test container",
    test: "a test environment"
  });

/**
 * The reader's name for each check a claim stands for, as it reads inside a
 * sentence. Keyed by every claim, so a new claim must be named here.
 */
export const VISIT_CHECK_LABELS: Readonly<Record<ReportClaimId, string>> = Object.freeze({
  "third-party-services": "third-party services",
  "named-platforms": "named platforms",
  "ga-remarketing": "Google Analytics remarketing",
  "third-party-cookies": "third-party cookies",
  "fingerprint-apis": "fingerprinting",
  "session-recording-input-monitoring": "session-recording signals",
  "keystroke-exfiltration": "the typing test",
  "storage-keys": "storage",
  "cname-cloaking": "CNAME cloaking",
  "pixel-events": "advertising pixels",
  "consent-banner": "the consent banner",
  "shields-blocked": "Brave Shields matches",
  "privacy-policy": "the privacy policy check"
});

// The scanner's own disclosures, matched by the clauses the reader restates.
// lib/report-visit-summary.test.ts holds each one to the admitted vocabulary.
export const TYPED_FIELDS_DISCLOSURE = /^This scan typed a synthetic test value into (1 form field|([0-9]+) form fields) /;
export const NO_INTERACTION_CLAUSE = "with no scrolling, clicking, or consent interaction.";
export const SCRIPTED_CHOICE_CLAUSES = [
  "with no scrolling or clicking except one scripted choice on the cookie/consent banner",
  "with no scrolling or clicking except scripted attempts to activate one choice on the cookie/consent banner"
] as const;
export const CLOUDFLARE_NO_INTERACTION_CLAUSE = "It does not scroll, click, sign in, or interact with consent prompts.";
export const FIXED_PROFILE_CLAUSE = "from a fixed en-US / UTC profile";
export const OTHER_VISITORS_CLAUSE =
  "Sites can behave differently for real users, browsers, regions, accounts, or network locations.";
export const LOWER_BOUND_SENTENCE_START = "Counts are a lower bound: ";
export const AFTER_INTERACTION_CLAUSE = "trackers that load only after interaction or consent";
export const AFTER_FURTHER_INTERACTION_CLAUSE = "trackers that load only after further interaction";
export const CATALOG_BIAS_CLAUSE =
  "Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled.";
export const POLICY_READ_DISCLOSURE = /^Read the site's privacy policy \(.+\) and compared its text against this visit's observed behavior\./;

type ArmRun = { run: RunView; facts: RunFacts; label: string };

export function buildReportVisitSummary(input: {
  view: ReportView;
  facts: ReportFacts;
  /** The board's cards, in board order: a limit links only to a card the page renders. */
  findings: readonly { id: string }[];
  /** The arm the board describes (renderedEvidenceArm). */
  evidenceArm: EvidenceArm | undefined;
}): ReportVisitSummary {
  const { view, facts } = input;
  const comparison = view.reportType === "comparison" && view.runs.length === 2 && view.comparison !== null;
  const arms: ArmRun[] = view.runs.map((run, index) => ({
    run,
    facts: facts.runs[index],
    label: armLabel(view, run)
  }));
  const display = displayRunView(view);
  return {
    checkedTitle: "What was checked",
    checked: [
      { term: "Page", text: pageText(display, arms, comparison) },
      { term: "When", text: formatReportTimestamp(display.startedAt ?? view.scannedAt) },
      { term: "Setup", text: setupText(view, arms, comparison) },
      { term: "Visits", text: visitsText(view, arms, comparison) },
      { term: "Interactions", text: interactionsText(arms, comparison) },
      { term: "Outcome", text: outcomeText(arms, comparison) }
    ],
    limitsTitle: comparison ? "What these visits could not see" : "What this visit could not see",
    limits: limits(arms, comparison, input.findings, input.evidenceArm)
  };
}

function armLabel(view: ReportView, run: RunView): string {
  if (run.label === "baseline") return view.comparison?.runLabels.baseline ?? "baseline";
  if (run.label === "variant") return view.comparison?.runLabels.variant ?? "variant";
  return "recorded";
}

/** "the No blocking visit" */
function theVisit(arm: ArmRun): string {
  return `the ${arm.label} visit`;
}

/**
 * The page the visit checked: the requested address, and, when a visit ended
 * somewhere else (a redirect to another path, a www change, a subdomain),
 * where it landed, since the evidence describes the page it landed on. Both
 * go through the reader form the header's requested address uses (sanitized
 * labels and segments render as "*" and "…"). A landing is stated once when
 * every visit landed on the same address, and per visit when they did not.
 */
function pageText(display: RunView, arms: readonly ArmRun[], comparison: boolean): string {
  const requested = displayPublicUrl(display.conditions.requestedUrl);
  const moved = (arm: ArmRun) => arm.run.conditions.finalUrl !== arm.run.conditions.requestedUrl;
  if (!arms.some(moved)) return requested;
  const finals = new Set(arms.map((arm) => arm.run.conditions.finalUrl));
  if (!comparison) {
    return `Requested ${requested}; the visit landed on ${displayPublicUrl(arms.find(moved)!.run.conditions.finalUrl)}`;
  }
  if (arms.every(moved) && finals.size === 1) {
    return `Requested ${requested}; both visits landed on ${displayPublicUrl(arms[0].run.conditions.finalUrl)}`;
  }
  return `Requested ${requested}; ${joinClauses(
    arms.map((arm) =>
      moved(arm)
        ? `${theVisit(arm)} landed on ${displayPublicUrl(arm.run.conditions.finalUrl)}`
        : `${theVisit(arm)} stayed on it`
    )
  )}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinClauses(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function fieldCount(count: number): string {
  return count === 1 ? "1 form field" : `${count.toLocaleString("en-US")} form fields`;
}

function browserPhrase(run: RunView): string {
  const conditions = run.conditions;
  if (conditions.automation === "playwright-chromium") {
    return conditions.headless ? "headless Chromium" : "Chromium";
  }
  if (conditions.automation === "brave-pagegraph") return "a self-reported Brave PageGraph capture";
  if (conditions.automation === "external") return "an imported external capture, self-reported";
  return conditions.browserName ?? conditions.automation;
}

function egressPhrase(label: string): string {
  return Object.hasOwn(SCANNER_EGRESS_READER_PHRASES, label)
    ? SCANNER_EGRESS_READER_PHRASES[label as keyof typeof SCANNER_EGRESS_READER_PHRASES]
    : `"${label}"`;
}

function profilePhrase(run: RunView): string {
  const { viewport, locale, timezone } = run.conditions;
  return `${browserPhrase(run)} in a ${viewport.isMobile ? "mobile" : "desktop"} window of ${viewport.width} × ${
    viewport.height
  }, with ${locale} language and ${timezone} time zone`;
}

function egressSentencePhrase(run: RunView): string {
  const region = run.conditions.scannerEgressRegion;
  return `from ${egressPhrase(run.conditions.scannerEgress)}; ${
    region ? `the network region was recorded as ${region}` : "the network region was not recorded"
  }`;
}

function setupText(view: ReportView, arms: readonly ArmRun[], comparison: boolean): string {
  if (!comparison) {
    const run = arms[0].run;
    return [
      `${capitalize(profilePhrase(run))}.`,
      `It ran ${egressSentencePhrase(run)}.`,
      run.conditions.gpcEnabled
        ? "It sent the Global Privacy Control (GPC) signal."
        : "It did not send the Global Privacy Control (GPC) signal."
    ].join(" ");
  }
  const sentences: string[] = [];
  const profiles = arms.map((arm) => profilePhrase(arm.run));
  sentences.push(
    profiles.every((profile) => profile === profiles[0])
      ? `Both visits used ${profiles[0]}.`
      : arms.map((arm, index) => `${capitalize(theVisit(arm))} used ${profiles[index]}.`).join(" ")
  );
  const egress = arms.map((arm) => egressSentencePhrase(arm.run));
  sentences.push(
    egress.every((phrase) => phrase === egress[0])
      ? `Both ran ${egress[0]}.`
      : arms.map((arm, index) => `${capitalize(theVisit(arm))} ran ${egress[index]}.`).join(" ")
  );
  // GPC is what a GPC comparison varies; the Visits fact states it there.
  if (view.comparison?.axis !== "gpc") {
    const sent = arms.map((arm) => arm.run.conditions.gpcEnabled);
    sentences.push(
      sent.every(Boolean)
        ? "Both sent the Global Privacy Control (GPC) signal."
        : sent.every((value) => !value)
          ? "Neither sent the Global Privacy Control (GPC) signal."
          : arms
              .map((arm) =>
                `${capitalize(theVisit(arm))} ${arm.run.conditions.gpcEnabled ? "sent" : "did not send"} the Global Privacy Control (GPC) signal.`
              )
              .join(" ")
    );
  }
  return sentences.join(" ");
}

function visitsText(view: ReportView, arms: readonly ArmRun[], comparison: boolean): string {
  if (!comparison) return "One visit.";
  const [baseline, variant] = arms;
  const pair = `${baseline.label} and ${variant.label}`;
  if (view.comparison?.temporalPair) {
    return `Two visits to the same address at different times: ${baseline.label} on ${formatReportTimestamp(
      baseline.run.startedAt
    )} and ${variant.label} on ${formatReportTimestamp(variant.run.startedAt)}.`;
  }
  switch (view.comparison?.axis ?? null) {
    case "shields":
      return `Two visits configured to differ in Brave-list blocking: ${pair}.`;
    case "gpc":
      return `Two visits configured to differ in the Global Privacy Control (GPC) signal: ${pair}.`;
    case "consent":
      return `Two visits configured to differ in the cookie-banner choice: ${pair}.`;
    default:
      return `Two visits: ${pair}.`;
  }
}

function typedFieldCount(run: RunView): number | null {
  for (const warning of run.warnings) {
    const match = TYPED_FIELDS_DISCLOSURE.exec(warning);
    if (match) return match[2] === undefined ? 1 : Number(match[2]);
  }
  return null;
}

function typingSentence(arms: readonly ArmRun[], comparison: boolean): string {
  const counts = arms.map((arm) => typedFieldCount(arm.run));
  if (!comparison) {
    return counts[0] === null
      ? "No typing was recorded."
      : `Typed a made-up test value into ${fieldCount(counts[0])}, never submitting the form.`;
  }
  if (counts.every((count) => count === null)) return "No typing was recorded in either visit.";
  if (counts.every((count) => count === counts[0])) {
    return `Typed a made-up test value into ${fieldCount(counts[0]!)} in each visit, never submitting the form.`;
  }
  const typed = arms
    .map((arm, index) => ({ arm, count: counts[index] }))
    .filter((entry): entry is { arm: ArmRun; count: number } => entry.count !== null);
  const untyped = arms.filter((_, index) => counts[index] === null);
  const typedClause = `Typed a made-up test value into ${joinClauses(
    typed.map((entry) => `${fieldCount(entry.count)} in ${theVisit(entry.arm)}`)
  )}, never submitting the form`;
  return untyped.length === 0
    ? `${typedClause}.`
    : `${typedClause}; no typing was recorded in ${joinClauses(untyped.map(theVisit))}.`;
}

/**
 * One visit's banner interaction, worded as the Methodology row words it: a
 * click only where a control was activated, and the request, never the
 * outcome, where none was.
 */
function consentSentenceFor(consent: RunConsentView, where: string): string {
  const choice = `"${consentChoiceLabel(consent.mode)}"`;
  if (!consent.controlActivated) {
    return `Asked to choose ${choice} on a cookie banner${where}; no activated choice was recorded.`;
  }
  const banner = consent.cmp ? `the ${consent.cmp} banner` : "the cookie banner";
  const action = consent.matchedControlQualification
    ? `Asked for ${choice} on ${banner}${where} and clicked ${consent.matchedControlQualification}`
    : `Clicked ${choice} on ${banner}${where}`;
  return `${action} (${consentVerificationSummary(consent)}).`;
}

/**
 * Two visits that asked for the two choices and met the same outcome on the
 * same banner, in one sentence; the visit labels already name each choice.
 * null when they differ in any way the per-visit sentences would show.
 */
function pairedConsentSentence(first: RunConsentView, second: RunConsentView): string | null {
  if (first.mode === second.mode || first.controlActivated !== second.controlActivated) return null;
  const choices = (banner: string) =>
    `"${consentChoiceLabel(first.mode)}" on ${banner} in one visit and "${consentChoiceLabel(second.mode)}" in the other`;
  if (!first.controlActivated) {
    return `Asked to choose ${choices("a cookie banner")}; no activated choice was recorded in either.`;
  }
  if (
    first.cmp !== second.cmp ||
    first.matchedControlQualification !== null ||
    second.matchedControlQualification !== null ||
    consentVerificationSummary(first) !== consentVerificationSummary(second)
  ) {
    return null;
  }
  return `Clicked ${choices(first.cmp ? `the ${first.cmp} banner` : "the cookie banner")} (${consentVerificationSummary(
    first
  )} in both).`;
}

function consentSentence(arms: readonly ArmRun[], comparison: boolean): string | null {
  const withConsent = arms.filter((arm) => arm.run.consent !== null);
  if (withConsent.length === 0) return null;
  const paired =
    comparison && withConsent.length === 2
      ? pairedConsentSentence(withConsent[0].run.consent!, withConsent[1].run.consent!)
      : null;
  const sentences = paired
    ? [paired]
    : withConsent.map((arm) => consentSentenceFor(arm.run.consent!, comparison ? ` in ${theVisit(arm)}` : ""));
  const reloaded = withConsent.filter((arm) => arm.run.warnings.includes(CONSENT_RELOAD_DISCLOSURE));
  if (reloaded.length > 0) {
    sentences.push(
      comparison && reloaded.length === arms.length
        ? "Reloaded the page once after each click to read the registered choice."
        : comparison
          ? `Reloaded the page once after the click in ${joinClauses(reloaded.map(theVisit))} to read the registered choice.`
          : "Reloaded the page once after the click to read the registered choice."
    );
  }
  return sentences.join(" ");
}

type InteractionKind = "none" | "scripted-choice" | "cloudflare";

function interactionKind(run: RunView): InteractionKind | null {
  if (run.warnings.some((warning) => warning.includes(NO_INTERACTION_CLAUSE))) return "none";
  if (run.warnings.some((warning) => SCRIPTED_CHOICE_CLAUSES.some((clause) => warning.includes(clause)))) {
    return "scripted-choice";
  }
  if (run.warnings.some((warning) => warning.includes(CLOUDFLARE_NO_INTERACTION_CLAUSE))) return "cloudflare";
  return null;
}

function restraintSentence(arms: readonly ArmRun[]): string | null {
  const kinds = arms.map((arm) => interactionKind(arm.run));
  if (kinds.some((kind) => kind === null) || kinds.some((kind) => kind !== kinds[0])) return null;
  if (kinds[0] === "none") return "No scrolling, clicking or consent interaction.";
  if (kinds[0] === "scripted-choice") return "No scrolling and no other clicks.";
  return "No scrolling, clicking, signing in or consent interaction.";
}

function interactionsText(arms: readonly ArmRun[], comparison: boolean): string {
  return [typingSentence(arms, comparison), consentSentence(arms, comparison), restraintSentence(arms)]
    .filter((sentence): sentence is string => sentence !== null)
    .join(" ");
}

function runFailed(run: RunView): boolean {
  return run.quality.outcome === "failed";
}

function runCutShort(run: RunView): boolean {
  return !runFailed(run) && runCensorshipNotes(run).length > 0;
}

function failureStatus(run: RunView): string {
  return typeof run.status === "number" && run.status >= 400 ? ` (HTTP ${run.status})` : "";
}

function outcomeText(arms: readonly ArmRun[], comparison: boolean): string {
  const subjectUnestablished = arms.some(
    (arm) => !runFailed(arm.run) && !arm.facts.subject.describesSubject
  );
  const unestablishedNote = subjectUnestablished
    ? " The scanner could not establish that it reached the requested page."
    : "";
  if (!comparison) {
    const run = arms[0].run;
    if (runFailed(run)) return `The visit did not complete${failureStatus(run)}.`;
    if (runCutShort(run)) return `The visit completed, but some evidence was cut short.${unestablishedNote}`;
    if (runUnsupportedEvidenceNotes(run).length > 0) {
      return `The visit completed for the evidence its producer supports.${unestablishedNote}`;
    }
    return `The visit completed.${unestablishedNote}`;
  }
  const failed = arms.filter((arm) => runFailed(arm.run));
  if (failed.length === arms.length) {
    return `Neither visit completed: ${joinClauses(
      arms.map((arm) => `${theVisit(arm)}${failureStatus(arm.run)}`)
    )}.`;
  }
  if (failed.length > 0) {
    const completed = arms.filter((arm) => !runFailed(arm.run));
    return `${capitalize(joinClauses(failed.map((arm) => `${theVisit(arm)}${failureStatus(arm.run)}`)))} did not complete; ${joinClauses(
      completed.map(theVisit)
    )} completed${completed.some((arm) => runCutShort(arm.run)) ? ", with some evidence cut short" : ""}.${unestablishedNote}`;
  }
  const cutShort = arms.filter((arm) => runCutShort(arm.run));
  if (cutShort.length === arms.length) {
    return `Both visits completed, but some evidence was cut short.${unestablishedNote}`;
  }
  if (cutShort.length > 0) {
    return `Both visits completed, but some evidence in ${joinClauses(cutShort.map(theVisit))} was cut short.${unestablishedNote}`;
  }
  if (arms.some((arm) => runUnsupportedEvidenceNotes(arm.run).length > 0)) {
    return `Both visits completed for the evidence their producer supports.${unestablishedNote}`;
  }
  return `Both visits completed.${unestablishedNote}`;
}

function everyRunCarries(arms: readonly ArmRun[], test: (warning: string) => boolean): boolean {
  return arms.length > 0 && arms.every((arm) => arm.run.warnings.some(test));
}

function limits(
  arms: readonly ArmRun[],
  comparison: boolean,
  findings: readonly { id: string }[],
  evidenceArm: EvidenceArm | undefined
): ReportVisitLimit[] {
  const out: ReportVisitLimit[] = [];
  const policyRead = arms.some((arm) => arm.run.warnings.some((warning) => POLICY_READ_DISCLOSURE.test(warning)));
  out.push({
    id: "other-pages",
    lead: "Other pages on this site.",
    body: [
      {
        text: `Only the requested page's activity was recorded.${
          policyRead ? " The privacy policy was opened only to read its text, and none of its activity was recorded." : ""
        }`
      }
    ]
  });
  if (
    everyRunCarries(arms, (warning) => warning.includes(OTHER_VISITORS_CLAUSE)) &&
    everyRunCarries(arms, (warning) => warning.includes(FIXED_PROFILE_CLAUSE))
  ) {
    out.push({
      id: "other-visitors",
      lead: "Signed-in visitors, other browsers and other regions.",
      body: [
        {
          text: `${comparison ? "Both visits were automated," : "This was one automated visit"} ${FIXED_PROFILE_CLAUSE}. ${OTHER_VISITORS_CLAUSE}`
        }
      ]
    });
  }
  const lowerBound = (clause: string) =>
    everyRunCarries(arms, (warning) => warning.startsWith(LOWER_BOUND_SENTENCE_START) && warning.includes(clause));
  if (lowerBound(AFTER_INTERACTION_CLAUSE)) {
    out.push({
      id: "after-interaction",
      lead: "Anything that loads only after interaction or consent.",
      body: [{ text: "Trackers that load that late are not observed, so counts are a lower bound." }]
    });
  } else if (lowerBound(AFTER_FURTHER_INTERACTION_CLAUSE)) {
    out.push({
      id: "after-interaction",
      lead: "Anything that loads only after further interaction.",
      body: [{ text: "Trackers that load that late are not observed, so counts are a lower bound." }]
    });
  }
  if (everyRunCarries(arms, (warning) => warning.includes(CATALOG_BIAS_CLAUSE))) {
    out.push({
      id: "catalog",
      lead: "Services the catalog does not name.",
      body: [{ text: CATALOG_BIAS_CLAUSE }]
    });
  }
  const groups = cutShortGroups(arms, comparison, findings, evidenceArm);
  if (groups.length > 0) {
    const body: ReportVisitTextSegment[] = [];
    groups.forEach((group, groupIndex) => {
      body.push({ text: `${groupIndex > 0 ? " " : ""}${group.intro}` });
      if (group.every) {
        body.push({ text: "every check" });
      } else {
        group.checks.forEach((check, index) => {
          if (index > 0) body.push({ text: index === group.checks.length - 1 ? " and " : ", " });
          body.push(check.cardId ? { text: check.label, cardId: check.cardId } : { text: check.label });
        });
      }
      body.push({ text: "." });
    });
    if (groups.some((group) => group.every && group.onBoard)) {
      body.push({ text: " Every card below states only what was retained." });
    } else if (groups.some((group) => group.checks.some((check) => check.cardId))) {
      body.push({ text: " Each linked card states what was retained." });
    }
    out.push({ id: "incomplete-checks", lead: "Checks with incomplete evidence.", body });
  }
  return out;
}

type CutShortCheck = { claim: ReportClaimId; label: string; cardId: string | null };
type CutShortGroup = {
  intro: string;
  /** Every claim was cut short, so the group names no single check. */
  every: boolean;
  /** The board describes a visit this group covers. */
  onBoard: boolean;
  checks: CutShortCheck[];
};

/**
 * The checks whose evidence a visit did not finish collecting, from the claim
 * eligibility ReportFacts derives (a censored evidence family or a detector
 * that did not complete), grouped by the visits that lost them. Board order
 * first within a group, so the links read in the order the cards do.
 *
 * A check is linked only to a card the board renders AND whose visit lost it:
 * the board describes one arm of a comparison, and its card says nothing
 * about a loss in the other arm.
 */
function cutShortGroups(
  arms: readonly ArmRun[],
  comparison: boolean,
  findings: readonly { id: string }[],
  evidenceArm: EvidenceArm | undefined
): CutShortGroup[] {
  const boardRun = comparison ? arms.find((arm) => arm.run.label === (evidenceArm ?? "baseline")) : arms[0];
  const cardIds = findings.map((finding) => finding.id);
  const allClaims = Object.keys(VISIT_CHECK_LABELS) as ReportClaimId[];
  const position = (claim: ReportClaimId) => {
    const index = cardIds.indexOf(claim);
    return index === -1 ? cardIds.length + allClaims.indexOf(claim) : index;
  };
  const group = (intro: string, covered: readonly ArmRun[], claims: readonly ReportClaimId[]): CutShortGroup | null => {
    if (claims.length === 0) return null;
    const onBoard = boardRun !== undefined && covered.includes(boardRun);
    return {
      intro,
      every: claims.length === allClaims.length,
      onBoard,
      checks: [...claims]
        .sort((left, right) => position(left) - position(right))
        .map((claim) => ({
          claim,
          label: VISIT_CHECK_LABELS[claim],
          cardId: onBoard && cardIds.includes(claim) ? findingCardDomId(claim) : null
        }))
    };
  };
  const lostIn = (arm: ArmRun) => allClaims.filter((claim) => claimCutShort(arm.facts, claim));
  if (!comparison) {
    const single = group("In this visit: ", arms, lostIn(arms[0]));
    return single ? [single] : [];
  }
  const lost = arms.map(lostIn);
  if (lost.every((claims) => claims.length === allClaims.length)) {
    return [group("In both visits: ", arms, allClaims)].filter((entry): entry is CutShortGroup => entry !== null);
  }
  // A visit that lost every check is stated whole, beside whatever the other
  // visit lost, rather than split across a shared and an "only" group.
  if (lost.some((claims) => claims.length === allClaims.length)) {
    return arms
      .map((arm, index) => group(`In ${theVisit(arm)}: `, [arm], lost[index]))
      .filter((entry): entry is CutShortGroup => entry !== null);
  }
  const both = allClaims.filter((claim) => lost.every((claims) => claims.includes(claim)));
  return [
    group("In both visits: ", arms, both),
    ...arms.map((arm, index) =>
      group(`In ${theVisit(arm)} only: `, [arm], lost[index].filter((claim) => !both.includes(claim)))
    )
  ].filter((entry): entry is CutShortGroup => entry !== null);
}

function claimCutShort(facts: RunFacts, claim: ReportClaimId): boolean {
  return facts.claims[claim].blockers.some(
    (blocker) => blocker === "family-censored" || blocker === "detector-incomplete"
  );
}
