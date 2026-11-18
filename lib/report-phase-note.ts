import { consentChoiceLabel } from "./consent-interaction";
import { HEADLINE_PLATFORMS } from "./headline-platforms";
import type { RunFacts } from "./report-facts";
import { isTrackingEntity } from "./report-insights";
import {
  crossSitePhaseSplit,
  recordedScannerActions,
  type CrossSitePhaseSplit,
  type RecordedScannerAction,
  type RecordedScannerActions,
  type ScannerActionPhase
} from "./report-phase-split";
import type { ConsentMode } from "./types";

/**
 * The words the report prints about when its counted cross-site requests
 * were recorded, relative to the scanner's own actions (owner packet
 * 2026-11-18, items H-A5.T, H-15.1, H-15.3 and H-A20).
 *
 * One note string per split. The headline's subhead and share text and the
 * findings board's cards each read the value this module returns, so the same
 * rows are never described two ways. A phase records when a request started,
 * never why or what it carried, so no sentence here says the scanner caused a
 * request or that a request carried what was typed.
 */

export const PHASE_TIMING_SENTENCE = "A phase records timing, not cause or content.";
const TIMER_SENTENCE = "Pages also send requests on timers.";

/** A counted thing's noun, singular and plural. */
export type NoteNoun = { one: string; many: string };

export const CROSS_SITE_REQUESTS: NoteNoun = { one: "cross-site request", many: "cross-site requests" };
export const PLATFORM_REQUESTS: NoteNoun = { one: "request to these platforms", many: "requests to these platforms" };
export const TRACKING_SERVICE_ENTITIES: NoteNoun = {
  one: "catalogued tracking-service entity",
  many: "catalogued tracking-service entities"
};
export const CATALOGUED_PLATFORMS: NoteNoun = { one: "catalogued platform", many: "catalogued platforms" };

const counted = (count: number, noun: NoteNoun) => `${count} ${count === 1 ? noun.one : noun.many}`;

function consentPhrase(mode: ConsentMode | null): string | null {
  return mode === "accept-all" || mode === "reject-all" ? `the scanner clicked ${consentChoiceLabel(mode)}` : null;
}

/**
 * "during the scanner's typing probe", "after the scanner clicked Reject all",
 * or both, in phase order. A post-choice reload belongs to the click; its
 * requests are not recorded at all.
 */
function whenRecorded(actions: readonly ScannerActionPhase[], consentMode: ConsentMode | null, clickedControl: boolean): string | null {
  const parts: string[] = [];
  // "After the scanner clicked" only where the record shows the click; rows
  // from a consent phase whose control was never activated get no wording.
  const clicked = clickedControl ? consentPhrase(consentMode) : null;
  if ((actions.includes("consent-interaction") || actions.includes("post-choice-reload")) && !clicked && actions.every((action) => action === "consent-interaction" || action === "post-choice-reload")) {
    return null;
  }
  if ((actions.includes("consent-interaction") || actions.includes("post-choice-reload")) && clicked) parts.push(`after ${clicked}`);
  if (actions.includes("active-probe")) parts.push(parts.length > 0 ? "during its typing probe" : "during the scanner's typing probe");
  if (actions.includes("policy-analysis")) {
    parts.push(parts.length > 0 ? "while it read the privacy policy" : "while the scanner read the privacy policy");
  }
  return parts.length > 0 ? parts.join(" or ") : null;
}

function unknownActionsText(kinds: readonly RecordedScannerAction[]): string | null {
  if (kinds.includes("consent click") && kinds.includes("typing probe")) return "consent click or typing probe";
  if (kinds.includes("consent click")) return "consent click";
  if (kinds.includes("typing probe")) return "typing probe";
  return null;
}

/** The entity clause of a mixed note: the claim's own named set, counted by its own split. */
export type NoteEntities = { split: CrossSitePhaseSplit; total: number; noun: NoteNoun };

/**
 * The note for one split, or null where there is nothing to say (page load
 * only, no rows, no action recorded). The unknown note has one sentence and
 * no timing sentence: it states that no phase was recorded.
 */
export function phaseNote(
  split: CrossSitePhaseSplit,
  input: { noun: NoteNoun; consentMode: ConsentMode | null; recorded: RecordedScannerActions; entities?: NoteEntities }
): string | null {
  if (split.state === "unknown-after-action") {
    const actions = unknownActionsText(input.recorded.kinds);
    return actions ? `This older report does not record which requests came during the scanner's ${actions}.` : null;
  }
  if (split.state !== "mixed" && split.state !== "all-after-action") return null;
  const when = whenRecorded(split.actions, input.consentMode, input.recorded.consentClick);
  if (!when) return null;
  const { total, afterAction } = split.requests;
  if (split.requestsCensored) {
    return `Recorded ${when}: ${afterAction} of the ${total} retained ${total === 1 ? input.noun.one : input.noun.many}. ${PHASE_TIMING_SENTENCE}`;
  }
  if (split.state === "all-after-action") {
    return `All ${counted(total, input.noun)} ${total === 1 ? "was" : "were"} recorded ${when}, none during the initial page load. ${PHASE_TIMING_SENTENCE} ${TIMER_SENTENCE}`;
  }
  const only = input.entities?.split.entities.onlyAfterAction.length ?? 0;
  const clause =
    input.entities && only > 0
      ? `, including every request to ${only} of the visit's ${counted(input.entities.total, input.entities.noun)}`
      : "";
  return `Recorded ${when}: ${afterAction} of the ${counted(total, input.noun)}${clause}. ${PHASE_TIMING_SENTENCE}`;
}

