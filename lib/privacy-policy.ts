import { partyKey } from "./domain-utils";
import type {
  PrivacyPolicyClaim,
  PrivacyPolicyClaimKind,
  PrivacyPolicySummary
} from "./types";

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
 *      sell or share personal information", "we honor Global Privacy Control").
 *      Each claim stores the matched sentence so a reader can verify it in
 *      context.
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
// text reads "Privacy features".
//
// Keep the vocabulary aligned with the bounded in-page candidate collector.
// The collector deliberately casts a broad net; this selector is the
// conservative second stage, so every localized form below is either an exact
// policy-shaped path segment or an explicit phrase that means policy/notice/
// statement. Bare mentions such as "why privacy matters" remain insufficient.
//
// Every stem the collector matches on must be answerable here. A stem the
// collector finds but this stage cannot score is worse than not collecting it
// at all: the run then reports "no discoverable policy link" as a property of
// the SITE when it is a limit of the instrument. The handoff guard in
// privacy-policy.test.ts derives its cases from the collector's declared
// POLICY_LINK_TERMS so the two halves cannot drift apart again.
//
// Two normalization notes for the localized forms: normalizePolicySignal
// strips combining marks, so an accented link label arrives here unaccented,
// but the Nordic "ae" ligature and the Turkish dotless i (ı) are separate
// letters that survive it and need their own alternatives.
const POLICY_PATH_SEGMENT =
  /^(?:privacy|privacy[-_]?(?:policy|notice|statement|centre|center)|datenschutz(?:erkl(?:a|ae)rung|hinweise?|richtlinie|bestimmungen)?|privacybeleid|privacyverklaring|gegevensbeschermingsbeleid|privacidad|(?:politica|politicas|aviso|declaracion)[-_](?:de[-_])?privacidad|confidentialite|(?:politique|charte|avis)[-_](?:de[-_])?confidentialite|politique[-_](?:de[-_])?protection[-_]des[-_]donnees|privacidade|(?:politica|politicas|aviso|declaracao)[-_](?:de[-_])?privacidade|politica[-_](?:de[-_])?protecao[-_]de[-_]dados|privatezza|informativa[-_](?:su[-_]|sulla[-_]|sulle[-_]|sui[-_])?(?:privacy|privatezza)|integritetspolicy|tietosuoja(?:seloste|kaytanto|lauseke|ilmoitus|periaatteet)?|personvern(?:erkl(?:ae|æ)ring|policy)?|persondatapolitik|privatlivspolitik|(?:politik[-_]om[-_]|beskyttelse[-_]af[-_])personoplysninger|(?:polityka|ochrona)[-_]prywatnosci|gizlilik(?:[-_](?:politikas[iı]|bildirimi|sozlesmesi))?|(?:ochrana|zasady[-_]ochrany)[-_]soukromi|adatvedelmi[-_](?:tajekoztato|nyilatkozat|szabalyzat|iranyelvek))(?:\.[a-z0-9]+)?$/;

const POLICY_TEXT_PATTERNS = [
  /\bprivacy\s+(?:policy|notice|statement)\b/,
  /^(?:politica|politicas|aviso|declaracion)\s+(?:de\s+)?privacidad$/,
  /^(?:politique|charte|avis)\s+(?:de\s+)?confidentialite$/,
  /^politique\s+(?:de\s+)?protection\s+des\s+donnees$/,
  /^datenschutz(?:erkl(?:a|ae)rung|hinweise?|richtlinie|bestimmungen)$/,
  /^(?:privacybeleid|privacyverklaring|gegevensbeschermingsbeleid)$/,
  /^(?:politica|politicas|aviso|declaracao)\s+(?:de\s+)?privacidade$/,
  /^politica\s+(?:de\s+)?protecao\s+de\s+dados$/,
  /^informativa\s+(?:su\s+|sulla\s+|sulle\s+|sui\s+)?(?:privacy|privatezza)$/,
  /^integritetspolicy$/,
  /^tietosuoja(?:seloste|kaytanto|lauseke|ilmoitus|periaatteet)$/,
  /^personvern(?:erkl(?:ae|æ)ring|policy)$/,
  /^(?:persondatapolitik|privatlivspolitik)$/,
  /^(?:politik\s+om|beskyttelse\s+af)\s+personoplysninger$/,
  /^(?:polityka|ochrona)\s+prywatnosci$/,
  /^gizlilik\s+(?:politikas[iı]|bildirimi|sozlesmesi)$/,
  /^(?:ochrana|zasady\s+ochrany)\s+soukromi$/,
  /^adatvedelmi\s+(?:tajekoztato|nyilatkozat|szabalyzat|iranyelvek)$/
];

