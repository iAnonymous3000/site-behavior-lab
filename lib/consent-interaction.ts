import type { ConsentInteractionSummary, ConsentMode } from "./types";

export type { ConsentInteractionSummary } from "./types";
export { CONSENT_QUALIFIED_CHOICE_CONTROLS, consentControlQualification } from "./consent-control-semantics";

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
 * Known first-layer-REACHABLE accept/reject controls per consent platform.
 * Selectors are the CMPs' own stable ids/classes, not site-specific. A missing
 * reject entry for a site (many banners hide reject behind "settings") is an
 * expected, disclosed outcome, not an error.
 *
 * "First-layer only" is a rule about what the scanner DOES, not about which
 * layer a selector belongs to: the scanner never opens a settings or
 * preference layer. Two OneTrust entries (#accept-recommended-btn-handler and
 * .ot-pc-refuse-all-handler) are the Preference Center's own Allow All and
 * Reject All. They are listed as a symmetric pair so neither arm is favoured,
 * and the visibility gate means they can only be clicked when that layer is
 * already the visible one, never by the scanner navigating to it.
 *
 * Each entry's list is ordered: the control that most fully expresses the
 * choice comes first, because the search returns at the first visible match.
 * See CONSENT_QUALIFIED_CHOICE_CONTROLS for the controls whose submitted
 * choice is configuration-dependent.
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
const CONSENT_SHADOW_ROOT_REGISTRY_KEY = "site-behavior-lab/consent-shadow-root-registry/v1";
const CONSENT_PAGE_RUNTIME_GLOBAL_KEY = "__siteBehaviorLabConsentRuntimeV1";

/**
 * Budgets that decide what counts as a recognized consent control. Each is a
 * measurement boundary, not an implementation detail: raising the ancestor
 * depth or the context-text budget admits controls the scanner would otherwise
 * refuse to click, and lowering the candidate budget silently stops looking.
 * The page functions are serialized into the browser and cannot close over
 * module scope, so every budget is carried in through their args objects and
 * pinned by test rather than left inline where it could drift unnoticed.
 */
/** Elements the generic tier's context gate examines: the control plus six ancestors. */
export const CONSENT_CONTEXT_ANCESTOR_DEPTH = 7;
/** Longest ancestor text still treated as banner copy rather than page prose. */
export const CONSENT_CONTEXT_TEXT_MAX_LENGTH = 2_000;
/** Elements one selector query may return, and the running per-root inspection cap. */
export const CONSENT_CANDIDATE_BUDGET = 1_500;

export type ConsentShadowRootCaptureArgs = {
  capability: string;
  shadowHosts: string[];
  registryKey: string;
  runtimeGlobalKey: string;
  /** {@link CONSENT_CONTEXT_ANCESTOR_DEPTH}, carried in rather than closed over. */
  contextAncestorDepth: number;
  /** {@link CONSENT_CONTEXT_TEXT_MAX_LENGTH}, carried in rather than closed over. */
  contextTextMaxLength: number;
};

