/**
 * Upgraded 2-layer CMP interaction, dark-pattern scorecard, and multi-standard
 * consent verification probe (`__tcfapi`, `__gpp`, `__uspapi`, Google Consent
 * Mode `gcs`/`gcd`, and major CMP cookies) for Site Behavior Lab v3.
 */

import type {
  ConsentBannerAuditV3,
  ConsentModeV3,
  ConsentSignalStateV3,
  ConsentSummaryV3,
  ConsentVerificationV3,
  CookieRecordV3,
  DarkPatternFlagV3,
  GoogleConsentModeSignalV3
} from "../schema";

export type CmpRuleV3 = {
  cmp: string;
  accept: readonly string[];
  reject: readonly string[];
  settings: readonly string[];
  secondLayerReject: readonly string[];
};

export const CMP_RULES_V3: readonly CmpRuleV3[] = [
  {
    cmp: "OneTrust",
    accept: ["#onetrust-accept-btn-handler", "#accept-recommended-btn-handler"],
    reject: ["#onetrust-reject-all-handler"],
    settings: ["#onetrust-pc-btn-handler", ".cookie-setting-link"],
    secondLayerReject: [".ot-pc-refuse-all-handler", ".save-preference-btn-handler"]
  },
  {
    cmp: "Cookiebot",
    accept: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept"],
    reject: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll", "#CybotCookiebotDialogBodyButtonDecline"],
    settings: ["#CybotCookiebotDialogBodyEdgeMoreDetailsLink", "#CybotCookiebotDialogBodyButtonDetails"],
    secondLayerReject: ["#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection"]
  },
  {
    cmp: "Didomi",
    accept: ["#didomi-notice-agree-button"],
    reject: ["#didomi-notice-disagree-button", ".didomi-continue-without-agreeing"],
    settings: ["#didomi-notice-learn-more-button"],
    secondLayerReject: [".didomi-components-button--secondary", "button[aria-label*='Disagree' i]"]
  },
  {
    cmp: "Usercentrics",
    accept: ["[data-testid='uc-accept-all-button']"],
    reject: ["[data-testid='uc-deny-all-button']"],
    settings: ["[data-testid='uc-customize-button']"],
    secondLayerReject: ["[data-testid='uc-deny-all-button']", "[data-testid='uc-save-button']"]
  },
  {
    cmp: "TrustArc",
    accept: ["#truste-consent-button", "#truste-consent-track .call", ".truste_box_overlay .call", ".pdynamicbutton .call"],
    reject: ["#truste-consent-required"],
    settings: ["#truste-show-consent"],
    secondLayerReject: [".rejectAll", ".pdynamicbutton .shp"]
  },
  {
    cmp: "Sourcepoint",
    accept: [".sp_choice_type_11", ".message-button.sp_choice_type_ACCEPT_ALL"],
    reject: [".sp_choice_type_13", ".message-button.sp_choice_type_REJECT_ALL"],
    settings: [".sp_choice_type_12"],
    secondLayerReject: [".sp_choice_type_13", ".sp_choice_type_SAVE_AND_EXIT"]
  },
  {
    cmp: "CookieYes",
    accept: ["[data-cky-tag='accept-button']", ".cky-btn-accept"],
    reject: ["[data-cky-tag='reject-button']", ".cky-btn-reject"],
    settings: ["[data-cky-tag='settings-button']", ".cky-btn-customize"],
    secondLayerReject: ["[data-cky-tag='detail-reject-button']", "[data-cky-tag='detail-save-button']"]
  },
  {
    cmp: "Osano",
    accept: [".osano-cm-accept-all", ".osano-cm-accept"],
    reject: [".osano-cm-denyAll", ".osano-cm-deny"],
    settings: [".osano-cm-manage"],
    secondLayerReject: [".osano-cm-save"]
  },
  {
    cmp: "Quantcast Choice",
    accept: [".qc-cmp2-summary-buttons button[mode='primary']"],
    reject: [".qc-cmp2-summary-buttons button[mode='secondary']"],
    settings: [".qc-cmp2-summary-buttons button[mode='link']"],
    secondLayerReject: [".qc-cmp2-buttons-desktop button[mode='secondary']"]
  },
  {
    cmp: "Complianz",
    accept: [".cmplz-accept"],
    reject: [".cmplz-deny"],
    settings: [".cmplz-view-preferences"],
    secondLayerReject: [".cmplz-save-preferences"]
  },
  {
    cmp: "Iubenda",
    accept: [".iubenda-cs-accept-btn"],
    reject: [".iubenda-cs-reject-btn"],
    settings: [".iubenda-cs-customize-btn"],
    secondLayerReject: [".iubenda-cs-reject-btn", "#iubFooterBtn"]
  },
  {
    cmp: "Termly",
    accept: ["[data-tid='banner-accept']"],
    reject: ["[data-tid='banner-decline']"],
    settings: ["[data-tid='banner-preferences']"],
    secondLayerReject: ["[data-tid='preferences-save']"]
  },
  {
    cmp: "ConsentManager",
    accept: [".cmpboxbtnyes"],
    reject: [".cmpboxbtnno"],
    settings: [".cmpboxbtncustom"],
    secondLayerReject: [".cmpboxbtnno", ".cmpboxbtnsave"]
  }
];

