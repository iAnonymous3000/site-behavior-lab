import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadCommittedCorpusStats } from "./current-scan-cohort";
import {
  CUT_SHORT_LIMIT,
  FORMED_FINDING_LIMITS,
  NAMED_FINDING_LIMITS,
  NEW_FINDING_LIMITS,
  WHOLE_FINDING_LIMITS,
  cardSentences,
  limitTakenWhole,
  limitTakenWholeOfForm,
  limitWithSubjectNamed,
  limitWrittenNew,
  wholeLimitHoldsString
} from "./finding-limits";
import { COMPARED_POLICY_CLAIM_KINDS } from "./privacy-policy";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-views";

/** The card sentence guard's ceiling (lib/report-findings.test.ts). */
const MAX_CARD_SENTENCE_WORDS = 30;
/** En and em dashes, built from their code points so this file spells neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/**
 * The approved limit sentences, word for word. This is the record of what was
 * approved, held apart from the module on purpose: a change to a sentence
 * there fails here until this copy is changed too, and this copy changes only
 * with the owner's approval of the new words.
 */
const APPROVED_WHOLE: Record<keyof typeof WHOLE_FINDING_LIMITS, string> = {
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
    "Major-platform domains were not observed in this single passive visit; interaction-gated requests could still load for real users.",
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
};

/**
 * A sentence approved as a form, because its words carry the card's counts:
 * the form as the module must spell it, and the sentences the owner was
 * shown, word for word.
 */
const APPROVED_FORMS: Record<keyof typeof FORMED_FINDING_LIMITS, { form: string; shown: readonly string[] }> = {
  servicesHostsUnidentified: {
    form:
      "^This scan could not identify (?:the 1 third-party host recorded here, so it cannot say who operates it|" +
      "(?:[2-9]|[1-9][0-9,]+) of the (?:[2-9]|[1-9][0-9,]+) third-party hosts recorded here, so it cannot say who operates them)\\.$",
    shown: [
      "This scan could not identify the 1 third-party host recorded here, so it cannot say who operates it.",
      "This scan could not identify 2 of the 2 third-party hosts recorded here, so it cannot say who operates them."
    ]
  }
};

const APPROVED_NEW: Record<keyof typeof NEW_FINDING_LIMITS, string> = {
  bottomLineRanked:
    "Where severity is ranked, the cohort is a curated set of popular, mostly commercial sites, not a random sample of the web.",
  servicesNoneMatched:
    "This does not prove the site contacts no third-party service; it means this visit matched no domain to one.",
  analyticsNone:
    "This does not prove the site never uses Google Analytics; it means this visit recorded no request to it.",
  analyticsNoSync:
    "This does not prove advertising or remarketing features are off; it means this visit recorded no DoubleClick remarketing sync.",
  policyNothingContradicted:
    "Only a few kinds of statement are checked automatically, so this is not a reading of the whole policy."
};

/** A sentence of the card's string, approved with its subject named. */
const APPROVED_NAMED: Record<keyof typeof NAMED_FINDING_LIMITS, { inString: string; sentence: string }> = {
  analyticsTagManagerOnly: {
    inString: "It can fetch Google Analytics or other tags, or none; this report cannot tell which it fetched here.",
    sentence:
      "Tag Manager can fetch Google Analytics or other tags, or none; this report cannot tell which it fetched here."
  }
};

const APPROVED_CUT_SHORT =
  "Evidence collection was cut short, so this covers only what was recorded before the cutoff.";