/** Serializable arguments for {@link installConsentShadowRootCapture}. */
export function consentShadowRootCaptureArgs(capability: string): ConsentShadowRootCaptureArgs {
  assertConsentShadowRootCapability(capability);
  return {
    capability,
    shadowHosts: CONSENT_SHADOW_HOSTS,
    registryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY,
    runtimeGlobalKey: CONSENT_PAGE_RUNTIME_GLOBAL_KEY,
    contextAncestorDepth: CONSENT_CONTEXT_ANCESTOR_DEPTH,
    contextTextMaxLength: CONSENT_CONTEXT_TEXT_MAX_LENGTH
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
  if (
    Object.prototype.hasOwnProperty.call(globalThis, registrySymbol) ||
    Object.prototype.hasOwnProperty.call(globalThis, args.runtimeGlobalKey)
  ) return;

  const closedRoots = new WeakMap<Element, ShadowRoot>();
  const nativeReflectApply = Reflect.apply;
  const nativeReflectConstruct = Reflect.construct;
  const nativeObjectDefineProperty = Object.defineProperty;
  const nativeObjectFreeze = Object.freeze;
  const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeHasOwnProperty = Object.prototype.hasOwnProperty;
  const nativeArrayIsArray = Array.isArray;
  const nativeRegExpTest = RegExp.prototype.test;
  const nativeRegExpExec = RegExp.prototype.exec;
  const opacityFilterPattern = /opacity\(\s*([0-9]*\.?[0-9]+)\s*(%)?\s*\)/ig;
  const whitespacePattern = /\s+/g;
  const trailingPunctuationPattern = /[.!→»>]+$/;
  const nativeStringReplace = String.prototype.replace;
  const nativeStringTrim = String.prototype.trim;
  const nativeStringToLowerCase = String.prototype.toLowerCase;
  const nativeFunctionHasInstance = Function.prototype[Symbol.hasInstance];
  const NativeRegExp = RegExp;
  const NativeHTMLElement = HTMLElement;
  const NativeHTMLInputElement = HTMLInputElement;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nativeMatches = Element.prototype.matches;
  const nativeElementQuerySelectorAll = Element.prototype.querySelectorAll;
  const nativeDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
  const nativeFragmentQuerySelectorAll = DocumentFragment.prototype.querySelectorAll;
  const nativeNodeListItem = NodeList.prototype.item;
  const nativeNodeListLength = Object.getOwnPropertyDescriptor(NodeList.prototype, "length")?.get;
  const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const nativeGetRootNode = Node.prototype.getRootNode;
  const nativeNodeContains = Node.prototype.contains;
  const nativeHasAttribute = Element.prototype.hasAttribute;
  const nativeGetAttribute = Element.prototype.getAttribute;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  const nativeGetComputedStyle = globalThis.getComputedStyle;
  const nativeCssGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
  const nativeElementsFromPoint = Document.prototype.elementsFromPoint;
  const NativePromise = Promise;
  const NativeMouseEvent = MouseEvent;
  const trustedScheduler = (globalThis as unknown as {
    scheduler?: { postTask?: (callback: () => void, options?: { delay?: number }) => Promise<void> };
  }).scheduler;
  const nativePostTask = trustedScheduler?.postTask;
  const nativeParentElement = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement")?.get;
  const nativeTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.get;
  const nativeIsConnected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected")?.get;
  const nativeShadowRootHost = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "host")?.get;
  const nativeElementShadowRoot = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
  const nativeInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get;
  const nativeDocumentBody = Object.getOwnPropertyDescriptor(Document.prototype, "body")?.get;
  const nativeDocumentElement = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement")?.get;
  const nativeClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")?.get;
  const nativeClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")?.get;
  const nativeRectLeft = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "left")?.get;
  const nativeRectRight = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "right")?.get;
  const nativeRectTop = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "top")?.get;
  const nativeRectBottom = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "bottom")?.get;
  const nativeParseFloat = Number.parseFloat;
  const nativeNumberIsFinite = Number.isFinite;
  const nativeMathMax = Math.max;
  const nativeMathMin = Math.min;
  const nativeWeakMapGet = WeakMap.prototype.get;
  const nativeWeakMapSet = WeakMap.prototype.set;
  const nativeShadowRootMode = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode")?.get;
  const trustedDocument = document;
  const trustedWindow = globalThis;
  const isKnownConsentHost = (host: Element): boolean => {
    for (let selectorIndex = 0; selectorIndex < args.shadowHosts.length; selectorIndex += 1) {
      const selector = args.shadowHosts[selectorIndex];
      try {
        if (nativeReflectApply(nativeMatches, host, [selector]) as boolean) return true;
      } catch {
        // Ignore one invalid or hostile selector evaluation and keep the
        // bounded known-host search deterministic.
      }
    }
    return false;
  };

  const parentOf = (element: Element): Element | null => {
    if (typeof nativeParentElement === "function") {
      const parent = nativeReflectApply(nativeParentElement, element, []) as Element | null;
      if (parent) return parent;
    }
    if (typeof nativeShadowRootHost !== "function") return null;
    const root = nativeReflectApply(nativeGetRootNode, element, []);
    try {
      return nativeReflectApply(nativeShadowRootHost, root, []) as Element;
    } catch {
      return null;
    }
  };
  const cssValue = (style: CSSStyleDeclaration, property: string): string =>
    nativeReflectApply(nativeCssGetPropertyValue, style, [property]) as string;
  const rectValue = (getter: ((this: DOMRectReadOnly) => number) | undefined, rect: DOMRectReadOnly): number =>
    typeof getter === "function" ? nativeReflectApply(getter, rect, []) as number : 0 / 0;
  const filterOpacity = (filter: string): number => {
    opacityFilterPattern.lastIndex = 0;
    let factor = 1;
    while (true) {
      const match = nativeReflectApply(nativeRegExpExec, opacityFilterPattern, [filter]) as RegExpExecArray | null;
      if (!match) break;
      const parsed = nativeParseFloat(match[1]);
      if (!nativeNumberIsFinite(parsed)) return 0;
      factor *= match[2] === "%" ? parsed / 100 : parsed;
    }
    opacityFilterPattern.lastIndex = 0;
    return factor;
  };
  const clipsAxis = (overflow: string): boolean => overflow !== "" && overflow !== "visible";
  const containsElement = (elements: Element[], target: Element): boolean => {
    for (let index = 0; index < elements.length; index += 1) {
      if (elements[index] === target) return true;
    }
    return false;
  };
  const inspectElement = (element: Element): { visible: boolean; actionable: boolean } => {
    try {
      const rect = nativeReflectApply(nativeGetBoundingClientRect, element, []) as DOMRectReadOnly;
      let left = rectValue(nativeRectLeft, rect);
      let right = rectValue(nativeRectRight, rect);
      let top = rectValue(nativeRectTop, rect);
      let bottom = rectValue(nativeRectBottom, rect);
      if (
        !nativeNumberIsFinite(left) ||
        !nativeNumberIsFinite(right) ||
        !nativeNumberIsFinite(top) ||
        !nativeNumberIsFinite(bottom)
      ) {
        return { visible: false, actionable: false };
      }

      const documentElement = typeof nativeDocumentElement === "function"
        ? nativeReflectApply(nativeDocumentElement, trustedDocument, []) as Element | null
        : null;
      const viewportWidth = documentElement && typeof nativeClientWidth === "function"
        ? nativeReflectApply(nativeClientWidth, documentElement, []) as number
        : 0;
      const viewportHeight = documentElement && typeof nativeClientHeight === "function"
        ? nativeReflectApply(nativeClientHeight, documentElement, []) as number
        : 0;
      left = nativeMathMax(0, left);
      right = nativeMathMin(viewportWidth, right);
      top = nativeMathMax(0, top);
      bottom = nativeMathMin(viewportHeight, bottom);
      if (right - left < 2 || bottom - top < 2) return { visible: false, actionable: false };

      let actionable = true;
      let effectiveOpacity = 1;
      const composedHosts: Element[] = [];
      for (let current: Element | null = element; current; current = parentOf(current)) {
        const style = nativeReflectApply(nativeGetComputedStyle, trustedWindow, [current]) as CSSStyleDeclaration;
        const visibility = cssValue(style, "visibility");
        const display = cssValue(style, "display");
        const contentVisibility = cssValue(style, "content-visibility");
        const opacity = nativeParseFloat(cssValue(style, "opacity") || "1");
        const filter = cssValue(style, "filter");
        const filterOpacityFactor = filterOpacity(filter);
        effectiveOpacity *= opacity * filterOpacityFactor;
        if (
          visibility === "hidden" ||
          visibility === "collapse" ||
          display === "none" ||
          contentVisibility === "hidden" ||
          !nativeNumberIsFinite(opacity) ||
          !nativeNumberIsFinite(filterOpacityFactor) ||
          !nativeNumberIsFinite(effectiveOpacity) ||
          effectiveOpacity <= 0.05
        ) {
          return { visible: false, actionable: false };
        }

        const ariaDisabled = nativeReflectApply(nativeGetAttribute, current, ["aria-disabled"]) as string | null;
        const normalizedAriaDisabled = ariaDisabled === null
          ? ""
          : nativeReflectApply(
              nativeStringToLowerCase,
              nativeReflectApply(nativeStringTrim, ariaDisabled, []),
              []
            ) as string;
        if (
          nativeReflectApply(nativeHasAttribute, current, ["inert"]) as boolean ||
          normalizedAriaDisabled === "true" ||
          cssValue(style, "pointer-events") === "none"
        ) actionable = false;

        if (current !== element) {
          const ancestorRect = nativeReflectApply(nativeGetBoundingClientRect, current, []) as DOMRectReadOnly;
          const ancestorLeft = rectValue(nativeRectLeft, ancestorRect);
          const ancestorRight = rectValue(nativeRectRight, ancestorRect);
          const ancestorTop = rectValue(nativeRectTop, ancestorRect);
          const ancestorBottom = rectValue(nativeRectBottom, ancestorRect);
          if (clipsAxis(cssValue(style, "overflow-x"))) {
            left = nativeMathMax(left, ancestorLeft);
            right = nativeMathMin(right, ancestorRight);
          }
          if (clipsAxis(cssValue(style, "overflow-y"))) {
            top = nativeMathMax(top, ancestorTop);
            bottom = nativeMathMin(bottom, ancestorBottom);
          }
          if (right - left < 2 || bottom - top < 2) return { visible: false, actionable: false };
        }

        const root = nativeReflectApply(nativeGetRootNode, current, []);
        if (typeof nativeShadowRootHost === "function") {
          try {
            const host = nativeReflectApply(nativeShadowRootHost, root, []) as Element;
            if (host && !containsElement(composedHosts, host)) composedHosts[composedHosts.length] = host;
          } catch {
            // A document root has no ShadowRoot host.
          }
        }
      }

      if (nativeReflectApply(nativeMatches, element, [":disabled"]) as boolean) actionable = false;
      if (typeof nativeIsConnected === "function" && !(nativeReflectApply(nativeIsConnected, element, []) as boolean)) {
        return { visible: false, actionable: false };
      }

      // Geometry and computed styles do not account for clip-path or complete
      // occlusion. Sample the surviving painted rectangle with the pristine DOM
      // hit-test. A descendant or a retargeted shadow host both prove exposure.
      const insetX = nativeMathMin(1, (right - left) / 4);
      const insetY = nativeMathMin(1, (bottom - top) / 4);
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + insetX, top + insetY],
        [right - insetX, top + insetY],
        [left + insetX, bottom - insetY],
        [right - insetX, bottom - insetY]
      ];
      let hit = false;
      for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        const x = points[pointIndex][0];
        const y = points[pointIndex][1];
        const stack = nativeReflectApply(nativeElementsFromPoint, trustedDocument, [x, y]) as Element[];
        // Only the topmost painted hit proves that a user could reach this
        // control. Accepting the target anywhere deeper in the stack lets an
        // opaque overlay manufacture a visible/clickable consent signal.
        const candidate = stack[0];
        if (
          candidate &&
          (
            candidate === element ||
            (nativeReflectApply(nativeNodeContains, element, [candidate]) as boolean) ||
            containsElement(composedHosts, candidate)
          )
        ) {
          hit = true;
        }
        if (hit) break;
      }
      return { visible: hit, actionable: hit && actionable };
    } catch {
      return { visible: false, actionable: false };
    }
  };

  const queryElements = (root: Document | ShadowRoot, selector: string, limit: number): Element[] => {
    let list: NodeListOf<Element> | null = null;
    const queryFunctions = [nativeDocumentQuerySelectorAll, nativeFragmentQuerySelectorAll, nativeElementQuerySelectorAll];
    for (let functionIndex = 0; functionIndex < queryFunctions.length && list === null; functionIndex += 1) {
      try {
        list = nativeReflectApply(queryFunctions[functionIndex], root, [selector]) as NodeListOf<Element>;
      } catch {
        // Try the next pristine querySelectorAll brand.
      }
    }
    if (list === null || typeof nativeNodeListLength !== "function") return [];
    const length = nativeReflectApply(nativeNodeListLength, list, []) as number;
    const boundedLength = nativeMathMin(nativeMathMax(0, limit), length);
    const elements: Element[] = [];
    for (let index = 0; index < boundedLength; index += 1) {
      const element = nativeReflectApply(nativeNodeListItem, list, [index]) as Element | null;
      if (element) elements[elements.length] = element;
    }
    return elements;
  };
  const isHtmlElement = (element: Element): boolean =>
    nativeReflectApply(nativeFunctionHasInstance, NativeHTMLElement, [element]) as boolean;
  const normalizedLabel = (element: Element): string => {
    if (!isHtmlElement(element)) return "";
    const input = nativeReflectApply(nativeFunctionHasInstance, NativeHTMLInputElement, [element]) as boolean;
    const raw = input && typeof nativeInputValue === "function"
      ? nativeReflectApply(nativeInputValue, element, []) as string
      : typeof nativeTextContent === "function"
        ? (nativeReflectApply(nativeTextContent, element, []) as string | null) ?? ""
        : "";
    let normalized = nativeReflectApply(nativeStringReplace, raw, [whitespacePattern, " "]) as string;
    normalized = nativeReflectApply(nativeStringTrim, normalized, []) as string;
    normalized = nativeReflectApply(nativeStringReplace, normalized, [trailingPunctuationPattern, ""]) as string;
    normalized = nativeReflectApply(nativeStringTrim, normalized, []) as string;
    return nativeReflectApply(nativeStringToLowerCase, normalized, []) as string;
  };
  const matchesPattern = (value: string, source: string, flags = ""): boolean => {
    try {
      const pattern = nativeReflectConstruct(NativeRegExp, [source, flags]) as RegExp;
      return nativeReflectApply(nativeRegExpTest, pattern, [value]) as boolean;
    } catch {
      return false;
    }
  };
  const hasConsentContext = (
    element: Element,
    knownConsentHost: boolean,
    markerSource: string,
    textSource: string
  ): boolean => {
    if (knownConsentHost) return true;
    const documentBody = typeof nativeDocumentBody === "function"
      ? nativeReflectApply(nativeDocumentBody, trustedDocument, []) as HTMLElement | null
      : null;
    const documentElement = typeof nativeDocumentElement === "function"
      ? nativeReflectApply(nativeDocumentElement, trustedDocument, []) as Element | null
      : null;
    let current: Element | null = element;
    for (let depth = 0; current && depth < args.contextAncestorDepth; depth += 1, current = parentOf(current)) {
      if (current === documentBody || current === documentElement) return false;
      const marker = `${nativeReflectApply(nativeGetAttribute, current, ["id"]) as string | null ?? ""} ${
        nativeReflectApply(nativeGetAttribute, current, ["class"]) as string | null ?? ""
      } ${nativeReflectApply(nativeGetAttribute, current, ["role"]) as string | null ?? ""} ${
        nativeReflectApply(nativeGetAttribute, current, ["aria-label"]) as string | null ?? ""
      } ${nativeReflectApply(nativeGetAttribute, current, ["data-testid"]) as string | null ?? ""} ${
        nativeReflectApply(nativeGetAttribute, current, ["data-consent"]) as string | null ?? ""
      }`;
      if (matchesPattern(marker, markerSource, "i")) return true;
      if (current !== element && typeof nativeTextContent === "function") {
        const contextText = normalizedLabel(current);
        if (
          contextText.length > 0 &&
          contextText.length <= args.contextTextMaxLength &&
          matchesPattern(contextText, textSource, "i")
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const registry = nativeObjectFreeze({
    query(root: Document | ShadowRoot, selector: string, limit: number, capability: string): Element[] {
      return capability === args.capability ? queryElements(root, selector, limit) : [];
    },
    openRoot(host: Element, capability: string): ShadowRoot | null {
      if (capability !== args.capability) return null;
      if (typeof nativeElementShadowRoot === "function") {
        const openRoot = nativeReflectApply(nativeElementShadowRoot, host, []) as ShadowRoot | null;
        if (openRoot) return openRoot;
      }
      return isKnownConsentHost(host)
        ? (nativeReflectApply(nativeWeakMapGet, closedRoots, [host]) as ShadowRoot | undefined) ?? null
        : null;
    },
    rootFor(host: Element, capability: string): ShadowRoot | null {
      if (capability !== args.capability) return null;
      return isKnownConsentHost(host)
        ? (nativeReflectApply(nativeWeakMapGet, closedRoots, [host]) as ShadowRoot | undefined) ?? null
        : null;
    },
    inspect(element: Element, capability: string): { visible: boolean; actionable: boolean } {
      return capability === args.capability
        ? inspectElement(element)
        : { visible: false, actionable: false };
    },
    isHtmlElement(element: Element, capability: string): boolean {
      return capability === args.capability && isHtmlElement(element);
    },
    normalizedLabel(element: Element, capability: string): string {
      return capability === args.capability ? normalizedLabel(element) : "";
    },
    matchesPattern(value: string, source: string, flags: string, capability: string): boolean {
      return capability === args.capability && matchesPattern(value, source, flags);
    },
    hasConsentContext(
      element: Element,
      knownConsentHost: boolean,
      markerSource: string,
      textSource: string,
      capability: string
    ): boolean {
      return capability === args.capability && hasConsentContext(element, knownConsentHost, markerSource, textSource);
    },
    dispatchClick(element: Element, capability: string): boolean {
      if (capability !== args.capability) return false;
      try {
        const event = nativeReflectConstruct(NativeMouseEvent, ["click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: trustedWindow
        }]) as MouseEvent;
        nativeReflectApply(nativeDispatchEvent, element, [event]);
        return true;
      } catch {
        return false;
      }
    },
    delay(delayMs: number, capability: string): Promise<void> {
      if (capability !== args.capability) return nativeReflectConstruct(NativePromise, [
        (resolve: () => void) => resolve()
      ]) as Promise<void>;
      const boundedDelay = nativeMathMax(0, nativeMathMin(350, delayMs));
      if (typeof nativePostTask !== "function" || !trustedScheduler) {
        return nativeReflectConstruct(NativePromise, [(resolve: () => void) => resolve()]) as Promise<void>;
      }
      return nativeReflectApply(nativePostTask, trustedScheduler, [() => undefined, { delay: boundedDelay }]) as Promise<void>;
    },
    makePromise<T>(executor: (resolve: (value: T) => void) => void): Promise<T> {
      return nativeReflectConstruct(NativePromise, [executor]) as Promise<T>;
    },
    setTimer(callback: () => void, delayMs: number): unknown {
      const boundedDelay = nativeMathMax(0, nativeMathMin(60_000, delayMs));
      if (typeof nativePostTask !== "function" || !trustedScheduler) {
        callback();
        return null;
      }
      nativeReflectApply(nativePostTask, trustedScheduler, [callback, { delay: boundedDelay }]);
      return null;
    },
    clearTimer(_handle: unknown): void {
      // Scheduler tasks expose no numeric timer handle for page code to cancel;
      // the reader's settled guard makes a later timeout callback harmless.
    },
    hasOwn(value: object, key: string): boolean {
      return nativeReflectApply(nativeHasOwnProperty, value, [key]) as boolean;
    },
    ownValue(value: object, key: string): unknown {
      const descriptor = nativeReflectApply(nativeObjectGetOwnPropertyDescriptor, Object, [value, key]) as
        | PropertyDescriptor
        | undefined;
      return descriptor && (nativeReflectApply(nativeHasOwnProperty, descriptor, ["value"]) as boolean)
        ? descriptor.value
        : undefined;
    },
    isArray(value: unknown): boolean {
      return nativeReflectApply(nativeArrayIsArray, Array, [value]) as boolean;
    }
  });
  nativeObjectDefineProperty(globalThis, registrySymbol, {
    configurable: false,
    enumerable: false,
    value: registry,
    writable: false
  });
  nativeObjectDefineProperty(globalThis, args.runtimeGlobalKey, {
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
  nativeObjectDefineProperty(Element.prototype, "attachShadow", {
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
    /^(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|i agree|i accept|agree and close|accept and close|yes, i agree|accepter tout|tout accepter|alle akzeptieren|aceptar todo)$/,
  "reject-all":
    /^(reject|reject all|reject all cookies|decline|decline all|decline all cookies|refuse|refuse all|deny|deny all|disagree|i do not accept|do not accept|no thanks|reject non-essential|reject non-essential cookies|reject optional cookies|necessary only|necessary cookies only|only necessary|only necessary cookies|use necessary cookies only|essential only|essential cookies only|only essential|only essential cookies|strictly necessary only|continue without accepting|continue without agreeing|tout refuser|alle ablehnen|rechazar todo)$/
};

/**
 * Context required in addition to a generic whole-label match. Bare privacy
 * words are deliberately insufficient: newsletter and terms dialogs commonly
 * link to a privacy policy next to an unrelated "I agree" / "No thanks"
 * control. Localized alternatives therefore require an explicit choice,
 * settings, or consent phrase (while "cookie" remains language-neutral).
 * Sources are passed into the serialized page functions so click and visibility
 * probes cannot drift onto different definitions of a recognized control.
 */
const CONSENT_CONTEXT_MARKER_PATTERN =
  /cookie|cmp(?:[-_\s]|$)|gdpr|ccpa|consent[-_\s]?(banner|dialog|manager|notice|preferences?|settings?)|privacy[-_\s]?(banner|choices?|dialog|notice|preferences?|settings?)/i;
const CONSENT_CONTEXT_TEXT_PATTERN =
  /\bcookies?\b|tracking technolog(?:y|ies)|privacy (?:choices?|preferences?|settings?)|consent (?:choices?|preferences?|settings?)|(?:consent|agree) to (?:cookies?|tracking|data processing)|(?:choix|préférences|paramètres) (?:de confidentialité|de vie privée)|consentement (?:aux?|pour les?) (?:cookies?|traceurs?)|datenschutz(?:einstellungen|optionen|präferenzen)|einwilligung (?:in|zu|für) (?:cookies?|tracking|datenverarbeitung)|(?:preferencias|opciones|configuración) (?:de )?privacidad|consentimiento (?:de|para|al) (?:cookies?|seguimiento|tratamiento de datos)/i;

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
  runtimeGlobalKey: string;
  /** Source of the whole-label regex for the generic tier (page-serializable). */
  textPatternSource: string;
  /** Sources of the bounded generic-control context rules. */
  contextMarkerPatternSource: string;
  contextTextPatternSource: string;
  /** {@link CONSENT_CANDIDATE_BUDGET}, carried in rather than closed over. */
  candidateBudget: number;
  /** {@link CONSENT_CONTEXT_ANCESTOR_DEPTH}, carried in rather than closed over. */
  contextAncestorDepth: number;
  /** {@link CONSENT_CONTEXT_TEXT_MAX_LENGTH}, carried in rather than closed over. */
  contextTextMaxLength: number;
};

export type ConsentClickOutcome =
  | { clicked: true; cmp?: string; selector?: string; matchedText?: string }
  /**
   * No control was confirmed. `dispatched` counts the clicks that DID land on
   * a candidate that never visibly responded, which is not the same finding as
   * an empty search: the page was clicked, so this visit's evidence can span
   * both sides of a choice even though nothing can be attributed.
   */
  | { clicked: false; dispatched: number };

/** Serializable arguments for {@link findAndClickConsentControl} in one frame. */
export function consentClickArgs(choice: ConsentChoice, shadowRootCapability: string): ConsentClickArgs {
  assertConsentShadowRootCapability(shadowRootCapability);
  return {
    selectors: cmpSelectorsForChoice(choice),
    shadowHosts: CONSENT_SHADOW_HOSTS,
    shadowRootCapability,
    shadowRootRegistryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY,
    runtimeGlobalKey: CONSENT_PAGE_RUNTIME_GLOBAL_KEY,
    textPatternSource: CONSENT_TEXT_PATTERNS[choice].source,
    contextMarkerPatternSource: CONSENT_CONTEXT_MARKER_PATTERN.source,
    contextTextPatternSource: CONSENT_CONTEXT_TEXT_PATTERN.source,
    candidateBudget: CONSENT_CANDIDATE_BUDGET,
    contextAncestorDepth: CONSENT_CONTEXT_ANCESTOR_DEPTH,
    contextTextMaxLength: CONSENT_CONTEXT_TEXT_MAX_LENGTH
  };
}

/**
 * Runs INSIDE the page (via frame.evaluate) with {@link ConsentClickArgs}:
 * tries the known CMP selectors first (including the targeted shadow hosts),
 * then the generic whole-label text match over visible button-like elements.
 * It may try bounded no-op/stale candidates while searching, but dispatches at
 * most 12 synthetic clicks total and reports only the first control that reacts
 * by disappearing, hiding, or disabling. The bound prevents a decoy-heavy page
 * from consuming the scan budget. A control identified by a known CMP selector
 * that only reacts to a later generic-tier dispatch keeps its CMP attribution.
 * Self-contained: no closure over module scope, so it serializes cleanly into
 * the browser.
 */
export async function findAndClickConsentControl(args: ConsentClickArgs): Promise<ConsentClickOutcome> {
  const runtime = (globalThis as unknown as Record<string, unknown>)[args.runtimeGlobalKey] as
    | {
        query?: (root: Document | ShadowRoot, selector: string, limit: number, capability: string) => Element[];
        openRoot?: (host: Element, capability: string) => ShadowRoot | null;
        inspect?: (element: Element, capability: string) => { visible: boolean; actionable: boolean };
        isHtmlElement?: (element: Element, capability: string) => boolean;
        normalizedLabel?: (element: Element, capability: string) => string;
        matchesPattern?: (value: string, source: string, flags: string, capability: string) => boolean;
        hasConsentContext?: (
          element: Element,
          knownConsentHost: boolean,
          markerSource: string,
          textSource: string,
          capability: string
        ) => boolean;
        dispatchClick?: (element: Element, capability: string) => boolean;
        delay?: (delayMs: number, capability: string) => Promise<void>;
      }
    | undefined;
  if (
    typeof runtime?.query !== "function" ||
    typeof runtime.openRoot !== "function" ||
    typeof runtime.inspect !== "function" ||
    typeof runtime.isHtmlElement !== "function" ||
    typeof runtime.normalizedLabel !== "function" ||
    typeof runtime.matchesPattern !== "function" ||
    typeof runtime.hasConsentContext !== "function" ||
    typeof runtime.dispatchClick !== "function" ||
    typeof runtime.delay !== "function"
  ) return { clicked: false, dispatched: 0 };
  const capability = args.shadowRootCapability;
  const roots: { root: Document | ShadowRoot; knownConsentHost: boolean }[] = [
    { root: document, knownConsentHost: false }
  ];
  for (let hostIndex = 0; hostIndex < args.shadowHosts.length; hostIndex += 1) {
    const hosts = runtime.query(document, args.shadowHosts[hostIndex], 1, capability);
    const host = hosts[0];
    if (!host) continue;
    const shadowRoot = runtime.openRoot(host, capability);
    if (shadowRoot) {
      let duplicate = false;
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        if (roots[rootIndex].root === shadowRoot) duplicate = true;
      }
      if (!duplicate) roots[roots.length] = { root: shadowRoot, knownConsentHost: true };
    }
  }

  const stateFor = (element: Element): { visible: boolean; actionable: boolean } =>
    runtime.inspect!(element, capability);
  // A synthetic click event by itself proves nothing: a page can place a
  // no-op decoy before its real CMP control. Fail closed unless the candidate
  // reacts like a first-layer choice control by leaving the composed tree,
  // becoming hidden, or becoming disabled/inert. Polling for at most 350ms
  // admits common 200-300ms exit animations without turning one no-op decoy
  // into an unbounded wait. This is activation evidence, not proof of
  // registered CMP state.
  let activationAttempts = 0;
  let dispatchedControls = 0;
  const activateControl = async (element: Element): Promise<"reacted" | "no-reaction" | "not-dispatched"> => {
    if (activationAttempts >= 12) return "not-dispatched";
    activationAttempts += 1;
    if (!runtime.dispatchClick!(element, capability)) return "not-dispatched";
    dispatchedControls += 1;
    const reacted = (): boolean => {
      const state = stateFor(element);
      return !state.visible || !state.actionable;
    };
    if (reacted()) return "reacted";
    for (let elapsedMs = 0; elapsedMs < 350; elapsedMs += 25) {
      await runtime.delay!(25, capability);
      if (reacted()) return "reacted";
    }
    return "no-reaction";
  };
  // A page-owned click handler can throw on its first dispatch (leaving the
  // control unreacted) yet succeed on a retry from the generic tier. The CMP
  // identification is the more specific finding, so it must survive that
  // cross-tier retry instead of degrading into a generic text match.
  const dispatchedCmpControls: { element: Element; cmp: string; selector: string }[] = [];
  const cmpAttributionFor = (element: Element): { cmp: string; selector: string } | null => {
    for (let index = 0; index < dispatchedCmpControls.length; index += 1) {
      if (dispatchedCmpControls[index].element === element) return dispatchedCmpControls[index];
    }
    return null;
  };

  let knownCandidatesInspected = 0;
  for (let selectorIndex = 0; selectorIndex < args.selectors.length; selectorIndex += 1) {
    const selectorEntry = args.selectors[selectorIndex];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const elements = runtime.query(roots[rootIndex].root, selectorEntry.selector, args.candidateBudget, capability);
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        knownCandidatesInspected += 1;
        if (knownCandidatesInspected > args.candidateBudget) break;
        const state = stateFor(element);
        if (runtime.isHtmlElement(element, capability) && state.visible && state.actionable) {
          const activation = await activateControl(element);
          if (activation === "reacted") {
            return { clicked: true, cmp: selectorEntry.cmp, selector: selectorEntry.selector };
          }
          if (activation === "no-reaction" && cmpAttributionFor(element) === null) {
            dispatchedCmpControls[dispatchedCmpControls.length] = {
              element,
              cmp: selectorEntry.cmp,
              selector: selectorEntry.selector
            };
          }
        }
      }
      if (knownCandidatesInspected > args.candidateBudget) break;
    }
    if (knownCandidatesInspected > args.candidateBudget) break;
  }

  // Generic phrases such as "I agree" and "No thanks" occur in terms
  // prompts, newsletters, age gates, and other unrelated UI. Known CMP
  // selectors above are already specific enough to stand alone; the generic
  // tier must additionally prove that its control belongs to a bounded
  // cookie/privacy-choice context. Search only the control and its nearest few
  // ancestors, never the whole page, so a privacy link elsewhere cannot turn
  // an unrelated button into a consent control.
  const controlSelector = "button, a, [role=button], input[type=button], input[type=submit]";
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const rootEntry = roots[rootIndex];
    const candidates = runtime.query(rootEntry.root, controlSelector, args.candidateBudget, capability);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (!runtime.isHtmlElement(candidate, capability)) continue;
      const candidateState = stateFor(candidate);
      if (!candidateState.visible || !candidateState.actionable) continue;
      const normalized = runtime.normalizedLabel(candidate, capability);
      if (
        !normalized ||
        normalized.length > 48 ||
        !runtime.matchesPattern(normalized, args.textPatternSource, "", capability)
      ) continue;
      if (!runtime.hasConsentContext(
        candidate,
        rootEntry.knownConsentHost,
        args.contextMarkerPatternSource,
        args.contextTextPatternSource,
        capability
      )) continue;
      if (await activateControl(candidate) !== "reacted") continue;
      const cmpAttribution = cmpAttributionFor(candidate);
      if (cmpAttribution) {
        return { clicked: true, cmp: cmpAttribution.cmp, selector: cmpAttribution.selector };
      }
      return { clicked: true, matchedText: normalized };
    }
  }

  return { clicked: false, dispatched: dispatchedControls };
}

