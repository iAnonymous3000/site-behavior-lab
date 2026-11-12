import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConsentComparisonReport,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import { reportConsistencyViolations, validateReportPresentation, type ReportConsistencyRuleId } from "./report-consistency";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts } from "./report-facts";
import * as productionFindings from "./report-findings";
import * as productionHeadline from "./report-headline";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makeConsentInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { viewFromV1Report, viewFromV2, type ReportView, type RunView } from "./scan-report-views";
import type { FingerprintDetectionSummary, ScanResult, TrackerMatch } from "./types";

/**
 * RC, a finite check that a report's headline and its findings board do not contradict the
 * facts, or each other: the rules of lib/report-consistency.ts, held over a product of visits.
 *
 * Each visit is a view the suite builds, the facts come from the real buildReportFacts, the
 * headline from the real buildReportHeadline, the board from the real buildFindings on the
 * arm the headline focuses, and the rules are the real reportConsistencyViolations. No rule
 * may fire on any visit of the product, outside the two classes pinned open below.
 *
 * The product is not every report. It is four slices, each the full product of the classes
 * its own lists write out, with every field outside those lists at the value the fixtures
 * give it. Each class is one written-out value: one third-party cookie stands for the counts
 * from 1 to 4, and so on. The classes were read from the comparisons the facts, the headline
 * and the board's cards for one visit make (0, the reference thresholds, present or absent,
 * each state of an evidence family and of a detector). The board's comparison cards were not
 * read branch by branch: the pair slices reach them through the real constructors, over the
 * classes written out there and no others.
 *
 * - ACTIVITY: one visit on the v1 wire, read by viewFromV1Report. What it recorded:
 *   third-party services, cookies, fingerprint evidence, listener detections, DNS aliases,
 *   filter-list matches and a privacy policy; and, over fewer classes of those, a typing
 *   test and advertising pixels.
 * - AVAILABILITY: one visit, crossed with what the page was (the requested page, an HTTP
 *   error, unverified, a suspected challenge, a failed load) and with what the scan could
 *   not record. The v1 form leaves optional evidence out or names a loss in its quality
 *   reasons. The r2 form is set on the view: a detector ledger with one detector partial or
 *   skipped, and one evidence family censored or unsupported. Those views are built at the
 *   view seam and no reader made them, so a state no reader produces is walked too.
 * - PAIRS: two visits on the v1 wire, joined by the real comparison constructors for the
 *   privacy signal, blocking, consent and before/after designs, so each pair's claim gates
 *   are the ones the real decision gives it.
 * - CONSENT: the r2 consent fixture's pair with its recorded choice states, its gates and
 *   each visit's trackers set on the view, which is where a verified choice can be walked.
 *
 * Not walked: corpus percentiles (the board is built with no corpus), a published
 * correction, a PageGraph import's own card, storage counts, same-organization ownership,
 * and any pairing of classes across slices.
 *
 * Two real disagreements were found on the way and are pinned open, with the code left as it
 * is. In both, a calm headline sits over a board whose bottom line is an alert: a policy
 * that says no cookies are used beside a cookie the visit recorded, and a consent platform
 * on the site's own host. A visit in either class is held only to firing no other rule.
 */

type HeadlineModule = typeof productionHeadline;
type FindingsModule = typeof productionFindings;

const RULES: readonly ReportConsistencyRuleId[] = [
  "fingerprint-asserted-without-events",
  "cookie-absence-with-recorded-cookie",
  "quiet-copy-over-loud-finding",
  "identity-conflict",
  "unsafe-categorical-title-under-incomplete-evidence",
  "unscoped-absence-lead-under-incomplete-evidence",
  "error-page-signals-attributed-to-site",
  "headline-describes-another-visit"
];
const QUIET_OVER_LOUD: ReportConsistencyRuleId = "quiet-copy-over-loud-finding";

// ---------------------------------------------------------------------------------------
// One visit, on the v1 wire.
// ---------------------------------------------------------------------------------------

const SERVICES = [
  "none", "hosts-1", "hosts-15", "hosts-30", "tracker-1", "tracker-6", "tracker-12", "platform-1", "platform-3",
  "operational-1", "unclassified-1", "replay-1", "analytics-sync", "consent-platform", "consent-platform-own-host"
] as const;
const COOKIES = ["none", "own-1", "third-party-1", "third-party-5", "third-party-12"] as const;
const FINGERPRINT = ["none", "events", "heuristic", "webgl-single-signal"] as const;
const LISTENERS = ["none", "session-recording", "input-monitoring"] as const;
const KEYSTROKE = ["none", "plain", "hashed"] as const;
const PIXELS = ["none", "event-labels", "identifier-fields"] as const;
const ALIASES = ["none", "tracking-alias"] as const;
const SHIELDS = ["unmeasured", "matched-0", "matched-1", "matched-10"] as const;
const POLICY = ["none", "no-checkable-statement", "says-no-cookies", "says-no-third-party-cookies", "says-no-selling"] as const;

