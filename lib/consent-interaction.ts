import type { ConsentInteractionSummary, ConsentMode } from "./types";

export type { ConsentInteractionSummary } from "./types";

/**
 * Consent-banner interaction: the pure catalog and matching rules behind the
 * consent-diff comparison (one visit clicks "Accept all", one clicks
 * "Reject all", and the report diffs what differed between the two visits;
 * the click is dispatched, never verified as registered by the site).
 *
 * Two matching tiers, tried in order:
 *
 *   1. Known CMP controls: stable selectors for the dedicated consent platforms
 *      the scanner already recognizes (see `consent-banner.ts`). A hit names the
 *      CMP in the report.
 *   2. Generic label match: a visible button/link whose ENTIRE trimmed label is
 *      one of a conservative list of accept/reject phrases. Whole-label matching
 *      keeps "Accept all" from matching "Accept all the great deals" and means
 *      the stored `matchedText` can only ever be one of these known phrases,
 *      never arbitrary page text.
 *
 * Deliberately first-layer only: reject controls hidden behind a settings layer
 * are NOT chased, and a failed click is reported honestly (`clicked: false`,
 * that run stays pre-consent) rather than guessed at. Banner presence also
 * varies by scanner location (many CMPs only gate EEA/UK/California traffic),
 * so "no control found" never becomes a claim about the site.
 *
 * Pure data + a self-contained page function (serialized into the browser by
 * the scanner), so this module stays runtime-neutral and unit-testable.
 */

export type ConsentChoice = Exclude<ConsentMode, "observe">;

export type ConsentCmpSelectors = {
  /** Consent platform name, aligned with the CMP detection list where shared. */
  cmp: string;
  accept: string[];
  reject: string[];
};

/**
 * Known first-layer accept/reject controls per consent platform. Selectors are
 * the CMPs' own stable ids/classes, not site-specific. A missing reject entry
 * for a site (many banners hide reject behind "settings") is an expected,
 * disclosed outcome, not an error.
 */
export const CONSENT_CMP_SELECTORS: ConsentCmpSelectors[] = [
  {
    cmp: "OneTrust",
    accept: ["#onetrust-accept-btn-handler", "#accept-recommended-btn-handler"],
    reject: ["#onetrust-reject-all-handler", ".ot-pc-refuse-all-handler"]
  },
  {
    cmp: "Cookiebot",
    accept: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept"],
    reject: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll", "#CybotCookiebotDialogBodyButtonDecline"]
  },
  {
    cmp: "Didomi",
    accept: ["#didomi-notice-agree-button"],
    reject: ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing"]
  },
  {
    cmp: "Usercentrics",
    accept: ["[data-testid=uc-accept-all-button]"],
    reject: ["[data-testid=uc-deny-all-button]"]
  },
  {
    cmp: "TrustArc",
    accept: ["#truste-consent-button"],
    reject: ["#truste-consent-required"]
  },
  {
    cmp: "Sourcepoint",
    accept: [".sp_choice_type_11", ".message-button.sp_choice_type_ACCEPT_ALL"],
    reject: [".sp_choice_type_13", ".message-button.sp_choice_type_REJECT_ALL"]
  },
  {
    cmp: "CookieYes",
    accept: ["[data-cky-tag=accept-button]", ".cky-btn-accept"],
    reject: ["[data-cky-tag=reject-button]", ".cky-btn-reject"]
  },
  {
    cmp: "Osano",
    accept: [".osano-cm-accept-all", ".osano-cm-accept"],
    reject: [".osano-cm-denyAll", ".osano-cm-deny"]
  },
  {
    cmp: "Complianz",
    accept: [".cmplz-accept"],
    reject: [".cmplz-deny"]
  },
  {
    cmp: "Iubenda",
    accept: [".iubenda-cs-accept-btn"],
    reject: [".iubenda-cs-reject-btn"]
  },
  {
    cmp: "Termly",
    accept: ["[data-tid=banner-accept]"],
    reject: ["[data-tid=banner-decline]"]
  }
];

// Shadow-DOM CMP hosts (Usercentrics renders inside a closed-over shadow root).
// Targeted hosts, not a whole-document shadow walk, so the search stays bounded.
export const CONSENT_SHADOW_HOSTS = ["#usercentrics-root", "#usercentrics-cmp-ui", "#cmpwrapper"];

/**
 * Whole-label phrases for the generic tier. Matching is against the FULL
 * normalized label (trimmed, whitespace collapsed, trailing punctuation
 * stripped, lowercased), so partial matches can never fire. The reject list
 * includes the "necessary only" family because that is the reject-equivalent
 * many banners offer as their only first-layer refusal.
 */