export type ConsentVisibilityArgs = {
  selectors: { cmp: string; selector: string }[];
  shadowHosts: string[];
  shadowRootCapability: string;
  shadowRootRegistryKey: string;
  runtimeGlobalKey: string;
  /** Sources of BOTH whole-label regexes; visibility is choice-agnostic. */
  textPatternSources: string[];
  /** Sources of the bounded generic-control context rules. */
  contextMarkerPatternSource: string;
  contextTextPatternSource: string;
  /** {@link CONSENT_CANDIDATE_BUDGET}, carried in rather than closed over. */
  candidateBudget: number;
  /** {@link CONSENT_CONTEXT_ANCESTOR_DEPTH}, carried in rather than closed over. */
  contextAncestorDepth: number;
  /** {@link CONSENT_CONTEXT_TEXT_MAX_LENGTH}, carried in rather than closed over. */
  contextTextMaxLength: number;
};

/** Serializable arguments for {@link findVisibleConsentControl} in one frame. */
export function consentVisibilityArgs(shadowRootCapability: string): ConsentVisibilityArgs {
  assertConsentShadowRootCapability(shadowRootCapability);
  return {
    selectors: [...cmpSelectorsForChoice("accept-all"), ...cmpSelectorsForChoice("reject-all")],
    shadowHosts: CONSENT_SHADOW_HOSTS,
    shadowRootCapability,
    shadowRootRegistryKey: CONSENT_SHADOW_ROOT_REGISTRY_KEY,
    runtimeGlobalKey: CONSENT_PAGE_RUNTIME_GLOBAL_KEY,
    textPatternSources: [CONSENT_TEXT_PATTERNS["accept-all"].source, CONSENT_TEXT_PATTERNS["reject-all"].source],
    contextMarkerPatternSource: CONSENT_CONTEXT_MARKER_PATTERN.source,
    contextTextPatternSource: CONSENT_CONTEXT_TEXT_PATTERN.source,
    candidateBudget: CONSENT_CANDIDATE_BUDGET,
    contextAncestorDepth: CONSENT_CONTEXT_ANCESTOR_DEPTH,
    contextTextMaxLength: CONSENT_CONTEXT_TEXT_MAX_LENGTH
  };
}

