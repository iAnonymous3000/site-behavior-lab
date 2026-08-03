import {
  comparisonArmViews,
  type ReportView,
  type RunView
} from "./scan-report-views";
import {
  HEADLINE_PLATFORMS,
  fingerprintDetection,
  isTrackingEntity,
  keystrokeLeakHashed,
  pixelFieldLabel,
  shieldsRunMeasurement,
  trackerOwnershipBreakdown,
  trackerResponseQualification
} from "./report-insights";
import { reviewedOwnershipRelationship } from "./reviewed-ownership";
import { displayHost, plural } from "./text-format";
import {
  CONSENT_WHOLE_VISIT_CAVEAT,
  consentChoiceVerified,
  consentRegistrationSentence
} from "./report-consent-copy";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import {
  buildReportFacts,
  retainedCountLabel,
  retainedCountPhrase,
  type ReportClaimId,
  type RunFacts
} from "./report-facts";

/**
 * Plain-language "headline" layer.
 *
 * This module turns a {@link ReportView} into the single punchy, shareable
 * takeaway that leads the report UI, the social unfurl metadata, and the
 * generated Open Graph card. It deliberately leads with the most concrete,
 * defensible signal (a privacy-signal that changed little, named platforms,
 * tracking companies) and keeps the rigor in `caveat` so the framing never
 * outruns the evidence.
 *
 * It consumes the version-independent view seam, never a wire shape: every
 * comparison number is derived from the two arms' run views (the same counts
 * the v1 wire's diff was computed from), and every comparison framing is
 * gated on `view.claims` (default-deny), so the headline can never disagree
 * with the findings board or the comparison panel's banner.
 *
 * It is intentionally dependency-free (types plus the runtime-light views
 * module) so it can run in the React client, in server-side
 * `generateMetadata`, and inside the `next/og` image route without pulling in
 * browser- or Node-only code.
 *
 * The tracker/fingerprint classification it relies on lives in
 * `lib/report-insights.ts`, shared with the report UI so the two cannot drift.
 */

export type HeadlineTone = "alarm" | "warn" | "info" | "calm";

export type ReportHeadlineStat = {
  label: string;
  value: string;
  emphasis?: boolean;
};

export type ReportHeadline = {
  tone: HeadlineTone;
  kicker: string;
  headline: string;
  subhead: string;
  /**
   * The subhead without its trailing secondary-observation clause ("It also
   * looks like ..."), which every headline family may append after the lead
   * finding and its qualification.
   *
   * Surfaces that cannot fit the whole subhead drop SECONDARY findings before
   * withholding the claim: losing an additional observation states nothing
   * false, while withholding the lead finding costs the reader the claim and
   * the hedge that qualifies it. Equal to `subhead` when there is no such
   * clause.
   */
  subheadPrimaryClaim: string;
  caveat: string;
  stats: ReportHeadlineStat[];
  domain: string;
  /** Suggested post text (without the URL); the UI appends the report link. */
  shareText: string;
  /** A complete, claim-safe social-card restatement when the full subhead is too long. */
  compactSubhead?: string;
  /**
   * The exact full subhead for which `compactSubhead` was derived. Consumers
   * may receive a caller-modified headline object; the compact restatement is
   * safe only while its source claim is unchanged.
   */
  compactSubheadSource?: string;
  /**
   * The comparison arm the lead finding DESCRIBES, when that differs from the
   * report's lead run. The shell opens the evidence switcher on this arm so a
   * variant-focused headline never sits above baseline evidence. Absent on
   * singles and on branches that describe the lead run.
   */
  focusArm?: "baseline" | "variant";
  /**
   * Machine-readable meaning used by the report-consistency gate. Prose may
   * change without turning semantic checks back into regular expressions.
   */
  semantic: {
    story:
      | "load-failure"
      | "subject-unverified"
      | "interstitial"
      | "keystroke-transmission"
      | "pixel-identifiers"
      | "consent"
      | "comparison"
      | "catalogued-services"
      | "same-organization"
      | "fingerprint-api"
      | "listener-coverage"
      | "shields"
      | "cookies"
      | "raw-fingerprint-events"
      | "unidentified-cross-site"
      | "incomplete-evidence"
      | "unsupported-evidence"
      | "quiet"
      | "observed-activity";
    reassuring: boolean;
    runScope: "display" | "baseline" | "variant" | "pair";
    subjectScope: "requested-page" | "returned-document";
    assertedClaims: ReportClaimId[];
    absenceClaims: ReportClaimId[];
  };
};

const SINGLE_VISIT_CAVEAT = "Observed in one automated visit: evidence to check, not a verdict.";
const COMPARISON_CAVEAT = "Observed in two automated visits: evidence to check, not a verdict.";
const KICKER = "What this actually means";
const SHARE_TAGLINE = "See what a site does, not what it says. Open-source and reproducible:";

