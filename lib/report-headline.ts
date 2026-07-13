import {
  comparisonArmViews,
  displayRunView,
  runCensorshipNotes,
  type ReportView,
  type RunView
} from "./scan-report-views";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  fingerprintDetection,
  highEntropyDetections,
  isOperationalEntity,
  keystrokeLeakHashed,
  pixelFieldLabel,
  scanLoadFailureStatus,
  shieldsRunMeasurement,
  trackerEntitySummaries
} from "./report-insights";
import { plural } from "./text-format";

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
  caveat: string;
  stats: ReportHeadlineStat[];
  domain: string;
  /** Suggested post text (without the URL); the UI appends the report link. */
  shareText: string;
  /**
   * The comparison arm the lead finding DESCRIBES, when that differs from the
   * report's lead run. The shell opens the evidence switcher on this arm so a
   * variant-focused headline never sits above baseline evidence. Absent on
   * singles and on branches that describe the lead run.
   */
  focusArm?: "baseline" | "variant";
};

const SINGLE_VISIT_CAVEAT = "Observed in one automated visit: evidence to check, not a verdict.";
const COMPARISON_CAVEAT = "Observed in two automated visits: evidence to check, not a verdict.";
const KICKER = "What this actually means";
const SHARE_TAGLINE = "See what a site does, not what it says. Open-source and reproducible:";

