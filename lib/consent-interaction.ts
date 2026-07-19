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
 * A symbol-backed, page-local registry populated before site scripts run.
 * Closed roots are not exposed through `host.shadowRoot`, so the interaction
 * probes need this narrow browser-init seam to retain roots for known CMP
 * hosts without changing their open/closed mode.
 */
export const CONSENT_SHADOW_ROOT_REGISTRY_KEY = "site-behavior-lab/consent-shadow-root-registry/v1";

export type ConsentShadowRootCaptureArgs = {
  capability: string;
  shadowHosts: string[];
  registryKey: string;
};

/** Serializable arguments for {@link installConsentShadowRootCapture}. */
export function consentShadowRootCaptureArgs(capability: string): ConsentShadowRootCaptureArgs {
  assertConsentShadowRootCapability(capability);
  return {
    capability,
    shadowHosts: CONSENT_SHADOW_HOSTS,
    registryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY
  };
}

/**
 * Runs as a BrowserContext init script, before target-page scripts. Native DOM
 * APIs intentionally hide a closed shadow root even from Playwright's normal
 * page evaluation and locators. Retain closed roots weakly as they are created,
 * but only disclose one when its current host matches the bounded CMP-host
 * catalog. Open roots keep their native behavior and are read via shadowRoot.
 *
 * Self-contained for Playwright serialization: do not close over module scope.
 */
export function installConsentShadowRootCapture(args: ConsentShadowRootCaptureArgs): void {
  if (!/^[a-f0-9]{64}$/.test(args.capability)) return;
  const registrySymbol = Symbol.for(args.registryKey);
  if (Object.prototype.hasOwnProperty.call(globalThis, registrySymbol)) return;

  const closedRoots = new WeakMap<Element, ShadowRoot>();
  const nativeReflectApply = Reflect.apply;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nativeMatches = Element.prototype.matches;
  const nativeWeakMapGet = WeakMap.prototype.get;
  const nativeWeakMapSet = WeakMap.prototype.set;
  const nativeShadowRootMode = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode")?.get;
  const isKnownConsentHost = (host: Element): boolean => {
    for (const selector of args.shadowHosts) {
      try {
        if (nativeReflectApply(nativeMatches, host, [selector]) as boolean) return true;
      } catch {
        // Ignore one invalid or hostile selector evaluation and keep the
        // bounded known-host search deterministic.
      }
    }
    return false;
  };

  const registry = Object.freeze({
    rootFor(host: Element, capability: string): ShadowRoot | null {
      if (capability !== args.capability) return null;
      return isKnownConsentHost(host)
        ? (nativeReflectApply(nativeWeakMapGet, closedRoots, [host]) as ShadowRoot | undefined) ?? null
        : null;
    }
  });
  Object.defineProperty(globalThis, registrySymbol, {
    configurable: false,
    enumerable: false,
    value: registry,
    writable: false
  });

  const attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = nativeReflectApply(nativeAttachShadow, this, [init]) as ShadowRoot;
    const mode =
      typeof nativeShadowRootMode === "function"
        ? (nativeReflectApply(nativeShadowRootMode, root, []) as ShadowRootMode)
        : null;
    if (mode === "closed") nativeReflectApply(nativeWeakMapSet, closedRoots, [this, root]);
    return root;
  };
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  Object.defineProperty(Element.prototype, "attachShadow", {
    ...descriptor,
    value: attachShadow
  });
}

/**
 * Whole-label phrases for the generic tier. Matching is against the FULL
 * normalized label (trimmed, whitespace collapsed, trailing punctuation
 * stripped, lowercased), so partial matches can never fire. The reject list
 * includes the "necessary only" family because that is the reject-equivalent
 * many banners offer as their only first-layer refusal.
 */
export const CONSENT_TEXT_PATTERNS: Record<ConsentChoice, RegExp> = {
  "accept-all":
    /^(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|i agree|i accept|agree and close|accept and close|yes, i agree|accepter tout|alle akzeptieren|aceptar todo)$/,
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
  shadowRootCapability: string;
  shadowRootRegistryKey: string;
  /** Source of the whole-label regex for the generic tier (page-serializable). */
  textPatternSource: string;
};

export type ConsentClickOutcome =
  | { clicked: true; cmp?: string; selector?: string; matchedText?: string }
  | { clicked: false };