const PRIVACY_TERM =
  /\b(?:privacy|privacidad|privacidade|privatezza|confidentialite|datenschutz|privacybeleid|privacyverklaring|gegevensbescherming|integritetspolicy|tietosuoja|personvern|personoplysninger|prywatnosci|gizlilik|soukromi|adatvedelmi)\b/;

// Privacy-adjacent pages that are NOT the policy: product/marketing ("privacy
// features", "privacy principles/promise"), changelogs ("privacy updates"),
// campaigns ("privacy day/month"), and blog/news posts. Without this, a
// "Privacy features" link outscores the real /privacy/ policy whose link text
// does not contain the word "privacy". Kept deliberately narrow to avoid
// excluding a genuine policy that happens to sit at an unusual path.
const NON_POLICY_PRIVACY_PAGE =
  /privacy[-_ ]?(feature|update|day|month|week|matter|blog|news|tip|principle|promise|commitment|glossary)/;

const NON_POLICY_LOCALIZED_LINK =
  /\b(?:consejos?|preferencias?|opciones?|configuracion|centro|guia|modelo|como redactar)\b|\b(?:fonctionnalites?|preferences?|choix|parametres?|conseils?|guide|centre)\b|\b(?:einstellungen|tipps?|ratgeber|beispiel|was gehort)\b|\b(?:voorbeeld|voorkeuren|tips?|centrum|handleiding)\b|\b(?:preferencias?|opcoes|configuracoes|dicas|modelo|guia)\b/;

/**
 * Whether a policy document URL can still be attributed to the scanned site.
 * Keep this gate shared by link selection and the scanner's post-navigation
 * checks: redirects and client-side navigation must not turn an eligible link
 * into another organization's policy after selection.
 */
export function isAllowedPrivacyPolicyUrl(url: string | URL, firstPartyHostname: string): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const linkParty = partyKey(parsed.hostname);
  return linkParty === partyKey(firstPartyHostname) || POLICY_HOSTING_SERVICES.includes(linkParty);
}

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
    if (!isAllowedPrivacyPolicyUrl(parsed, firstPartyHostname)) continue;

    const linkParty = partyKey(parsed.hostname);
    const sameParty = linkParty === firstParty;

    const text = normalizePolicySignal(link.text.trim());
    const segments = normalizedPolicyPathSegments(parsed.pathname);
    if (!segments) continue;
    const path = segments.join("/");

    // Marketing/changelog/opt-out pages are never the policy, regardless of the
    // word "privacy" appearing in the text or path.
    if (
      NON_POLICY_PRIVACY_PAGE.test(path) ||
      NON_POLICY_PRIVACY_PAGE.test(text) ||
      (NON_POLICY_LOCALIZED_LINK.test(text) && !/^privacy cent(?:re|er)$/.test(text))
    ) {
      continue;
    }
    if (
      /do not sell|cookie (?:settings|preferences)|opt[- ]out|your privacy choices/.test(text) ||
      /no vender|preferencias de privacidad|opciones de privacidad|configuracion de cookies/.test(text) ||
      /preferences de confidentialite|choix de confidentialite|parametres des cookies/.test(text) ||
      /datenschutzeinstellungen|cookie[- ]einstellungen/.test(text) ||
      /privacyvoorkeuren|cookie[- ]instellingen/.test(text) ||
      /preferencias de privacidade|opcoes de privacidade|configuracoes de cookies/.test(text)
    ) {
      continue;
    }

    const hasPolicyPath = segments.some((segment) => POLICY_PATH_SEGMENT.test(segment));
    const hasPolicyText = POLICY_TEXT_PATTERNS.some((pattern) => pattern.test(text));

    let score = 0;
    if (hasPolicyPath) score += 5;
    if (hasPolicyText) score += 4;
    if (PRIVACY_TERM.test(text)) score += 1;
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

