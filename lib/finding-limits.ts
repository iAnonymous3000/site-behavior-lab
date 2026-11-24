/**
 * The one-sentence limit of a findings card: the sentence that says what the
 * card's claim does not establish, and the rest of the card's explanatory
 * string as the text behind it.
 *
 * A card's `detail` stays one string and every surface that prints it still
 * can. This module adds the two-part form for the cards whose limit sentence
 * was approved, and only for them: a card with no approved limit carries no
 * `limit` and prints its full string.
 *
 * Three kinds of limit exist. Most are one sentence taken whole and unchanged
 * from the card's own string, so the sentence and the text behind it are
 * exactly that string's sentences, in order. One of those carries the card's
 * own counts, so what was approved is its form, and the sentence printed is
 * the one the string holds. One is a sentence of the string
 * with its subject named in place of a pronoun, because the pronoun pointed at
 * the sentence before it; the rest of the string is behind it. Five are
 * sentences written for this field, for cards whose string restates the claim
 * or states no limit that bounds it; the card's full string stays behind those.
 *
 * Every sentence below was approved by the owner as the limit of its card. A
 * change to one of them is a wording change that needs the same approval. An
 * edit to a card's string that changes or removes its limit sentence does not
 * change the limit: `limitTakenWhole` stops finding the sentence, the card
 * falls back to its full string, and lib/finding-limits.test.ts fails.
 */

export type FindingLimit = {
  /** The one sentence printed beside the claim. */
  sentence: string;
  /**
   * The text behind it, in order: one paragraph, or none when the sentence is
   * the card's whole string. For a sentence taken whole, or one with its
   * subject named, the card's string with that sentence taken out; for a
   * sentence written new, the full string.
   */
  behind: readonly string[];
};

/**
 * Where one card sentence ends and the next begins. The same rule the card
 * sentence guard in lib/report-findings.test.ts measures sentences by.
 */
const CARD_SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"(])/;

/** A card string's sentences, in order. */
export function cardSentences(text: string): string[] {
  return text.split(CARD_SENTENCE_BOUNDARY);
}

/**
 * The first approved sentence that is one whole sentence of this card's
 * string, with the rest of the string behind it, or undefined when the string
 * holds none of them.
 *
 * Fails closed. A string whose sentences do not join back to it with single
 * spaces, or that holds the sentence twice, yields no limit, so the page
 * prints the full string and never a part of it under a line that is not its
 * limit.
 */
export function limitTakenWhole(detail: string, approved: readonly string[]): FindingLimit | undefined {
  const sentences = cardSentences(detail);
  if (sentences.join(" ") !== detail) return undefined;
  for (const sentence of approved) {
    const at = sentences.indexOf(sentence);
    if (at < 0) continue;
    if (sentences.indexOf(sentence, at + 1) >= 0) return undefined;
    const rest = sentences.filter((_, index) => index !== at).join(" ");
    return { sentence, behind: rest === "" ? [] : [rest] };
  }
  return undefined;
}

/**
 * A limit taken whole whose words carry the card's own counts, so no one
 * sentence can be named ahead of the string: the one sentence of the string
 * that has the approved form, with the rest of the string behind it. No limit
 * when no sentence has the form or more than one does.
 */
export function limitTakenWholeOfForm(detail: string, form: RegExp): FindingLimit | undefined {
  const ofForm = cardSentences(detail).filter((sentence) => form.test(sentence));
  return ofForm.length === 1 ? limitTakenWhole(detail, ofForm) : undefined;
}

/**
 * Whether a limit taken whole and the text behind it are exactly this string:
 * the sentence is one of its sentences, once, and the text behind it is the
 * others, unchanged and in order.
 */
export function wholeLimitHoldsString(detail: string, limit: FindingLimit): boolean {
  const sentences = cardSentences(detail);
  const at = sentences.indexOf(limit.sentence);
  if (at < 0 || sentences.indexOf(limit.sentence, at + 1) >= 0 || limit.behind.length > 1) return false;
  const rest = sentences.filter((_, index) => index !== at);
  if (rest.length === 0) return limit.behind.length === 0;
  return limit.behind.length === 1 && limit.behind[0] === rest.join(" ") && sentences.join(" ") === detail;
}

