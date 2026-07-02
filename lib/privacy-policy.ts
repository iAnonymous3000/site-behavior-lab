import { partyKey } from "./domain-utils";
import type { PrivacyPolicyClaim, PrivacyPolicySummary } from "./types";

export type { PrivacyPolicyClaim, PrivacyPolicyClaimKind, PrivacyPolicySummary } from "./types";

/**
 * Privacy-policy cross-check: the pure decision layer.
 *
 * The scanner reads the site's own privacy policy (discovered from the scanned
 * page's links, fetched through the same SSRF-guarded browser context) and this
 * module compares the policy TEXT against the visit's observed EVIDENCE:
 *
 *   1. Checkable claims: conservative sentence-level matches for statements a
 *      scan can actually test ("we do not use third-party cookies", "we do not
 *      sell personal information", "we honor Global Privacy Control"). Each
 *      claim stores the matched sentence so a reader can verify it in context.
 *   2. Disclosure gaps: observed tracking companies whose name (or a common
 *      alias, e.g. Facebook for Meta) never appears in the policy text.
 *
 * Deliberately humble: this is an automated text match, not a legal reading.
 * Claim patterns require an explicit first-person subject ("we do not sell...")
 * so a CCPA "Do Not Sell Or Share My Personal Information" opt-out LINK, which
 * implies the opposite, never matches as a claim. The findings layer phrases
 * every result as evidence to check against the quoted sentence, not a verdict.
 *
 * Pure (no fetch/DOM) so it unit-tests directly; the scanner supplies the link
 * candidates, the extracted policy text, and the observed tracking entities.
 */

export type PolicyLinkCandidate = {
  href: string;
  text: string;
};

const MAX_QUOTE_LENGTH = 200;
const MAX_UNMENTIONED_ENTITIES = 12;
// Below this the "policy" is more likely an error page, interstitial, or bot
// block than a real policy; treat the fetch as failed rather than analyze it.
export const MIN_POLICY_TEXT_LENGTH = 500;

// Services that host other sites' privacy policies (consent/policy platforms).
// A policy link to one of these is still the SITE'S policy; any other off-site
// "Privacy Policy" link is attributed to someone else and must be skipped. The
// classic trap is the reCAPTCHA badge ("protected by reCAPTCHA and the Google
// Privacy Policy applies") or a Cloudflare challenge page linking Cloudflare's
// own policy: analyzing those would judge the site against another company's
// promises.
const POLICY_HOSTING_SERVICES = [
  "termly.io",
  "iubenda.com",
  "privacypolicies.com",
  "termsfeed.com",
  "getterms.io",
  "enzuzo.com",
  "freeprivacypolicy.com"
];

// A URL PATH segment that is itself a privacy-policy identifier. This is the
// strongest signal, and it is what separates the real policy from marketing
// pages: brave.com/privacy/browser/ (segment "privacy") is the policy, while
// brave.com/privacy-features/ (a product page) is not, even though its link
// text reads "Privacy features". Matches "privacy", "privacy-policy",
// "privacypolicy", "privacy-notice", "privacy-statement", "datenschutz", ...
// The trailing `(\.[a-z0-9]+)?` tolerates a file extension (privacy-policy.html,
// privacy.php) so those still count as policy paths.
const POLICY_PATH_SEGMENT = /^(privacy|privacy[-_]?(policy|notice|statement|centre|center)|datenschutz|privacybeleid)(\.[a-z0-9]+)?$/;

// Privacy-adjacent pages that are NOT the policy: product/marketing ("privacy
// features", "privacy principles/promise"), changelogs ("privacy updates"),
// campaigns ("privacy day/month"), and blog/news posts. Without this, a
// "Privacy features" link outscores the real /privacy/ policy whose link text
// does not contain the word "privacy". Kept deliberately narrow to avoid
// excluding a genuine policy that happens to sit at an unusual path.
const NON_POLICY_PRIVACY_PAGE =
  /privacy[-_ ]?(feature|update|day|month|week|matter|blog|news|tip|principle|promise|commitment|glossary)/;

/**
 * Pick the most plausible privacy-policy URL from a page's links. The decision
 * is driven primarily by the URL PATH (a segment that IS a privacy-policy id),
 * then by link text explicitly naming a policy; a bare "privacy" mention is too
 * weak on its own. Only same-site links (same registrable domain) and known
 * policy-hosting services qualify: an arbitrary off-site "Privacy Policy" link
 * is some other company's policy, and misattributing it is worse than skipping.
 */
export function pickPrivacyPolicyLink(links: PolicyLinkCandidate[], firstPartyHostname: string): string | null {
  const firstParty = partyKey(firstPartyHostname);
  let best: { url: string; score: number; depth: number } | null = null;

  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

    const linkParty = partyKey(parsed.hostname);
    const sameParty = linkParty === firstParty;
    const policyHost = POLICY_HOSTING_SERVICES.includes(linkParty);
    if (!sameParty && !policyHost) continue;

    const text = link.text.trim().toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const segments = path.split("/").filter(Boolean);

    // Marketing/changelog/opt-out pages are never the policy, regardless of the
    // word "privacy" appearing in the text or path.
    if (NON_POLICY_PRIVACY_PAGE.test(path) || NON_POLICY_PRIVACY_PAGE.test(text)) continue;
    if (/do not sell|cookie (settings|preferences)|opt[- ]out|your privacy choices/.test(text)) continue;

    const hasPolicyPath = segments.some((segment) => POLICY_PATH_SEGMENT.test(segment));
    const hasPolicyText = /\bprivacy\s+(policy|notice|statement)\b/.test(text);

    let score = 0;
    if (hasPolicyPath) score += 5;
    if (hasPolicyText) score += 4;
    if (/\bprivacy\b/.test(text)) score += 1;
    // Require a strong signal: a policy-shaped path or an explicit "privacy
    // policy/notice/statement" in the text. A bare "privacy" mention (a "Global
    // Privacy Control" explainer, a "privacy features" teaser) never qualifies.
    if (score < 4) continue;
    if (sameParty) score += 2;

    // Break ties toward the most canonical policy: the shallowest path (e.g.
    // /privacy/ over /privacy/website/), then the shorter URL.
    const depth = segments.length;
    if (!best || score > best.score || (score === best.score && depth < best.depth)) {
      best = { url: parsed.href, score, depth };
    }
  }

  return best?.url ?? null;
}

