/**
 * Single-arm execution engine for Site Behavior Lab v3.
 *
 * Runs one isolated BrowserContext with:
 *  - Flattened CDP telemetry collector (O(1) network, WebSockets, SW, cookies,
 *    IndexedDB, CacheStorage, initiator call stacks)
 *  - Optional Shields request interception (Standard vs Aggressive + $removeparam)
 *  - Optional GPC header + `navigator.globalPrivacyControl = true`
 *  - Persisted phases: passive-load -> consent-choice -> scroll-interaction ->
 *    active-input -> policy-check
 *  - Shared immutable caches across concurrent comparison arms (CNAME + policy)
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { checkAdblockDetailed, mapRequestType } from "../../adblock-engine";
import { partyKey } from "../../domain-utils";
import { summarizeBeaconEventsV3 } from "../probes/beacons";
import { runCnameProbeV3, type CnameProbeOutcomeV3, type CnameResolverFnV3 } from "../probes/cname-probe";
import {
  CMP_RULES_V3,
  computeDarkPatternAuditV3,
  detectCmpFromDomainsAndCookies,
  emptyConsentSummaryV3,
  evaluateConsentVerificationV3,
  readAllConsentApisInPage,
  type BannerInspectionMetricsV3
} from "../probes/consent-probe";
import { analyzeFingerprintTelemetryV3, buildFingerprintInitScriptV3 } from "../probes/fingerprint-probe";
import {
  buildSentinelEncodingsV3,
  createKeystrokeCanaryV3,
  detectKeystrokeLeaksV3,
  typeCanaryInDocument
} from "../probes/keystroke-probe";
import { analyzePolicyTextV3, selectPrivacyPolicyUrlV3, type PolicyLinkCandidateV3 } from "../probes/policy-probe";
import type {
  ArmConditionsV3,
  ConsentSummaryV3,
  PolicySummaryV3,
  ProbeCoverageV3,
  ProbeName,
  ScanArmV3,
  ScanPhaseRecordV3
} from "../schema";
import { CdpSessionCollectorV3 } from "./cdp-session";
import { buildArmSummaryV3 } from "./summary";

type AdblockEngineArg = Parameters<typeof checkAdblockDetailed>[0];

export type SharedArmCachesV3 = {
  cnameByHost: Map<string, Promise<{ chain: string[]; terminated: boolean }>>;
  policyByUrl: Map<string, Promise<{ text: string; language: string | null } | null>>;
};

export type RunArmOptionsV3 = {
  armId: string;
  label: string;
  targetUrl: string;
  conditions: ArmConditionsV3;
  browser: Browser;
  adblockEngine: AdblockEngineArg;
  proxyServer?: string;
  locale?: string;
  timezone?: string;
  navigationTimeoutMs?: number;
  passiveDwellMs?: number;
  scrollDwellMs?: number;
  inputDwellMs?: number;
  resolveCnameChain?: CnameResolverFnV3;
  sharedCaches?: SharedArmCachesV3;
};

export type RunArmResultV3 = {
  arm: ScanArmV3;
  sentinelsUsed: string[];
};

const DESKTOP_VIEWPORT = { width: 1366, height: 860 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

export async function runScanArmV3(options: RunArmOptionsV3): Promise<RunArmResultV3> {
  const startedAt = Date.now();
  const targetParsed = new URL(options.targetUrl);
  const firstPartyHost = targetParsed.hostname.toLowerCase();
  const firstPartyReg = partyKey(firstPartyHost).toLowerCase();
  const navTimeoutMs = options.navigationTimeoutMs ?? 20_000;
  const passiveDwellMs = options.passiveDwellMs ?? 2_200;
  const scrollDwellMs = options.scrollDwellMs ?? 1_200;
  const inputDwellMs = options.inputDwellMs ?? 1_200;

  const phases: ScanPhaseRecordV3[] = [];
  const sentinelsUsed: string[] = [];
  const probes: Record<ProbeName, ProbeCoverageV3> = {
    network: { status: "complete" },
    websockets: { status: "complete" },
    serviceWorkers: { status: "complete" },
    cookies: { status: "complete" },
    storage: { status: "complete" },
    beacons: { status: "complete" },
    cname: { status: "complete" },
    fingerprinting: { status: "complete" },
    keystrokes: { status: options.conditions.activeInputProbe ? "complete" : "skipped" },
    consent: { status: "complete" },
    policy: { status: options.conditions.policyCheck ? "complete" : "skipped" }
  };

  const context: BrowserContext = await options.browser.newContext({
    viewport: options.conditions.device === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
    isMobile: options.conditions.device === "mobile",
    hasTouch: options.conditions.device === "mobile",
    locale: options.locale ?? "en-US",
    timezoneId: options.timezone ?? "America/New_York",
    serviceWorkers: "allow",
    ...(options.proxyServer ? { proxy: { server: options.proxyServer } } : {}),
    extraHTTPHeaders: options.conditions.gpcEnabled ? { "Sec-GPC": "1" } : undefined
  });

  // Install fingerprint + JS-cookie init script (and GPC navigator property when enabled).
  await context.addInitScript(buildFingerprintInitScriptV3("main"));
  if (options.conditions.gpcEnabled) {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, "globalPrivacyControl", {
          get: () => true,
          configurable: true
        });
      } catch {}
    });
  }

  const page = await context.newPage();
  const collector = new CdpSessionCollectorV3({
    page,
    context,
    firstPartyHost,
    shieldsMode: options.conditions.shieldsMode,
    adblockEngine: options.adblockEngine,
    startedAtEpochMs: startedAt
  });

  const cdpAttached = await collector.attach();
  if (!cdpAttached) {
    probes.websockets = { status: "unavailable", reason: "cdp-attach-failed" };
    probes.serviceWorkers = { status: "unavailable", reason: "cdp-attach-failed" };
  }

  // Optional Shields enforcement route (Standard vs Aggressive + $removeparam rewriting)
  if (options.conditions.shieldsMode !== "off" && options.adblockEngine) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await route.continue();
        return;
      }
      const frame = req.frame();
      const isMainNav = req.resourceType() === "document" && frame === page.mainFrame();
      if (isMainNav) {
        await route.continue();
        return;
      }
      const sourceUrl = page.url().startsWith("http") ? page.url() : options.targetUrl;
      const adblockType = mapRequestType(req.resourceType(), { subFrame: frame !== page.mainFrame() });
      const detailed = checkAdblockDetailed(options.adblockEngine, url, sourceUrl, adblockType, req.method());
      const block =
        options.conditions.shieldsMode === "standard"
          ? detailed.shouldBlockStandard
          : detailed.shouldBlockAggressive;
      if (block) {
        collector.markRouteBlocked(url);
        await route.abort("blockedbyclient");
        return;
      }
      if (detailed.rewrittenUrl && detailed.rewrittenUrl !== url) {
        await route.continue({ url: detailed.rewrittenUrl });
        return;
      }
      await route.continue();
    });
  }

  let httpStatus: number | null = null;
  let finalUrl = options.targetUrl;
  let loadOutcome: ScanArmV3["loadOutcome"] = "ok";

  try {
    // --- Phase 1: Passive load ---
    const passiveStart = Date.now() - startedAt;
    collector.setPhase("passive-load");
    try {
      const response = await page.goto(options.targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: navTimeoutMs
      });
      httpStatus = response?.status() ?? null;
      finalUrl = page.url() || options.targetUrl;
      if (httpStatus !== null && httpStatus >= 400) {
        loadOutcome = "http-error";
      }
      await page.waitForLoadState("networkidle", { timeout: Math.min(4_000, passiveDwellMs) }).catch(() => {});
      await sleep(Math.min(passiveDwellMs, 1_500));
      phases.push({
        name: "passive-load",
        startedAtMs: passiveStart,
        endedAtMs: Date.now() - startedAt,
        status: loadOutcome === "ok" ? "completed" : "partial"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadOutcome = /timeout/i.test(msg) ? "timeout" : "navigation-error";
      phases.push({
        name: "passive-load",
        startedAtMs: passiveStart,
        endedAtMs: Date.now() - startedAt,
        status: "failed",
        reason: loadOutcome
      });
    }

    // --- Phase 2: Consent banner audit & optional 1st/2nd-layer interaction ---
    let consent: ConsentSummaryV3 = emptyConsentSummaryV3(options.conditions.consentMode);
    const consentStart = Date.now() - startedAt;
    collector.setPhase("consent-choice");
    if (loadOutcome === "ok") {
      try {
        consent = await runConsentPhaseInPage(page, options.conditions.consentMode);
        if (consent.interaction.clicked) {
          await sleep(1_200);
        }
        phases.push({
          name: "consent-choice",
          startedAtMs: consentStart,
          endedAtMs: Date.now() - startedAt,
          status: "completed"
        });
      } catch {
        probes.consent = { status: "partial", reason: "consent-probe-error" };
        phases.push({
          name: "consent-choice",
          startedAtMs: consentStart,
          endedAtMs: Date.now() - startedAt,
          status: "partial"
        });
      }
    } else {
      probes.consent = { status: "skipped", reason: loadOutcome };
      phases.push({
        name: "consent-choice",
        startedAtMs: consentStart,
        endedAtMs: Date.now() - startedAt,
        status: "skipped",
        reason: loadOutcome
      });
    }

    // --- Phase 3: Lightweight persisted scroll-interaction phase ---
    const scrollStart = Date.now() - startedAt;
    collector.setPhase("scroll-interaction");
    if (options.conditions.scrollCheck && loadOutcome === "ok") {
      try {
        await runBoundedScroll(page, scrollDwellMs);
        phases.push({
          name: "scroll-interaction",
          startedAtMs: scrollStart,
          endedAtMs: Date.now() - startedAt,
          status: "completed"
        });
      } catch {
        phases.push({
          name: "scroll-interaction",
          startedAtMs: scrollStart,
          endedAtMs: Date.now() - startedAt,
          status: "partial"
        });
      }
    } else {
      phases.push({
        name: "scroll-interaction",
        startedAtMs: scrollStart,
        endedAtMs: Date.now() - startedAt,
        status: "skipped"
      });
    }

    // --- Phase 4: Active keystroke / input-exfiltration probe ---
    const inputStart = Date.now() - startedAt;
    collector.setPhase("active-input");
    let fieldsTyped = 0;
    let iframeFieldsTyped = 0;
    let shadowDomFieldsTyped = 0;
    const fieldTypeSet = new Set<string>();
    let canary: string | null = null;

    if (options.conditions.activeInputProbe && loadOutcome === "ok") {
      try {
        canary = createKeystrokeCanaryV3();
        sentinelsUsed.push(canary);
        const frames = page.frames();
        for (const frame of frames) {
          if (fieldsTyped >= 6) break;
          const url = frame.url();
          if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
          try {
            const res = await frame.evaluate(typeCanaryInDocument, {
              canary,
              maxFields: 6 - fieldsTyped
            });
            fieldsTyped += res.fieldsTyped;
            shadowDomFieldsTyped += res.shadowDomFieldsTyped;
            if (frame !== page.mainFrame()) iframeFieldsTyped += res.fieldsTyped;
            for (const ft of res.fieldTypes) fieldTypeSet.add(ft);
          } catch {
            // Frame cross-origin or detached
          }
        }
        if (fieldsTyped > 0) {
          // Trigger visibilitychange/pagehide beacons gently only after short dwell
          await sleep(inputDwellMs);
        }
        phases.push({
          name: "active-input",
          startedAtMs: inputStart,
          endedAtMs: Date.now() - startedAt,
          status: "completed"
        });
      } catch {
        probes.keystrokes = { status: "partial", reason: "input-probe-error" };
        phases.push({
          name: "active-input",
          startedAtMs: inputStart,
          endedAtMs: Date.now() - startedAt,
          status: "partial"
        });
      }
    } else {
      phases.push({
        name: "active-input",
        startedAtMs: inputStart,
        endedAtMs: Date.now() - startedAt,
        status: "skipped"
      });
    }

    // --- Collect final CDP storage, cookies, fingerprint telemetry, and consent APIs ---
    const collected = await collector.collectStorageCookiesAndTelemetry();
    const consentApis =
      loadOutcome === "ok"
        ? await page.evaluate(readAllConsentApisInPage, 1_200).catch(() => ({
            tcf: { present: false, gdprApplies: null, eventStatus: null, purposeConsents: {} },
            gpp: { present: false, applicableSections: [], gppStringPresent: false },
            usp: { present: false, uspString: null }
          }))
        : {
            tcf: { present: false, gdprApplies: null, eventStatus: null, purposeConsents: {} },
            gpp: { present: false, applicableSections: [], gppStringPresent: false },
            usp: { present: false, uspString: null }
          };

    // Build network, beacons, websockets, service workers, fingerprinting
    const network = collector.buildNetworkRequests(finalUrl);
    const omittedRequests = collector.getOmittedRequestCount();
    if (omittedRequests > 0) {
      probes.network = { status: "partial", reason: "request-cap-reached", omittedCount: omittedRequests };
    }
    const beacons = summarizeBeaconEventsV3(collector.buildBeaconInputs());
    const websockets = collector.buildWebSockets();
    const serviceWorkers = collector.buildServiceWorkers();
    const fingerprinting = analyzeFingerprintTelemetryV3(collected.fingerprintEvents);
    if (collected.droppedFingerprintEvents > 0) {
      probes.fingerprinting = {
        status: "partial",
        reason: "event-cap-reached",
        omittedCount: collected.droppedFingerprintEvents
      };
    }

    // Parallel DNS CNAME uncloaking (reuses shared cache across concurrent arms!)
    const resolveCname = wrapSharedCnameResolver(options.resolveCnameChain, options.sharedCaches);
    const cnameOutcome: CnameProbeOutcomeV3 = await runCnameProbeV3(network, firstPartyHost, {
      registrableDomain: partyKey,
      resolveCnameChain: resolveCname,
      shieldsMatchHost: (targetHost) =>
        checkAdblockDetailed(options.adblockEngine, `https://${targetHost}/`, finalUrl, "script", "GET")
          .shouldBlockAggressive
    });
    if (cnameOutcome.omittedCandidateCount > 0 || cnameOutcome.failedLookups > 0) {
      probes.cname = {
        status: "partial",
        reason: cnameOutcome.failedLookups > 0 ? "dns-lookup-failures" : "host-cap-reached",
        omittedCount: cnameOutcome.omittedCandidateCount + cnameOutcome.failedLookups
      };
    }

    // Keystroke leak detection across HTTP URL/body/gzip/beacon + WebSocket frames + CNAME cloaks
    const keystrokeLeaks =
      canary && fieldsTyped > 0
        ? detectKeystrokeLeaksV3(buildSentinelEncodingsV3(canary), collector.buildKeystrokeCandidates(), {
            cloakTargetByHost: cnameOutcome.cloakTargetByHost
          })
        : [];

    // Complete consent verification with Google Consent Mode beacons & CMP cookies
    const allGcm = beacons.flatMap((b) => b.consentModeSignals);
    if (!consent.banner.cmp) {
      consent.banner.cmp = detectCmpFromDomainsAndCookies(
        network.map((r) => r.domain),
        collected.cookies
      );
    }
    consent.verification = evaluateConsentVerificationV3({
      mode: options.conditions.consentMode,
      clicked: consent.interaction.clicked,
      apis: consentApis,
      googleConsentMode: allGcm,
      rawCmpCookies: collected.rawCmpCookies
    });

    // --- Phase 5: Multilingual / iframe-aware privacy policy check ---
    let policy: PolicySummaryV3 | null = null;
    const policyStart = Date.now() - startedAt;
    collector.setPhase("policy-check");
    if (options.conditions.policyCheck && loadOutcome === "ok") {
      try {
        const candidates = await collectPolicyLinkCandidates(page);
        const selected = selectPrivacyPolicyUrlV3(candidates, firstPartyReg, partyKey);
        if (selected) {
          const fetched = await fetchPolicyTextShared(context, selected.url, options.sharedCaches);
          if (fetched) {
            const observedEntities = [
              ...new Set([
                ...network.filter((r) => r.thirdParty && r.entity).map((r) => r.entity!.entity),
                ...cnameOutcome.cloaks.map((c) => c.entity.entity)
              ])
            ];
            policy = analyzePolicyTextV3({
              url: selected.url,
              text: fetched.text,
              language: fetched.language,
              fromIframe: selected.fromIframe,
              observedEntities
            });
          } else {
            probes.policy = { status: "unavailable", reason: "policy-fetch-failed" };
          }
        } else {
          probes.policy = { status: "unavailable", reason: "no-policy-link-found" };
        }
        phases.push({
          name: "policy-check",
          startedAtMs: policyStart,
          endedAtMs: Date.now() - startedAt,
          status: policy ? "completed" : "partial"
        });
      } catch {
        probes.policy = { status: "unavailable", reason: "policy-probe-error" };
        phases.push({
          name: "policy-check",
          startedAtMs: policyStart,
          endedAtMs: Date.now() - startedAt,
          status: "failed"
        });
      }
    } else {
      phases.push({
        name: "policy-check",
        startedAtMs: policyStart,
        endedAtMs: Date.now() - startedAt,
        status: "skipped"
      });
    }

    const keystrokes = {
      fieldsTyped,
      iframeFieldsTyped,
      shadowDomFieldsTyped,
      fieldTypes: [...fieldTypeSet].sort(),
      leaks: keystrokeLeaks
    };

    const summary = buildArmSummaryV3({
      network,
      websockets,
      serviceWorkers,
      cookies: collected.cookies,
      storage: collected.storage,
      beacons,
      cnameCloaks: cnameOutcome.cloaks,
      fingerprinting,
      keystrokes,
      consent
    });

    return {
      arm: {
        armId: options.armId,
        label: options.label,
        conditions: options.conditions,
        finalUrl,
        httpStatus,
        loadOutcome,
        durationMs: Math.max(0, Date.now() - startedAt),
        phases,
        probes,
        network,
        websockets,
        serviceWorkers,
        cookies: collected.cookies,
        storage: collected.storage,
        beacons,
        cnameCloaks: cnameOutcome.cloaks,
        fingerprinting,
        keystrokes,
        consent,
        policy,
        summary
      },
      sentinelsUsed
    };
  } finally {
    await collector.detach();
    await context.close().catch(() => {});
  }
}

// --- In-page phase helpers --------------------------------------------------

async function runBoundedScroll(page: Page, dwellMs: number): Promise<void> {
  await page.evaluate(async () => {
    const docHeight = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0);
    const steps = [0.35, 0.7, 1.0];
    for (const frac of steps) {
      window.scrollTo(0, Math.round(docHeight * frac));
      await new Promise((r) => setTimeout(r, 200));
    }
  });
  await sleep(Math.min(dwellMs, 1_500));
}

async function runConsentPhaseInPage(page: Page, mode: ConsentSummaryV3["mode"]): Promise<ConsentSummaryV3> {
  const result = emptyConsentSummaryV3(mode);
  const rules = CMP_RULES_V3.map((r) => ({
    cmp: r.cmp,
    accept: [...r.accept],
    reject: [...r.reject],
    settings: [...r.settings],
    secondLayerReject: [...r.secondLayerReject]
  }));

  const inspect = await page.evaluate(
    (arg: {
      rules: { cmp: string; accept: string[]; reject: string[]; settings: string[]; secondLayerReject: string[] }[];
      mode: string;
    }) => {
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!el || !(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };

      const areaOf = (el: HTMLElement | null): number | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return Math.round(r.width * r.height);
      };

      const findFirst = (selectors: string[]): { el: HTMLElement; selector: string } | null => {
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (isVisible(el)) return { el, selector: sel };
          } catch {}
        }
        return null;
      };

      let cmp: string | null = null;
      let acceptMatch: { el: HTMLElement; selector?: string; text?: string } | null = null;
      let rejectMatch: { el: HTMLElement; selector?: string; text?: string } | null = null;
      let settingsMatch: { el: HTMLElement; selector?: string; text?: string } | null = null;
      let matchedRule: (typeof arg.rules)[number] | null = null;

      for (const rule of arg.rules) {
        const a = findFirst(rule.accept);
        const r = findFirst(rule.reject);
        const s = findFirst(rule.settings);
        if (a || r || s) {
          cmp = rule.cmp;
          matchedRule = rule;
          if (a) acceptMatch = a;
          if (r) rejectMatch = r;
          if (s) settingsMatch = s;
          break;
        }
      }

      // Generic fallback across visible buttons inside consent-like containers
      if (!acceptMatch && !rejectMatch) {
        const ACCEPT_RE = /^(accept all|accept cookies|allow all|agree|i agree|got it|accept)$/i;
        const REJECT_RE = /^(reject all|decline all|deny all|refuse all|reject|decline|necessary only|essential only)$/i;
        const SETTINGS_RE = /^(cookie settings|manage preferences|manage cookies|customize|preferences|options|settings)$/i;
        const buttons = Array.from(document.querySelectorAll("button, a[role='button'], input[type='button']")).slice(0, 200);
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim();
          if (!text || text.length > 48) continue;
          const contextText = (btn.closest("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [role='dialog']")?.textContent || "").slice(0, 600);
          if (!contextText || !/cookie|consent|privacy/i.test(contextText)) continue;
          if (!acceptMatch && ACCEPT_RE.test(text)) acceptMatch = { el: btn, text };
          else if (!rejectMatch && REJECT_RE.test(text)) rejectMatch = { el: btn, text };
          else if (!settingsMatch && SETTINGS_RE.test(text)) settingsMatch = { el: btn, text };
        }
      }

      const detected = Boolean(acceptMatch || rejectMatch || settingsMatch);
      const bodyOverflowHidden = window.getComputedStyle(document.body || document.documentElement).overflow === "hidden";
      const cookieWallDetected = detected && bodyOverflowHidden;

      // Count any visible pre-checked non-essential checkboxes in the banner
      let preTickedNonEssentialCount = 0;
      if (detected) {
        const checks = Array.from(document.querySelectorAll("input[type='checkbox']:checked")).slice(0, 40);
        for (const cb of checks) {
          if (!(cb instanceof HTMLInputElement) || cb.disabled) continue;
          const label = (cb.closest("label")?.textContent || cb.getAttribute("aria-label") || "").toLowerCase();
          if (/analytics|marketing|advertising|targeting|personalization|performance/.test(label)) {
            preTickedNonEssentialCount += 1;
          }
        }
      }

      let clicked = false;
      let layer: 1 | 2 | null = null;
      let selector: string | undefined;
      let matchedText: string | undefined;
      let needsSecondLayer = false;

      if (arg.mode === "accept-all" && acceptMatch) {
        acceptMatch.el.click();
        clicked = true;
        layer = 1;
        selector = acceptMatch.selector;
        matchedText = acceptMatch.text;
      } else if (arg.mode === "reject-all") {
        if (rejectMatch) {
          rejectMatch.el.click();
          clicked = true;
          layer = 1;
          selector = rejectMatch.selector;
          matchedText = rejectMatch.text;
        } else if (settingsMatch) {
          settingsMatch.el.click();
          needsSecondLayer = true;
        }
      }

      const metrics: BannerInspectionMetricsV3 = {
        detected,
        cmp,
        hasFirstLayerAccept: Boolean(acceptMatch),
        hasFirstLayerReject: Boolean(rejectMatch),
        hasSettingsEntry: Boolean(settingsMatch),
        acceptAreaPx: areaOf(acceptMatch?.el ?? null),
        rejectAreaPx: areaOf(rejectMatch?.el ?? null),
        cookieWallDetected,
        preTickedNonEssentialCount
      };

      return {
        metrics,
        clicked,
        layer,
        selector,
        matchedText,
        needsSecondLayer,
        secondLayerSelectors: matchedRule?.secondLayerReject ?? []
      };
    },
    { rules, mode }
  );

  let secondLayerRejectFound = false;
  let finalClicked = inspect.clicked;
  let finalLayer: 1 | 2 | null = inspect.layer;
  let finalSelector = inspect.selector;
  let finalMatchedText = inspect.matchedText;
  if (inspect.needsSecondLayer && mode === "reject-all") {
    await sleep(500);
    const second = await page.evaluate((selectors: string[]) => {
      const isVisible = (el: Element | null): el is HTMLElement => {
        if (!el || !(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 10 && r.height >= 10 && window.getComputedStyle(el).display !== "none";
      };
      let preTicked = 0;
      for (const cb of Array.from(document.querySelectorAll("input[type='checkbox']:checked")).slice(0, 40)) {
        if (!(cb instanceof HTMLInputElement) || cb.disabled) continue;
        const label = (cb.closest("label")?.textContent || cb.getAttribute("aria-label") || "").toLowerCase();
        if (/analytics|marketing|advertising|targeting|personalization|performance/.test(label)) {
          preTicked += 1;
        }
      }
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (isVisible(el)) {
            el.click();
            return { clicked: true, selector: sel, matchedText: undefined as string | undefined, preTicked };
          }
        } catch {}
      }
      const REJECT_OR_SAVE = /^(reject all|refuse all|decline all|confirm my choices|save preferences|save settings|save & exit)$/i;
      for (const btn of Array.from(document.querySelectorAll("button")).slice(0, 150)) {
        if (!isVisible(btn)) continue;
        const text = (btn.innerText || "").trim();
        if (REJECT_OR_SAVE.test(text)) {
          btn.click();
          return { clicked: true, selector: undefined as string | undefined, matchedText: text, preTicked };
        }
      }
      return { clicked: false, selector: undefined, matchedText: undefined, preTicked };
    }, inspect.secondLayerSelectors);

    inspect.metrics.preTickedNonEssentialCount += second.preTicked;
    if (second.clicked) {
      secondLayerRejectFound = true;
      finalClicked = true;
      finalLayer = 2;
      finalSelector = second.selector;
      finalMatchedText = second.matchedText;
    }
  }

  result.banner = computeDarkPatternAuditV3(inspect.metrics, { secondLayerRejectFound });
  result.interaction = {
    attempted: mode !== "observe",
    clicked: finalClicked,
    layer: finalLayer,
    ...(finalSelector ? { selector: finalSelector } : {}),
    ...(finalMatchedText ? { matchedText: finalMatchedText } : {})
  };
  return result;
}

async function collectPolicyLinkCandidates(page: Page): Promise<PolicyLinkCandidateV3[]> {
  const out: PolicyLinkCandidateV3[] = [];
  for (const frame of page.frames()) {
    const isIframe = frame !== page.mainFrame();
    try {
      const links = await frame.evaluate(() => {
        const res: { href: string; text: string }[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 400)) {
          const anchor = a as HTMLAnchorElement;
          const text = (anchor.innerText || anchor.getAttribute("aria-label") || "").trim().slice(0, 120);
          if (anchor.href) res.push({ href: anchor.href, text });
        }
        return res;
      });
      for (const l of links) out.push({ ...l, fromIframe: isIframe });
    } catch {
      // Skip inaccessible frame
    }
  }
  return out;
}

async function fetchPolicyTextShared(
  context: BrowserContext,
  url: string,
  sharedCaches?: SharedArmCachesV3
): Promise<{ text: string; language: string | null } | null> {
  const load = async () => {
    const policyPage = await context.newPage();
    try {
      const resp = await policyPage.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (!resp || resp.status() >= 400) return null;
      return await policyPage.evaluate(() => ({
        text: (document.body?.innerText || "").slice(0, 250_000),
        language: document.documentElement?.lang || null
      }));
    } catch {
      return null;
    } finally {
      await policyPage.close().catch(() => {});
    }
  };

  if (!sharedCaches) return load();
  const cached = sharedCaches.policyByUrl.get(url);
  if (cached) return cached;
  const promise = load();
  sharedCaches.policyByUrl.set(url, promise);
  return promise;
}

function wrapSharedCnameResolver(
  resolver: CnameResolverFnV3 | undefined,
  sharedCaches?: SharedArmCachesV3
): CnameResolverFnV3 | undefined {
  if (!sharedCaches) return resolver;
  return async (host: string) => {
    const key = host.toLowerCase();
    const existing = sharedCaches.cnameByHost.get(key);
    if (existing) return existing;
    const { defaultResolveCnameChainV3 } = await import("../probes/cname-probe");
    const promise = (resolver ?? defaultResolveCnameChainV3)(key);
    sharedCaches.cnameByHost.set(key, promise);
    return promise;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