/**
 * A sentence of the card's string with its subject named, in front of the
 * rest of that string. `inString` is the sentence as the string holds it; it
 * is taken out as a whole sentence is, and `sentence` stands where it would
 * have, so nothing the string says is said twice and nothing is lost but the
 * pronoun. No limit when the string does not hold `inString` whole.
 */
export function limitWithSubjectNamed(
  detail: string,
  named: { inString: string; sentence: string }
): FindingLimit | undefined {
  const taken = limitTakenWhole(detail, [named.inString]);
  return taken ? { sentence: named.sentence, behind: taken.behind } : undefined;
}

/** A sentence written for this field, in front of the card's full string. */
export function limitWrittenNew(detail: string, sentence: string): FindingLimit {
  return { sentence, behind: [detail] };
}

/**
 * Appended to an absence card whose evidence was cut short
 * (CENSORED_ABSENCE_NOTE in lib/report-findings.ts, without its leading
 * space). On a card that claims an absence, or reports a check as not made,
 * it is the limit: it is the narrowest restriction the card states. On a card
 * that claims a presence the card's ordinary limit stays and this sentence is
 * behind it.
 */
export const CUT_SHORT_LIMIT =
  "Evidence collection was cut short, so this covers only what was recorded before the cutoff.";

/** Limits taken whole from a card's own string, by card. */
export const WHOLE_FINDING_LIMITS = {
  bottomLineNotRanked:
    "This failed or incomplete evidence is not ranked against corpus percentiles; positive signals remain visible as lower bounds.",
  bottomLineFixedThresholds:
    "The cards below translate the evidence into plain language; severity reflects fixed reference thresholds, not measured population percentiles.",
  shieldsMatches:
    "Blocking can also prevent follow-on requests, so this number is neither a measured block count nor what a Brave visit would block.",
  servicesCatalogMatch:
    "A catalog match identifies a maintainer-reviewed service/domain mapping; it does not establish why an individual request occurred, what it carried, or whether profiling happened.",
  servicesOperationalRoles:
    "The role taxonomy assigns these services explicitly non-tracking operational, support, security, consent-management, or hosting roles; the matches do not establish each request's purpose.",
  servicesOperatorIdentity:
    "Operator identity and tracking classification are separate: naming an operator does not prove that a request was for tracking.",
  servicesOwnershipRelation:
    "The ownership relation names the operator, while the absence of a catalog classification says nothing about the request's purpose.",
  servicesUnclassifiedRole:
    "An unclassified role is not evidence that a service was harmless, but it is also not a basis for calling the service tracking-related.",
  platformsMatched:
    "The domain matches identify services, not the requests' purpose, payload, or whether any profile linking occurred.",
  platformsNoneRecorded:
    "Major-platform domains were not observed in this single visit; interaction-gated requests could still load for real users.",
  platformsNotInCatalog:
    "Asset and font hosts reach this state often: the ownership map establishes who operates the domain, and nothing here establishes the request's purpose or payload.",
  platformsSameOrganization:
    "Cross-registrable-domain traffic remains counted in the report, but this reviewed ownership relationship does not support an outside-recipient disclosure claim.",
  analyticsSyncUntold: "This report neither shows nor rules out the sync.",
  cookiesPresent:
    "This report does not retain cookie values or partition keys, so it does not establish whether a cookie was a persistent identifier or could recognize a visitor across sites.",
  cookiesNoneObserved:
    "This does not prove the site never uses cookies; it means this visit did not observe third-party cookies.",
  fingerprintNoneObserved: "This is an observation layer, not proof that fingerprinting is impossible.",
  fingerprintHeuristics: "They are review prompts for this visit, not proof of cross-site identity tracking.",
  fingerprintSingleSignalWebgl:
    "WebGL calls can be legitimate (charts, graphics, maps), so this is a review prompt for this visit, not proof of fingerprinting.",
  fingerprintCalls:
    "These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it excludes Web and Service Workers.",
  fingerprintCallsSomeWorkers:
    "These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it excludes Service Workers but can include some Web Worker calls.",
  fingerprintCallsScopeUnknown:
    "These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it may omit Web and Service Worker calls.",
  comparisonNoClaim:
    "The raw request logs of both visits remain below for transparency, but the diff between them supports no claim about what the compared condition changed.",
  shieldsComparisonChanged: "Treat this as an observed difference, not a measured blocking rate.",
  shieldsComparisonNoChange:
    "Treat this as no observed difference for this pair of visits, not evidence that blocking removes nothing.",
  consentNoActivation: "No claim about the site's consent behavior can be made from this pair of visits.",
  consentBeforeClick:
    "It is a documented observation to review against the banner's promises, not a violation ruling.",
  policyUnnamedCompanies:
    "Policies often disclose vendor categories rather than company names, so an unnamed vendor is a transparency gap worth reviewing, not automatically a violation.",
  policyChecksMade:
    "Global Privacy Control claims are never checked against request counts, which cannot show whether selling or sharing stopped.",
  policyShortRead:
    "Company mentions and policy statements recorded from it are not used; later scanner versions wait for the page to settle and withhold such a read.",
  policySiteRoot: "Company mentions and policy statements recorded from that text are not used.",
  listenerSignal:
    "This is a behavioral instrumentation signal from listener registration, stack-attributed script origins, and known-vendor requests: it shows the page was instrumented to observe interaction, not that anything was transmitted.",
  sessionVendorDomainMatch: "The domain match alone does not prove that a recording occurred.",
  consentToolingAndTrackers:
    "It does not determine whether any request required consent or whether the site's behavior complied with applicable law.",
  consentToolingOnly:
    "An observed response supports delivery, but neither fact proves a banner was visibly shown to this scanner.",
  dnsAliases: "These matches do not establish a request's purpose, profiling, or an intent to conceal tracking.",
  pixelIdentifiers:
    "The scanner records their categories, never their values, so their contents, hashing, successful delivery, and eventual use are not verified.",
  pixelEventLabels: "Event labels do not establish user actions or successful delivery.",
  pixelRetainedLabels: "Retained labels describe request contents, not verified user actions or successful delivery.",
  typedValueRecoverable:
    "The report does not establish whether transmission happened during typing, blur, or unload, why it was sent, or whether real visitor input follows the same path."
} as const;