test("every limit sentence is the approved one, word for word", () => {
  assert.deepEqual({ ...WHOLE_FINDING_LIMITS }, APPROVED_WHOLE);
  assert.deepEqual({ ...NEW_FINDING_LIMITS }, APPROVED_NEW);
  assert.deepEqual(JSON.parse(JSON.stringify(NAMED_FINDING_LIMITS)), APPROVED_NAMED);
  assert.equal(CUT_SHORT_LIMIT, APPROVED_CUT_SHORT);
  assert.deepEqual(
    Object.fromEntries(Object.entries(FORMED_FINDING_LIMITS).map(([key, form]) => [key, { source: form.source, flags: form.flags }])),
    Object.fromEntries(Object.entries(APPROVED_FORMS).map(([key, approved]) => [key, { source: approved.form, flags: "" }]))
  );
  const fixed = [
    ...Object.values(APPROVED_WHOLE),
    ...Object.values(APPROVED_NEW),
    ...Object.values(APPROVED_NAMED).map((named) => named.sentence),
    APPROVED_CUT_SHORT
  ];
  for (const form of Object.values(FORMED_FINDING_LIMITS)) {
    for (const sentence of [...fixed, ...Object.values(APPROVED_NAMED).map((named) => named.inString)]) {
      assert.doesNotMatch(sentence, form, "a form takes in a sentence approved under its own name");
    }
  }
  const all = [...fixed, ...Object.values(APPROVED_FORMS).flatMap((approved) => approved.shown)];
  assert.equal(new Set(all).size, all.length, "two cards' limits are the same sentence under two names");
  for (const sentence of all) {
    assert.equal(cardSentences(sentence).length, 1, `more than one sentence: ${sentence}`);
    const words = sentence.match(/\S+/g)?.length ?? 0;
    assert.ok(words <= MAX_CARD_SENTENCE_WORDS, `${words} words: ${sentence}`);
    assert.match(sentence, /^[A-Z].*\.$/, `not a sentence: ${sentence}`);
    assert.doesNotMatch(sentence, DASHES, `a dash: ${sentence}`);
  }
});

test("a sentence with its subject named differs from the string's sentence by that subject alone", () => {
  // The approval was of the string's own sentence with "It" named, so the
  // two may differ in nothing else.
  const { inString, sentence } = NAMED_FINDING_LIMITS.analyticsTagManagerOnly;
  assert.match(inString, /^It can fetch /);
  assert.equal(sentence, inString.replace(/^It /, "Tag Manager "));
  assert.notEqual(sentence, inString);

  // It stands where the string's sentence stood, and the rest is behind it.
  const detail = `Tag Manager is a loader. ${inString}`;
  assert.deepEqual(limitWithSubjectNamed(detail, { inString, sentence }), {
    sentence,
    behind: ["Tag Manager is a loader."]
  });
  assert.deepEqual(limitWithSubjectNamed(`${inString} After it.`, { inString, sentence }), { sentence, behind: ["After it."] });
  assert.deepEqual(limitWithSubjectNamed(inString, { inString, sentence }), { sentence, behind: [] });
  // A string that does not hold the sentence whole, or already holds the
  // named form in its place, gets no limit.
  assert.equal(limitWithSubjectNamed("Tag Manager is a loader.", { inString, sentence }), undefined);
  assert.equal(limitWithSubjectNamed(`Tag Manager is a loader. ${sentence}`, { inString, sentence }), undefined);
  assert.equal(limitWithSubjectNamed(`${inString} ${inString}`, { inString, sentence }), undefined);
});