type NoSellingOrSharingClaimScope = "blanket" | "qualified" | "not-checkable";

const NO_TRANSFER_BRIDGE_WORDS = new Set([
  "and",
  "any",
  "collect",
  "currently",
  "disclose",
  "ever",
  "exchange",
  "in",
  "knowingly",
  "lease",
  "license",
  "nor",
  "or",
  "otherwise",
  "rent",
  "share",
  "trade",
  "transfer",
  "use",
  "way"
]);

const NO_TRANSFER_GOVERNED_WORDS = new Set([
  ...NO_TRANSFER_BRIDGE_WORDS,
  "address",
  "data",
  "email",
  "information",
  "it",
  "other",
  "party",
  "parties",
  "personal",
  "provided",
  "sell",
  "selling",
  "sells",
  "shares",
  "sharing",
  "them",
  "third",
  "to",
  "with",
  "your"
]);

/**
 * Classify a combined no-selling-or-sharing sentence before it is allowed to
 * become a checkable blanket claim.
 *
 * A scanner observation cannot contradict a promise limited to children,
 * knowing conduct, a particular kind of consideration, or the current moment.
 * Nor can this sentence matcher safely summarize an adversarial/contradictory
 * clause such as "we do not sell for money, but sharing may be a sale." Those
 * statements can still be meaningful legal disclosures; they are simply not
 * the blanket factual promise represented by `no-selling-or-sharing`.
 */