/**
 * Limits taken whole from a card's own string whose words carry that card's
 * counts, by card. Each is the form of the sentence as it was approved, whole
 * from its capital to its full stop, and nothing wider.
 *
 * The services card that matched no service and could not identify its
 * third-party hosts: one host, or two or more with all the counts the card
 * prints. The string can also say "1 of the" several hosts, with "it"; that
 * form was not shown for approval, no committed card holds it, and a card
 * that does prints its full string.
 */
export const FORMED_FINDING_LIMITS = {
  servicesHostsUnidentified:
    /^This scan could not identify (?:the 1 third-party host recorded here, so it cannot say who operates it|(?:[2-9]|[1-9][0-9,]+) of the (?:[2-9]|[1-9][0-9,]+) third-party hosts recorded here, so it cannot say who operates them)\.$/
} as const;

/**
 * Limits that are a sentence of the card's string with its subject named.
 * Alone beside the claim, "It" could be read as the visit; in the string it
 * is Tag Manager, named by the sentence before.
 */
export const NAMED_FINDING_LIMITS = {
  analyticsTagManagerOnly: {
    inString: "It can fetch Google Analytics or other tags, or none; this report cannot tell which it fetched here.",
    sentence:
      "Tag Manager can fetch Google Analytics or other tags, or none; this report cannot tell which it fetched here."
  }
} as const;

/**
 * Limits written for this field. Each stands in front of a string that
 * restates its card's claim, or that names no limit that bounds the claim and
 * can stand alone.
 */
export const NEW_FINDING_LIMITS = {
  bottomLineRanked:
    "Where severity is ranked, the cohort is a curated set of popular, mostly commercial sites, not a random sample of the web.",
  servicesNoneMatched:
    "This does not prove the site contacts no third-party service; it means this visit matched no domain to one.",
  analyticsNone:
    "This does not prove the site never uses Google Analytics; it means this visit recorded no request to it.",
  analyticsNoSync:
    "This does not prove advertising or remarketing features are off; it means this visit recorded no DoubleClick remarketing sync.",
  /**
   * "A few" is three today (COMPARED_POLICY_CLAIM_KINDS in
   * lib/privacy-policy.ts); lib/finding-limits.test.ts holds the count to
   * what the word can mean.
   */
  policyNothingContradicted:
    "Only a few kinds of statement are checked automatically, so this is not a reading of the whole policy."
} as const;