export type BannerInspectionMetricsV3 = {
  detected: boolean;
  cmp: string | null;
  hasFirstLayerAccept: boolean;
  hasFirstLayerReject: boolean;
  hasSettingsEntry: boolean;
  acceptAreaPx: number | null;
  rejectAreaPx: number | null;
  cookieWallDetected: boolean;
  preTickedNonEssentialCount: number;
};

/**
 * Pure dark-pattern scorer (0–100) based on objective, verifiable UI geometry
 * and click-path observations from a consent banner audit.
 */
export function computeDarkPatternAuditV3(
  metrics: BannerInspectionMetricsV3,
  options?: { secondLayerRejectFound?: boolean }
): ConsentBannerAuditV3 {
  if (!metrics.detected) {
    return {
      detected: false,
      cmp: metrics.cmp,
      hasFirstLayerAccept: false,
      hasFirstLayerReject: false,
      hasSettingsEntry: false,
      clicksToAccept: null,
      clicksToReject: null,
      darkPatternFlags: [],
      darkPatternScore: 0
    };
  }

  const flags: DarkPatternFlagV3[] = [];
  let score = 0;

  const clicksToAccept = metrics.hasFirstLayerAccept ? 1 : null;
  const clicksToReject = metrics.hasFirstLayerReject
    ? 1
    : options?.secondLayerRejectFound
      ? 2
      : metrics.hasSettingsEntry
        ? 2
        : null;

  if (metrics.hasFirstLayerAccept && !metrics.hasFirstLayerReject) {
    flags.push("reject-hidden-in-settings");
    score += 35;
  }

  if (clicksToAccept !== null && (clicksToReject === null || clicksToReject > clicksToAccept)) {
    flags.push("asymmetric-clicks");
    score += 20;
  }

  if (metrics.preTickedNonEssentialCount > 0) {
    flags.push("pre-ticked-non-essential");
    score += 25;
  }

  if (
    metrics.acceptAreaPx !== null &&
    metrics.rejectAreaPx !== null &&
    metrics.rejectAreaPx > 0 &&
    metrics.acceptAreaPx / metrics.rejectAreaPx >= 1.75
  ) {
    flags.push("prominence-asymmetry");
    score += 15;
  }

  if (metrics.cookieWallDetected) {
    flags.push("cookie-wall");
    score += 20;
  }

  return {
    detected: true,
    cmp: metrics.cmp,
    hasFirstLayerAccept: metrics.hasFirstLayerAccept,
    hasFirstLayerReject: metrics.hasFirstLayerReject,
    hasSettingsEntry: metrics.hasSettingsEntry,
    clicksToAccept,
    clicksToReject,
    darkPatternFlags: flags,
    darkPatternScore: Math.min(100, score)
  };
}

