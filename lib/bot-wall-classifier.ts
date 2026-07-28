export type BotWallPageSignals = {
  navigationSettled: boolean;
  pageText?: string;
  pageTextAvailable?: boolean;
  pageTitle: string;
  status: number | null;
  totalRequests: number;
};

export const SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE = "suspected-challenge-or-soft-block" as const;
export const SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING =
  "The scanner found multiple signs of a challenge, robot check, or blocking consent interstitial; this report reflects a suspected soft block, not a normal page load.";
export const PAGE_SUBJECT_UNVERIFIED_STATE = "page-subject-unverified" as const;
export const PAGE_SUBJECT_UNVERIFIED_WARNING =
  "The scanner could not verify whether the rendered document was the requested page because its bounded page-content collector was unavailable or unreadable; this report reflects an unverified page subject, not a normal page load.";
export const PAGE_SUBJECT_CAPTURE_LOSS_DETAIL = "page-subject-validity" as const;

export type PageSubjectState =
  | "normal"
  | typeof SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE
  | typeof PAGE_SUBJECT_UNVERIFIED_STATE;

// These are deliberately whole-title signatures. Generic fragments such as
// "security check" and "enable JavaScript" also appear in ordinary article,
// help, and account-page titles; a substring match lets the measured page turn
// an otherwise healthy visit into a failed one with unrelated prose.
const BOT_WALL_TITLE_SIGNATURES = [
  /^access denied[.!…]*$/i,
  /^attention required!?(?:\s*[|\-–—]\s*cloudflare)?$/i,
  /^just a moment[.!…]*$/i,
  /^pardon our interruption[.!…]*$/i,
  /^robot check[.!…]*$/i,
  /^captcha[.!…]*$/i,
  /^security (?:check|verification)[.!…]*$/i,
  /^are you (?:a )?(?:human|robot)\??$/i,
  /^verify (?:you are|you'?re|your) (?:a )?human\??$/i,
  /^checking your browser(?: before accessing .+)?[.!…]*$/i,
  /^unusual traffic(?: from your computer network)?[.!…]*$/i,
  /^request unsuccessful(?:\.\s*incapsula incident id:.*)?$/i
] as const;

const CONSENT_WALL_TITLE_SIGNATURES = [
  /^before you continue(?: to .+)?[.!…]*$/i,
  /^consent required[.!…]*$/i,
  /^cookie consent required[.!…]*$/i
] as const;

// A settled HTTP-200 interstitial needs testimony beyond its title. These are
// deliberately specific phrases used by challenge pages, not generic words
// such as "captcha", "cookies", "security", or "JavaScript", which ordinary
// pages can discuss.
const BOT_WALL_BODY_SIGNATURES = [
  /\bsorry, we just need to make sure (?:you'?re|you are) not a robot\b/i,
  /\benter the characters you see below\b/i,
  /\b(?:verify|confirm)(?: that)? (?:you are|you'?re) (?:a )?human\b/i,
  /\bcomplete (?:the )?(?:captcha|security verification) to continue\b/i,
  /\bperforming security verification\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\baccess to this page has been denied because we believe you are using automation tools\b/i,
  /\b(?:unusual|automated) traffic (?:has been detected|from your computer network)\b/i
] as const;

const CONSENT_WALL_BODY_SIGNATURES = [
  /\bbefore you continue to (?:google|youtube)\b/i,
  /\bwe use cookies and data to\b/i,
  /\bconsent is required (?:before|to) continue\b/i,
  /\byou must accept (?:our )?(?:cookies|privacy (?:policy|terms)) (?:before|to) continue\b/i,
  /\bplease (?:accept|agree to) (?:our )?(?:cookies|privacy (?:policy|terms)) (?:before|to) continue\b/i
] as const;

const MAX_SPARSE_INTERSTITIAL_REQUESTS = 12;

/**
 * Conservatively classify whether the measured document is the requested
 * subject or a challenge/soft-block interstitial.
 *
 * HTTP-200 is not proof that the requested page was served: Amazon robot
 * checks, Cloudflare challenges, and blocking consent interstitials commonly
 * answer successfully. For a settled successful response, no single
 * page-controlled phrase is enough. The classifier requires either a specific
 * title/body pair or two distinct body signatures plus a sparse request shape.
 * Consent walls require their own specific title/body pair. Ordinary sparse
 * pages and pages quoting one challenge sentence therefore remain valid.
 */
export function classifyPageSubject(signals: BotWallPageSignals): PageSubjectState {
  if (signals.pageTextAvailable === false) return PAGE_SUBJECT_UNVERIFIED_STATE;

  const title = signals.pageTitle.trim().replace(/\s+/g, " ");
  const text = (signals.pageText ?? "").trim().replace(/\s+/g, " ");
  const botTitleMatched = BOT_WALL_TITLE_SIGNATURES.some((signature) => signature.test(title));
  const consentTitleMatched = CONSENT_WALL_TITLE_SIGNATURES.some((signature) => signature.test(title));
  const titleMatched = botTitleMatched || consentTitleMatched;

  // Preserve the previous diagnostic behavior on an independently failed or
  // unsettled navigation. The title is not what failed quality in this branch;
  // it only identifies the likely shape of the failed response.
  if (titleMatched && (signals.status === null || signals.status >= 400 || !signals.navigationSettled)) {
    return SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE;
  }

  const successfulStatus = signals.status !== null && signals.status >= 200 && signals.status < 400;
  if (!successfulStatus || !signals.navigationSettled) return "normal";

  const sparse =
    Number.isSafeInteger(signals.totalRequests) &&
    signals.totalRequests > 0 &&
    signals.totalRequests <= MAX_SPARSE_INTERSTITIAL_REQUESTS;
  const botBodyMatchCount = BOT_WALL_BODY_SIGNATURES.reduce(
    (count, signature) => count + (signature.test(text) ? 1 : 0),
    0
  );
  const consentBodyMatched = CONSENT_WALL_BODY_SIGNATURES.some((signature) => signature.test(text));

  // A titleless page needs two distinct body signatures: a single quoted
  // challenge sentence plus a small request footprint is still plausible
  // legitimate content. A specific whole-page challenge title supplies the
  // second signal when one body signature is present.
  const botWallMatched =
    (botTitleMatched && botBodyMatchCount > 0) ||
    (sparse && botBodyMatchCount >= 2);
  if (botWallMatched || (consentBodyMatched && consentTitleMatched)) {
    return SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE;
  }
  return "normal";
}

/** Frozen r2 names this fact `botWallTitleMatched`; keep the compatibility API. */
export function isLikelyBotWallPage(signals: BotWallPageSignals): boolean {
  return classifyPageSubject(signals) === SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE;
}