/**
 * The lead of a visit with no phases whose record shows a scanner action:
 * "The log of the <site> visit labeled <label>, which included <actions>,
 * lists <claim>." (a single visit: "The log of this <site> visit, ...").
 */
export function unknownPhaseLead(site: string, visitLabel: string | null, kinds: readonly RecordedScannerAction[], claim: string): string | null {
  const included =
    kinds.includes("consent click") && kinds.includes("typing probe")
      ? "a consent click and a typing probe"
      : kinds.includes("consent click")
        ? "a consent click"
        : kinds.includes("typing probe")
          ? "a typing probe"
          : null;
  if (!included) return null;
  return visitLabel
    ? `The log of the ${site} visit labeled ${visitLabel}, which included ${included}, lists ${claim}.`
    : `The log of this ${site} visit, which included ${included}, lists ${claim}.`;
}

/**
 * The caveat for a comparison whose two visits recorded different scanner
 * actions, or null when they recorded the same. On a comparison of the
 * consent choice the click is the compared variable, so only typing counts.
 */
export function pairActionCaveat(
  arms: { baseline: RecordedScannerActions; variant: RecordedScannerActions },
  labels: { baseline: string; variant: string },
  axis: string | null
): string | null {
  const relevant = (kinds: readonly RecordedScannerAction[]) => (axis === "consent" ? kinds.filter((kind) => kind !== "consent click") : [...kinds]);
  const baseline = relevant(arms.baseline.kinds);
  const variant = relevant(arms.variant.kinds);
  const onlyBaseline = baseline.filter((kind) => !variant.includes(kind));
  const onlyVariant = variant.filter((kind) => !baseline.includes(kind));
  if (onlyBaseline.length === 0 && onlyVariant.length === 0) return null;
  const setting = axis === "shields" ? "blocking" : axis === "gpc" ? "the privacy signal" : "the compared setting";
  if (onlyBaseline.length > 0 && onlyVariant.length > 0) {
    return `The two visits recorded different scanner actions; part of this difference may come from them, not ${setting}.`;
  }
  const [label, only] = onlyBaseline.length > 0 ? [labels.baseline, onlyBaseline] : [labels.variant, onlyVariant];
  const action = only.length === 2 ? "the scanner's consent click and typing probe" : `the scanner's ${only[0]}`;
  return `Only the visit labeled ${label} recorded ${action}; part of this difference may come from ${only.length === 2 ? "them" : "it"}, not ${setting}.`;
}

/** The first sentence of a text, up to and including its first full stop followed by a space or the end. */
export function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end < 0 ? text : text.slice(0, end + 1);
}

/** A text with the note placed after its first sentence. */
export function withNoteAfterFirstSentence(text: string, note: string): string {
  const first = firstSentence(text);
  const rest = text.slice(first.length).trimStart();
  return rest ? `${first} ${note} ${rest}` : `${first} ${note}`;
}

export type RunPhaseNotes = {
  recorded: RecordedScannerActions;
  /** All counted cross-site rows. */
  crossSite: CrossSitePhaseSplit;
  /** Rows to the visit's catalogued tracking-service entities, the set the subhead counts. */
  tracking: CrossSitePhaseSplit;
  trackingNames: string[];
  /** Rows to the visit's catalogued headline platforms, the platforms card's set. */
  platforms: CrossSitePhaseSplit;
  platformNames: string[];
  /** Each headline platform's own rows, for a lead that names platforms one by one. */
  perPlatform: ReadonlyMap<string, CrossSitePhaseSplit>;
  /** The note for the subhead, the services card and the share text. */
  note: string | null;
  /** The note for the platforms card, from its own rows. */
  platformsNote: string | null;
};

/**
 * Every phase note one visit's surfaces print, from one place. The headline
 * and the findings board both call this for the run they describe.
 */
export function runPhaseNotes(facts: Pick<RunFacts, "run" | "identity" | "evidence">): RunPhaseNotes {
  const run = facts.run;
  const recorded = recordedScannerActions(run);
  const requestsCensored = facts.evidence.requests.state === "censored";
  const trackingNames = facts.identity.ownership.otherOrUnreviewed.filter(isTrackingEntity).map((entity) => entity.entity);
  const platformNames = trackingNames.filter((name) => HEADLINE_PLATFORMS.includes(name));
  const split = (claimRows?: (request: RunFacts["run"]["evidence"]["requests"][number]) => boolean) =>
    crossSitePhaseSplit(run, { claimRows, requestsCensored, unphased: recorded });
  const toNamed = (names: readonly string[]) => (request: RunFacts["run"]["evidence"]["requests"][number]) =>
    request.thirdParty && request.tracker !== null && names.includes(request.tracker.entity);
  const crossSite = split();
  const tracking = split(toNamed(trackingNames));
  const platforms = split(toNamed(platformNames));
  const perPlatform = new Map(platformNames.map((name) => [name, split(toNamed([name]))] as const));
  const consentMode = run.conditions.consentMode as ConsentMode;
  return {
    recorded,
    crossSite,
    tracking,
    trackingNames,
    platforms,
    platformNames,
    perPlatform,
    note: phaseNote(crossSite, {
      noun: CROSS_SITE_REQUESTS,
      consentMode,
      recorded,
      entities: { split: tracking, total: trackingNames.length, noun: TRACKING_SERVICE_ENTITIES }
    }),
    platformsNote: phaseNote(platforms, {
      noun: PLATFORM_REQUESTS,
      consentMode,
      recorded,
      entities: { split: platforms, total: platformNames.length, noun: CATALOGUED_PLATFORMS }
    })
  };
}
