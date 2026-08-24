import type { DomainSummary, NetworkRequestRecord, TrackerMatch } from "./types";

export type EvidenceSection = "domains" | "requests";
export type EvidenceArm = "baseline" | "variant";
export type EvidenceRequestSignal =
  | "all"
  | "third-party"
  | "known-service"
  | "shields-blocked"
  | "fingerprinting"
  | "provenance";

/**
 * Which comparison arm the page is describing: the headline's focused arm when
 * it set one, otherwise the display run's arm (the newer run of a temporal
 * pair, the baseline of an intervention pair). The renderer, the evidence
 * links, and the consistency gate must all read the SAME derivation -- the
 * gate validating a differently-derived board than the one rendered is
 * exactly the split this function exists to prevent.
 */
export function renderedEvidenceArm(
  view: { reportType: string; comparison?: { temporalPair?: unknown } | null },
  headline: { focusArm?: EvidenceArm | null }
): EvidenceArm | undefined {
  if (view.reportType !== "comparison") return undefined;
  return headline.focusArm ?? (view.comparison?.temporalPair ? "variant" : "baseline");
}

/**
 * One drawn attribution edge, as an ordered pair.
 *
 * Structural, because no single string identifies an edge. A committed report
 * draws `www.dianomi.com` as both a source node and a destination node,
 * including a self-loop, so naming one endpoint is undecidable between three
 * drawn edges. Membership is decided by `requestMatchesAttributionPair`, never
 * by the free-text query below, which ORs one needle across eight row fields
 * and over-matches by design.
 */
export type EvidenceAttributionPair = {
  actor: string;
  destination: string;
};

export type EvidenceTarget = {
  section: EvidenceSection;
  arm?: EvidenceArm;
  query?: string;
  signal?: EvidenceRequestSignal;
  /** Requests section only. Both endpoints or neither; see parseEvidenceHash. */
  pair?: EvidenceAttributionPair;
};

export type DomainRequestDelta = {
  domain: string;
  baselineRequests: number;
  variantRequests: number;
  delta: number;
  thirdParty: boolean;
  tracker: TrackerMatch | null;
};

export type FindingEvidenceLink = {
  label: string;
  target: EvidenceTarget;
};

const EVIDENCE_SECTIONS = new Set<EvidenceSection>(["domains", "requests"]);
const EVIDENCE_ARMS = new Set<EvidenceArm>(["baseline", "variant"]);
const REQUEST_SIGNALS = new Set<EvidenceRequestSignal>([
  "all",
  "third-party",
  "known-service",
  "shields-blocked",
  "fingerprinting",
  "provenance"
]);

/**
 * A same-page, reload-free report evidence link. The target is deliberately
 * encoded in the fragment: freshly produced reports on the scanner page may
 * not have a permalink yet, so changing the query string would discard their
 * in-memory report state.
 */
export function buildEvidenceHash(target: EvidenceTarget): string {
  const params = new URLSearchParams({ evidence: target.section });
  if (target.arm) params.set("arm", target.arm);
  if (target.query?.trim()) params.set("query", target.query.trim());
  if (target.section === "requests" && target.signal && target.signal !== "all") {
    params.set("signal", target.signal);
  }
  if (
    target.section === "requests" &&
    target.pair?.actor.trim() &&
    target.pair.destination.trim()
  ) {
    params.set("actor", target.pair.actor.trim());
    params.set("destination", target.pair.destination.trim());
  }
  return `#${params.toString()}`;
}