/**
 * Runs INSIDE the page (via frame.evaluate): reports whether any first-layer
 * consent control this scanner recognizes is currently visible. The weak
 * banner-visibility signal (RFC 15.5) is exactly this boolean; nothing is
 * clicked and no page text is returned. Self-contained for serialization.
 */
export function findVisibleConsentControl(args: ConsentVisibilityArgs): boolean {
  const runtime = (globalThis as unknown as Record<string, unknown>)[args.runtimeGlobalKey] as
    | {
        query?: (root: Document | ShadowRoot, selector: string, limit: number, capability: string) => Element[];
        openRoot?: (host: Element, capability: string) => ShadowRoot | null;
        inspect?: (element: Element, capability: string) => { visible: boolean; actionable: boolean };
        isHtmlElement?: (element: Element, capability: string) => boolean;
        normalizedLabel?: (element: Element, capability: string) => string;
        matchesPattern?: (value: string, source: string, flags: string, capability: string) => boolean;
        hasConsentContext?: (
          element: Element,
          knownConsentHost: boolean,
          markerSource: string,
          textSource: string,
          capability: string
        ) => boolean;
      }
    | undefined;
  if (
    typeof runtime?.query !== "function" ||
    typeof runtime.openRoot !== "function" ||
    typeof runtime.inspect !== "function" ||
    typeof runtime.isHtmlElement !== "function" ||
    typeof runtime.normalizedLabel !== "function" ||
    typeof runtime.matchesPattern !== "function" ||
    typeof runtime.hasConsentContext !== "function"
  ) return false;
  const capability = args.shadowRootCapability;
  const roots: { root: Document | ShadowRoot; knownConsentHost: boolean }[] = [
    { root: document, knownConsentHost: false }
  ];
  for (let hostIndex = 0; hostIndex < args.shadowHosts.length; hostIndex += 1) {
    const hosts = runtime.query(document, args.shadowHosts[hostIndex], 1, capability);
    const host = hosts[0];
    if (!host) continue;
    const shadowRoot = runtime.openRoot(host, capability);
    if (shadowRoot) {
      let duplicate = false;
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        if (roots[rootIndex].root === shadowRoot) duplicate = true;
      }
      if (!duplicate) roots[roots.length] = { root: shadowRoot, knownConsentHost: true };
    }
  }

  const isVisible = (element: Element): boolean =>
    runtime.inspect!(element, capability).visible;

  let knownCandidatesInspected = 0;
  for (let selectorIndex = 0; selectorIndex < args.selectors.length; selectorIndex += 1) {
    const selector = args.selectors[selectorIndex].selector;
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const elements = runtime.query(roots[rootIndex].root, selector, args.candidateBudget, capability);
      for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
        const element = elements[elementIndex];
        knownCandidatesInspected += 1;
        if (knownCandidatesInspected > args.candidateBudget) break;
        if (runtime.isHtmlElement(element, capability) && isVisible(element)) return true;
      }
      if (knownCandidatesInspected > args.candidateBudget) break;
    }
    if (knownCandidatesInspected > args.candidateBudget) break;
  }

  const controlSelector = "button, a, [role=button], input[type=button], input[type=submit]";
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const rootEntry = roots[rootIndex];
    const candidates = runtime.query(rootEntry.root, controlSelector, args.candidateBudget, capability);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      if (!runtime.isHtmlElement(candidate, capability) || !isVisible(candidate)) continue;
      const normalized = runtime.normalizedLabel(candidate, capability);
      if (!normalized || normalized.length > 48) continue;
      let matches = false;
      for (let patternIndex = 0; patternIndex < args.textPatternSources.length; patternIndex += 1) {
        if (runtime.matchesPattern(normalized, args.textPatternSources[patternIndex], "", capability)) {
          matches = true;
          break;
        }
      }
      if (
        matches &&
        runtime.hasConsentContext(
          candidate,
          rootEntry.knownConsentHost,
          args.contextMarkerPatternSource,
          args.contextTextPatternSource,
          capability
        )
      ) {
        return true;
      }
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

