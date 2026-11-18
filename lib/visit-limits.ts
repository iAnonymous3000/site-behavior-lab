import { findingCardDomId, type EvidenceArm } from "./report-evidence-navigation";
import type { ReportClaimId, ReportFacts, RunFacts } from "./report-facts";
import type { ReportView, RunView } from "./scan-report-views";

/*
 * What a visit could not see, as the limits a report states: the leads and
 * their sentences. A module of its own so that a result with no report page
 * (a scan's result on the homepage, a report opened from a file) can state
 * the leads in its figure's "Not measured" row from the same source as the
 * report page. It reads a visit's warnings, its claims' blockers and its
 * labels, and nothing else: no consent, censorship, egress or scroll-check
 * module, so it may ship in the evidence renderer's chunk.
 * lib/report-visit-summary.ts builds the report page's lists from it and
 * adds the scroll-check entry there.
 */

/** A run of text, linked to a findings card when `cardId` is set. */
export type ReportVisitTextSegment = { text: string; cardId?: string };

export type ReportVisitLimitId =
  | "other-pages"
  | "other-visitors"
  | "after-interaction"
  | "catalog"
  | "incomplete-checks";

/** A limit as this module builds it; the report page's summary may add an entry to it. */
export type VisitLimit = {
  id: ReportVisitLimitId;
  lead: string;
  body: ReportVisitTextSegment[];
};

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

// The scanner's own disclosures, matched by the clauses the limits restate.
// lib/report-visit-summary.test.ts holds each one to the admitted vocabulary.
export const FIXED_PROFILE_CLAUSE = "from a fixed en-US / UTC profile";
export const OTHER_VISITORS_CLAUSE =
  "Sites can behave differently for real users, browsers, regions, accounts, or network locations.";
export const LOWER_BOUND_SENTENCE_START = "Counts are a lower bound: ";
export const AFTER_INTERACTION_CLAUSE = "trackers that load only after interaction or consent";
export const AFTER_FURTHER_INTERACTION_CLAUSE = "trackers that load only after further interaction";
export const CATALOG_BIAS_CLAUSE =
  "Service labels use a US-biased hand-curated catalog, so regional services may be under-labeled.";
export const POLICY_READ_DISCLOSURE = /^Read the site's privacy policy \(.+\) and compared its text against this visit's observed behavior\./;

export type ArmRun = { run: RunView; facts: RunFacts; label: string };

export function armLabel(view: ReportView, run: RunView): string {
  if (run.label === "baseline") return view.comparison?.runLabels.baseline ?? "baseline";
  if (run.label === "variant") return view.comparison?.runLabels.variant ?? "variant";
  return "recorded";
}

/** "the No blocking visit" */
export function theVisit(arm: ArmRun): string {
  return `the ${arm.label} visit`;
}

export function everyRunCarries(arms: readonly ArmRun[], test: (warning: string) => boolean): boolean {
  return arms.length > 0 && arms.every((arm) => arm.run.warnings.some(test));
}

/** The arms of a report as the limits read them, and whether it is a comparison. */
export function visitArms(view: ReportView, facts: ReportFacts): { arms: ArmRun[]; comparison: boolean } {
  const comparison = view.reportType === "comparison" && view.runs.length === 2 && view.comparison !== null;
  return {
    comparison,
    arms: view.runs.map((run, index) => ({ run, facts: facts.runs[index], label: armLabel(view, run) }))
  };
}

/**
 * The leads of what a visit could not see, without their full stop: the
 * figure's "Not measured" row, on a report page and on a result elsewhere.
 */
export function notMeasuredLeads(input: {
  view: ReportView;
  facts: ReportFacts;
  findings: readonly { id: string }[];
  evidenceArm: EvidenceArm | undefined;
}): string[] {
  const { arms, comparison } = visitArms(input.view, input.facts);
  return visitLimits(arms, comparison, input.findings, input.evidenceArm).map((limit) => limit.lead.replace(/\.$/, ""));
}