/** Parse and validate a report evidence fragment. Unknown filters are ignored. */
export function parseEvidenceHash(hash: string): EvidenceTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const section = params.get("evidence");
  if (!section || !EVIDENCE_SECTIONS.has(section as EvidenceSection)) return null;
  const validSection = section as EvidenceSection;

  const armValue = params.get("arm");
  const arm = armValue && EVIDENCE_ARMS.has(armValue as EvidenceArm) ? (armValue as EvidenceArm) : undefined;
  const queryValue = params.get("query")?.trim() ?? "";
  // Bound fragment-controlled UI state so a pasted URL cannot force an
  // unreasonably large controlled-input value into the report page.
  const query = queryValue ? queryValue.slice(0, 500) : undefined;

  if (validSection === "domains") {
    return { section: validSection, ...(arm ? { arm } : {}), ...(query ? { query } : {}) };
  }

  const signalValue = params.get("signal");
  const signal =
    signalValue && REQUEST_SIGNALS.has(signalValue as EvidenceRequestSignal)
      ? (signalValue as EvidenceRequestSignal)
      : undefined;
  // BOTH endpoints or neither. A half-specified pair must not degrade into a
  // one-sided filter: that is precisely the over-matching selection the pair
  // exists to replace, and it would arrive wearing the pair's exact-count
  // label. Bounded like `query`, since a pasted fragment controls both values.
  const actorValue = params.get("actor")?.trim() ?? "";
  const destinationValue = params.get("destination")?.trim() ?? "";
  const pair =
    actorValue && destinationValue
      ? {
          actor: actorValue.slice(0, 500),
          destination: destinationValue.slice(0, 500)
        }
      : undefined;
  return {
    section: validSection,
    ...(arm ? { arm } : {}),
    ...(query ? { query } : {}),
    ...(signal && signal !== "all" ? { signal } : {}),
    ...(pair ? { pair } : {})
  };
}

/**
 * Per-domain request-count changes, sorted by contribution magnitude. This is
 * derived from the two run views rather than added to either frozen wire
 * schema. A positive value means variant minus baseline is positive; it is not
 * a quality judgment.
 */
export function domainRequestDeltas(
  baseline: readonly DomainSummary[],
  variant: readonly DomainSummary[]
): DomainRequestDelta[] {
  const baselineByDomain = new Map(baseline.map((entry) => [entry.domain, entry]));
  const variantByDomain = new Map(variant.map((entry) => [entry.domain, entry]));
  const domains = new Set([...baselineByDomain.keys(), ...variantByDomain.keys()]);

  return Array.from(domains, (domain) => {
    const before = baselineByDomain.get(domain);
    const after = variantByDomain.get(domain);
    const baselineRequests = before?.requests ?? 0;
    const variantRequests = after?.requests ?? 0;
    return {
      domain,
      baselineRequests,
      variantRequests,
      delta: variantRequests - baselineRequests,
      thirdParty: after?.thirdParty ?? before?.thirdParty ?? false,
      tracker: after?.tracker ?? before?.tracker ?? null
    };
  })
    .filter((entry) => entry.delta !== 0)
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) ||
        Math.max(right.baselineRequests, right.variantRequests) -
          Math.max(left.baselineRequests, left.variantRequests) ||
        left.domain.localeCompare(right.domain)
    );
}

/** Findings whose supporting rows exist in the domain/request evidence tables. */
export function findingEvidenceLink(findingId: string, arm?: EvidenceArm): FindingEvidenceLink | null {
  const withArm = <T extends EvidenceTarget>(target: T): T => (arm ? { ...target, arm } : target);

  switch (findingId) {
    case "third-party-services":
      return { label: "Show third-party requests", target: withArm({ section: "requests", signal: "third-party" }) };
    case "named-platforms":
    case "ga-remarketing":
    case "pixel-events":
      return { label: "Show catalog-matched requests", target: withArm({ section: "requests", signal: "known-service" }) };
    case "shields-blocked":
    case "shields-comparison":
      return { label: "Show matched requests", target: withArm({ section: "requests", signal: "shields-blocked" }) };
    case "pagegraph-provenance":
      return { label: "Show requests with provenance", target: withArm({ section: "requests", signal: "provenance" }) };
    case "cname-cloaking":
      return { label: "Open domain evidence", target: withArm({ section: "domains" }) };
    default:
      return null;
  }
}

/** Concise non-visual equivalent for the request timing plot. */
export function requestTimingSummary(requests: readonly NetworkRequestRecord[]): string | null {
  if (requests.length === 0) return null;
  const starts = requests.map((request) => request.startedAtMs);
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  const noun = requests.length === 1 ? "request was" : "requests were";
  return `${requests.length.toLocaleString("en-US")} ${noun} recorded from ${first.toLocaleString("en-US")} ms to ${last.toLocaleString("en-US")} ms.`;
}