type Visit = {
  services: (typeof SERVICES)[number];
  cookies: (typeof COOKIES)[number];
  fingerprint: (typeof FINGERPRINT)[number];
  listeners: (typeof LISTENERS)[number];
  keystroke: (typeof KEYSTROKE)[number];
  pixels: (typeof PIXELS)[number];
  aliases: (typeof ALIASES)[number];
  shields: (typeof SHIELDS)[number];
  policy: (typeof POLICY)[number];
  /** Further third-party requests to one uncatalogued host, which move a pair's request counts and nothing else. */
  padding: number;
  status: number;
};

const QUIET: Visit = {
  services: "none", cookies: "none", fingerprint: "none", listeners: "none", keystroke: "none", pixels: "none",
  aliases: "none", shields: "unmeasured", policy: "none", padding: 0, status: 200
};

const tracker = (entity: string, domain: string, category: string): TrackerMatch => ({ domain, entity, category, confidence: "curated" });
const PLATFORMS = [tracker("Google", "googleadservices.com", "advertising"), tracker("Meta", "facebook.net", "social / advertising pixel"), tracker("TikTok", "tiktok.com", "advertising")];
const trackers = (count: number) => Array.from({ length: count }, (_, index) => tracker(`Example Analytics ${index + 1}`, `metrics${index + 1}.example.net`, "analytics"));

type Row = { host: string; thirdParty: boolean; tracker: TrackerMatch | null };
const hosts = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ host: `cdn${index + 1}.example.org`, thirdParty: true, tracker: null }));
const matched = (matches: readonly TrackerMatch[]): Row[] => matches.map((match) => ({ host: match.domain, thirdParty: true, tracker: match }));

function rowsOf(services: Visit["services"]): Row[] {
  switch (services) {
    case "none": return [];
    case "hosts-1": return hosts(1);
    case "hosts-15": return hosts(15);
    case "hosts-30": return hosts(30);
    case "tracker-1": return matched(trackers(1));
    case "tracker-6": return matched(trackers(6));
    case "tracker-12": return matched(trackers(12));
    case "platform-1": return matched(PLATFORMS.slice(0, 1));
    case "platform-3": return matched(PLATFORMS);
    case "operational-1": return matched([tracker("Example Hosting", "static.example.net", "cdn / hosting")]);
    case "unclassified-1": return matched([tracker("Example Experiments", "experiments.example.net", "experimentation")]);
    case "replay-1": return matched([tracker("Example Replay", "replay.example.net", "session replay")]);
    case "analytics-sync": return matched([tracker("Google", "www.google-analytics.com", "analytics / advertising"), tracker("Google", "stats.g.doubleclick.net", "analytics / advertising")]);
    case "consent-platform": return [{ host: "consent.cookiebot.com", thirdParty: true, tracker: null }];
    case "consent-platform-own-host": return [{ host: "consent.cookiebot.com", thirdParty: false, tracker: null }];
  }
}

const LISTENER_ORIGIN = "https://scripts.example.org";