export function buildReportHeadline(
  view: ReportView,
  reportFacts = buildReportFacts(view)
): ReportHeadline {
  const facts = reportFacts.display;
  const run = facts.run;
  const arms = comparisonArmViews(view);
  const axis = view.comparison?.axis ?? null;
  const domain = friendlyDomain(run);
  const ownership = facts.identity.ownership;
  const entities = ownership.otherOrUnreviewed;
  const sameOrganizationEntities = ownership.sameOrganization;
  const trackingEntities = entities.filter(isTrackingEntity);
  const sameOrganizationTrackingEntities = sameOrganizationEntities.filter(isTrackingEntity);
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const respondedEntities = facts.identity.respondedEntities;
  const platforms = trackingEntities
    .filter((entity) => HEADLINE_PLATFORMS.includes(entity.entity))
    .map((entity) => entity.entity);
  const highEntropy = facts.signals.fingerprint.highEntropyDetections;
  const sessionReplay = facts.signals.fingerprint.sessionReplayNames.length > 0;
  const sessionRecording = Boolean(facts.signals.fingerprint.sessionRecording);
  const inputMonitoring = Boolean(facts.signals.fingerprint.inputMonitoring);
  const requestState = facts.evidence.requests.state;
  const fingerprintClaim = facts.claims["fingerprint-apis"];
  const fingerprintEvidenceIncomplete = fingerprintClaim.blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  const stats = buildStats(facts, trackingEntities.length);
  const sameOrganizationNote =
    ownership.sameOrganizationDomainCount > 0
      ? ` ${plural(
          ownership.sameOrganizationDomainCount,
          "catalogued cross-site domain"
        )} belonged to the same reviewed ${ownership.sameOrganizationName ?? "organization"} domain family as the site; those requests are not evidence of disclosure to an outside company.`
      : "";
  // Comparison claims are gated on the seam's default-deny claim policy: the
  // same derivation the findings board and the comparison panel consult, so a
  // failed, request-capped, or mismatched arm disqualifies every comparison
  // framing below at once and the report falls back to the evidence-led
  // single-visit story (the findings board explains why). Every branch that
  // quotes a request-count delta additionally requires the raw-counts family
  // gate (RFC 4.4: a family delta renders iff its family is eligible), and
  // no branch below uses intervention-ATTRIBUTED phrasing; that wording needs
  // claims.interventionAttribution, which no readable report grants yet.
  const comparisonUsable = view.claims.pairComparison?.allowed ?? false;
  const rawCountDeltasUsable = comparisonUsable && view.claims.familyDeltas?.["raw-counts"]?.allowed === true;
  // Cross-arm framing that leans on the tracker catalog ("still contacted",
  // "loaded no catalogued trackers while the other visit did") additionally
  // needs the classification family: two visits classified by different
  // catalogs support no such contrast.
  const classificationDeltasUsable =
    comparisonUsable && view.claims.familyDeltas?.["tracker-classification"]?.allowed === true;

  const extras: string[] = [];
  if (inputMonitoring) {
    extras.push("a cross-site script registered listeners on keyboard input");
  } else if (sessionRecording || sessionReplay) {
    extras.push("a catalogued session-replay service appeared or broad interaction listeners were registered");
  }
  if (highEntropy.length > 0) {
    extras.push(`${plural(highEntropy.length, "browser-fingerprinting heuristic")} matched`);
  }
  const extraNote = extras.length > 0 ? ` It also looks like ${joinNames(extras, 2)}.` : "";

  const finish = (
    tone: HeadlineTone,
    headline: string,
    subhead: string,
    statsOverride?: ReportHeadlineStat[],
    focusArm?: "baseline" | "variant",
    semanticOverride?: Partial<ReportHeadline["semantic"]>,
    compactSubhead?: string
  ): ReportHeadline => {
    const resolvedStats = statsOverride ?? stats;
    const runScope =
      semanticOverride?.runScope ?? (focusArm ?? "display");
    const semanticRuns =
      runScope === "pair"
        ? reportFacts.runs
        : runScope === "baseline" || runScope === "variant"
          ? [reportFacts.arms?.[runScope] ?? facts]
          : [facts];
    // Derived from the exact clause appended above, never by re-matching its
    // prose: a second copy of that sentence in another module is one wording
    // change away from silently keeping the secondary claim.
    const subheadPrimaryClaim =
      extraNote.length > 0 && subhead.endsWith(extraNote) ? subhead.slice(0, -extraNote.length) : subhead;
    return {
      tone,
      kicker: KICKER,
      headline,
      subhead,
      subheadPrimaryClaim,
      caveat: view.reportType === "comparison" ? COMPARISON_CAVEAT : SINGLE_VISIT_CAVEAT,
      stats: resolvedStats,
      domain,
      shareText: buildShareText(headline, resolvedStats),
      semantic: {
        story: "observed-activity",
        reassuring: tone === "calm",
        runScope,
        subjectScope: semanticRuns.every((candidate) => candidate.subject.describesSubject)
          ? "requested-page"
          : "returned-document",
        assertedClaims: [],
        absenceClaims: [],
        ...semanticOverride
      },
      ...(compactSubhead ? { compactSubhead, compactSubheadSource: subhead } : {}),
      ...(focusArm ? { focusArm } : {})
    };
  };

  // A page that answered with an HTTP error or block status (403/404/500/503…)
  // did not really load, so its low tracker/cookie/fingerprint counts are an
  // artifact of the failed load, not a privacy result. Lead with that instead
  // of letting it fall through to "kept this visit relatively private".
  const loadFailureStatus = facts.subject.kind === "http-error" ? facts.subject.status : null;
  if (loadFailureStatus !== null) {
    // A 401 or 403 proves only that this visit was denied. Authentication,
    // authorization policy, rate controls, automation filtering, and other
    // causes can produce the same status, so the report must not pick one.
    const refusedVisit = loadFailureStatus === 401 || loadFailureStatus === 403;
    // This subhead is also the social-card copy, which is hard-bounded, so it
    // carries only the correction. The fuller automation-block explanation lives
    // in the findings bottom line, which has room for it.
    const guidance = refusedVisit
      ? "The status alone cannot identify the cause (authentication, access policy, automation filtering, or another control)."
      : loadFailureStatus === 429
        ? "The site rate-limited this visit, so a later re-scan may succeed."
        : loadFailureStatus === 404
          ? "The requested address returned 404; verify the URL. The status does not establish why that response was returned."
          : loadFailureStatus >= 500
            ? "That is a server-side error, so a later re-scan may succeed."
            : "Re-scan when the site serves the page.";
    const failureSummary = refusedVisit
      ? `HTTP ${loadFailureStatus} denied this visit`
      : `HTTP ${loadFailureStatus} prevented the requested page from being measured`;
    return finish(
      "info",
      `${domain} returned HTTP ${loadFailureStatus} instead of a verified normal page load.`,
      `${failureSummary}. Signals below describe the returned error or block page, not ${domain}'s normal behavior. ${guidance}`,
      [{ label: "HTTP status", value: n(loadFailureStatus), emphasis: true }]
      ,
      undefined,
      { story: "load-failure", subjectScope: "returned-document" }
    );
  }

  if (facts.subject.kind === "unverified") {
    return finish(
      "info",
      `${domain}'s rendered page could not be verified as the requested page.`,
      `The bounded page-content collector was unavailable or unreadable, so tracker, cookie, and fingerprinting counts cannot support a privacy conclusion about ${domain}'s normal behavior. Re-scan for a verified page load.`,
      [{ label: "Page subject", value: "Unverified", emphasis: true }],
      undefined,
      { story: "subject-unverified", subjectScope: "returned-document" }
    );
  }

  // A successful HTTP status can still be a robot check, CAPTCHA, or blocking
  // consent interstitial. The scanner records this only after multiple
  // independent signals agree; lead with the subject-validity problem so the
  // interstitial's low counts never become a privacy claim.
  if (facts.subject.kind === "interstitial") {
    return finish(
      "info",
      `${domain} showed a suspected challenge or soft block, not a normal page load.`,
      `The successful HTTP response appears to be a robot check, CAPTCHA, or blocking consent interstitial rather than the requested page. Low tracker, cookie, and fingerprinting counts describe that interstitial, not ${domain}'s normal behavior; re-scan for a complete page load.`,
      [{ label: "Page state", value: "Suspected block", emphasis: true }],
      undefined,
      { story: "interstitial", subjectScope: "returned-document" }
    );
  }

  // Recorded r2 quality can prove a failed navigation even when the frozen
  // wire cannot carry the exact status (valid 600-999 is normalized to null
  // with a reserved capture-loss marker). That null must never fall through to
  // a calm or otherwise positive evidence story, and the UI must not invent a
  // replacement status such as 599.
  if (facts.subject.kind === "failed") {
    const statusUnrepresentable =
      run.quality.facts?.captureLoss.some((loss) => loss.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE) === true;
    return finish(
      "info",
      `${domain}'s main page did not complete a trustworthy load.`,
      statusUnrepresentable
        ? "The site returned an HTTP status outside this frozen report format's representable range. The status field is left empty rather than coerced to a value the site never sent. Tracker, cookie, and fingerprinting counts come from a failed or incomplete visit, not a positive privacy result; re-scan for a complete load."
        : "The scanner's recorded quality facts mark the main-page load as failed or incomplete. Tracker, cookie, and fingerprinting counts from this visit do not support a positive privacy result; re-scan for a complete load.",
      [{ label: "Navigation", value: "Failed", emphasis: true }],
      undefined,
      { story: "load-failure", subjectScope: "returned-document" }
    );
  }

  // Confirmed input transmission leads over every other story. Hashing is a
  // stronger transformation signal, but neither the encoding nor this frozen
  // summary identifies the recipient's purpose or whether transmission
  // happened during typing, blur, or the scanner's unload flush.
  const keystrokeExfil = fingerprintDetection(run.evidence, "keystroke-exfiltration");
  if (keystrokeExfil) {
    const sameOrganizationRecipients = keystrokeExfil.evidence.recipients.filter(
      (recipient) => reviewedOwnershipRelationship(run.domain, recipient).kind === "same-organization"
    );
    const recipientCount = plural(keystrokeExfil.evidence.recipients.length, "cross-site domain");
    const recipients = joinNames(keystrokeExfil.evidence.recipients);
    const recipientOwnershipNote =
      sameOrganizationRecipients.length > 0
        ? ` ${plural(
            sameOrganizationRecipients.length,
            "recipient domain"
          )} belonged to the site's same reviewed organization, so that portion is not disclosure to an outside company.`
        : "";
    return keystrokeLeakHashed(keystrokeExfil.evidence.encodings)
      ? finish(
          "alarm",
          `${domain} sent a hashed form of synthetic input to ${recipientCount} before submission.`,
          `A one-way hash of the scanner's unique test value appeared in requests to ${recipients} without form submission. The report does not establish whether transmission happened during typing, blur, or unload, what the recipient used it for, or whether real visitor input follows the same path.${recipientOwnershipNote}`
        )
      : finish(
          "warn",
          `${domain} sent synthetic form input to ${recipientCount} before submission.`,
          `The scanner's unique test value appeared in requests to ${recipients} without form submission. The report does not establish whether transmission happened during typing, blur, or unload, why it was sent, or whether real visitor input follows the same path.${recipientOwnershipNote}`
        );
  }

  // An ad pixel whose advanced-matching fields were POPULATED is a stronger
  // story than mere pixel presence, so it outranks the platform/comparison
  // framings below. Event-only pixels carry no identifier and fall through to
  // the named-platform line. What the scanner proves is that designated
  // personal-identifier fields held values; it only ever checks the fields
  // for being non-empty (never storing the values), so the copy must not
  // assert they WERE personal identifiers, nor that matching succeeded, only
  // what the fields are designed for.
  const pixelsWithMatching = run.evidence.pixelEvents.filter((pixel) => pixel.advancedMatching.length > 0);
  if (pixelsWithMatching.length > 0) {
    const products = joinNames(pixelsWithMatching.map((pixel) => pixel.product));
    const fields = joinNames(
      Array.from(new Set(pixelsWithMatching.flatMap((pixel) => pixel.advancedMatching))).map(pixelFieldLabel)
    );
    return finish(
      "warn",
      `${domain} sent data in personal-identifier fields to ${products}.`,
      `An advertising pixel on ${domain} attached populated fields that the platform designates for personal identifiers (${fields}) to the events it reported. The scanner records only that they were filled, never their values, so their contents, hashing, and eventual use are not verified.${extraNote}`
    );
  }

  // A contradictory registered-state readback is affirmative evidence, not
  // merely an ineligible-comparison footnote. It must prevent the ordinary
  // quiet fall-through even when the request log itself contains no trackers.
  // Keep no-click wording precise: a contradiction can be observed against a
  // requested choice even when the scanner never activated that control.
  if (arms && axis === "consent") {
    const contradicted =
      arms.variant.consent?.choiceState === "contradicted"
        ? { run: arms.variant, label: "Reject all", focus: "variant" as const }
        : arms.baseline.consent?.choiceState === "contradicted"
          ? { run: arms.baseline, label: "Accept all", focus: "baseline" as const }
          : null;
    if (contradicted) {
      const activated = contradicted.run.consent?.controlActivated === true;
      const contradictedTracking = trackerOwnershipBreakdown(
        contradicted.run.evidence,
        contradicted.run.domain
      ).otherOrUnreviewed.filter(
        isTrackingEntity
      );
      return finish(
        "warn",
        activated
          ? `${domain}'s registered consent state contradicted the ${contradicted.label} click.`
          : `${domain}'s registered consent state was inconsistent with the requested ${contradicted.label} choice.`,
        activated
          ? `The scanner activated ${contradicted.label}, but the site's consent-state readback was inconsistent with that choice. This pair does not support an accept-versus-reject outcome or any reassuring consent conclusion.`
          : `The scanner did not activate the ${contradicted.label} control, so this is not evidence of a completed consent interaction. It nevertheless read a registered state inconsistent with the requested choice, and the pair supports no reassuring consent conclusion.`,
        buildStats(
          contradicted.focus === "variant"
            ? (reportFacts.arms?.variant ?? facts)
            : (reportFacts.arms?.baseline ?? facts),
          contradictedTracking.length
        ),
        contradicted.focus,
        { story: "consent", runScope: contradicted.focus }
      );
    }
  }

  // Consent comparison: the story is what changed between the two visits.
  // Claims are gated on both controls having observable effect AND on the pair
  // claim gate; dispatch alone can hit a no-op/decoy control. When either gate
  // fails, the report falls through to the ordinary evidence-led headline.
  // Registration wording comes from the recorded consent state;
  // even verified r2 evidence does not make the whole request log post-choice.
  if (
    classificationDeltasUsable &&
    arms &&
    axis === "consent" &&
    consentChoiceVerified(arms.baseline.consent) &&
    consentChoiceVerified(arms.variant.consent)
  ) {
    const rejectTracking = trackerOwnershipBreakdown(
      arms.variant.evidence,
      arms.variant.domain
    ).otherOrUnreviewed.filter(isTrackingEntity);
    const rejectResponded = reportFacts.arms?.variant.identity.respondedEntities ?? new Set<string>();
    // Both consent headlines describe the Reject-all (variant) visit, so the
    // stat chips and share text must quote that run too, not the Accept-all
    // baseline the report otherwise leads with. "In the visit where the
    // scanner clicked", never "after the click": the recording covers traffic
    // from before and after the click, so no sentence may sequence every
    // request relative to it even when r2 verified the registered state.
    const registration = consentRegistrationSentence(view, arms.variant.consent, "Reject all");
    if (rejectTracking.length > 0) {
      return finish(
        "warn",
        `${domain} still contacted ${plural(rejectTracking.length, "distinct catalogued tracking-related service")} in the visit that clicked Reject all.`,
        `In the visit where the scanner clicked Reject all, ${joinNames(
          rejectTracking.map((entity) => entity.entity)
        )} ${trackerResponseQualification(rejectTracking, rejectResponded)}. ${registration} ${CONSENT_WHOLE_VISIT_CAVEAT} The diff lists the services that appeared only in the visit that clicked Accept all.`,
        buildStats(reportFacts.arms?.variant ?? facts, rejectTracking.length),
        "variant",
        {
          story: "consent",
          runScope: "variant",
          assertedClaims: ["third-party-services"]
        }
      );
    }
    if (rawCountDeltasUsable && trackingEntities.length > 0) {
      return finish(
        "info",
        `${domain} recorded no requests to catalogued trackers in the visit that clicked Reject all.`,
        `The visit that clicked Reject all recorded no request to a catalogued tracking-related service, while the visit that clicked Accept all recorded requests to ${plural(
          trackingEntities.length,
          "distinct catalogued tracking-related service"
        )}: ${plural(arms.baseline.counts.thirdPartyRequests, "third-party request")} became ${arms.variant.counts.thirdPartyRequests.toLocaleString("en-US")}. ${registration} ${CONSENT_WHOLE_VISIT_CAVEAT}`,
        buildStats(reportFacts.arms?.variant ?? facts, 0),
        "variant",
        {
          story: "consent",
          runScope: "variant",
          absenceClaims: ["third-party-services"]
        }
      );
    }
  }

  if (rawCountDeltasUsable && arms && axis === "gpc") {
    const before = arms.baseline.counts.thirdPartyRequests;
    const after = arms.variant.counts.thirdPartyRequests;
    const reductionPct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;

    // This story is about the GPC-ON visit, so every number and name in it,
    // including the stat chips and share text, must come from the variant run.
    // The report's lead result (and its extras) is the baseline run, which
    // would mix the two arms' evidence. The wording stays DESCRIPTIVE (the
    // two visits' numbers side by side): "the signal changed nothing" is
    // intervention-attributed phrasing (RFC 4.4) and needs
    // claims.interventionAttribution, which no readable report grants yet.
    const gpcOnTracking = trackerOwnershipBreakdown(
      arms.variant.evidence,
      arms.variant.domain
    ).otherOrUnreviewed.filter(isTrackingEntity);
    if (classificationDeltasUsable && gpcOnTracking.length > 0 && after > 0 && reductionPct < 25) {
      return finish(
        "alarm",
        `${domain} still contacted ${plural(gpcOnTracking.length, "distinct catalogued tracking-related service")} with a privacy signal configured.`,
        `The visit configured with a "do not sell or share" (GPC) signal still contacted ${plural(
          gpcOnTracking.length,
          "distinct catalogued tracking-related service"
        )}: ${plural(after, "third-party request")}, versus ${n(before)} in the visit without the signal. An observed difference for this pair of visits; request counts cannot show whether data sales stopped, only what was requested.`,
        buildStats(reportFacts.arms?.variant ?? facts, gpcOnTracking.length),
        "variant",
        {
          story: "comparison",
          runScope: "variant",
          assertedClaims: ["third-party-services"]
        }
      );
    }
    if (reductionPct >= 50) {
      // A large reduction is not a clean result. This is the only comparison
      // branch that can render "calm" (and therefore semantic.reassuring), and
      // it used to do so on the delta alone: theguardian.com dropped 641 -> 160
      // third-party requests, so a reassuring headline rendered above 20
      // catalogued tracking entities and 158 third-party cookie records. That
      // is exactly the state report-consistency calls
      // "quiet-copy-over-loud-finding", and nothing enforces that rule at
      // render time. Stay reassuring only when neither arm carries a
      // review-worthy signal of its own.
      // reportFacts.arms is non-null whenever the local `arms` is (both come
      // from comparisonArmViews), but fall back to every run rather than to
      // "no signal": an absent arm must never be the reason a report reassures.
      const pairFacts = reportFacts.arms
        ? [reportFacts.arms.baseline, reportFacts.arms.variant]
        : reportFacts.runs;
      const pairCarriesReviewSignal = pairFacts.some(
        (arm) =>
          arm.strongestObservedSeverity === "warn" || arm.strongestObservedSeverity === "loud"
      );
      // Pair-framed: the stat chips stay on the lead (baseline) run, so the
      // evidence switcher default stays there too (no focusArm).
      return finish(
        pairCarriesReviewSignal ? "info" : "calm",
        `Off-site requests to ${domain} were ${reductionPct}% lower in the visit configured with a privacy signal.`,
        `In the visit configured with Global Privacy Control, off-site requests were ${reductionPct}% lower (${n(before)} → ${n(after)}). An observed difference for this pair of visits, not proof the site honors or received the signal.${
          pairCarriesReviewSignal
            ? " Both visits still recorded review-worthy activity of their own; the cards below describe what remained."
            : ""
        }`,
        undefined,
        undefined,
        { story: "comparison", runScope: "pair" }
      );
    }
  }

  if (rawCountDeltasUsable && arms && axis === "shields") {
    const before = arms.baseline.counts.thirdPartyRequests;
    const after = arms.variant.counts.thirdPartyRequests;
    const removed = Math.max(0, before - after);
    const total = arms.baseline.counts.totalRequests;
    // The engine-blocked count (block simulation, variant run) and the total
    // third-party reduction are DIFFERENT measurements: blocking one script
    // also prevents its follow-on requests from ever starting, so the
    // reduction usually exceeds the direct blocks. Say both, never blend them.
    const engineBlocks = shieldsRunMeasurement(arms.variant);
    if (removed > 0) {
      const engineNote =
        engineBlocks && engineBlocks.kind === "engine-blocked"
          ? ` The blocker directly stopped ${plural(engineBlocks.count, "request")}; the remaining difference may include follow-on requests that never started once their sources were blocked, plus run-to-run variance.`
          : "";
      const compactEngineNote =
        engineBlocks && engineBlocks.kind === "engine-blocked"
          ? ` The engine directly stopped ${plural(
              engineBlocks.count,
              "request"
            )}; the difference may also include prevented follow-on requests and run-to-run variance.`
          : " This is an observed difference between two visits and may include run-to-run variance.";
      const compactSubhead =
        `Brave-list block simulation in this scanner, not a live Brave-browser visit: ` +
        `${plural(total, "request")} without blocking; ${plural(
          removed,
          "fewer third-party request"
        )} in the blocking visit.${compactEngineNote}`;
      // "Brave-list blocking", never "Brave Shields on": the blocking arm ran
      // Brave's ad-block engine and default Shields lists as a block
      // SIMULATION in this scanner's browser, not a live Brave-browser visit.
      // Pair-framed with lead-run stats: no focusArm (see the GPC calm note).
      return finish(
        removed >= 30 ? "warn" : "info",
        `${domain} recorded ${plural(removed, "fewer third-party request")} in the visit configured for Brave-list blocking.`,
        `The visit with no blocking made ${plural(
          total,
          "request"
        )}; the visit configured to apply Brave's ad-block engine and default Shields filter lists (a simulation in this scanner's browser, not a live Brave-browser visit) recorded ${plural(removed, "fewer third-party request")}.${engineNote}${extraNote}`
        ,
        undefined,
        undefined,
        {
          story: "comparison",
          runScope: "pair",
          assertedClaims: ["shields-blocked"]
        },
        compactSubhead
      );
    }
  }

  // A recorded response qualifies delivery of a request, but neither dispatch
  // nor response establishes the request's purpose or payload meaning.
  const receiptClause = (names: string, total: number, answeredCount: number): string =>
    requestState === "censored"
      ? `Retained request rows include ${names}; ${answeredCount} of the retained service matches recorded responses`
      : answeredCount === total
      ? `${names} recorded responses`
      : answeredCount > 0
        ? `${names} had requests dispatched (${answeredCount} recorded responses; the rest recorded no response)`
        : `${names} had requests dispatched, though no response was recorded`;

  if (platforms.length > 0) {
    const answeredPlatforms = platforms.filter((platform) => respondedEntities.has(platform));
    const clause =
      trackingEntities.length > 0
        ? receiptClause(
            plural(trackingEntities.length, "distinct catalogued tracking-service entity", "distinct catalogued tracking-service entities"),
            trackingEntities.length,
            trackingEntities.filter((entity) => respondedEntities.has(entity.entity)).length
          )
        : receiptClause("Catalogued platform domains", platforms.length, answeredPlatforms.length);
    return finish(
      platforms.length >= 3 ? "alarm" : "warn",
      requestState === "censored"
        ? `${domain}'s retained request log includes catalogued ${joinNames(platforms)} domains.`
        : `${domain} contacted catalogued ${joinNames(platforms)} domains during this visit.`,
      `${clause} across ${retainedCountPhrase(
        run.counts.thirdPartyDomains,
        "cross-site domain",
        "cross-site domains",
        requestState
      )}. A catalog match identifies the service domain, not why the request occurred or what it carried.${sameOrganizationNote}${extraNote}`
    );
  }

  if (trackingEntities.length > 0) {
    const answeredCount = trackingEntities.filter((entity) => respondedEntities.has(entity.entity)).length;
    return finish(
      trackingEntities.length >= 6 ? "warn" : "info",
      requestState === "censored"
        ? `${domain}'s retained request log includes ${plural(
            trackingEntities.length,
            "distinct catalogued tracking-related service"
          )}.`
        : `${domain} contacted ${plural(
            trackingEntities.length,
            "distinct catalogued tracking-related service"
          )} during this visit.`,
      `${
        requestState === "censored"
          ? `Retained rows include ${joinNames(trackingNames)} (${answeredCount} recorded responses)`
          : answeredCount === trackingEntities.length
          ? `${joinNames(trackingNames)} recorded responses`
          : answeredCount > 0
            ? `${joinNames(trackingNames)} had requests dispatched (${answeredCount} recorded responses; the rest recorded no response)`
            : `${joinNames(trackingNames)} had requests dispatched with no recorded response`
      }: ${retainedCountPhrase(
        run.counts.thirdPartyRequests,
        "request",
        "requests",
        requestState
      )} went to ${retainedCountPhrase(
        run.counts.thirdPartyDomains,
        "cross-site domain",
        "cross-site domains",
        requestState
      )}. Catalog labels do not prove the purpose of an individual request or that profiling occurred.${sameOrganizationNote}${extraNote}`
    );
  }

  if (sameOrganizationTrackingEntities.length > 0) {
    return finish(
      "info",
      `${domain} contacted catalogued services on separate ${ownership.sameOrganizationName ?? "same-organization"} domains.`,
      `${plural(
        ownership.sameOrganizationDomainCount,
        "request destination"
      )} crossed a registrable-domain boundary, but the reviewed ownership map groups the destination with the site's own organization. This is not evidence of disclosure to an outside company, and the catalog label does not prove request purpose.${extraNote}`
    );
  }

  if (highEntropy.length > 0) {
    const probeStats: ReportHeadlineStat[] =
      stats.length > 0 ? stats : [{ label: "fingerprint-like patterns", value: n(highEntropy.length), emphasis: true }];
    return finish(
      "warn",
      fingerprintEvidenceIncomplete
        ? `${domain}'s retained evidence matched fingerprint-like browser API patterns.`
        : `${domain} triggered fingerprint-like browser API patterns.`,
      `${fingerprintEvidenceIncomplete ? "At least " : ""}${plural(
        highEntropy.length,
        "browser-fingerprinting heuristic"
      )} matched${fingerprintEvidenceIncomplete ? " in retained evidence" : ""}. These are heuristic review signals, not proof of fingerprinting intent.`,
      probeStats,
      undefined,
      { story: "fingerprint-api", assertedClaims: ["fingerprint-apis"] }
    );
  }

  if (sessionRecording || inputMonitoring) {
    const listenerDescription = inputMonitoring
      ? "a cross-site script registered listeners that could observe typing-related input"
      : "a cross-site script registered broad interaction listeners";
    return finish(
      "info",
      `${domain} registered a third-party interaction-monitoring signal.`,
      `${listenerDescription[0].toUpperCase()}${listenerDescription.slice(1)}. Listener coverage shows that a script was positioned to observe interaction; it does not show that input was transmitted.${
        fingerprintEvidenceIncomplete
          ? " Fingerprinting-heuristic evaluation was incomplete and is not treated as an absence."
          : ""
      }`,
      stats.length > 0
        ? stats
        : [{ label: "listener coverage", value: inputMonitoring ? "Input" : "Interaction", emphasis: true }],
      undefined,
      {
        story: "listener-coverage",
        assertedClaims: ["session-recording-input-monitoring"]
      }
    );
  }

  const shieldsMeasurement = facts.signals.shields.measurement;
  if (shieldsMeasurement && shieldsMeasurement.count > 0) {
    const retained = requestState === "censored" ? " retained before request capture stopped" : "";
    const shieldsCount = retainedCountPhrase(
      shieldsMeasurement.count,
      "request",
      "requests",
      requestState
    );
    return finish(
      facts.signals.shields.severity === "warn" ? "warn" : "info",
      shieldsMeasurement.kind === "engine-blocked"
        ? `Brave's blocking engine stopped ${shieldsCount} during this visit.`
        : `${shieldsCount} in this visit matched Brave Shields filter lists.`,
      shieldsMeasurement.kind === "engine-blocked"
        ? `This was a block simulation in the scanner's browser, not a live Brave-browser visit. The count covers requests the engine directly stopped; follow-on requests that never started are separate.`
        : `${shieldsCount} matched while loading normally, out of ${retainedCountLabel(
            run.counts.totalRequests,
            requestState
          )}${retained} requests. Matching identifies traffic the lists would target; it does not establish the purpose or payload of an individual request.`,
      stats,
      undefined,
      { story: "shields", assertedClaims: ["shields-blocked"] }
    );
  }

  if (run.counts.thirdPartyCookies > 0) {
    const cookieState = facts.evidence.cookies.state;
    return finish(
      "info",
      `${domain} recorded ${plural(run.counts.thirdPartyCookies, "third-party cookie")} in this visit.`,
      cookieState === "censored"
        ? `The end-of-visit cookie snapshot was incomplete. It retained ${plural(
            run.counts.thirdPartyCookies,
            "third-party cookie"
          )}, so the count is not a complete snapshot of the visit.`
        : `The scanner observed cookie metadata whose domain crossed the site's registrable-domain boundary. Cookie values and partition keys are not retained, so this does not establish whether a cookie could recognize a visitor across sites.`,
      stats,
      undefined,
      { story: "cookies", assertedClaims: ["third-party-cookies"] }
    );
  }

  if (run.counts.fingerprintEvents > 0) {
    const eventObservation = fingerprintClaim.exactCountAllowed
      ? `${plural(
          run.counts.fingerprintEvents,
          "browser-API event",
          "browser-API events"
        )} appeared in the instrumentation log.`
      : fingerprintClaim.lowerBound
        ? `At least ${plural(
            run.counts.fingerprintEvents,
            "retained browser-API event",
            "retained browser-API events"
          )} appeared in the incomplete instrumentation log.`
        : `The incomplete instrumentation log retained ${plural(
            run.counts.fingerprintEvents,
            "browser-API event record",
            "browser-API event records"
          )}; this is not an exact total.`;
    return finish(
      "info",
      `${domain} called instrumented browser APIs during this visit.`,
      `${eventObservation} These APIs can support legitimate graphics or media use, so the observation is not proof of fingerprinting intent.${
        fingerprintEvidenceIncomplete
          ? " Fingerprinting-heuristic evaluation was incomplete."
          : ""
      }`,
      stats,
      undefined,
      { story: "raw-fingerprint-events", assertedClaims: ["fingerprint-apis"] }
    );
  }

  if (run.counts.thirdPartyDomains > 0) {
    return finish(
      "info",
      requestState === "censored"
        ? `${domain}'s retained log includes ${plural(
            run.counts.thirdPartyDomains,
            "cross-site host"
          )} that the service catalog did not classify as tracking.`
        : `${domain} contacted ${plural(
            run.counts.thirdPartyDomains,
            "cross-site host"
          )} that the service catalog did not classify as tracking.`,
      `${retainedCountPhrase(
        run.counts.thirdPartyRequests,
        "cross-site request",
        "cross-site requests",
        requestState
      )} appeared in the log. The identity map named ${
        facts.identity.coverage.identifiedHosts
      } of ${plural(facts.identity.coverage.thirdPartyHosts, "host")}; an unmatched host is a catalog limit, not evidence that it is harmless.`,
      stats,
      undefined,
      { story: "unidentified-cross-site" }
    );
  }

  // Censored evidence can support the positive stories above (they are lower
  // bounds), but never the calm one: a truncated visit has low counts because
  // collection stopped, not because the site was quiet.
  const censorshipNotes = facts.censorshipNotes;
  const unsupportedFamilies = facts.unsupportedFamilies;
  // The absence sentence the counts support on their own. Shared with the calm
  // branch below so the two cannot drift into describing the same run
  // differently.
  const observedAbsence = "No cross-site hosts, catalogued tracking-related services, or third-party cookie records showed up in this visit";
  const completedAbsenceClaims: ReportClaimId[] = [];
  const completedAbsenceParts: string[] = [];
  if (
    facts.claims["third-party-services"].allowed &&
    run.counts.thirdPartyDomains === 0 &&
    trackingEntities.length === 0
  ) {
    completedAbsenceClaims.push("third-party-services", "named-platforms");
    completedAbsenceParts.push(
      "the request log recorded no cross-site hosts or catalogued tracking-related services"
    );
  }
  if (
    facts.claims["third-party-cookies"].allowed &&
    run.counts.thirdPartyCookies === 0
  ) {
    completedAbsenceClaims.push("third-party-cookies");
    completedAbsenceParts.push(
      "the cookie snapshot recorded no third-party cookie records"
    );
  }
  if (
    facts.claims["fingerprint-apis"].allowed &&
    run.counts.fingerprintEvents === 0 &&
    highEntropy.length === 0
  ) {
    completedAbsenceClaims.push("fingerprint-apis");
    completedAbsenceParts.push(
      "the fingerprint observer recorded no instrumented API events or matched heuristics"
    );
  }
  // WHICH family stopped early decides what may be hedged. A loss in the
  // detector ledger says nothing about the request log, the cookie jar, or
  // storage: those ran to completion, so calling their figures "floors" and
  // "snapshots of an interrupted visit" is false about them, and it makes a
  // genuinely quiet site unreportable as quiet. Only a loss in a family that
  // BACKS the counts can undermine the counts.
  const requestEvidenceCensored = facts.evidence.requests.state === "censored";
  const censoredSnapshots = [
    facts.evidence.cookies.state === "censored" ? "cookie" : "",
    facts.evidence.storage.state === "censored" ? "storage" : ""
  ].filter(Boolean);
  const countEvidenceCensored = requestEvidenceCensored || censoredSnapshots.length > 0;
  if (censorshipNotes.length > 0 && countEvidenceCensored) {
    const incompleteCountNotes = [
      requestEvidenceCensored
        ? "Request-derived activity counts are retained lower bounds for this visit, not exact totals or proof of absence."
        : "",
      censoredSnapshots.length > 0
        ? `The ${joinNames(censoredSnapshots)} ${
            censoredSnapshots.length === 1 ? "figure is an incomplete end-state snapshot" : "figures are incomplete end-state snapshots"
          }, not a lower bound or an observed absence.`
        : "",
      unsupportedFamilies.length > 0
        ? `${joinNames(unsupportedFamilies)} evidence was not captured by this producer; its zeroes are unavailable measurements.`
        : ""
    ].filter(Boolean);
    return finish(
      "info",
      `${domain}'s scan did not finish every measurement.`,
      `Evidence collection did not finish: ${joinNames(censorshipNotes, 2)}. ${incompleteCountNotes.join(" ")}`,
      stats.length > 0
        ? stats
        : [{
            label: "third-party requests",
            value: requestEvidenceCensored
              ? retainedCountLabel(run.counts.thirdPartyRequests, facts.evidence.requests.state)
              : n(run.counts.thirdPartyRequests),
            emphasis: true
          }],
      undefined,
      { story: "incomplete-evidence" }
    );
  }

  if (censorshipNotes.length > 0) {
    // Counts complete, an instrument short. Report both, and hedge only the
    // absence claims that actually depend on the instrument that stopped.
    return finish(
      "info",
      completedAbsenceParts.length > 0
        ? `${domain}'s completed measurements recorded no listed activity, but another check did not finish.`
        : `${domain}'s scan completed some measurements, but another check did not finish.`,
      `${completedAbsenceParts.length > 0 ? `${joinNames(completedAbsenceParts)}. ` : ""}${
        unsupportedFamilies.length > 0
          ? `${joinNames(unsupportedFamilies)} evidence was not captured and is not treated as an observed absence. `
          : ""
      }${joinNames(
        censorshipNotes,
        2
      )}, so whatever those checks look for is unproven here rather than shown to be absent.`,
      stats.length > 0 ? stats : [{ label: "third-party requests", value: n(run.counts.thirdPartyRequests), emphasis: true }],
      undefined,
      {
        story: "incomplete-evidence",
        absenceClaims: completedAbsenceClaims
      }
    );
  }

  if (unsupportedFamilies.length > 0) {
    return finish(
      "info",
      `${domain}'s PageGraph report covers requests, not every evidence family.`,
      `${joinNames(unsupportedFamilies)} evidence was not captured by this PageGraph producer. Zeroes in those families mean unavailable measurements, not observed absences.`,
      stats.length > 0
        ? stats
        : [{
            label:
              facts.evidence.requests.state === "complete"
                ? "requests captured"
                : "request measurement",
            value:
              facts.evidence.requests.state === "complete"
                ? n(run.counts.totalRequests)
                : "Unavailable",
            emphasis: true
          }],
      undefined,
      { story: "unsupported-evidence" }
    );
  }

  if (!facts.calmEligible) {
    return finish(
      "info",
      `${domain}'s visit produced evidence that needs context.`,
      "The report retained an informational signal that does not support a categorical absence or a reassuring summary. Review the findings and raw evidence below.",
      stats,
      undefined,
      { story: "observed-activity" }
    );
  }

  const calmStats: ReportHeadlineStat[] = stats.length > 0 ? stats : [{ label: "third-party requests", value: "0", emphasis: true }];
  const rawFingerprintNote =
    run.counts.fingerprintEvents > 0
      ? ` The observer recorded ${plural(
          run.counts.fingerprintEvents,
          "browser-API event used by the fingerprinting heuristics",
          "browser-API events used by the fingerprinting heuristics"
        )}, but none met a detector's fingerprinting threshold.`
      : "";
  return finish(
    "calm",
    `${domain} showed few catalogued or fingerprint-like signals in this visit.`,
    `${observedAbsence}.${rawFingerprintNote || " No fingerprint-observer events showed up either."}`,
    calmStats,
    undefined,
    {
      story: "quiet",
      reassuring: true,
      absenceClaims: [
        "third-party-services",
        "named-platforms",
        "third-party-cookies",
        "fingerprint-apis"
      ]
    }
  );
}

