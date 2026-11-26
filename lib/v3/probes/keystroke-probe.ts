/**
 * Expanded active keystroke / input-exfiltration probe for Site Behavior Lab v3.
 *
 * Upgrades over v1/v2:
 *  - Types synthetic canary into main document, accessible iframes, AND open
 *    Shadow DOM form fields (never submitting forms).
 *  - Decompresses gzip / deflate / brotli POST bodies (capped at 1 MiB) before
 *    matching sentinel encodings.
 *  - Inspects outgoing WebSocket frames (`transport: "websocket"`).
 *  - Catches CNAME-cloaked first-party collectors (`cloakTargetByHost`), not
 *    only raw third-party hosts!
 */

import { createHash, randomBytes } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { KeystrokeLeakV3, KeystrokeTransportV3, ScanPhaseName } from "../schema";

export const MAX_DECOMPRESSED_BODY_BYTES = 1024 * 1024;
export const MAX_INSPECTED_CHARS = 128_000;

export type SentinelEncodingV3 = {
  encoding: string;
  value: string;
  caseSensitive: boolean;
};

export type KeystrokePayloadCandidateV3 = {
  domain: string;
  registrableDomain: string;
  thirdParty: boolean;
  url: string;
  body?: string | Buffer | null;
  contentEncoding?: string | null;
  resourceType?: string;
  isWebSocketFrame?: boolean;
  phase: ScanPhaseName;
};

export function createKeystrokeCanaryV3(randomHex = randomBytes(8).toString("hex")): string {
  return `sblcanary${randomHex}`;
}

export function buildSentinelEncodingsV3(canary: string): SentinelEncodingV3[] {
  const candidates: Array<{ suffix: string; value: string }> = [
    { suffix: "", value: canary },
    { suffix: "-email", value: `${canary}@example.invalid` }
  ];
  const raw: SentinelEncodingV3[] = [];
  const seenValues = new Set<string>();

  for (const { suffix, value } of candidates) {
    const buf = Buffer.from(value, "utf8");
    const base64 = buf.toString("base64").replace(/=+$/, "");
    const base64Encoded = encodeURIComponent(base64);
    const base64url = buf.toString("base64url");
    const urlEncoded = encodeURIComponent(value);
    const variants: SentinelEncodingV3[] = [
      { encoding: `plain${suffix}`, value, caseSensitive: false },
      ...(urlEncoded !== value ? [{ encoding: `url-encoded${suffix}`, value: urlEncoded, caseSensitive: false }] : []),
      { encoding: `hex${suffix}`, value: buf.toString("hex"), caseSensitive: false },
      { encoding: `base64${suffix}`, value: base64, caseSensitive: true },
      ...(base64Encoded !== base64 ? [{ encoding: `base64-url${suffix}`, value: base64Encoded, caseSensitive: true }] : []),
      ...(base64url !== base64 ? [{ encoding: `base64url${suffix}`, value: base64url, caseSensitive: true }] : []),
      { encoding: `md5${suffix}`, value: createHash("md5").update(value).digest("hex"), caseSensitive: false },
      { encoding: `sha1${suffix}`, value: createHash("sha1").update(value).digest("hex"), caseSensitive: false },
      { encoding: `sha256${suffix}`, value: createHash("sha256").update(value).digest("hex"), caseSensitive: false }
    ];
    for (const item of variants) {
      if (item.value.length >= 8 && !seenValues.has(item.value)) {
        seenValues.add(item.value);
        raw.push(item);
      }
    }
  }
  return raw;
}

/**
 * Safely decompress gzip/deflate/brotli buffers with a strict 1 MiB output cap
 * to prevent decompression bombs from untrusted pages.
 */
export function tryDecompressBodyV3(
  body: string | Buffer | null | undefined,
  contentEncoding?: string | null
): { text: string | null; wasCompressed: boolean } {
  if (!body) return { text: null, wasCompressed: false };
  const enc = (contentEncoding ?? "").trim().toLowerCase();
  const isBuf = Buffer.isBuffer(body);
  const rawBuf = isBuf ? body : Buffer.from(body, "latin1");

  const looksGzip = rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b;
  if (enc.includes("gzip") || looksGzip) {
    try {
      const out = gunzipSync(rawBuf, { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES });
      return { text: out.toString("utf8").slice(0, MAX_INSPECTED_CHARS), wasCompressed: true };
    } catch {
      // Fall through to plain text check
    }
  }
  if (enc.includes("br")) {
    try {
      const out = brotliDecompressSync(rawBuf, { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES });
      return { text: out.toString("utf8").slice(0, MAX_INSPECTED_CHARS), wasCompressed: true };
    } catch {
      // Fall through
    }
  }
  if (enc.includes("deflate")) {
    for (const fn of [inflateSync, inflateRawSync]) {
      try {
        const out = fn(rawBuf, { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES });
        return { text: out.toString("utf8").slice(0, MAX_INSPECTED_CHARS), wasCompressed: true };
      } catch {
        // Try next inflate variant
      }
    }
  }
  const plain = typeof body === "string" ? body : body.toString("utf8");
  return { text: plain.slice(0, MAX_INSPECTED_CHARS), wasCompressed: false };
}