function resultOf(visit: Visit): ScanResult {
  const result = makeScanReportV1() as ScanResult;
  const site = visit.services === "consent-platform-own-host" ? "cookiebot.com" : "example.com";
  result.summary.firstPartyDomain = site;
  result.summary.status = visit.status;
  result.conditions.requestedUrl = `https://${site}/`;
  result.conditions.finalUrl = `https://${site}/`;

  const rows: Row[] = [
    { host: site, thirdParty: false, tracker: null },
    ...rowsOf(visit.services),
    ...(visit.listeners === "none" ? [] : [{ host: "scripts.example.org", thirdParty: true, tracker: null }]),
    ...Array.from({ length: visit.padding }, () => ({ host: "assets.example.org", thirdParty: true, tracker: null }))
  ];
  result.requests = rows.map((row, index) => ({
    id: index + 1, url: `https://${row.host}/`, domain: row.host, method: "GET", resourceType: "script", status: 200, thirdParty: row.thirdParty, tracker: row.tracker, startedAtMs: index
  }));
  const byHost = new Map<string, Row[]>();
  for (const row of rows) byHost.set(row.host, [...(byHost.get(row.host) ?? []), row]);
  result.domains = [...byHost].map(([host, own]) => ({ domain: host, requests: own.length, thirdParty: own[0].thirdParty, tracker: own[0].tracker, statuses: [200], resourceTypes: ["script"] }));
  result.summary.totalRequests = rows.length;
  result.summary.thirdPartyRequests = rows.filter((row) => row.thirdParty).length;
  result.summary.knownTrackerRequests = rows.filter((row) => row.tracker !== null).length;
  result.summary.thirdPartyDomains = result.domains.filter((domain) => domain.thirdParty).length;

  const thirdPartyCookies = { none: 0, "own-1": 0, "third-party-1": 1, "third-party-5": 5, "third-party-12": 12 }[visit.cookies];
  const ownCookies = visit.cookies === "own-1" ? 1 : 0;
  const cookie = (name: string, domain: string, thirdParty: boolean) => ({ name, domain, path: "/", sameSite: "Lax", secure: true, httpOnly: true, session: true, thirdParty });
  result.cookies = [
    ...Array.from({ length: ownCookies }, (_, index) => cookie(`own${index}`, site, false)),
    ...Array.from({ length: thirdPartyCookies }, (_, index) => cookie(`other${index}`, "metrics.example.net", true))
  ];
  result.summary.cookies = result.cookies.length;
  result.summary.thirdPartyCookies = thirdPartyCookies;

  const detections: FingerprintDetectionSummary[] = [];
  if (visit.fingerprint !== "none") {
    result.fingerprintEvents = [{ api: "WebGLRenderingContext.getParameter", count: 1 }];
    result.summary.fingerprintEvents = 1;
  }
  if (visit.fingerprint === "heuristic") {
    detections.push({ kind: "webgl-fingerprinting", heuristic: "webgl-entropy-read-v1", count: 1, evidence: { readApis: ["webgl.readPixels"], parameters: ["UNMASKED_RENDERER_WEBGL"], getParameterCalls: 2, readPixelsCalls: 1 } });
  }
  if (visit.fingerprint === "webgl-single-signal") {
    detections.push({ kind: "webgl-fingerprinting", heuristic: "webgl-entropy-read-v1", count: 1, evidence: { readApis: ["webgl.readPixels"], parameters: [], getParameterCalls: 0, readPixelsCalls: 1 } });
  }
  if (visit.listeners !== "none") {
    detections.push({
      kind: visit.listeners,
      heuristic: visit.listeners === "session-recording" ? "interaction-listener-coverage-v1" : "input-listener-coverage-v1",
      count: 1,
      evidence: { eventTypes: ["mousemove", "click", "scroll", "keydown", "input"], listenerTargets: ["document"], thirdPartyOrigins: [LISTENER_ORIGIN], totalListenerCalls: 9 }
    } as FingerprintDetectionSummary);
  }
  if (visit.keystroke !== "none") {
    detections.push({
      kind: "keystroke-exfiltration", heuristic: "input-sentinel-exfiltration-v1", count: 1,
      evidence: { recipients: ["collect.example.org"], encodings: [visit.keystroke === "hashed" ? "sha256" : "plain"], fieldsTyped: 1, fieldTypes: ["email"] }
    } as FingerprintDetectionSummary);
  }
  result.fingerprintDetections = detections;
  result.pixelEvents = visit.pixels === "none" ? [] : [{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: visit.pixels === "identifier-fields" ? ["email"] : [], requests: 1 }];
  result.cnameCloaks = visit.aliases === "none" ? [] : [{ host: `metrics.${site}`, cname: "collect.alias.example.net", tracker: tracker("Example Alias Analytics", "alias.example.net", "analytics") }];
  // The v1 wire has no way to say a policy was looked for and not found: without one, the evidence is unrecorded.
  result.privacyPolicy =
    visit.policy === "none"
      ? undefined
      : {
          url: `https://${site}/privacy`,
          claims:
            visit.policy === "says-no-cookies"
              ? [{ kind: "no-cookies", quote: "We do not use cookies." }]
              : visit.policy === "says-no-third-party-cookies"
                ? [{ kind: "no-third-party-cookies", quote: "We do not use third-party cookies." }]
                : visit.policy === "says-no-selling"
                  ? [{ kind: "no-selling-or-sharing", quote: "We do not sell or share your personal information." }]
                  : [],
          mentionedEntities: [],
          unmentionedEntities: [],
          policyTextLength: 5000
        };
  if (visit.shields !== "unmeasured") {
    result.conditions.shieldsMode = "classification";
    result.conditions.adblock = { active: true, source: "Brave default ad-block lists", lists: 31, fetchedAt: "2026-07-09T09:00:00.000Z" };
    result.summary.shieldsBlockedRequests = { "matched-0": 0, "matched-1": 1, "matched-10": 10 }[visit.shields];
  }
  return result;
}

/** The two classes pinned open: a policy that says no cookies beside a recorded cookie, and a consent platform on the site's own host. */
const pinnedOpen = (visit: Visit) => (visit.policy === "says-no-cookies" && visit.cookies !== "none") || visit.services === "consent-platform-own-host";

// ---------------------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------------------

type Fired = Map<ReportConsistencyRuleId, unknown>;
type Tally = { fired: Fired; views: number; open: number; openFired: number; calm: number; stories: Set<string> };
const newTally = (): Tally => ({ fired: new Map(), views: 0, open: 0, openFired: 0, calm: 0, stories: new Set() });

/** One view through the real facts, a headline module, a findings module on the arm that headline focuses, and the real rules. */
function present(view: ReportView, headlines: HeadlineModule, boards: FindingsModule) {
  const facts = buildReportFacts(view);
  const headline = headlines.buildReportHeadline(view, facts);
  const findings = boards.buildFindings(view, null, facts, renderedEvidenceArm(view, headline));
  return { facts, headline, findings, violations: reportConsistencyViolations(facts, headline, findings) };
}