test("a limit approved as a form is the sentences shown for approval, with other counts, and nothing wider", () => {
  const form = FORMED_FINDING_LIMITS.servicesHostsUnidentified;
  const [one, several] = APPROVED_FORMS.servicesHostsUnidentified.shown;
  assert.ok(one && several);
  assert.match(one, form);
  assert.match(several, form);
  // Other counts, as the card prints them, thousands separator included.
  for (const counts of ["3 of the 7", "12 of the 34", "10 of the 10", "1,204 of the 1,300"]) {
    assert.match(several.replace("2 of the 2", counts), form, counts);
  }
  const refused = [
    // The words before the wording pass, which no card prints any more.
    "This scan could not identify 1 of the 1 third-party host recorded here, so it cannot say who operates it.",
    // One host of several: a form the string can write that was not shown for approval.
    "This scan could not identify 1 of the 5 third-party hosts recorded here, so it cannot say who operates it.",
    // Number agreement the string never writes.
    "This scan could not identify 1 of the 5 third-party hosts recorded here, so it cannot say who operates them.",
    "This scan could not identify 2 of the 2 third-party hosts recorded here, so it cannot say who operates it.",
    "This scan could not identify 0 of the 3 third-party hosts recorded here, so it cannot say who operates them.",
    "This scan could not identify the 2 third-party hosts recorded here, so it cannot say who operates them.",
    // One word changed, and more or less than the whole sentence.
    "This scan cannot identify 2 of the 2 third-party hosts recorded here, so it cannot say who operates them.",
    "This scan could not identify 2 of the 2 third-party hosts recorded here.",
    `${several} More.`,
    `Note: ${several}`,
    several.slice(0, -1),
    // The sentence of the card that identified every host.
    "This scan identified an operator for the 1 third-party domain recorded here using catalog, consent-platform, reviewed-ownership, and CNAME evidence."
  ];
  for (const sentence of refused) assert.doesNotMatch(sentence, form, sentence);

  // Taken as a whole sentence is: the rest of the string closes up behind it.
  const before = "No known operator or catalog entity was matched.";
  const after = "That is a limit of identity coverage, not evidence about the site.";
  for (const sentence of [one, several]) {
    const detail = `${before} ${sentence} ${after}`;
    const limit = limitTakenWholeOfForm(detail, form);
    assert.deepEqual(limit, { sentence, behind: [`${before} ${after}`] });
    assert.ok(limit);
    assert.equal(wholeLimitHoldsString(detail, limit), true);
    assert.deepEqual(limitTakenWholeOfForm(sentence, form), { sentence, behind: [] });
  }
  // No sentence of the form, two of them, the same one twice, or a string
  // whose sentences do not join back to it: no limit.
  assert.equal(limitTakenWholeOfForm(`${before} ${after}`, form), undefined);
  assert.equal(limitTakenWholeOfForm(`${before} ${refused[1]} ${after}`, form), undefined);
  assert.equal(limitTakenWholeOfForm(`${one} ${several}`, form), undefined);
  assert.equal(limitTakenWholeOfForm(`${one} ${before} ${one}`, form), undefined);
  assert.equal(limitTakenWholeOfForm(`${before}  ${one}`, form), undefined);
});

test("the policy limit's \"a few kinds\" is true of the kinds this scan compares", () => {
  // The sentence says "a few" and names no number. Three kinds are compared
  // today. One or two would not be a few, and past five the word understates
  // how much of a policy is checked; either way the sentence needs new words.
  assert.match(NEW_FINDING_LIMITS.policyNothingContradicted, /^Only a few kinds of statement are checked automatically, /);
  assert.equal(new Set(COMPARED_POLICY_CLAIM_KINDS).size, COMPARED_POLICY_CLAIM_KINDS.length);
  assert.ok(
    COMPARED_POLICY_CLAIM_KINDS.length >= 3 && COMPARED_POLICY_CLAIM_KINDS.length <= 5,
    `${COMPARED_POLICY_CLAIM_KINDS.length} kinds of policy statement are compared; "a few" no longer describes that`
  );
});

