/**
 * Which visit of a comparison ran first, as a report may state it.
 *
 * The two visits of a comparison are sequential, so whatever the site does
 * over time (cache warming, ad rotation, a rising bot score) lands on the
 * visit that ran second. No claim depends on the order (causal wording needs
 * replicated AB and BA pairs, never one pair), so this is disclosure only, and
 * it states no more than the record supports:
 *
 * - "recorded": the producer recorded the executed order. Frozen v1 records it
 *   only as its disclosure sentence (comparisonOrderDisclosure, matched in
 *   viewFromV1Report), v2 as `experiment.order`, which the v2 validators
 *   already hold to the runs' chronology.
 * - "not-recorded": no order was recorded, as on comparisons captured before
 *   order randomization shipped, or on a design that never records one. The
 *   recorded start times stand in only when they strictly differ; equal,
 *   missing, or unparseable times order nothing. A recorded order that the
 *   start times contradict also lands here, with no start order, so an
 *   inconsistent upload states neither.
 * - "not-applicable": a temporal pair, whose "Before" and "After" are the
 *   order by design.
 *
 * Dependency-free on purpose: the view layer is imported statically by client
 * components (see lib/scan-report-views.ts).
 */
export type ComparisonVisitOrder =
  | { state: "recorded"; first: "baseline" | "variant" }
  | { state: "not-recorded"; startedFirst: "baseline" | "variant" | null }
  | { state: "not-applicable" };

export function comparisonVisitOrder(pair: {
  temporalPair: boolean;
  /** The arm the producer recorded as executed first, or null when it recorded none. */
  recordedFirst: "baseline" | "variant" | null;
  baselineStartedAt: string | null;
  variantStartedAt: string | null;
}): ComparisonVisitOrder {
  // Before anything else: a temporal pair carrying an order sentence (a
  // tampered upload) still orders nothing that its labels do not already say.
  if (pair.temporalPair) return { state: "not-applicable" };
  const startedFirst = strictlyEarlierArm(pair.baselineStartedAt, pair.variantStartedAt);
  if (pair.recordedFirst === null) return { state: "not-recorded", startedFirst };
  if (startedFirst !== null && startedFirst !== pair.recordedFirst) return { state: "not-recorded", startedFirst: null };
  return { state: "recorded", first: pair.recordedFirst };
}

function strictlyEarlierArm(baselineStartedAt: string | null, variantStartedAt: string | null): "baseline" | "variant" | null {
  const baselineMs = Date.parse(baselineStartedAt ?? "");
  const variantMs = Date.parse(variantStartedAt ?? "");
  if (!Number.isFinite(baselineMs) || !Number.isFinite(variantMs) || baselineMs === variantMs) return null;
  return baselineMs < variantMs ? "baseline" : "variant";
}

/**
 * The visit-order line a comparison renders, in the view's display labels, or
 * null on a temporal pair. A line marked `seeMethodology` is followed by a link
 * to the methodology page's comparison section, which says why an order can be
 * missing; the line itself never names the release that began recording it,
 * and never calls a pair randomized or counterbalanced.
 */
export function comparisonVisitOrderLine(
  order: ComparisonVisitOrder,
  labels: { baseline: string; variant: string }
): { text: string; seeMethodology: boolean } | null {
  if (order.state === "not-applicable") return null;
  if (order.state === "recorded") return { text: `Ran first: ${labels[order.first]}`, seeMethodology: false };
  return order.startedFirst
    ? { text: `Started first: ${labels[order.startedFirst]}; order not recorded`, seeMethodology: true }
    : { text: "Order not recorded", seeMethodology: true };
}