function hold(tally: Tally, view: ReportView, open: boolean, input: () => unknown, headlines: HeadlineModule, boards: FindingsModule): void {
  const { headline, violations } = present(view, headlines, boards);
  tally.views += 1;
  tally.stories.add(headline.semantic.story);
  if (headline.semantic.reassuring) tally.calm += 1;
  if (open) {
    tally.open += 1;
    if (violations.length > 0) tally.openFired += 1;
    // In a pinned class the one rule fires exactly when the headline is calm.
    if (violations.some((violation) => violation.id === QUIET_OVER_LOUD) !== headline.semantic.reassuring && !tally.fired.has(QUIET_OVER_LOUD)) {
      tally.fired.set(QUIET_OVER_LOUD, { ...(input() as object), pinnedOpen: true, reassuring: headline.semantic.reassuring });
    }
  }
  for (const violation of violations) {
    if (open && violation.id === QUIET_OVER_LOUD) continue;
    if (!tally.fired.has(violation.id)) tally.fired.set(violation.id, { ...(input() as object), story: headline.semantic.story, message: violation.message });
  }
}

/** Every rule held over what a walk gathered, in the rules' own order. */
function holdRules(tally: Tally): void {
  for (const rule of RULES) holds(rule, !tally.fired.has(rule), () => tally.fired.get(rule));
}

function product<T extends Record<string, readonly unknown[]>>(lists: T, visit: (choice: { [K in keyof T]: T[K][number] }) => void): void {
  const keys = Object.keys(lists) as (keyof T)[];
  const choice = {} as { [K in keyof T]: T[K][number] };
  const walk = (index: number): void => {
    if (index === keys.length) return visit(choice);
    for (const value of lists[keys[index]]) {
      choice[keys[index]] = value as T[keyof T][number];
      walk(index + 1);
    }
  };
  walk(0);
}
const sizeOf = (lists: Record<string, readonly unknown[]>) => Object.values(lists).reduce((size, list) => size * list.length, 1);

// ---------------------------------------------------------------------------------------
// ACTIVITY: what one visit recorded.
// ---------------------------------------------------------------------------------------

const ACTIVITY = { services: SERVICES, cookies: COOKIES, fingerprint: FINGERPRINT, listeners: LISTENERS, aliases: ALIASES, shields: SHIELDS, policy: POLICY } as const;
/** The typing test and the pixels lead the headline over everything below them, so they cross fewer classes of the rest. */
const ACTIVITY_LEADS = {
  keystroke: KEYSTROKE, pixels: PIXELS,
  services: ["none", "tracker-1", "platform-1", "consent-platform-own-host"], cookies: ["none", "own-1", "third-party-1"],
  fingerprint: ["none", "heuristic"], listeners: ["none", "session-recording"], shields: ["unmeasured", "matched-10"], policy: POLICY
} as const;

function walkActivity(tally: Tally, headlines: HeadlineModule, boards: FindingsModule): void {
  product(ACTIVITY, (choice) => {
    const visit = { ...QUIET, ...choice };
    hold(tally, viewFromV1Report(resultOf(visit)), pinnedOpen(visit), () => ({ slice: "ACTIVITY", ...choice }), headlines, boards);
  });
}

function walkActivityLeads(tally: Tally, headlines: HeadlineModule, boards: FindingsModule): void {
  product(ACTIVITY_LEADS, (choice) => {
    const visit = { ...QUIET, ...choice };
    hold(tally, viewFromV1Report(resultOf(visit)), pinnedOpen(visit), () => ({ slice: "ACTIVITY_LEADS", ...choice }), headlines, boards);
  });
}

// ---------------------------------------------------------------------------------------
// AVAILABILITY: what the page was, and what the scan could not record.
// ---------------------------------------------------------------------------------------

const SUBJECT = ["requested-page", "http-error", "unverified", "suspected-challenge", "failed-load"] as const;
const LEGACY_GAPS = ["none", "optional-evidence-unrecorded", "budget-exhausted", "fingerprint-observer-lost"] as const;
const DETECTORS = ["fingerprint-heuristics", "keystroke-exfiltration", "cname-uncloaking", "pixel-events", "consent-banner", "privacy-policy"] as const;
const LEDGER = ["all-complete", ...DETECTORS.flatMap((detector) => [`${detector}:partial`, `${detector}:skipped`])] as readonly string[];
const FAMILY_LOSS = ["none", "requests", "cookies", "storage", "fingerprinting", "detector-output", "unsupported"] as const;
const AVAILABILITY_VISITS = {
  services: ["none", "hosts-1", "tracker-1", "operational-1"], cookies: ["none", "third-party-1"],
  fingerprint: ["none", "events", "heuristic"], policy: ["none", "no-checkable-statement"], shields: ["unmeasured", "matched-0"]
} as const;

function withSubject(view: ReportView, subject: (typeof SUBJECT)[number]): void {
  const run = view.runs[0];
  if (subject === "unverified") run.quality.reasons.push("page-subject-unverified");
  if (subject === "suspected-challenge") run.quality.reasons.push("suspected-challenge-or-soft-block");
  if (subject === "failed-load") run.quality.outcome = "failed";
}