test("a limit taken whole and the text behind it are the card's string, in order", () => {
  const first = "One is first. Two is second. Three is third.";
  assert.deepEqual(limitTakenWhole(first, ["One is first."]), {
    sentence: "One is first.",
    behind: ["Two is second. Three is third."]
  });
  // From the middle: the sentences either side close up, unchanged.
  assert.deepEqual(limitTakenWhole(first, ["Two is second."]), {
    sentence: "Two is second.",
    behind: ["One is first. Three is third."]
  });
  assert.deepEqual(limitTakenWhole(first, ["Three is third."]), {
    sentence: "Three is third.",
    behind: ["One is first. Two is second."]
  });
  // The whole string: nothing is behind it.
  assert.deepEqual(limitTakenWhole("One is first.", ["One is first."]), { sentence: "One is first.", behind: [] });
  // The first approved sentence the string holds wins, in the order approved.
  assert.equal(limitTakenWhole(first, ["Absent here.", "Three is third.", "One is first."])?.sentence, "Three is third.");
  for (const candidate of [first, "One is first."]) {
    const limit = limitTakenWhole(candidate, ["One is first."]);
    assert.ok(limit);
    assert.equal(wholeLimitHoldsString(candidate, limit), true);
  }
});

test("a string that does not hold an approved sentence whole gets no limit", () => {
  const detail = "One is first. Two is second.";
  assert.equal(limitTakenWhole(detail, []), undefined);
  assert.equal(limitTakenWhole(detail, ["Three is third."]), undefined);
  // Part of a sentence, or a sentence with one word changed, is not that sentence.
  assert.equal(limitTakenWhole(detail, ["One is first"]), undefined);
  assert.equal(limitTakenWhole(detail, ["Two is second"]), undefined);
  assert.equal(limitTakenWhole(detail, ["One was first."]), undefined);
  assert.equal(limitTakenWhole(detail, ["is first. Two is second."]), undefined);
  // Held twice: taking one copy out would leave the other behind the line.
  assert.equal(limitTakenWhole("One is first. Two is second. One is first.", ["One is first."]), undefined);
  // Sentences that do not join back to the string with single spaces.
  assert.equal(limitTakenWhole("One is first.  Two is second.", ["One is first."]), undefined);
  assert.equal(limitTakenWhole("One is first.\nTwo is second.", ["Two is second."]), undefined);
});

test("a limit that is not the string's own sentence does not hold it", () => {
  const detail = "One is first. Two is second. Three is third.";
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Two is second.", behind: ["One is first. Three is third."] }), true);
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Two is second.", behind: ["Three is third. One is first."] }), false);
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Two is second.", behind: ["One is first."] }), false);
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Two is second.", behind: [] }), false);
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Two is second.", behind: ["One is first.", "Three is third."] }), false);
  assert.equal(wholeLimitHoldsString(detail, { sentence: "Four is new.", behind: [detail] }), false);
  assert.equal(wholeLimitHoldsString("One is first.", { sentence: "One is first.", behind: ["One is first."] }), false);
});

test("a sentence written new stands in front of the full string", () => {
  const detail = "One is first. Two is second.";
  assert.deepEqual(limitWrittenNew(detail, "Three is new."), { sentence: "Three is new.", behind: [detail] });
});