/**
 * Every un-clicked outcome this module can disclose: each failure of the
 * instrument, plus `null` for the one case that IS a completed search.
 *
 * The public redaction boundary admits consent warnings by regenerating them
 * from this list, so the producer and the sanitizer cannot disagree about which
 * sentences exist. A hand-written copy on either side gets the honest failure
 * wording replaced by "[redacted warning]" in every saved report.
 */
export const CONSENT_PROBE_OUTCOMES = [
  "budget-unavailable",
  "scan-failed",
  "engine-unavailable",
  "search-interrupted",
  "frames-unreadable",
  "dispatch-unconfirmed",
  null
] as const;

/** Why the consent probe produced no click, when it was not a completed search. */
export type ConsentProbeFailure = Exclude<(typeof CONSENT_PROBE_OUTCOMES)[number], null>;

/**
 * One plain-language warning line disclosing the interaction (or its absence).
 *
 * `clicked: false` alone cannot carry the disclosure: a probe that never ran
 * because the budget was spent, one that threw, and one that could not read a
 * frame all produce the same summary as a completed search that found no
 * control. Reporting all four as "no recognizable control was found" told the
 * reader the banner was searched when it was not, which is a claim about the
 * SITE derived from a failure of the instrument.
 */
export function consentInteractionWarning(
  summary: ConsentInteractionSummary,
  probeFailure: ConsentProbeFailure | null = null
): string {
  const label = consentChoiceLabel(summary.mode);
  if (!summary.clicked) {
    if (probeFailure === "budget-unavailable") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, but the scan's time budget ran out before the banner search could run. Nothing was searched or clicked, and results reflect the pre-consent state.`;
    }
    if (probeFailure === "scan-failed") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, but the banner search itself failed before it could complete. Whether a control exists on this page is unknown, and results reflect the pre-consent state.`;
    }
    if (probeFailure === "engine-unavailable") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, but no frame could be read to search for one. Whether a control exists on this page is unknown, and results reflect the pre-consent state.`;
    }
    if (probeFailure === "dispatch-unconfirmed") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, and clicked a control that never visibly responded. A page shows an unresponsive control both when it is a decoy in front of the real one and when the real one acts more slowly than the scanner waits, so whether a choice registered is unknown, and this visit's requests, cookies, and storage may include traffic from after that click.`;
    }
    if (probeFailure === "frames-unreadable") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, but one or more frames could not be read, so the search did not cover the whole page. A recognizable control may exist in a frame this visit could not search, and no control was clicked.`;
    }
    if (probeFailure === "search-interrupted") {
      return `This visit was asked to choose "${label}" on a cookie/consent banner, but the page moved out from under the search before it finished: a frame stopped being readable, which is also what a control that reloads the page on click does. Whether a control was found or clicked is unknown, and this visit's requests, cookies, and storage may include traffic from both sides of that choice.`;
    }
    return `This visit was asked to choose "${label}" on a cookie/consent banner, but no recognizable control was found (the banner may not be shown to this scanner's location, the choice may sit behind a settings layer, or the control is not in the catalog). Results reflect the pre-consent state.`;
  }
  const via = summary.cmp
    ? `the ${summary.cmp} banner`
    : summary.matchedText
      ? `a control labeled "${summary.matchedText}"`
      : "the consent banner";
  // NOTE: a catalogued control whose submitted choice is configuration-dependent
  // (CONSENT_QUALIFIED_CHOICE_CONTROLS) makes this sentence's `clicked "Accept
  // all"` narrower than it reads. The qualification is disclosed READ-side, off
  // the recorded selector, in RunConsentView.matchedControlQualification, which
  // reaches already-published reports too. Restating it here would change an
  // admitted public string and so retire the r2 normalization identity, which
  // must be sequenced deliberately with the producer tuples that pin it.
  return `This visit clicked "${label}" on ${via} after page load. The click was dispatched, not verified as registered by the site, and the visit's requests, cookies, and storage include traffic from before and after the click.`;
}