export function buildReportHeadline(view: ReportView): ReportHeadline {
  const run = displayRunView(view);
  const arms = comparisonArmViews(view);
  const axis = view.comparison?.axis ?? null;
  const domain = friendlyDomain(run);
  const entities = trackerEntitySummaries(run.evidence);
  const trackingEntities = entities.filter((entity) => !isOperationalEntity(entity));
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const platforms = entities.filter((entity) => HEADLINE_PLATFORMS.includes(entity.entity)).map((entity) => entity.entity);
  const highEntropy = highEntropyDetections(run.evidence);
  const sessionReplay = trackingEntities.some((entity) =>
    entity.categories.some((category) => category.toLowerCase().includes("session replay"))
  );
  // Listener-coverage claims are restricted to genuinely cross-site origins:
  // the in-page probe's hostname heuristic can misread same-site siblings
  // (see crossSiteListenerDetection), and a same-party listener is normal.
  const sessionRecording = Boolean(crossSiteListenerDetection(run.evidence, "session-recording"));
  const inputMonitoring = Boolean(crossSiteListenerDetection(run.evidence, "input-monitoring"));
  const stats = buildStats(run, trackingEntities.length);
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
    extras.push("a third-party script registered listeners on keyboard input");
  } else if (sessionRecording || sessionReplay) {
    extras.push("a session-replay vendor can record how you move and click");
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
    focusArm?: "baseline" | "variant"
  ): ReportHeadline => {
    const resolvedStats = statsOverride ?? stats;
    return {
      tone,
      kicker: KICKER,
      headline,
      subhead,
      caveat: view.reportType === "comparison" ? COMPARISON_CAVEAT : SINGLE_VISIT_CAVEAT,
      stats: resolvedStats,
      domain,
      shareText: buildShareText(headline, resolvedStats),
      ...(focusArm ? { focusArm } : {})
    };
  };

  // A page that answered with an HTTP error or block status (403/404/500/503…)
  // did not really load, so its low tracker/cookie/fingerprint counts are an
  // artifact of the failed load, not a privacy result. Lead with that instead
  // of letting it fall through to "kept this visit relatively private".
  const loadFailureStatus = scanLoadFailureStatus(run.status);
  if (loadFailureStatus !== null) {
    return finish(
      "info",
      `${domain} returned an error, so there was little to scan.`,
      `The page responded with HTTP ${loadFailureStatus}, an error or block page, not the real site. The low tracker, cookie, and fingerprinting counts mean the page did not load, not that ${domain} is private. Re-scan when it is reachable.`,
      [{ label: "HTTP status", value: n(loadFailureStatus), emphasis: true }]
    );
  }

  // Confirmed input capture leads over every other story, including the
  // comparison framing. A one-way HASH of the typed value (md5/sha1/sha256)
  // cannot drive a functional type-ahead, so it is the distinctive sign of
  // deliberate identity capture and gets the alarm. Plain text or a reversible
  // encoding (base64/hex) reads as a third-party search/autocomplete and gets a
  // calmer warn, though the keystrokes still leave the site.
  const keystrokeExfil = fingerprintDetection(run.evidence, "keystroke-exfiltration");
  if (keystrokeExfil) {
    const recipientCount = plural(keystrokeExfil.evidence.recipients.length, "third party", "third parties");
    const recipients = joinNames(keystrokeExfil.evidence.recipients);
    return keystrokeLeakHashed(keystrokeExfil.evidence.encodings)
      ? finish(
          "alarm",
          `${domain} sent a hashed copy of what you type to ${recipientCount}.`,
          `A unique value typed into a form on ${domain} reached ${recipients} as a one-way hash, without the form being submitted, the pattern used to match you to a known identity. A real visitor's keystrokes could be captured the same way.`
        )
      : finish(
          "warn",
          `${domain} sends what you type to ${recipientCount} as you type.`,
          `A unique value typed into a form on ${domain} was sent to ${recipients} as it was typed, without the form being submitted, typically search or autocomplete handled by a third party, not necessarily covert capture, but your keystrokes still leave the site.`
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
      `An advertising pixel on ${domain} attached populated personal-identifier fields (${fields}) to the events it reported. These fields exist to match a visit to a known person; the scanner records only that they were filled, never their values, so what they contained is not verified.${extraNote}`
    );
  }

  // Consent comparison: the story is what changed between the two visits.
  // Claims are gated on the reject click having really been dispatched AND on
  // the pair claim gate; when either fails, the report falls through to the
  // ordinary evidence-led headline instead of pretending the choice was
  // measured. The scanner clicks the control but cannot verify the site
  // accepted the choice, and recording covers the whole visit including
  // pre-click traffic, so the wording stays observational.
  if (classificationDeltasUsable && arms && axis === "consent" && arms.variant.consent?.controlActivated === true) {
    const rejectTracking = trackerEntitySummaries(arms.variant.evidence).filter((entity) => !isOperationalEntity(entity));
    // Both consent headlines describe the Reject-all (variant) visit, so the
    // stat chips and share text must quote that run too, not the Accept-all
    // baseline the report otherwise leads with. "In the visit where the
    // scanner clicked", never "after the click": the recording covers traffic
    // from before and after an unverified click, so no sentence may sequence
    // the traffic relative to it.
    if (rejectTracking.length > 0) {
      return finish(
        "warn",
        `${domain} still reached ${plural(rejectTracking.length, "tracking company", "tracking companies")} in the visit that clicked Reject all.`,
        `In the visit where the scanner clicked Reject all, ${joinNames(
          rejectTracking.map((entity) => entity.entity)
        )} received requests. The recording covers traffic from before and after the click, the click's acceptance by the site is never verified, and some vendors may be claimed as strictly necessary; the diff lists the services that appeared only in the visit that clicked Accept all.`,
        buildStats(arms.variant, rejectTracking.length),
        "variant"
      );
    }
    if (rawCountDeltasUsable && arms.baseline.consent?.controlActivated === true && trackingEntities.length > 0) {
      return finish(
        "info",
        `${domain} loaded no catalogued trackers in the visit that clicked Reject all.`,
        `The visit that clicked Reject all loaded no catalogued tracking company, while the visit that clicked Accept all loaded ${plural(
          trackingEntities.length,
          "tracking company",
          "tracking companies"
        )}: ${plural(arms.baseline.counts.thirdPartyRequests, "third-party request")} became ${arms.variant.counts.thirdPartyRequests.toLocaleString("en-US")}.`,
        buildStats(arms.variant, 0),
        "variant"
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
    const gpcOnTracking = trackerEntitySummaries(arms.variant.evidence).filter((entity) => !isOperationalEntity(entity));
    if (classificationDeltasUsable && gpcOnTracking.length > 0 && after > 0 && reductionPct < 25) {
      return finish(
        "alarm",
        `${domain} still contacted ${plural(gpcOnTracking.length, "tracking company", "tracking companies")} with a privacy signal on.`,
        `The visit with a "do not sell or share" (GPC) signal switched on still contacted ${plural(
          gpcOnTracking.length,
          "tracking company",
          "tracking companies"
        )}: ${plural(after, "third-party request")}, versus ${n(before)} in the visit without the signal. An observed difference for this pair of visits; request counts cannot show whether data sales stopped, only what loaded.`,
        buildStats(arms.variant, gpcOnTracking.length),
        "variant"
      );
    }
    if (reductionPct >= 50) {
      // Pair-framed: the stat chips stay on the lead (baseline) run, so the
      // evidence switcher default stays there too (no focusArm).
      return finish(
        "calm",
        `Off-site requests to ${domain} dropped ${reductionPct}% with a privacy signal on.`,
        `With a Global Privacy Control signal on, off-site requests dropped ${reductionPct}% (${n(before)} → ${n(after)}). An observed difference for this pair of visits, not proof the site honors the signal.`
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
      // "Brave-list blocking", never "Brave Shields on": the blocking arm ran
      // Brave's ad-block engine and default Shields lists as a block
      // SIMULATION in this scanner's browser, not a live Brave-browser visit.
      // Pair-framed with lead-run stats: no focusArm (see the GPC calm note).
      return finish(
        removed >= 30 ? "warn" : "info",
        `${domain} loaded ${plural(removed, "fewer third-party request")} with Brave-list blocking on.`,
        `The visit with no blocking made ${plural(
          total,
          "request"
        )}; with Brave's ad-block engine and default Shields filter lists actively blocking (a simulation in this scanner's browser, not a live Brave-browser visit), ${plural(removed, "third-party request")} did not load.${engineNote}${extraNote}`
      );
    }
  }

  // Receipt wording ("told", "saw", "loaded") needs an observed response: a
  // request record is created at dispatch, so an entity whose every request
  // has a null status is proven only to have been SENT requests, never to
  // have received them. Entities with at least one answered request keep the
  // receipt verbs; the rest get attempt wording.
  const respondedEntities = new Set<string>();
  for (const domainSummary of run.evidence.domains) {
    if (domainSummary.thirdParty && domainSummary.tracker && domainSummary.statuses.length > 0) {
      respondedEntities.add(domainSummary.tracker.entity);
    }
  }
  const receiptClause = (names: string, total: number, answeredCount: number): string =>
    answeredCount === total
      ? `${names} saw this visit`
      : answeredCount > 0
        ? `${names} were sent this visit (${answeredCount} answered; the rest recorded no response)`
        : `${names} were sent this visit, though no response was recorded, so receipt is unproven`;

  if (platforms.length > 0) {
    const answeredPlatforms = platforms.filter((platform) => respondedEntities.has(platform));
    const clause =
      trackingEntities.length > 0
        ? receiptClause(
            plural(trackingEntities.length, "tracking company", "tracking companies"),
            trackingEntities.length,
            trackingEntities.filter((entity) => respondedEntities.has(entity.entity)).length
          )
        : receiptClause("Trackers", platforms.length, answeredPlatforms.length);
    return finish(
      platforms.length >= 3 ? "alarm" : "warn",
      answeredPlatforms.length > 0
        ? `${domain} told ${joinNames(answeredPlatforms)} you were here.`
        : `${domain} tried to tell ${joinNames(platforms)} you were here.`,
      `${clause} across ${plural(run.counts.thirdPartyDomains, "third-party domain")}.${extraNote}`
    );
  }

  if (trackingEntities.length > 0) {
    const answeredCount = trackingEntities.filter((entity) => respondedEntities.has(entity.entity)).length;
    return finish(
      trackingEntities.length >= 6 ? "warn" : "info",
      answeredCount > 0
        ? `${domain} shared this visit with ${plural(trackingEntities.length, "tracking company", "tracking companies")}.`
        : `${domain} sent this visit to ${plural(trackingEntities.length, "tracking company", "tracking companies")}.`,
      `${
        answeredCount === trackingEntities.length
          ? `${joinNames(trackingNames)} loaded with the page`
          : answeredCount > 0
            ? `${joinNames(trackingNames)} were sent requests (${answeredCount} answered; the rest recorded no response)`
            : `${joinNames(trackingNames)} were sent requests that recorded no response, so receipt is unproven`
      }: ${plural(run.counts.thirdPartyRequests, "request")} went to ${plural(
        run.counts.thirdPartyDomains,
        "third-party domain"
      )}.${extraNote}`
    );
  }

  if (highEntropy.length > 0 || sessionRecording || inputMonitoring) {
    const probeStats: ReportHeadlineStat[] =
      stats.length > 0 ? stats : [{ label: "fingerprinting signals", value: n(highEntropy.length), emphasis: true }];
    return finish(
      "warn",
      `${domain} probed your browser, not just served a page.`,
      `No catalogued tracking company matched, but ${joinNames(
        extras.length > 0 ? extras : ["fingerprint-like browser APIs were called"],
        2
      )}.`,
      probeStats
    );
  }

  // Censored evidence can support the positive stories above (they are lower
  // bounds), but never the calm one: a truncated visit has low counts because
  // collection stopped, not because the site was quiet.
  const censorshipNotes = runCensorshipNotes(run);
  if (censorshipNotes.length > 0) {
    return finish(
      "info",
      `${domain}'s scan was cut short, so low counts are not the full story.`,
      `Evidence collection did not finish: ${joinNames(censorshipNotes, 2)}. Activity counts in this report are floors for this visit, and its cookie and storage figures are snapshots of an interrupted visit, not the site's full behavior.`,
      stats.length > 0 ? stats : [{ label: "third-party requests", value: n(run.counts.thirdPartyRequests), emphasis: true }]
    );
  }

  const calmStats: ReportHeadlineStat[] = stats.length > 0 ? stats : [{ label: "third-party requests", value: "0", emphasis: true }];
  return finish(
    "calm",
    `${domain} kept this visit relatively private.`,
    run.counts.thirdPartyDomains > 0
      ? `${plural(
          run.counts.thirdPartyDomains,
          "third-party domain"
        )} loaded, but no catalogued tracking company, third-party cookie, or fingerprinting signal showed up in this visit.`
      : "No third-party domains, tracking companies, cookies, or fingerprinting signals showed up in this visit.",
    calmStats
  );
}

function buildStats(run: RunView, trackingCount: number): ReportHeadlineStat[] {
  const stats: ReportHeadlineStat[] = [];

  if (trackingCount > 0) {
    stats.push({ label: trackingCount === 1 ? "tracking company" : "tracking companies", value: n(trackingCount), emphasis: true });
  } else if (run.counts.thirdPartyDomains > 0) {
    stats.push({
      label: run.counts.thirdPartyDomains === 1 ? "third-party domain" : "third-party domains",
      value: n(run.counts.thirdPartyDomains),
      emphasis: true
    });
  }

  if (run.counts.thirdPartyRequests > 0) {
    stats.push({ label: "data requests sent off-site", value: n(run.counts.thirdPartyRequests) });
  }
  if (run.counts.thirdPartyCookies > 0) {
    stats.push({
      label: run.counts.thirdPartyCookies === 1 ? "third-party cookie" : "third-party cookies",
      value: n(run.counts.thirdPartyCookies)
    });
  }

  const fingerprintSignals = highEntropyDetections(run.evidence).length;
  if (fingerprintSignals > 0) {
    stats.push({ label: fingerprintSignals === 1 ? "fingerprinting signal" : "fingerprinting signals", value: n(fingerprintSignals) });
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
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  if (visible.length === 0) return "";
  if (visible.length === 1) return remaining > 0 ? `${visible[0]} and ${remaining} more` : visible[0];
  const base = `${visible.slice(0, -1).join(", ")} and ${visible[visible.length - 1]}`;
  return remaining > 0 ? `${base}, +${remaining} more` : base;
}