/**
 * Inspect captured HTTP requests & WebSocket frames for keystroke canary leaks.
 * Flags third-party recipients AND first-party hosts that are CNAME-cloaked to
 * a third-party tracker (`cloakTargetByHost`).
 */
export function detectKeystrokeLeaksV3(
  encodings: readonly SentinelEncodingV3[],
  candidates: readonly KeystrokePayloadCandidateV3[],
  options?: { cloakTargetByHost?: ReadonlyMap<string, string> }
): KeystrokeLeakV3[] {
  const leaks: KeystrokeLeakV3[] = [];
  const seen = new Set<string>();
  const cloakMap = options?.cloakTargetByHost;

  for (const candidate of candidates) {
    const domain = candidate.domain.toLowerCase();
    const cnameTarget = cloakMap?.get(domain);
    const effectivelyThirdParty = candidate.thirdParty || Boolean(cnameTarget);
    if (!effectivelyThirdParty) continue;

    const surfaces: { transport: KeystrokeTransportV3; raw: string }[] = [];
    if (candidate.isWebSocketFrame) {
      const { text } = tryDecompressBodyV3(candidate.body, candidate.contentEncoding);
      if (text) surfaces.push({ transport: "websocket", raw: text });
    } else {
      if (candidate.url) {
        surfaces.push({
          transport: candidate.resourceType === "ping" ? "beacon" : "http-url",
          raw: candidate.url.slice(0, MAX_INSPECTED_CHARS)
        });
      }
      if (candidate.body) {
        const { text, wasCompressed } = tryDecompressBodyV3(candidate.body, candidate.contentEncoding);
        if (text) {
          surfaces.push({
            transport:
              candidate.resourceType === "ping"
                ? "beacon"
                : wasCompressed
                  ? "http-body-gzip"
                  : "http-body",
            raw: text
          });
        }
      }
    }

    for (const { transport, raw } of surfaces) {
      const lower = raw.toLowerCase();
      for (const enc of encodings) {
        const haystack = enc.caseSensitive ? raw : lower;
        const needle = enc.caseSensitive ? enc.value : enc.value.toLowerCase();
        if (!haystack.includes(needle)) continue;

        const key = `${domain}|${transport}|${enc.encoding}|${candidate.phase}`;
        if (seen.has(key)) continue;
        seen.add(key);
        leaks.push({
          domain,
          registrableDomain: candidate.registrableDomain.toLowerCase(),
          thirdParty: candidate.thirdParty,
          ...(cnameTarget ? { cnameTarget } : {}),
          transport,
          encoding: enc.encoding,
          phase: candidate.phase
        });
      }
    }
  }

  return leaks.sort((a, b) => a.domain.localeCompare(b.domain) || a.transport.localeCompare(b.transport));
}

export type InPageTypingResultV3 = {
  fieldsTyped: number;
  shadowDomFieldsTyped: number;
  fieldTypes: string[];
};

/**
 * Self-contained browser evaluation function that locates up to 6 visible
 * non-password input/textarea controls across the document AND open Shadow DOM
 * roots, dispatches realistic input/keyup/change events without submitting any
 * form, and returns counts + field types.
 */
export function typeCanaryInDocument(args: { canary: string; maxFields: number }): InPageTypingResultV3 {
  const ALLOWED_TYPES = new Set(["text", "email", "search", "tel", "url", ""]);
  const found: { el: HTMLInputElement | HTMLTextAreaElement; inShadow: boolean; fieldType: string }[] = [];
  const visitedRoots = new Set<Document | ShadowRoot>();

  const collect = (root: Document | ShadowRoot, inShadow: boolean) => {
    if (visitedRoots.has(root) || found.length >= args.maxFields) return;
    visitedRoots.add(root);
    const elements = root.querySelectorAll("input, textarea");
    for (const node of Array.from(elements)) {
      if (found.length >= args.maxFields) break;
      const el = node as HTMLInputElement | HTMLTextAreaElement;
      if (el.disabled || el.readOnly) continue;
      const tag = el.tagName.toLowerCase();
      const rawType = tag === "textarea" ? "textarea" : (el.getAttribute("type") || "text").toLowerCase();
      if (tag === "input" && !ALLOWED_TYPES.has(rawType)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      found.push({ el, inShadow, fieldType: rawType || "text" });
    }
    if (found.length >= args.maxFields) return;
    const all = root.querySelectorAll("*");
    let scanned = 0;
    for (const elem of Array.from(all)) {
      if (++scanned > 1500 || found.length >= args.maxFields) break;
      if (elem.shadowRoot) collect(elem.shadowRoot, true);
    }
  };

  collect(document, false);

  let shadowDomFieldsTyped = 0;
  const fieldTypes: string[] = [];

  for (const item of found) {
    try {
      const valueToType = item.fieldType === "email" ? `${args.canary}@example.invalid` : args.canary;
      item.el.focus();
      const proto = item.el.tagName.toLowerCase() === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(item.el, valueToType);
      else item.el.value = valueToType;
      item.el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      item.el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "a" }));
      item.el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      item.el.blur();
      fieldTypes.push(item.fieldType);
      if (item.inShadow) shadowDomFieldsTyped += 1;
    } catch {
      // Ignore individual element failure
    }
  }

  return {
    fieldsTyped: fieldTypes.length,
    shadowDomFieldsTyped,
    fieldTypes: Array.from(new Set(fieldTypes)).sort()
  };
}