export type RawConsentApisSnapshotV3 = {
  tcf: {
    present: boolean;
    gdprApplies: boolean | null;
    eventStatus: string | null;
    purposeConsents: Record<string, boolean>;
  };
  gpp: {
    present: boolean;
    applicableSections: number[];
    gppStringPresent: boolean;
  };
  usp: {
    present: boolean;
    uspString: string | null;
  };
};

/**
 * Self-contained page function reading `__tcfapi`, `__gpp`, and `__uspapi`
 * with bounded local timeouts. Raw TC/GPP strings stay inside the page.
 */
export async function readAllConsentApisInPage(timeoutMs = 1200): Promise<RawConsentApisSnapshotV3> {
  const win = window as unknown as {
    __tcfapi?: (cmd: string, ver: number, cb: (data: unknown, ok: boolean) => void) => void;
    __gpp?: (cmd: string, cb: (data: unknown, ok: boolean) => void) => void;
    __uspapi?: (cmd: string, ver: number, cb: (data: unknown, ok: boolean) => void) => void;
  };

  const tcf: RawConsentApisSnapshotV3["tcf"] = {
    present: typeof win.__tcfapi === "function",
    gdprApplies: null,
    eventStatus: null,
    purposeConsents: {}
  };
  if (typeof win.__tcfapi === "function") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        win.__tcfapi!("getTCData", 2, (data, ok) => {
          clearTimeout(timer);
          if (ok && data && typeof data === "object") {
            const rec = data as Record<string, unknown>;
            if (typeof rec.gdprApplies === "boolean") tcf.gdprApplies = rec.gdprApplies;
            if (typeof rec.eventStatus === "string") tcf.eventStatus = rec.eventStatus;
            const purpose = rec.purpose as Record<string, unknown> | undefined;
            const consents = purpose?.consents as Record<string, unknown> | undefined;
            if (consents && typeof consents === "object") {
              for (let i = 1; i <= 11; i++) {
                const k = String(i);
                if (typeof consents[k] === "boolean") tcf.purposeConsents[k] = consents[k] as boolean;
              }
            }
          }
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  const gpp: RawConsentApisSnapshotV3["gpp"] = {
    present: typeof win.__gpp === "function",
    applicableSections: [],
    gppStringPresent: false
  };
  if (typeof win.__gpp === "function") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        win.__gpp!("ping", (data) => {
          clearTimeout(timer);
          if (data && typeof data === "object") {
            const rec = data as Record<string, unknown>;
            if (Array.isArray(rec.applicableSections)) {
              gpp.applicableSections = rec.applicableSections.filter((n): n is number => typeof n === "number" && n > 0);
            }
            gpp.gppStringPresent = typeof rec.gppString === "string" && rec.gppString.length > 0;
          }
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  const usp: RawConsentApisSnapshotV3["usp"] = {
    present: typeof win.__uspapi === "function",
    uspString: null
  };
  if (typeof win.__uspapi === "function") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        win.__uspapi!("getUSPData", 1, (data, ok) => {
          clearTimeout(timer);
          if (ok && data && typeof data === "object") {
            const raw = (data as Record<string, unknown>).uspString;
            if (typeof raw === "string" && /^[1-9][YN-]{3}$/i.test(raw)) {
              usp.uspString = raw.toUpperCase();
            }
          }
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  return { tcf, gpp, usp };
}

/**
 * Pure interpreter mapping observed CMP APIs, Google Consent Mode beacons,
 * and CMP cookie values (read transiently in memory, never persisted) into
 * {@link ConsentVerificationV3}.
 */
export function evaluateConsentVerificationV3(input: {
  mode: ConsentModeV3;
  clicked: boolean;
  apis: RawConsentApisSnapshotV3;
  googleConsentMode: readonly GoogleConsentModeSignalV3[];
  rawCmpCookies: readonly { name: string; value: string }[];
}): ConsentVerificationV3 {
  // 1. TCF state
  let tcfState: ConsentSignalStateV3 = "unavailable";
  if (input.apis.tcf.present) {
    const entries = Object.values(input.apis.tcf.purposeConsents);
    if (entries.length === 0) tcfState = "unknown";
    else if (entries.every((v) => v === true)) tcfState = "granted";
    else if (entries.every((v) => v === false)) tcfState = "denied";
    else tcfState = "mixed";
  }

  // 2. GPP state
  const gppState: ConsentSignalStateV3 = !input.apis.gpp.present
    ? "unavailable"
    : input.apis.gpp.gppStringPresent
      ? "unknown"
      : "unavailable";

  // 3. USP (CCPA) opt-out flag: 3rd char of `1YNN` -> `Y` means opted out of sale
  const uspString = input.apis.usp.uspString;
  const optOutSale = uspString ? (uspString[2] === "Y" ? true : uspString[2] === "N" ? false : null) : null;

  // 4. CMP cookies (interpreted transiently; values never persisted!)
  const cmpCookies: ConsentVerificationV3["cmpCookies"] = [];
  for (const cookie of input.rawCmpCookies) {
    if (cookie.name === "OptanonConsent") {
      const groupsMatch = /groups=([^&]+)/.exec(decodeSafe(cookie.value));
      if (groupsMatch) {
        const pairs = groupsMatch[1]
          .split(",")
          .map((p) => p.split(":"))
          .filter((p) => p.length === 2);
        // Ignore strictly necessary C0001 when summarizing optional consent groups.
        const optional = pairs.filter(([id]) => id !== "C0001");
        let state: ConsentSignalStateV3 = "unknown";
        if (optional.length > 0) {
          if (optional.every(([, v]) => v === "1")) state = "granted";
          else if (optional.every(([, v]) => v === "0")) state = "denied";
          else state = "mixed";
        }
        cmpCookies.push({ cmp: "OneTrust", cookieName: "OptanonConsent", state });
      }
    } else if (cookie.name === "CookieConsent") {
      const val = decodeSafe(cookie.value);
      const marketing = /marketing:(true|false)/i.exec(val)?.[1]?.toLowerCase();
      const stats = /statistics:(true|false)/i.exec(val)?.[1]?.toLowerCase();
      let state: ConsentSignalStateV3 = "unknown";
      if (marketing === "true" && stats === "true") state = "granted";
      else if (marketing === "false" && stats === "false") state = "denied";
      else if (marketing || stats) state = "mixed";
      cmpCookies.push({ cmp: "Cookiebot", cookieName: "CookieConsent", state });
    } else if (cookie.name === "didomi_token") {
      cmpCookies.push({ cmp: "Didomi", cookieName: "didomi_token", state: "unknown" });
    } else if (cookie.name === "euconsent-v2") {
      cmpCookies.push({ cmp: "TCF v2", cookieName: "euconsent-v2", state: tcfState });
    }
  }

  // 5. Consistency verdict against requested action
  let consistency: ConsentVerificationV3["consistency"] = "unavailable";
  if (input.mode !== "observe" && input.clicked) {
    const signals: ConsentSignalStateV3[] = [];
    if (tcfState !== "unavailable" && tcfState !== "unknown") signals.push(tcfState);
    for (const c of cmpCookies) {
      if (c.state !== "unavailable" && c.state !== "unknown") signals.push(c.state);
    }
    for (const gcm of input.googleConsentMode) {
      if (gcm.adStorage === "granted" && gcm.analyticsStorage === "granted") signals.push("granted");
      else if (gcm.adStorage === "denied" && gcm.analyticsStorage === "denied") signals.push("denied");
      else if (gcm.adStorage !== "unknown" || gcm.analyticsStorage !== "unknown") signals.push("mixed");
    }

    if (signals.length === 0) {
      consistency = "inconclusive";
    } else if (input.mode === "reject-all") {
      if (signals.some((s) => s === "granted")) consistency = "contradicted";
      else if (signals.every((s) => s === "denied")) consistency = "verified";
      else consistency = "inconclusive";
    } else if (input.mode === "accept-all") {
      if (signals.some((s) => s === "denied")) consistency = "contradicted";
      else if (signals.every((s) => s === "granted")) consistency = "verified";
      else consistency = "inconclusive";
    }
  }

  return {
    tcf: {
      present: input.apis.tcf.present,
      gdprApplies: input.apis.tcf.gdprApplies,
      eventStatus: input.apis.tcf.eventStatus,
      state: tcfState
    },
    gpp: {
      present: input.apis.gpp.present,
      applicableSections: input.apis.gpp.applicableSections,
      state: gppState
    },
    usp: {
      present: input.apis.usp.present,
      optOutSale
    },
    googleConsentMode: [...input.googleConsentMode],
    cmpCookies,
    consistency
  };
}

export function emptyConsentSummaryV3(mode: ConsentModeV3): ConsentSummaryV3 {
  return {
    mode,
    banner: {
      detected: false,
      cmp: null,
      hasFirstLayerAccept: false,
      hasFirstLayerReject: false,
      hasSettingsEntry: false,
      clicksToAccept: null,
      clicksToReject: null,
      darkPatternFlags: [],
      darkPatternScore: 0
    },
    interaction: {
      attempted: mode !== "observe",
      clicked: false,
      layer: null
    },
    verification: {
      tcf: { present: false, gdprApplies: null, eventStatus: null, state: "unavailable" },
      gpp: { present: false, applicableSections: [], state: "unavailable" },
      usp: { present: false, optOutSale: null },
      googleConsentMode: [],
      cmpCookies: [],
      consistency: "unavailable"
    }
  };
}

/** Detect CMP name from observed requests/cookies as an additional fallback signal. */
export function detectCmpFromDomainsAndCookies(
  domains: readonly string[],
  cookies: readonly CookieRecordV3[]
): string | null {
  const hostSet = domains.map((d) => d.toLowerCase());
  const matchHost = (suffix: string) => hostSet.some((h) => h === suffix || h.endsWith(`.${suffix}`));
  if (matchHost("cookielaw.org") || matchHost("onetrust.com") || cookies.some((c) => c.name === "OptanonConsent")) {
    return "OneTrust";
  }
  if (matchHost("cookiebot.com") || matchHost("cookiebot.eu") || cookies.some((c) => c.name === "CookieConsent")) {
    return "Cookiebot";
  }
  if (matchHost("didomi.io") || matchHost("privacy-center.org") || cookies.some((c) => c.name === "didomi_token")) {
    return "Didomi";
  }
  if (matchHost("usercentrics.eu") || matchHost("usercentrics.com")) return "Usercentrics";
  if (matchHost("sp-prod.net") || matchHost("sourcepoint.com") || matchHost("privacy-mgmt.com")) return "Sourcepoint";
  if (matchHost("trustarc.com") || matchHost("truste.com")) return "TrustArc";
  if (matchHost("cookieyes.com")) return "CookieYes";
  if (matchHost("osano.com")) return "Osano";
  if (matchHost("quantcast.mgr.consensu.org") || matchHost("cmp.inmobi.com")) return "Quantcast Choice";
  if (matchHost("iubenda.com")) return "Iubenda";
  if (matchHost("termly.io")) return "Termly";
  if (matchHost("ketchcdn.com") || matchHost("ketch.com")) return "Ketch";
  if (matchHost("transcend-cdn.com")) return "Transcend";
  if (matchHost("consentmanager.net")) return "ConsentManager";
  return null;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