/**
 * Page/tab title for a report permalink. Most headline branches already name
 * the site ("webmd.com loaded 306 fewer..."), and prefixing the domain again
 * produced "webmd.com: webmd.com loaded ..." in every tab, header, and search
 * result. Prefix only when the headline does not already identify the site.
 */
export function reportPageTitle(headline: ReportHeadline): string {
  return headline.headline.toLowerCase().includes(headline.domain.toLowerCase())
    ? headline.headline
    : `${headline.domain}: ${headline.headline}`;
}

function buildStats(facts: RunFacts, trackingCount: number): ReportHeadlineStat[] {
  const run = facts.run;
  const stats: ReportHeadlineStat[] = [];
  const requestState = facts.evidence.requests.state;
  const cookieState = facts.evidence.cookies.state;

  if (trackingCount > 0) {
    stats.push({
      label:
        requestState === "censored"
          ? trackingCount === 1
            ? "tracking-service entity retained"
            : "tracking-service entities retained"
          : trackingCount === 1
            ? "tracking-service entity"
            : "tracking-service entities",
      value: requestState === "censored" ? `≥${n(trackingCount)}` : n(trackingCount),
      emphasis: true
    });
  } else if (run.counts.thirdPartyDomains > 0) {
    stats.push({
      label: run.counts.thirdPartyDomains === 1 ? "cross-site domain" : "cross-site domains",
      value: retainedCountLabel(run.counts.thirdPartyDomains, requestState),
      emphasis: true
    });
  }

  if (run.counts.thirdPartyRequests > 0) {
    stats.push({ label: "cross-site requests", value: retainedCountLabel(run.counts.thirdPartyRequests, requestState) });
  }
  if (run.counts.thirdPartyCookies > 0) {
    stats.push({
      label: run.counts.thirdPartyCookies === 1 ? "third-party cookie record" : "third-party cookie records",
      value: cookieState === "censored" ? "Snapshot incomplete" : n(run.counts.thirdPartyCookies)
    });
  }

  const fingerprintSignals = facts.signals.fingerprint.highEntropyDetections.length;
  if (fingerprintSignals > 0) {
    const incomplete = facts.claims["fingerprint-apis"].blockers.some(
      (blocker) => blocker !== "subject-not-established"
    );
    stats.push({
      label:
        incomplete
          ? fingerprintSignals === 1
            ? "fingerprint-like pattern retained"
            : "fingerprint-like patterns retained"
          : fingerprintSignals === 1
            ? "fingerprint-like pattern"
            : "fingerprint-like patterns",
      value: incomplete ? `≥${n(fingerprintSignals)}` : n(fingerprintSignals)
    });
  }

  return stats.slice(0, 4);
}