function noSellingOrSharingClaimScope(sentence: string): NoSellingOrSharingClaimScope {
  const lower = normalizePolicySignal(sentence);
  const negation = FIRST_PERSON_NEGATION.exec(lower);
  if (!negation) return "not-checkable";

  const governedClause = lower
    .slice(negation.index + negation[0].length)
    .split(/[.!?]/, 1)[0] ?? "";
  if (/[;:]/.test(governedClause)) return "not-checkable";
  const sale = /\b(?:sell|sells|selling)\b/.exec(governedClause);
  const sharing = /\b(?:share|shares|sharing)\b/.exec(governedClause);
  if (!sale || !sharing) return "not-checkable";
  const personalData = /\b(?:personal|your)\s+(?:information|data)\b/.exec(governedClause);
  if (!personalData) return "not-checkable";

  // Both transfer verbs must live in the same direct action phrase governed by
  // this ONE negation. Sell-only/share-only wording cannot populate a combined
  // field, and a second subject or second negation cannot be borrowed to make
  // two separate promises look like one.
  const firstActionIndex = Math.min(sale.index, sharing.index);
  const lastActionEnd = Math.max(sale.index + sale[0].length, sharing.index + sharing[0].length);
  const transferScopeEnd = Math.max(lastActionEnd, personalData.index + personalData[0].length);
  if (!/\b(?:or|nor)\b/.test(governedClause.slice(0, transferScopeEnd))) return "not-checkable";
  const bridge = governedClause.slice(0, firstActionIndex);
  if (bridge.length > 120 || /\b(?:but|however|although|though|while|whereas|yet)\b|[.;:]/.test(bridge)) {
    return "not-checkable";
  }
  const bridgeWords = bridge.match(/[a-z]+/g) ?? [];
  if (bridgeWords.some((word) => !NO_TRANSFER_BRIDGE_WORDS.has(word))) return "not-checkable";
  const governedWords = governedClause.slice(0, lastActionEnd).match(/[a-z]+/g) ?? [];
  if (governedWords.some((word) => !NO_TRANSFER_GOVERNED_WORDS.has(word))) return "not-checkable";

  // A sentence with a second, contrasting clause is not safely reducible to
  // its first negative clause, even when the narrowing words appear later.
  if (/\b(?:but|however|although|though|while|whereas|yet)\b/.test(lower)) return "not-checkable";
  if (
    /\b(?:may|might|can|could)\s+(?:still\s+|also\s+)?(?:sell|share)\b/.test(lower) ||
    /\b(?:sale|sharing)\b[^.!?]{0,60}\b(?:considered|deemed|constitute|qualif(?:y|ies))\b/.test(lower)
  ) {
    return "not-checkable";
  }

  // These terms narrow the population, state of mind, time, data category, or
  // form of value covered by the promise. Treat the sentence as qualified
  // rather than publishing it as "the policy says personal information is not
  // sold or shared."
  if (
    /\bknowingly\b/.test(lower) ||
    /\b(?:minor|child|children)(?:s|'s)?\b|\bunder\s+(?:the\s+age\s+of\s+)?\d{1,2}\b/.test(lower) ||
    /\b(?:currently|at (?:this|the present) time|for now|today|to date)\b/.test(lower) ||
    /\b(?:monetary|financial)\s+(?:gain|consideration|compensation|payment|benefit|value)\b|\bfor money\b|\bin exchange for\b/.test(lower) ||
    /\b(?:except|unless|other than|only|certain|specific|sensitive)\b/.test(lower) ||
    /\bwithout\s+(?:your|the user's|the users')\s+(?:consent|permission)\b/.test(lower) ||
    /\b(?:as defined (?:by|under|in)|as (?:that|those|the) terms? (?:is|are) defined|within the meaning of|pursuant to|for purposes of)\b/.test(lower) ||
    /\bunder\s+(?:applicable|state|federal|california|consumer|privacy|data protection)[^.!?]{0,40}\blaws?\b/.test(lower)
  ) {
    return "qualified";
  }

  return "blanket";
}

/**
 * The claim kinds the report actually compares against observed evidence.
 *
 * `honors-gpc` is deliberately absent and must stay absent: honoring GPC means
 * not selling or sharing data, which request counts cannot observe, so no
 * count-based comparison may contradict it. It is still extracted and still
 * stored in the policy summary; it simply never participates in a check.
 *
 * This list is the single source of truth for "checkable". It used to exist
 * only implicitly, as the set of kinds the findings board happened to write a
 * comparison for, while the predicate below answered the same question its own
 * way and included `honors-gpc`. The two disagreed, so a policy whose only
 * match was a GPC claim published "no checked statement contradicted" and
 * "1 checkable statement matched" after running zero comparisons.
 */
export const COMPARED_POLICY_CLAIM_KINDS: readonly PrivacyPolicyClaimKind[] = [
  "no-third-party-cookies",
  "no-cookies",
  "no-selling-or-sharing"
];

/**
 * Revalidate stored claims at render time as well as extraction time. Public
 * archives can contain claims produced by an older detector revision; a
 * qualified historical quote must not keep driving a current contradiction
 * card merely because its old wire enum is still valid.
 *
 * "Checkable" means exactly "this scan will compare it against evidence", so a
 * kind the board never compares is not checkable, however well-formed its
 * quote is.
 */
export function isCurrentlyCheckablePolicyClaim(claim: PrivacyPolicyClaim): boolean {
  if (!COMPARED_POLICY_CLAIM_KINDS.includes(claim.kind)) return false;
  // A capped quote may have lost a qualifier after its retained prefix.
  if (claim.quote.trimEnd().endsWith("...")) return false;
  if (claim.kind === "no-cookies" || claim.kind === "no-third-party-cookies") {
    return blanketCookieClaimKind(claim.quote) === claim.kind;
  }
  return noSellingOrSharingClaimScope(claim.quote) === "blanket";
}

/** Only direct, unqualified denials support a cookie contradiction. A negation
 * elsewhere in the sentence must never govern a positive cookie statement. */
function blanketCookieClaimKind(sentence: string): "no-cookies" | "no-third-party-cookies" | null {
  const lower = normalizePolicySignal(sentence).trim();
  const active = /^(?:we|our (?:web)?site|this (?:web)?site)\s+(?:do(?:es)? not|don't|doesn't|never|will not|won't)\s+(?:use|set|place|serve|allow|store)\s+(?:any\s+)?(third[-\s]party\s+)?cookies(?:\s+on this (?:web)?site)?(?:\s+at all)?[.!]?$/;
  const passive = /^no (third[-\s]party\s+)?cookies\s+are\s+(?:used|set|placed|stored)(?:\s+on this (?:web)?site)?(?:\s+at all)?[.!]?$/;
  const match = active.exec(lower) ?? passive.exec(lower);
  return match ? (match[1] ? "no-third-party-cookies" : "no-cookies") : null;
}

/** Extract checkable claims from the policy text, one per kind, with the matched sentence as the quote. */
export function extractPolicyClaims(policyText: string): PrivacyPolicyClaim[] {
  const claims = new Map<PrivacyPolicyClaim["kind"], string>();

  for (const sentence of splitSentences(policyText)) {
    const lower = sentence.toLowerCase();
    const negated = FIRST_PERSON_NEGATION.test(lower);

    const cookieKind = blanketCookieClaimKind(sentence);
    if (cookieKind && !claims.has(cookieKind)) claims.set(cookieKind, sentence);

    if (!claims.has("no-selling-or-sharing") && noSellingOrSharingClaimScope(sentence) === "blanket") {
      claims.set("no-selling-or-sharing", sentence);
    }

    // A positive "we honor GPC" claim must contain NO negation at all: "We do
    // not honor Global Privacy Control" contains both the term and the verb,
    // and a first-person pattern alone misses subjects like "our systems".
    // A skipped real claim only means one less extracted statement; a negated
    // sentence extracted as support would invert the policy's meaning.
    if (!claims.has("honors-gpc") && !negated && /\bglobal privacy control\b/.test(lower) &&
      /\b(?:honor|respect|recogni[sz]|treat|comply|process)\w*\b/.test(lower) &&
      !/\b(?:not|never|no|don'?t|doesn'?t|won'?t|cannot|can'?t|unable)\b/.test(lower)) {
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
  "Amazon Ads": ["amazon"],
  "Oracle Advertising": ["oracle", "bluekai"],
  Adobe: ["adobe"],
  LinkedIn: ["linkedin"],
  TikTok: ["tiktok", "bytedance"]
};

/**
 * Company names that are also ordinary words cannot go in the case-insensitive
 * alias table: "meta" matches "meta tags", a bare "x" matches everything. But a
 * policy that names "Meta Platforms" or a mid-sentence capitalized "Meta" HAS
 * named the company, and publishing "Meta is never named in the privacy policy
 * text" over it is a false accusation. The costs are asymmetric: an over-match
 * merely withholds an accusation, an under-match invents one, so these patterns
 * lean toward matching.
 */
const ENTITY_NAME_PATTERNS: Record<string, RegExp[]> = {
  Meta: [/\bmeta\s+platforms?\b/i, /\bmeta\s+pixel\b/i, /\bMeta\b(?!\s*(?:tag|data|description|element))/],
  X: [/\bX\b(?!\s*[),.]?\s*(?:axis|ray))/]
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
    const found =
      aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(lower)) ||
      // Case-sensitive patterns run against the original text: they exist for
      // names the lowercased alias pass cannot safely test.
      (ENTITY_NAME_PATTERNS[entity] ?? []).some((pattern) => pattern.test(policyText));
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

function normalizePolicySignal(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedPolicyPathSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const rawSegment of pathname.split("/").filter(Boolean)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    // Decode only after splitting and reject delimiters introduced by escapes:
    // `%2Fprivacy` is one path segment, not a synthetic strong `privacy`
    // segment, and must not gain policy status through decoding.
    if (/[\\/]/.test(decoded)) return null;
    segments.push(normalizePolicySignal(decoded));
  }
  return segments;
}