/** Serializable arguments for {@link findAndClickConsentControl} in one frame. */
export function consentClickArgs(choice: ConsentChoice, shadowRootCapability: string): ConsentClickArgs {
  assertConsentShadowRootCapability(shadowRootCapability);
  return {
    selectors: cmpSelectorsForChoice(choice),
    shadowHosts: CONSENT_SHADOW_HOSTS,
    shadowRootCapability,
    shadowRootRegistryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY,
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
  const registry = Reflect.get(globalThis, Symbol.for(args.shadowRootRegistryKey)) as
    | { rootFor?: (host: Element, capability: string) => ShadowRoot | null }
    | undefined;
  for (const hostSelector of args.shadowHosts) {
    const host = document.querySelector(hostSelector);
    if (!host) continue;
    let shadowRoot = host.shadowRoot;
    if (!shadowRoot && typeof registry?.rootFor === "function") {
      try {
        shadowRoot = registry.rootFor(host, args.shadowRootCapability);
      } catch {
        shadowRoot = null;
      }
    }
    if (shadowRoot && !roots.includes(shadowRoot)) roots.push(shadowRoot);
  }

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
  };
  const isActionable = (element: HTMLElement): boolean => {
    if (element.matches(":disabled")) return false;
    if (element.getAttribute("aria-disabled")?.trim().toLowerCase() === "true") return false;
    if (element.closest("[inert]")) return false;
    return true;
  };
  const dispatchClick = (element: HTMLElement): boolean => {
    let dispatched = false;
    const observeDispatch = () => {
      dispatched = true;
    };
    try {
      element.addEventListener("click", observeDispatch, { capture: true, once: true });
      element.click();
    } catch {
      // A page-provided click override can fail. Report no activation and let
      // the bounded retry loop try a later actionable state.
    } finally {
      element.removeEventListener("click", observeDispatch, { capture: true });
    }
    return dispatched;
  };

  for (const { cmp, selector } of args.selectors) {
    for (const root of roots) {
      let element: Element | null = null;
      try {
        element = root.querySelector(selector);
      } catch {
        continue;
      }
      if (element instanceof HTMLElement && isVisible(element) && isActionable(element) && dispatchClick(element)) {
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
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate) || !isActionable(candidate)) continue;
      const label =
        candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent ?? "";
      const normalized = normalize(label);
      if (!normalized || normalized.length > 48 || !pattern.test(normalized)) continue;
      if (!dispatchClick(candidate)) continue;
      return { clicked: true, matchedText: normalized };
    }
  }

  return { clicked: false };
}

export type ConsentVisibilityArgs = {
  selectors: { cmp: string; selector: string }[];
  shadowHosts: string[];
  shadowRootCapability: string;
  shadowRootRegistryKey: string;
  /** Sources of BOTH whole-label regexes; visibility is choice-agnostic. */
  textPatternSources: string[];
};

/** Serializable arguments for {@link findVisibleConsentControl} in one frame. */
export function consentVisibilityArgs(shadowRootCapability: string): ConsentVisibilityArgs {
  assertConsentShadowRootCapability(shadowRootCapability);
  return {
    selectors: [...cmpSelectorsForChoice("accept-all"), ...cmpSelectorsForChoice("reject-all")],
    shadowHosts: CONSENT_SHADOW_HOSTS,
    shadowRootCapability,
    shadowRootRegistryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY,
    textPatternSources: [CONSENT_TEXT_PATTERNS["accept-all"].source, CONSENT_TEXT_PATTERNS["reject-all"].source]
  };
}

/**
 * Runs INSIDE the page (via frame.evaluate): reports whether any first-layer
 * consent control this scanner recognizes is currently visible. The weak
 * banner-visibility signal (RFC 15.5) is exactly this boolean; nothing is
 * clicked and no page text is returned. Self-contained for serialization.
 */
export function findVisibleConsentControl(args: ConsentVisibilityArgs): boolean {
  const roots: (Document | ShadowRoot)[] = [document];
  const registry = Reflect.get(globalThis, Symbol.for(args.shadowRootRegistryKey)) as
    | { rootFor?: (host: Element, capability: string) => ShadowRoot | null }
    | undefined;
  for (const hostSelector of args.shadowHosts) {
    const host = document.querySelector(hostSelector);
    if (!host) continue;
    let shadowRoot = host.shadowRoot;
    if (!shadowRoot && typeof registry?.rootFor === "function") {
      try {
        shadowRoot = registry.rootFor(host, args.shadowRootCapability);
      } catch {
        shadowRoot = null;
      }
    }
    if (shadowRoot && !roots.includes(shadowRoot)) roots.push(shadowRoot);
  }

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
  };

  for (const { selector } of args.selectors) {
    for (const root of roots) {
      let element: Element | null = null;
      try {
        element = root.querySelector(selector);
      } catch {
        continue;
      }
      if (element instanceof HTMLElement && isVisible(element)) return true;
    }
  }

  const patterns = args.textPatternSources.map((source) => new RegExp(source));
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
      const label = candidate instanceof HTMLInputElement ? candidate.value : candidate.textContent ?? "";
      const normalized = normalize(label);
      if (!normalized || normalized.length > 48) continue;
      if (patterns.some((pattern) => pattern.test(normalized))) return true;
    }
  }

  return false;
}

function assertConsentShadowRootCapability(capability: string): void {
  if (!/^[a-f0-9]{64}$/.test(capability)) {
    throw new Error("Invalid consent shadow-root capability.");
  }
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
  return `This visit clicked "${label}" on ${via} after page load. The click was dispatched, not verified as registered by the site, and the visit's requests, cookies, and storage include traffic from before and after the click.`;
}