const R2_RUN = viewFromV2(makePublicSingleReportV2R2(), 2).runs[0];

/** The r2 form, set on the view: every detector complete but the one named, every family complete but the one named. */
function asRecorded(view: ReportView, ledger: string, loss: (typeof FAMILY_LOSS)[number]): void {
  const run = view.runs[0];
  const [named, status] = ledger.split(":");
  run.unrecordedEvidence = [];
  run.detectors = Object.fromEntries(
    DETECTORS.map((detector) => [detector, { ...(R2_RUN.detectors as NonNullable<RunView["detectors"]>)[detector], status: detector === named ? status : "complete", reason: detector === named ? "probe-disabled" : null }])
  ) as RunView["detectors"];
  const lost = loss === "none" ? [] : loss === "unsupported" ? (["cookies", "storage", "fingerprinting", "detector-output"] as const) : [loss];
  const families = ["requests", "cookies", "storage", "fingerprinting", "detector-output", "consent-verification"] as const;
  run.quality = {
    origin: "recorded",
    outcome: run.quality.outcome,
    reasons: [...run.quality.reasons],
    byFamily: Object.fromEntries(families.map((family) => [family, (lost as readonly string[]).includes(family) ? { outcome: "censored" as const, reasons: ["capture-loss"] } : { outcome: "complete" as const, reasons: [] }])),
    facts: {
      botWallTitleMatched: false,
      navigationSettled: true,
      budgetsExhausted: [],
      captureLoss: lost.map((family) => ({ family, phaseId: null, kind: "dropped" as const, count: 1, ...(loss === "unsupported" ? { detail: "pagegraph-unsupported" } : {}) }))
    }
  };
}

function walkAvailability(tally: Tally, headlines: HeadlineModule, boards: FindingsModule): void {
  product({ subject: SUBJECT, ...AVAILABILITY_VISITS }, (choice) => {
    const visit: Visit = { ...QUIET, ...choice, status: choice.subject === "http-error" ? 403 : 200 };
    for (const gap of LEGACY_GAPS) {
      const result = resultOf(visit);
      if (gap === "optional-evidence-unrecorded") {
        delete result.fingerprintDetections;
        delete result.pixelEvents;
        delete result.cnameCloaks;
        delete result.privacyPolicy;
      }
      const view = viewFromV1Report(result);
      withSubject(view, choice.subject);
      if (gap === "budget-exhausted") view.runs[0].quality.reasons.push("budget-exhausted:requests");
      if (gap === "fingerprint-observer-lost") view.runs[0].quality.reasons.push("capture-loss:fingerprint-observer");
      hold(tally, view, false, () => ({ slice: "AVAILABILITY", form: "v1", gap, ...choice }), headlines, boards);
    }
    for (const ledger of LEDGER) {
      for (const loss of FAMILY_LOSS) {
        const view = viewFromV1Report(resultOf(visit));
        withSubject(view, choice.subject);
        asRecorded(view, ledger, loss);
        hold(tally, view, false, () => ({ slice: "AVAILABILITY", form: "r2", ledger, loss, ...choice }), headlines, boards);
      }
    }
  });
}
const AVAILABILITY_SIZE = sizeOf({ subject: SUBJECT, ...AVAILABILITY_VISITS }) * (LEGACY_GAPS.length + LEDGER.length * FAMILY_LOSS.length);

// ---------------------------------------------------------------------------------------
// PAIRS: two visits, joined by the real comparison constructors.
// ---------------------------------------------------------------------------------------

const ARM = { status: [200, 403], services: ["none", "tracker-1", "platform-1", "tracker-6"], padding: [0, 1, 40], cookies: ["none", "third-party-1"] } as const;
const DESIGNS = ["gpc", "shields-none-stopped", "shields-5-stopped", "shields-50-stopped", "consent-both-clicked", "consent-accept-only", "consent-reject-only", "consent-neither", "before-after"] as const;

function pairOf(design: (typeof DESIGNS)[number], baseline: ScanResult, variant: ScanResult): ReportView {
  if (design === "gpc") {
    variant.conditions.gpcEnabled = true;
    return viewFromV1Report(createGpcComparisonReport(baseline, variant));
  }
  if (design === "before-after") {
    variant.conditions.scannedAt = "2026-07-10T10:00:00.000Z";
    return viewFromV1Report(createTemporalComparisonReport(baseline, variant));
  }
  if (design.startsWith("shields")) {
    variant.conditions.shieldsMode = "block-simulation";
    variant.conditions.adblock = { active: true, source: "Brave default ad-block lists", lists: 31, fetchedAt: "2026-07-09T09:00:00.000Z" };
    variant.summary.shieldsBlockedRequests = { "shields-none-stopped": 0, "shields-5-stopped": 5, "shields-50-stopped": 50 }[design as "shields-none-stopped" | "shields-5-stopped" | "shields-50-stopped"];
    return viewFromV1Report(createShieldsComparisonReport(baseline, variant));
  }
  baseline.conditions.consentMode = "accept-all";
  baseline.consentInteraction = { mode: "accept-all", clicked: design === "consent-both-clicked" || design === "consent-accept-only" };
  variant.conditions.consentMode = "reject-all";
  variant.consentInteraction = { mode: "reject-all", clicked: design === "consent-both-clicked" || design === "consent-reject-only" };
  return viewFromV1Report(createConsentComparisonReport(baseline, variant));
}