function buildShareText(headline: string, stats: ReportHeadlineStat[]): string {
  const top = stats
    .slice(0, 2)
    .map((stat) => `${stat.value} ${stat.label}`)
    .join(" · ");
  return top ? `${headline} ${top}. ${SHARE_TAGLINE}` : `${headline} ${SHARE_TAGLINE}`;
}

function friendlyDomain(run: RunView): string {
  // A public report can retain only a `{label}` placeholder for an
  // unreviewed subdomain. Headlines should name the stable site boundary,
  // not present the privacy marker as if it were a literal hostname.
  const marker = "{label}.";
  const markerIndex = run.domain.lastIndexOf(marker);
  const stableSite = markerIndex >= 0 ? run.domain.slice(markerIndex + marker.length) : run.domain;
  return stableSite.replace(/^www\./, "") || run.domain;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function joinNames(items: string[], limit = 3): string {
  // Host-shaped privacy markers are wire tokens, not reader-facing prose.
  // Use the same wildcard presentation as evidence tables and CSV previews.
  const visible = items.slice(0, limit).map(displayHost);
  const remaining = items.length - visible.length;
  if (visible.length === 0) return "";
  if (visible.length === 1) return remaining > 0 ? `${visible[0]} and ${remaining} more` : visible[0];
  const base = `${visible.slice(0, -1).join(", ")} and ${visible[visible.length - 1]}`;
  return remaining > 0 ? `${base}, +${remaining} more` : base;
}