export function visitLimits(
  arms: readonly ArmRun[],
  comparison: boolean,
  findings: readonly { id: string }[],
  evidenceArm: EvidenceArm | undefined
): VisitLimit[] {
  const out: VisitLimit[] = [];
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
      } else if (group.except.length > 0) {
        body.push({ text: `every check except ${group.except.join(" and ")}` });
      } else {
        const chunks = sentenceChunks(group.intro, group.checks);
        chunks.forEach((chunk, chunkIndex) => {
          if (chunkIndex > 0) body.push({ text: `. ${group.intro}` });
          chunk.forEach((check, index) => {
            if (index > 0) body.push({ text: index === chunk.length - 1 ? " and " : ", " });
            body.push(check.cardId ? { text: check.label, cardId: check.cardId } : { text: check.label });
          });
        });
      }
      body.push({ text: "." });
    });
    if (groups.some((group) => group.every && group.onBoard)) {
      body.push({ text: " Every card below states only what was retained." });
    } else if (groups.some((group) => group.except.length > 0 && group.onBoard)) {
      body.push({ text: " The cards for the incomplete checks state only what was retained." });
    } else if (groups.some((group) => group.checks.some((check) => check.cardId))) {
      body.push({ text: " Each linked card states what was retained." });
    }
    out.push({ id: "incomplete-checks", lead: "Checks with incomplete evidence.", body });
  }
  return out;
}

/** At most this many unaffected checks are named as exceptions to "every check". */
const MAX_NAMED_EXCEPTIONS = 2;

/**
 * No sentence of a limit runs past this many words; the corpus guard in
 * lib/report-visit-summary.test.ts holds every report to it, and the limit
 * is never raised to fit a list.
 */
const MAX_LIMIT_SENTENCE_WORDS = 30;

/** Words in "<intro>a, b and c.", counted the way the guard counts them. */
function listSentenceWords(intro: string, labels: readonly string[]): number {
  const list = labels
    .map((label, index) => `${index === 0 ? "" : index === labels.length - 1 ? " and " : ", "}${label}`)
    .join("");
  return (`${intro}${list}.`.match(/\S+/g) ?? []).length;
}

/**
 * A group's named checks as the fewest sentences that each fit the limit,
 * split as evenly as the list allows and in its own order; every sentence
 * repeats the group's intro, so each still says which visit lost the checks.
 * A list that grows with what a visit lost cannot be bounded by its corpus:
 * nike.com on 2026-11-18 lost nine checks in one visit only and its single
 * sentence ran to 31 words. One check per sentence is the floor.
 */
function sentenceChunks<T extends { label: string }>(intro: string, checks: readonly T[]): T[][] {
  for (let count = 1; count <= checks.length; count += 1) {
    const chunks = Array.from({ length: count }, (_, index) =>
      checks.slice(Math.ceil((index * checks.length) / count), Math.ceil(((index + 1) * checks.length) / count))
    );
    if (chunks.every((chunk) => listSentenceWords(intro, chunk.map((check) => check.label)) <= MAX_LIMIT_SENTENCE_WORDS)) {
      return chunks;
    }
  }
  return checks.map((check) => [check]);
}

type CutShortCheck = { claim: ReportClaimId; label: string; cardId: string | null };
type CutShortGroup = {
  intro: string;
  /** Every claim was cut short, so the group names no single check. */
  every: boolean;
  /**
   * The one or two checks NOT cut short, when every other check was. A lost
   * request log cuts nearly every check at once, and naming eleven of twelve
   * ran the sentence past what a reader can hold; naming the exceptions says
   * the same thing in a line. Empty when the group names its checks.
   */
  except: string[];
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
    const unaffected = allClaims.filter((claim) => !claims.includes(claim));
    return {
      intro,
      every: claims.length === allClaims.length,
      except:
        unaffected.length > 0 && unaffected.length <= MAX_NAMED_EXCEPTIONS && claims.length > MAX_NAMED_EXCEPTIONS
          ? [...unaffected].sort((left, right) => position(left) - position(right)).map((claim) => VISIT_CHECK_LABELS[claim])
          : [],
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
  // Two visits that lost exactly the same checks are one sentence, whatever
  // its form.
  if (lost.every((claims) => claims.length === lost[0].length && claims.every((claim) => lost[0].includes(claim)))) {
    return [group("In both visits: ", arms, lost[0])].filter((entry): entry is CutShortGroup => entry !== null);
  }
  // A visit that lost every check, or all but one or two, is stated whole,
  // beside whatever the other visit lost, rather than split across a shared
  // and an "only" group. Split, its "only" group would either list nearly
  // every check or name as an exception a check the shared group had just
  // called incomplete in both visits.
  const lostNearlyAll = (claims: readonly ReportClaimId[]): boolean =>
    claims.length > MAX_NAMED_EXCEPTIONS && claims.length >= allClaims.length - MAX_NAMED_EXCEPTIONS;
  if (lost.some(lostNearlyAll)) {
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