function walkPairs(tally: Tally, headlines: HeadlineModule, boards: FindingsModule): void {
  for (const design of DESIGNS) {
    product(ARM, (baseline) => {
      const first = { ...baseline };
      product(ARM, (variant) => {
        const view = pairOf(design, resultOf({ ...QUIET, ...first }), resultOf({ ...QUIET, ...variant }));
        hold(tally, view, false, () => ({ slice: "PAIRS", design, baseline: first, variant: { ...variant } }), headlines, boards);
      });
    });
  }
}
const PAIRS_SIZE = DESIGNS.length * sizeOf(ARM) ** 2;

// ---------------------------------------------------------------------------------------
// CONSENT: the r2 consent pair, with a verified choice.
// ---------------------------------------------------------------------------------------

const CONSENT = {
  acceptTracker: [false, true], rejectTracker: [false, true],
  acceptChoice: ["as-recorded", "contradicted", "not-activated"], rejectChoice: ["as-recorded", "contradicted", "not-activated"],
  pair: ["as-recorded", "denied"], rawCounts: ["as-recorded", "denied"], classification: ["as-recorded", "denied"],
  rejectRequests: ["complete", "censored"]
} as const;

function consentPair(choice: { [K in keyof typeof CONSENT]: (typeof CONSENT)[K][number] }): ReportView {
  const view = viewFromV2(makeConsentInterventionReportV2R2(), 2);
  const [accept, reject] = [view.runs[0], view.runs[view.runs.length - 1]];
  const match = tracker("Example Analytics", "metrics.example.net", "analytics");
  const contact = (run: RunView): void => {
    run.evidence.domains = [...run.evidence.domains, { domain: match.domain, requests: 1, thirdParty: true, tracker: match, statuses: [200], resourceTypes: ["script"] }];
    run.evidence.requests = [...run.evidence.requests, { id: 99, url: `https://${match.domain}/collect`, domain: match.domain, method: "GET", resourceType: "script", status: 200, thirdParty: true, tracker: match, startedAtMs: 1 }];
    run.counts.totalRequests += 1;
    run.counts.knownTrackerRequests += 1;
    run.counts.thirdPartyRequests += 1;
    run.counts.thirdPartyDomains += 1;
  };
  if (choice.acceptTracker) contact(accept);
  if (choice.rejectTracker) contact(reject);
  for (const [run, state] of [[accept, choice.acceptChoice], [reject, choice.rejectChoice]] as const) {
    assert.ok(run.consent, "the fixture's visits record a consent interaction");
    if (state === "contradicted") run.consent.choiceState = "contradicted";
    if (state === "not-activated") run.consent.controlActivated = false;
  }
  const denied = { allowed: false, reasons: ["denied by the suite"] };
  assert.ok(view.claims.familyDeltas && view.claims.pairComparison, "the fixture's pair carries its gates");
  if (choice.rawCounts === "denied") view.claims.familyDeltas["raw-counts"] = denied;
  if (choice.classification === "denied") view.claims.familyDeltas["tracker-classification"] = denied;
  if (choice.pair === "denied") {
    view.claims.pairComparison = denied;
    for (const family of Object.keys(view.claims.familyDeltas) as (keyof typeof view.claims.familyDeltas)[]) view.claims.familyDeltas[family] = denied;
  }
  if (choice.rejectRequests === "censored") {
    assert.ok(reject.quality.byFamily && reject.quality.facts, "the fixture's visits record their quality");
    reject.quality.byFamily.requests = { outcome: "censored", reasons: ["capture-loss"] };
    reject.quality.facts.captureLoss.push({ family: "requests", phaseId: null, kind: "dropped", count: 1 });
  }
  return view;
}

function walkConsent(tally: Tally, headlines: HeadlineModule, boards: FindingsModule): void {
  product(CONSENT, (choice) => hold(tally, consentPair(choice), false, () => ({ slice: "CONSENT", ...choice }), headlines, boards));
}

/**
 * What a seeded fault is walked over: every slice but the larger activity product, which
 * production alone walks. Each fault names what fired over these and nothing wider.
 */
function walkForFaults(headlines: HeadlineModule, boards: FindingsModule): Tally {
  const tally = newTally();
  walkActivityLeads(tally, headlines, boards);
  walkAvailability(tally, headlines, boards);
  walkPairs(tally, headlines, boards);
  walkConsent(tally, headlines, boards);
  return tally;
}

