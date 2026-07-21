export type BotWallPageSignals = {
  navigationSettled: boolean;
  pageTitle: string;
  status: number | null;
  totalRequests: number;
};

// These are deliberately whole-title signatures. Generic fragments such as
// "security check" and "enable JavaScript" also appear in ordinary article,
// help, and account-page titles; a substring match lets the measured page turn
// an otherwise healthy visit into a failed one with unrelated prose.
const BOT_WALL_TITLE_SIGNATURES = [
  /^access denied[.!…]*$/i,
  /^attention required!?(?:\s*[|\-–—]\s*cloudflare)?$/i,
  /^just a moment[.!…]*$/i,
  /^pardon our interruption[.!…]*$/i,
  /^are you (?:a )?(?:human|robot)\??$/i,
  /^verify (?:you are|you'?re|your) (?:a )?human\??$/i,
  /^checking your browser(?: before accessing .+)?[.!…]*$/i,
  /^unusual traffic(?: from your computer network)?[.!…]*$/i,
  /^request unsuccessful(?:\.\s*incapsula incident id:.*)?$/i
] as const;

/**
 * Conservatively identify a bot/challenge page from report-safe facts.
 *
 * A page title and request sparsity are both controlled by the measured site,
 * so neither may turn an otherwise successful visit into a failed one. This
 * label is emitted only when a specific challenge title accompanies an
 * independently failed or unsettled navigation. The underlying HTTP/navigation
 * fact already fails quality; the title only makes that failure easier to
 * diagnose.
 */
export function isLikelyBotWallPage(signals: BotWallPageSignals): boolean {
  const title = signals.pageTitle.trim().replace(/\s+/g, " ");
  if (!title || !BOT_WALL_TITLE_SIGNATURES.some((signature) => signature.test(title))) return false;
  return signals.status === null || signals.status >= 400 || !signals.navigationSettled;
}