// A first-person subject followed by a negation, e.g. "we do not", "we never",
// "our website will not". Required for every claim so third-party boilerplate
// and opt-out link labels ("Do Not Sell My Personal Information") never match.
const FIRST_PERSON_NEGATION =
  /\b(?:we|our (?:web)?site|this (?:web)?site)\s+(?:currently\s+)?(?:do(?:es)?\s+not|don'?t|doesn'?t|never|will\s+not|won'?t)\b/;

/** Extract checkable claims from the policy text, one per kind, with the matched sentence as the quote. */
export function extractPolicyClaims(policyText: string): PrivacyPolicyClaim[] {
  const claims = new Map<PrivacyPolicyClaim["kind"], string>();

  for (const sentence of splitSentences(policyText)) {
    const lower = sentence.toLowerCase();
    const negated = FIRST_PERSON_NEGATION.test(lower);

    if (!claims.has("no-third-party-cookies")) {
      if ((negated && /\b(?:use|set|place|serve|allow|store)\b[^.]{0,40}\bthird[-\s]?party cookies\b/.test(lower)) ||
        /\bno third[-\s]?party cookies\b[^.]{0,40}\b(?:are|is)\s+(?:used|set|placed|stored)\b/.test(lower)) {
        claims.set("no-third-party-cookies", sentence);
      }
    }

    // "We do not use cookies" (blanket). The negative lookahead keeps scoped
    // statements ("we do not use cookies for advertising / to track you") from
    // matching, since those claim much less than "no cookies at all".
    if (!claims.has("no-cookies") && negated && /\buse\s+(?:any\s+)?cookies\b(?!\s*(?:for|to|that|which|other than|except))/.test(lower) && !/third[-\s]?party/.test(lower)) {
      claims.set("no-cookies", sentence);
    }

    if (!claims.has("no-selling-or-sharing") && negated && /\bsell\b|\bsells\b|\bselling\b/.test(lower) && /\b(?:personal|your)\s+(?:information|data)\b/.test(lower)) {
      claims.set("no-selling-or-sharing", sentence);
    }

    if (!claims.has("honors-gpc") && /\bglobal privacy control\b/.test(lower) &&
      /\b(?:honor|respect|recogni[sz]|treat|comply|process)\w*\b/.test(lower)) {
      claims.set("honors-gpc", sentence);
    }
  }

  return Array.from(claims.entries()).map(([kind, quote]) => ({ kind, quote: truncateQuote(quote) }));
}

// Common alternate names a policy might use for a catalogued entity. Matching
// is deliberately generous here: a false "mentioned" only reduces flagging,
// while an entity is reported unmentioned only when no alias appears at all.
const ENTITY_ALIASES: Record<string, string[]> = {
  Meta: ["facebook", "instagram"],
  X: ["twitter", "x corp"],
  Google: ["google", "doubleclick", "youtube"],
  Microsoft: ["microsoft", "bing", "clarity"],
  Amazon: ["amazon"],
  Oracle: ["oracle", "bluekai"],
  Adobe: ["adobe"],
  LinkedIn: ["linkedin"],
  TikTok: ["tiktok", "bytedance"]
};

/** Split observed tracking entities into those the policy names and those it never mentions. */
export function classifyEntityMentions(
  policyText: string,
  entities: string[]
): { mentioned: string[]; unmentioned: string[] } {
  const lower = policyText.toLowerCase();
  const mentioned: string[] = [];
  const unmentioned: string[] = [];

  for (const entity of entities) {
    const aliases = ENTITY_ALIASES[entity] ?? [entity.toLowerCase()];
    const found = aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(lower));
    (found ? mentioned : unmentioned).push(entity);
  }

  return { mentioned, unmentioned };
}

/**
 * Build the stored summary from the fetched policy text and the visit's
 * observed tracking entities. Returns null when the text is too short to be a
 * real policy (error page, bot block), so no claims are made from a bad fetch.
 */
export function buildPrivacyPolicySummary(input: {
  url: string;
  policyText: string;
  trackingEntities: string[];
}): PrivacyPolicySummary | null {
  const text = input.policyText.trim();
  if (text.length < MIN_POLICY_TEXT_LENGTH) return null;

  const { mentioned, unmentioned } = classifyEntityMentions(text, input.trackingEntities);

  return {
    url: input.url,
    claims: extractPolicyClaims(text),
    mentionedEntities: mentioned,
    unmentionedEntities: unmentioned.slice(0, MAX_UNMENTIONED_ENTITIES),
    policyTextLength: text.length
  };
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 600);
}

function truncateQuote(sentence: string): string {
  if (sentence.length <= MAX_QUOTE_LENGTH) return sentence;
  return `${sentence.slice(0, MAX_QUOTE_LENGTH - 3).trimEnd()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