// ---------------------------------------------------------------------------------------
// The checks on production.
// ---------------------------------------------------------------------------------------

const STORIES = new Set<string>();
const seen = (tally: Tally): Tally => {
  for (const story of tally.stories) STORIES.add(story);
  return tally;
};

test("RC: no rule fires on any visit of the activity slice, outside the two classes pinned open", () => {
  const tally = newTally();
  walkActivity(tally, productionHeadline, productionFindings);
  walkActivityLeads(tally, productionHeadline, productionFindings);
  holdRules(seen(tally));
  assert.equal(tally.views, sizeOf(ACTIVITY) + sizeOf(ACTIVITY_LEADS));
  // The slice reaches the calm headline, and in the pinned classes the rule fires on exactly the calm ones.
  assert.ok(tally.calm > 0 && tally.open > tally.openFired && tally.openFired > 0, JSON.stringify({ calm: tally.calm, open: tally.open, openFired: tally.openFired }));
});

test("RC: no rule fires on any visit of the availability slice, whatever the page was and whatever the scan could not record", () => {
  const tally = newTally();
  walkAvailability(tally, productionHeadline, productionFindings);
  holdRules(seen(tally));
  assert.equal(tally.views, AVAILABILITY_SIZE);
  assert.equal(tally.open, 0);
});

test("RC: no rule fires on any pair the real comparison constructors join, over each design", () => {
  const tally = newTally();
  walkPairs(tally, productionHeadline, productionFindings);
  holdRules(seen(tally));
  assert.equal(tally.views, PAIRS_SIZE);
});

test("RC: no rule fires on the consent pair, over each choice state, gate and tracker", () => {
  const tally = newTally();
  walkConsent(tally, productionHeadline, productionFindings);
  holdRules(seen(tally));
  assert.equal(tally.views, sizeOf(CONSENT));
});

// Reads what the four tests above gathered, so it holds only when they ran before it, as they do in this file's order.
test("the four slices above reached these headline stories, and no other", () => {
  assert.deepEqual(
    [...STORIES].sort(),
    [
      "comparison", "consent", "cookies", "fingerprint-api", "incomplete-evidence", "interstitial", "keystroke-transmission",
      "listener-coverage", "load-failure", "observed-activity", "pixel-identifiers", "quiet", "raw-fingerprint-events", "shields", "subject-unverified",
      "unidentified-cross-site", "unsupported-evidence"
    ]
  );
});

test("the walk's own composition gives what validateReportPresentation gives, on the slices' corners", () => {
  for (const visit of [QUIET, { ...QUIET, services: "platform-3" as const, cookies: "third-party-12" as const }, { ...QUIET, status: 403 }, { ...QUIET, policy: "says-no-cookies" as const, cookies: "own-1" as const }]) {
    const view = viewFromV1Report(resultOf(visit));
    const own = present(view, productionHeadline, productionFindings);
    const real = validateReportPresentation(view);
    assert.deepEqual(own.violations, real.violations);
    assert.deepEqual(own.headline, real.headline);
    assert.deepEqual(own.findings, real.findings);
  }
  for (const view of [pairOf("gpc", resultOf({ ...QUIET, services: "tracker-1", padding: 40 }), resultOf({ ...QUIET, services: "tracker-1" })), consentPair({ acceptTracker: true, rejectTracker: true, acceptChoice: "as-recorded", rejectChoice: "as-recorded", pair: "as-recorded", rawCounts: "as-recorded", classification: "as-recorded", rejectRequests: "complete" })]) {
    assert.deepEqual(present(view, productionHeadline, productionFindings).violations, validateReportPresentation(view).violations);
  }
});

// ---------------------------------------------------------------------------------------
// The two classes pinned open.
// ---------------------------------------------------------------------------------------

test("open (RC): a calm headline over a policy that says no cookies are used, beside a cookie the visit recorded", () => {
  const { headline, findings, violations } = validateReportPresentation(viewFromV1Report(resultOf({ ...QUIET, policy: "says-no-cookies", cookies: "own-1" })));
  assert.equal(headline.semantic.story, "quiet");
  assert.equal(headline.semantic.reassuring, true);
  assert.deepEqual(findings.filter((finding) => finding.level !== "ok").map((finding) => [finding.id, finding.level, finding.icon]), [["bottom-line", "warn", "alert"], ["privacy-policy", "warn", "file-text"]]);
  assert.deepEqual(violations.map((violation) => violation.id), [QUIET_OVER_LOUD, QUIET_OVER_LOUD]);
});

test("open (RC): a calm headline over a consent platform on the site's own host", () => {
  const { headline, findings, violations } = validateReportPresentation(viewFromV1Report(resultOf({ ...QUIET, services: "consent-platform-own-host", policy: "no-checkable-statement" })));
  assert.equal(headline.semantic.story, "quiet");
  assert.equal(headline.semantic.reassuring, true);
  assert.deepEqual(findings.filter((finding) => finding.level !== "ok").map((finding) => [finding.id, finding.level, finding.icon]), [["bottom-line", "info", "alert"], ["consent-banner", "info", "cookie"], ["privacy-policy", "info", "file-text"]]);
  assert.deepEqual(violations.map((violation) => violation.id), [QUIET_OVER_LOUD]);
});