test("every committed card's limit is an approved sentence over that card's own string", async (t) => {
  // Every committed report's board, built the way its permalink builds it.
  // Not pinned to which cards carry a limit: retention moves the corpus, and
  // the fixtures in lib/report-findings.test.ts hold the branches. This holds
  // what must be true of any limit a published page could print.
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(reportsDir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  assert.ok(files.length > 0, "no committed reports under public/reports; this test would be vacuous");
  const corpus = await loadCommittedCorpusStats();
  assert.ok(corpus, "public/corpus-stats.json must load, or the ranked bottom line goes unchecked");
  const whole = new Set<string>([...Object.values(WHOLE_FINDING_LIMITS), CUT_SHORT_LIMIT]);
  const written = new Set<string>(Object.values(NEW_FINDING_LIMITS));
  const named = new Map<string, string>(
    Object.values(NAMED_FINDING_LIMITS).map((entry) => [entry.sentence, entry.inString])
  );
  const formed = Object.entries(FORMED_FINDING_LIMITS).map(([key, form]) => ({ name: `form ${key}`, form }));
  const reached = new Set<string>();
  let cards = 0;
  let limits = 0;
  let cutShortLimits = 0;
  for (const name of files) {
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(reportsDir, name), "utf8")));
    assert.equal(read.ok, true, `reader rejected committed report ${name}`);
    if (!read.ok) continue;
    const view = toReportView(read.stored);
    const facts = buildReportFacts(view);
    const arm = renderedEvidenceArm(view, buildReportHeadline(view, facts));
    for (const finding of buildFindings(view, corpus, facts, arm)) {
      const at = `${name}: ${finding.id}`;
      cards += 1;
      assert.ok(finding.detail.length > 0, `${at}: no explanatory string`);
      const sentences = cardSentences(finding.detail);
      const limit = finding.limit;
      if (finding.id === "public-correction") assert.equal(limit, undefined, `${at}: a correction card carries a limit`);
      if (!limit) continue;
      limits += 1;
      const ofForm = formed.find(({ form }) => form.test(limit.sentence));
      reached.add(ofForm ? ofForm.name : limit.sentence);
      if (written.has(limit.sentence)) {
        // The full string is behind it, and it repeats none of it.
        assert.deepEqual(limit.behind, [finding.detail], `${at}: a new sentence without the full string behind it`);
        assert.equal(sentences.includes(limit.sentence), false, `${at}: a new sentence the string already holds`);
        assert.notEqual(finding.claim?.mode, "qualified-absence", `${at}: a new sentence over a hedged absence`);
      } else if (named.has(limit.sentence)) {
        // The string holds the sentence with its pronoun, not the named form,
        // and with that sentence taken out the rest is behind the line.
        assert.equal(sentences.includes(limit.sentence), false, `${at}: the string already names the subject`);
        assert.equal(
          wholeLimitHoldsString(finding.detail, { sentence: named.get(limit.sentence) ?? "", behind: limit.behind }),
          true,
          `${at}: the text behind the line is not the rest of the card's string`
        );
      } else {
        assert.ok(whole.has(limit.sentence) || ofForm, `${at}: a limit that was never approved: ${limit.sentence}`);
        assert.equal(wholeLimitHoldsString(finding.detail, limit), true, `${at}: the limit and the text behind it are not the card's string`);
        // The counted-hosts sentence is the limit of one card only, the
        // services card that named no service. Elsewhere it stays behind.
        if (ofForm) {
          assert.equal(finding.id, "third-party-services", `${at}: a limit approved for the services card`);
          assert.equal(sentences[0], "No known operator or catalog entity was matched.", `${at}: the counted hosts as the limit of a card that names a service`);
        }
      }
      // Where the string ends with the cut-short sentence: it is the limit of
      // a card that claims an absence or reports a check as not made, and it
      // stays behind the ordinary limit of a card that claims a presence.
      if (sentences[sentences.length - 1] === CUT_SHORT_LIMIT) {
        const claimsPresence = finding.claim === undefined || finding.claim.mode === "presence";
        assert.equal(limit.sentence === CUT_SHORT_LIMIT, !claimsPresence, `${at}: the cut-short sentence is on the wrong side of the line`);
        if (limit.sentence === CUT_SHORT_LIMIT) cutShortLimits += 1;
      } else {
        assert.notEqual(limit.sentence, CUT_SHORT_LIMIT, `${at}: cut-short as the limit of a string that does not end with it`);
      }
    }
  }
  assert.ok(limits > 0, "no committed card carried a limit, so none of this was checked");
  assert.ok(limits < cards || cards === 0, "every committed card carries a limit, the correction cards included");
  const approved = [...whole, ...written, ...named.keys(), ...formed.map(({ name }) => name)];
  const unreached = approved.filter((sentence) => !reached.has(sentence));
  t.diagnostic(
    `${limits} of ${cards} committed cards carry a limit (${cutShortLimits} the cut-short sentence); ` +
      `${reached.size} of ${approved.length} approved sentences are on a committed card` +
      (unreached.length > 0 ? `; not on one today: ${unreached.join(" | ")}` : "")
  );
});
