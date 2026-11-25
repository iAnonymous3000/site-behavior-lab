/**
 * Multilingual, iframe-aware privacy policy discovery & cross-check probe for
 * Site Behavior Lab v3.
 *
 * Covers EN, DE, FR, ES, IT, NL, PT, SV, PL, JA, ZH, and KO privacy policy
 * links and checkable policy claims, and cross-checks observed tracking
 * entities against the policy text using global corporate & alias resolution.
 */

import { entityPolicyAliasesV3 } from "../entity-catalog";
import type { PolicyClaimKindV3, PolicySummaryV3 } from "../schema";

export type PolicyLinkCandidateV3 = {
  href: string;
  text: string;
  fromIframe?: boolean;
};

const POLICY_HOSTING_DOMAINS = new Set([
  "termly.io",
  "iubenda.com",
  "privacypolicies.com",
  "termsfeed.com",
  "getterms.io",
  "enzuzo.com",
  "freeprivacypolicy.com"
]);

const POLICY_PATH_RE =
  /\/(?:privacy(?:[-_]?(?:policy|notice|statement|center|centre))?|datenschutz(?:erkl(?:a|ae)rung|hinweise)?|confidentialite|politique[-_]de[-_]confidentialite|privacidad|politica[-_]de[-_]privacidad|privacidade|informativa[-_]privacy|privacybeleid|integritetspolicy|polityka[-_]prywatnosci|privacy-policy)(?:\/|\.[a-z0-9]+)?$/i;

const POLICY_LINK_TEXT_RE =
  /(?:\bprivacy\s*(?:policy|notice|statement)\b|^privacy$|\bdatenschutz(?:erkl[äa]rung|hinweise)?\b|\bpolitique\s+de\s+confidentialit[ée]\b|\bconfidentialit[ée]\b|\bpol[íi]tica\s+de\s+privacidad\b|\baviso\s+de\s+privacidad\b|\binformativa\s+(?:sulla\s+)?privacy\b|\bprivacybeleid\b|\bpol[íi]tica\s+de\s+privacidade\b|\bintegritetspolicy\b|\bpolityka\s+prywatno[śs]ci\b|プライバシーポリシー|個人情報保護方針|隐私政策|隱私權政策|개인정보\s*처리방침)/i;

const MULTILINGUAL_CLAIMS: readonly { kind: PolicyClaimKindV3; pattern: RegExp }[] = [
  {
    kind: "no-cookies",
    pattern:
      /\b(?:we\s+do\s+not\s+use\s+cookies|does\s+not\s+use\s+cookies|wir\s+verwenden\s+keine\s+cookies|nous\s+n['’]utilisons\s+pas\s+de\s+cookies|no\s+utilizamos\s+cookies)\b/i
  },
  {
    kind: "no-third-party-cookies",
    pattern:
      /\b(?:we\s+do\s+not\s+use\s+third[- ]party\s+cookies|no\s+third[- ]party\s+cookies|keine\s+drittanbieter[- ]cookies|pas\s+de\s+cookies\s+tiers)\b/i
  },
  {
    kind: "no-selling-or-sharing",
    pattern:
      /\b(?:we\s+do\s+not\s+sell(?:\s+or\s+share)?\s+(?:your\s+)?personal\s+(?:information|data)|we\s+never\s+sell\s+(?:your\s+)?personal|wir\s+verkaufen\s+keine\s+personenbezogenen\s+daten|nous\s+ne\s+vendons\s+pas\s+vos\s+donn[ée]es|no\s+vendemos\s+(?:su|tu)\s+informaci[óo]n\s+personal)\b/i
  },
  {
    kind: "honors-gpc",
    pattern:
      /\b(?:we\s+(?:also\s+|fully\s+|will\s+)?(?:honor|honour|respect|recognize|recognise|respond\s+to)\s+(?:the\s+)?(?:global\s+privacy\s+control|gpc)\b|global\s+privacy\s+control\s+\(gpc\)\s+signals?\s+(?:are|will\s+be)\s+(?:honored|honoured|respected))\b/i
  }
];

/** Select the highest-confidence privacy policy URL belonging to the site (or an approved policy host). */
export function selectPrivacyPolicyUrlV3(
  candidates: readonly PolicyLinkCandidateV3[],
  siteRegistrableDomain: string,
  registrableDomain: (host: string) => string
): { url: string; fromIframe: boolean } | null {
  const siteReg = siteRegistrableDomain.toLowerCase();
  let best: { url: string; fromIframe: boolean; score: number } | null = null;

  for (const candidate of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(candidate.href);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const reg = registrableDomain(parsed.hostname).toLowerCase();
    const isSameSite = reg === siteReg;
    const isPolicyHost = POLICY_HOSTING_DOMAINS.has(reg);
    if (!isSameSite && !isPolicyHost) continue;

    let score = 0;
    if (POLICY_PATH_RE.test(parsed.pathname)) score += 60;
    if (POLICY_LINK_TEXT_RE.test(candidate.text.trim())) score += 45;
    if (isSameSite) score += 15;
    if (!candidate.fromIframe) score += 5;
    if (score < 45) continue;

    if (!best || score > best.score) {
      best = { url: parsed.toString(), fromIframe: Boolean(candidate.fromIframe), score };
    }
  }

  return best ? { url: best.url, fromIframe: best.fromIframe } : null;
}

/** Analyze extracted privacy policy text against observed tracking entities and checkable claims. */
export function analyzePolicyTextV3(input: {
  url: string;
  text: string;
  language?: string | null;
  fromIframe?: boolean;
  observedEntities: readonly string[];
}): PolicySummaryV3 | null {
  const normalized = input.text.replace(/\s+/g, " ").trim();
  if (normalized.length < 400) return null;

  const sentences = normalized.split(/(?<=[.!?。！？])\s+/);
  const claims: PolicySummaryV3["claims"] = [];
  const seenKinds = new Set<PolicyClaimKindV3>();

  for (const sentence of sentences) {
    if (sentence.length < 15 || sentence.length > 500) continue;
    for (const rule of MULTILINGUAL_CLAIMS) {
      if (seenKinds.has(rule.kind)) continue;
      if (rule.pattern.test(sentence)) {
        seenKinds.add(rule.kind);
        claims.push({ kind: rule.kind, quote: sentence.slice(0, 220) });
      }
    }
  }

  const lowered = normalized.toLowerCase();
  const mentionedEntities: string[] = [];
  const unmentionedEntities: string[] = [];

  for (const entity of [...new Set(input.observedEntities)].sort((a, b) => a.localeCompare(b))) {
    const aliases = entityPolicyAliasesV3(entity);
    const found = aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(lowered);
    });
    if (found) mentionedEntities.push(entity);
    else unmentionedEntities.push(entity);
  }

  return {
    url: input.url,
    language: input.language ?? null,
    textLength: normalized.length,
    fromIframe: Boolean(input.fromIframe),
    claims,
    mentionedEntities,
    unmentionedEntities: unmentionedEntities.slice(0, 30)
  };
}