// ---------------------------------------------------------------------------------------
// Seeded faults: each rule fires, and what else fires with it.
// ---------------------------------------------------------------------------------------

const headlinePath = require.resolve("./report-headline");
const findingsPath = require.resolve("./report-findings");
const headlineVariant = (...edits: SourceEdit[]) => loadVariant<HeadlineModule>(headlinePath, edits);
const findingsVariant = (...edits: SourceEdit[]) => loadVariant<FindingsModule>(findingsPath, edits);

type Fault = Readonly<{ name: string; rule: ReportConsistencyRuleId; alsoFires: readonly ReportConsistencyRuleId[]; in: "headline" | "findings"; find: string; replace: string }>;

const FAULTS: readonly Fault[] = [
  {
    name: "the listener story is told as the fingerprint story",
    rule: "fingerprint-asserted-without-events", alsoFires: [], in: "headline",
    find: 'story: "listener-coverage",', replace: 'story: "fingerprint-api",'
  },
  {
    name: "the cookie card claims an absence whatever it counted",
    rule: "cookie-absence-with-recorded-cookie", alsoFires: [], in: "findings",
    find: 'cookiesUnsupported ? "unavailable" : run.counts.thirdPartyCookies > 0 ? "presence" : "absence"', replace: 'cookiesUnsupported ? "unavailable" : "absence"'
  },
  {
    name: "the bottom line is an alert whatever the board holds",
    rule: "quiet-copy-over-loud-finding", alsoFires: [], in: "findings",
    find: 'icon: quietEnough && !censoredQuiet && !unsupportedQuiet ? "check" : "alert"', replace: 'icon: "alert"'
  },
  {
    name: "the services card claims an absence beside an operational service",
    rule: "identity-conflict", alsoFires: [], in: "findings",
    find: "trackingCnameNames.length > 0 ||\n            operationalEntities.length > 0 ||\n            unclassifiedEntities.length > 0 ||\n            nonCatalogIdentityNames.length > 0\n            ? \"presence\"",
    replace: "trackingCnameNames.length > 0 ||\n            unclassifiedEntities.length > 0 ||\n            nonCatalogIdentityNames.length > 0\n            ? \"presence\""
  },
  {
    name: "an absence is categorical whatever its fact gate says",
    rule: "unsafe-categorical-title-under-incomplete-evidence", alsoFires: [], in: "findings",
    find: 'eligibility.allowed\n                    ? "categorical-absence"\n                    : "qualified-absence"', replace: '"categorical-absence"'
  },
  {
    name: "the headline claims a fingerprint absence its fact gate closes",
    rule: "unsafe-categorical-title-under-incomplete-evidence", alsoFires: [], in: "headline",
    find: 'if (facts.claims["fingerprint-apis"].allowed &&\n        run.counts.fingerprintEvents === 0 &&', replace: "if (run.counts.fingerprintEvents === 0 &&"
  },
  {
    name: "a closed fact gate keeps the categorical lead",
    rule: "unscoped-absence-lead-under-incomplete-evidence", alsoFires: [], in: "findings",
    find: 'leadScope: "retained-evidence"', replace: 'leadScope: "categorical"'
  },
  {
    name: "a card speaks of the requested page whatever was returned",
    rule: "error-page-signals-attributed-to-site", alsoFires: [], in: "findings",
    find: 'scope: facts.subject.describesSubject ? "requested-page" : "returned-document"', replace: 'scope: "requested-page"'
  },
  {
    name: "the headline never leads with the consent comparison",
    rule: "headline-describes-another-visit", alsoFires: [], in: "headline",
    find: "if (comparisonUsable &&\n        arms &&\n        axis === \"consent\" &&\n        (0, report_consent_copy_1.consentChoiceVerified)(arms.baseline.consent) &&", replace: "if (false &&\n        arms &&\n        axis === \"consent\" &&\n        (0, report_consent_copy_1.consentChoiceVerified)(arms.baseline.consent) &&"
  }
];

test("every rule has a seeded fault", () => {
  assert.deepEqual([...new Set(FAULTS.map((fault) => fault.rule))].sort(), [...RULES].sort());
});

for (const fault of FAULTS) {
  test(`RC catches a variant: ${fault.name}`, async () => {
    const edit = { find: fault.find, replace: fault.replace };
    const tally = fault.in === "headline" ? walkForFaults(headlineVariant(edit), productionFindings) : walkForFaults(productionHeadline, findingsVariant(edit));
    // What fires with it is written out beside each fault, so an overlap between rules is on record and a new one fails.
    assert.deepEqual([...tally.fired.keys()].sort(), [fault.rule, ...fault.alsoFires].sort());
    await assertCaughtBy(fault.name, fault.rule, () => holds(fault.rule, !tally.fired.has(fault.rule), () => tally.fired.get(fault.rule)));
  });
}