export const CONSENT_TEXT_PATTERNS: Record<ConsentChoice, RegExp> = {
  "accept-all":
    /^(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|agree|i agree|i accept|agree and close|accept and close|yes, i agree|consent|accepter tout|alle akzeptieren|aceptar todo)$/,
  "reject-all":
    /^(reject|reject all|reject all cookies|decline|decline all|decline all cookies|refuse|refuse all|deny|deny all|disagree|i do not accept|do not accept|no thanks|reject non-essential|reject non-essential cookies|reject optional cookies|necessary only|necessary cookies only|only necessary|only necessary cookies|use necessary cookies only|essential only|essential cookies only|only essential|only essential cookies|strictly necessary only|continue without accepting|continue without agreeing|tout refuser|alle ablehnen|rechazar todo)$/
};

/** Normalize a control label the way the generic matcher expects. */
export function normalizeConsentLabel(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!→»>]+$/, "")
    .trim()
    .toLowerCase();
}

/** Whether a control label is an unambiguous whole-label match for the choice. */
export function matchesConsentChoice(choice: ConsentChoice, label: string): boolean {
  const normalized = normalizeConsentLabel(label);
  if (!normalized || normalized.length > 48) return false;
  return CONSENT_TEXT_PATTERNS[choice].test(normalized);
}

/** The CMP selector list for one choice, flattened for the page function. */
export function cmpSelectorsForChoice(choice: ConsentChoice): { cmp: string; selector: string }[] {
  return CONSENT_CMP_SELECTORS.flatMap((entry) =>
    (choice === "accept-all" ? entry.accept : entry.reject).map((selector) => ({ cmp: entry.cmp, selector }))
  );
}

export type ConsentClickArgs = {
  selectors: { cmp: string; selector: string }[];
  shadowHosts: string[];
  /** Source of the whole-label regex for the generic tier (page-serializable). */
  textPatternSource: string;
};

export type ConsentClickOutcome =
  | { clicked: true; cmp?: string; selector?: string; matchedText?: string }
  | { clicked: false };

/** Serializable arguments for {@link findAndClickConsentControl} in one frame. */
export function consentClickArgs(choice: ConsentChoice): ConsentClickArgs {
  return {
    selectors: cmpSelectorsForChoice(choice),
    shadowHosts: CONSENT_SHADOW_HOSTS,
    textPatternSource: CONSENT_TEXT_PATTERNS[choice].source
  };
}

/**
 * Runs INSIDE the page (via frame.evaluate) with {@link ConsentClickArgs}:
 * tries the known CMP selectors first (including the targeted shadow hosts),
 * then the generic whole-label text match over visible button-like elements.
 * Clicks at most one element and reports what it clicked. Self-contained: no
 * closure over module scope, so it serializes cleanly into the browser.
 */
export function findAndClickConsentControl(args: ConsentClickArgs): ConsentClickOutcome {
  const roots: (Document | ShadowRoot)[] = [document];
  for (const hostSelector of args.shadowHosts) {
    const host = document.querySelector(hostSelector);
    if (host?.shadowRoot) roots.push(host.shadowRoot);
  }

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
  };

  for (const { cmp, selector } of args.selectors) {
    for (const root of roots) {
      let element: Element | null = null;
      try {
        element = root.querySelector(selector);
      } catch {
        continue;
      }
      if (element instanceof HTMLElement && isVisible(element)) {
        element.click();
        return { clicked: true, cmp, selector };
      }
    }
  }

  const pattern = new RegExp(args.textPatternSource);
  const normalize = (text: string): string =>
    text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!→»>]+$/, "")
      .trim()
      .toLowerCase();

  for (const root of roots) {
    const candidates = root.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]");
    for (const candidate of Array.from(candidates).slice(0, 1_500)) {
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
      const label =
        candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent ?? "";
      const normalized = normalize(label);
      if (!normalized || normalized.length > 48 || !pattern.test(normalized)) continue;
      candidate.click();
      return { clicked: true, matchedText: normalized };
    }
  }

  return { clicked: false };
}

/** The human label for a consent choice, as report copy should print it. */
export function consentChoiceLabel(choice: ConsentChoice): string {
  return choice === "accept-all" ? "Accept all" : "Reject all";
}

/** One plain-language warning line disclosing the interaction (or its absence). */
export function consentInteractionWarning(summary: ConsentInteractionSummary): string {
  const label = consentChoiceLabel(summary.mode);
  if (!summary.clicked) {
    return `This visit was asked to choose "${label}" on a cookie/consent banner, but no recognizable control was found (the banner may not be shown to this scanner's location, the choice may sit behind a settings layer, or the control is not in the catalog). Results reflect the pre-consent state.`;
  }
  const via = summary.cmp
    ? `the ${summary.cmp} banner`
    : summary.matchedText
      ? `a control labeled "${summary.matchedText}"`
      : "the consent banner";
  return `This visit clicked "${label}" on ${via} after page load, so requests, cookies, and storage reflect the post-choice state.`;
}
