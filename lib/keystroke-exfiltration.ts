/**
 * Active keystroke / input-exfiltration detection.
 *
 * The scanner types a unique synthetic sentinel into a page's form fields
 * (without ever submitting), then watches the network for that sentinel leaving
 * to a third party. This module is the pure, encoding-aware matcher: given the
 * sentinel's encoded forms and the requests captured during the probe, it finds
 * which third parties received the typed value and in what encoding, and builds
 * the {@link KeystrokeExfiltrationDetectionSummary}.
 *
 * Unlike the listener-coverage heuristics (which only observe that a script
 * *could* read input), a hit here is direct evidence the typed value was
 * captured and transmitted — the test Blacklight performs, extended to match
 * common encodings, not just the raw value.
 *
 * Node-only: uses `node:crypto` / `Buffer` to compute the sentinel encodings.
 * Imported solely by the Node scanner; the UI consumes only the result type.
 */

import { createHash } from "node:crypto";
import type { KeystrokeExfiltrationDetectionSummary } from "./types";

export type SentinelEncoding = {
  encoding: string;
  value: string;
  /** base64 is case-significant; plain/hex/hash digests are matched case-insensitively. */
  caseSensitive: boolean;
};

export type CapturedRequest = {
  domain: string;
  thirdParty: boolean;
  url: string;
  body?: string | null;
};

export type KeystrokeLeak = {
  domain: string;
  thirdParty: boolean;
  encoding: string;
  location: "url" | "body";
};

/** A distinctive, synthetic, non-PII token to type into fields. */
export function createSentinel(randomHex: string): string {
  return `sblcanary${randomHex}`;
}

/**
 * The forms the sentinel could appear in once a script captures and re-encodes
 * it. Trailing base64 padding is dropped because it is commonly stripped in
 * transit; very short digests are skipped to avoid coincidental matches.
 */
export function sentinelEncodings(sentinel: string): SentinelEncoding[] {
  const buffer = Buffer.from(sentinel, "utf8");
  return [
    { encoding: "plain", value: sentinel, caseSensitive: false },
    { encoding: "hex", value: buffer.toString("hex"), caseSensitive: false },
    { encoding: "base64", value: buffer.toString("base64").replace(/=+$/, ""), caseSensitive: true },
    { encoding: "base64url", value: buffer.toString("base64url"), caseSensitive: true },
    { encoding: "md5", value: createHash("md5").update(sentinel).digest("hex"), caseSensitive: false },
    { encoding: "sha1", value: createHash("sha1").update(sentinel).digest("hex"), caseSensitive: false },
    { encoding: "sha256", value: createHash("sha256").update(sentinel).digest("hex"), caseSensitive: false }
  ].filter((encoding) => encoding.value.length >= 8);
}

/** Find every (recipient, encoding, location) the sentinel leaked through. */
export function findSentinelLeaks(encodings: SentinelEncoding[], requests: CapturedRequest[]): KeystrokeLeak[] {
  const leaks: KeystrokeLeak[] = [];
  const seen = new Set<string>();

  for (const request of requests) {
    const locations: { location: KeystrokeLeak["location"]; raw: string }[] = [
      { location: "url", raw: request.url },
      { location: "body", raw: request.body ?? "" }
    ];

    for (const { location, raw } of locations) {
      if (!raw) continue;
      const lowered = raw.toLowerCase();
      for (const encoding of encodings) {
        if (!encoding.value) continue;
        const haystack = encoding.caseSensitive ? raw : lowered;
        const needle = encoding.caseSensitive ? encoding.value : encoding.value.toLowerCase();
        if (!haystack.includes(needle)) continue;

        const key = `${request.domain}|${encoding.encoding}|${location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        leaks.push({ domain: request.domain, thirdParty: request.thirdParty, encoding: encoding.encoding, location });
      }
    }
  }

  return leaks;
}

/**
 * Build a detection from leaks, but only when a *third party* received the
 * sentinel. A first-party-only appearance is the site's own form handling
 * (expected, since the probe never submits) and is not flagged.
 */
export function buildKeystrokeExfiltrationDetection(
  leaks: KeystrokeLeak[],
  probe: { fieldsTyped: number; fieldTypes: string[] }
): KeystrokeExfiltrationDetectionSummary | null {
  const thirdPartyLeaks = leaks.filter((leak) => leak.thirdParty);
  if (thirdPartyLeaks.length === 0) return null;

  const recipients = uniqueSorted(thirdPartyLeaks.map((leak) => leak.domain));
  const encodings = uniqueSorted(thirdPartyLeaks.map((leak) => leak.encoding));

  return {
    kind: "keystroke-exfiltration",
    heuristic: "input-sentinel-exfiltration-v1",
    count: recipients.length,
    evidence: {
      recipients,
      encodings,
      fieldsTyped: Math.max(0, Math.floor(probe.fieldsTyped)),
      fieldTypes: uniqueSorted(probe.fieldTypes)
    }
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}
