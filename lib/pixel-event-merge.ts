/**
 * One pixel row per platform, for readers.
 *
 * The r2 producer records one pixel row per (platform, phase): a Meta pixel
 * that fires during the page load and again during the keystroke probe or
 * after a consent click is two wire rows. Every reader of a run view (the
 * facts, the findings, the pixel list and the comparison diff) treats a row as
 * one platform, so the view merges them here with the semantics
 * `summarizePixelEvents` (lib/pixel-events.ts) applies across one visit's
 * requests: events and identifier categories unioned, request counts summed,
 * canonical order.
 *
 * Deliberately dependency-free and separate from lib/pixel-events.ts: the
 * homepage bundle reaches the view seam statically, and the decoder builds its
 * vocabularies at module load. lib/pixel-event-merge.test.ts pins this merge
 * to `summarizePixelEvents` so the two orderings cannot drift apart.
 */
import type { PixelEventSummary, PixelMatchField } from "./types";

const FIELD_ORDER: readonly PixelMatchField[] = [
  "email",
  "phone",
  "name",
  "address",
  "date_of_birth",
  "gender",
  "external_id"
];
const PLATFORM_ORDER: readonly string[] = ["Meta", "TikTok", "X"];

export function mergePixelEventSummaries(rows: readonly PixelEventSummary[]): PixelEventSummary[] {
  const byPlatform = new Map<string, PixelEventSummary>();
  for (const row of rows) {
    const existing = byPlatform.get(row.platform);
    if (existing) {
      existing.requests += row.requests;
      mergeInto(existing.events, row.events);
      mergeInto(existing.advancedMatching, row.advancedMatching);
    } else {
      byPlatform.set(row.platform, {
        platform: row.platform,
        product: row.product,
        events: Array.from(new Set(row.events)),
        advancedMatching: Array.from(new Set(row.advancedMatching)),
        requests: row.requests
      });
    }
  }
  return Array.from(byPlatform.values())
    .map((summary) => ({
      ...summary,
      events: [...summary.events].sort((a, b) => a.localeCompare(b)),
      advancedMatching: [...summary.advancedMatching].sort((a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b))
    }))
    .sort((a, b) => platformRank(a.platform) - platformRank(b.platform) || a.platform.localeCompare(b.platform));
}

function mergeInto<T>(target: T[], items: readonly T[]): void {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}

function platformRank(platform: string): number {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index === -1 ? PLATFORM_ORDER.length : index;
}
