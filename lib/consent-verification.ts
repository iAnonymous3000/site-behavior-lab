import type { ConsentObservedState } from "./scan-report-v2";

/**
 * Kernel step 3: read the site's REGISTERED consent state after a dispatched
 * banner click (RFC 15.4). The interpreters here map raw CMP state into the
 * closed `ConsentObservedState` vocabulary before anything leaves the read;
 * raw CMP payloads are never retained. Method identifiers are the r2
 * evaluator's closed set (`tcf-api@4`, `onetrust-cookie@1`); readers retain
 * `tcf-api@1` through `tcf-api@3` only for historical validation. Nothing in this
 * module touches the frozen v1 wire.
 *
 * Every mapping errs toward "unknown" (which derives a null consistency and
 * therefore neither verifies nor contradicts the click) whenever the state's
 * meaning depends on site-specific configuration this scanner cannot know.
 */

export const CONSENT_VERIFICATION_ENV = "SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION";

export function consentVerificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONSENT_VERIFICATION_ENV] === "1";
}

export const TCF_API_METHOD = "tcf-api@4";
export const ONETRUST_COOKIE_METHOD = "onetrust-cookie@1";
export const ONETRUST_CONSENT_COOKIE = "OptanonConsent";

/**
 * v1 disclosure for the flag-gated post-choice reload. Shared with the public
 * warning boundary (lib/redact-scan-report-v1.ts) so the emitted sentence and
 * the admitted vocabulary cannot drift apart.
 *
 * "During that reload's measurement phase", not "from that reload": exclusion
 * is by phase (lib/scanner.ts recordRequest), so a straggler request the
 * reloaded document fires after the next phase begins is still recorded, and
 * the sentence must not claim otherwise.
 */
export const CONSENT_RELOAD_DISCLOSURE =
  "After the consent click, the scanner attempted one page reload to read the site's registered consent state; requests observed during that reload's measurement phase are not part of the recorded request log or counts.";

/** In-page read budget: __tcfapi answers in microtasks when present. */
export const TCF_READ_TIMEOUT_MS = 1_500;

export type TcfEventStatus = "useractioncomplete" | "tcloaded" | "cmpuishown";

export type TcfApiReadOutcome =
  | {
      status: "read";
      gdprApplies: boolean | null;
      eventStatus: TcfEventStatus | null;
      /** Purpose id -> consent flag, ids "1".."11" only; never the raw TCData. */
      purposeConsents: Record<string, boolean>;
      /** Purpose id -> legitimate-interest flag, ids "1".."11" only. */
      purposeLegitimateInterests: Record<string, boolean>;
      /**
       * Non-identifying summary of publisher.restrictions. Applying a present
       * restriction requires vendor/GVL facts this bounded mapper does not read.
       */
      publisherRestrictions: "none" | "present" | "unknown";
    }
  | { status: "unavailable" }
  | { status: "timeout" }
  | { status: "error" };

/**
 * Runs INSIDE the page (via frame.evaluate): calls `__tcfapi("getTCData", 2)`
 * with a local timeout and projects ONLY the fields the mapper needs. The TC
 * string, vendor lists, and every other raw field stay in the page.
 * Self-contained: no closure over module scope, so it serializes cleanly.
 */
export async function readTcfApiState(timeoutMs: number): Promise<TcfApiReadOutcome> {
  type TcfPage = Window & {
    __tcfapi?: (command: string, version: number, callback: (data: unknown, success: boolean) => void) => void;
  };
  type TrustedConsentRuntime = {
    makePromise<T>(executor: (resolve: (value: T) => void) => void): Promise<T>;
    setTimer(callback: () => void, delayMs: number): unknown;
    clearTimer(handle: unknown): void;
    hasOwn(value: object, key: string): boolean;
    ownValue(value: object, key: string): unknown;
    isArray(value: unknown): boolean;
  };
  const api = (window as TcfPage).__tcfapi;
  if (typeof api !== "function") {
    return { status: "unavailable" as const };
  }
  // Installed before page scripts by installConsentShadowRootCapture. A fixed,
  // non-configurable data property lets this serialized reader avoid ambient
  // Promise/timer/object intrinsics that the measured page can replace.
  const runtime = (window as unknown as Record<string, unknown>).__siteBehaviorLabConsentRuntimeV1 as
    | TrustedConsentRuntime
    | undefined;
  if (
    typeof runtime?.makePromise !== "function" ||
    typeof runtime.setTimer !== "function" ||
    typeof runtime.clearTimer !== "function" ||
    typeof runtime.hasOwn !== "function" ||
    typeof runtime.ownValue !== "function" ||
    typeof runtime.isArray !== "function"
  ) return { status: "error" };

  return runtime.makePromise<TcfApiReadOutcome>((resolve) => {
    let settled = false;
    let timer: unknown;
    const finish = (outcome: TcfApiReadOutcome) => {
      if (settled) return;
      settled = true;
      // Resolve even if cleanup encounters an unexpected browser failure. The
      // runtime uses a private Scheduler task, not a page-cancellable timer id.
      try {
        runtime.clearTimer(timer);
      } finally {
        resolve(outcome);
      }
    };

    try {
      timer = runtime.setTimer(() => finish({ status: "timeout" }), timeoutMs);
      api("getTCData", 2, (data: unknown, success: boolean) => {
        try {
          if (!success || data === null || typeof data !== "object" || runtime.isArray(data)) {
            finish({ status: "error" });
            return;
          }
          const record = data;
          const consents: Record<string, boolean> = {};
          const legitimateInterests: Record<string, boolean> = {};
          const purpose = runtime.ownValue(record, "purpose");
          const rawConsents = purpose !== null && typeof purpose === "object"
            ? runtime.ownValue(purpose, "consents")
            : undefined;
          const rawLegitimateInterests = purpose !== null && typeof purpose === "object"
            ? runtime.ownValue(purpose, "legitimateInterests")
            : undefined;
          const purposeIds = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
          if (rawConsents !== null && typeof rawConsents === "object" && !runtime.isArray(rawConsents)) {
            for (let index = 0; index < purposeIds.length; index += 1) {
              const id = purposeIds[index];
              const value = runtime.ownValue(rawConsents, id);
              if (typeof value === "boolean") consents[id] = value;
            }
          }
          if (
            rawLegitimateInterests !== null &&
            typeof rawLegitimateInterests === "object" &&
            !runtime.isArray(rawLegitimateInterests)
          ) {
            for (let index = 0; index < purposeIds.length; index += 1) {
              const id = purposeIds[index];
              const value = runtime.ownValue(rawLegitimateInterests, id);
              if (typeof value === "boolean") legitimateInterests[id] = value;
            }
          }
          let publisherRestrictions: "none" | "present" | "unknown" = "none";
          const hasPublisher = runtime.hasOwn(record, "publisher");
          const publisher = runtime.ownValue(record, "publisher");
          if (
            hasPublisher &&
            (publisher === undefined || publisher === null || typeof publisher !== "object" || runtime.isArray(publisher))
          ) {
            publisherRestrictions = "unknown";
          } else if (publisher !== null && typeof publisher === "object") {
            const hasRestrictions = runtime.hasOwn(publisher, "restrictions");
            const rawRestrictions = runtime.ownValue(publisher, "restrictions");
            if (
              hasRestrictions &&
              (rawRestrictions === undefined || rawRestrictions === null || typeof rawRestrictions !== "object" || runtime.isArray(rawRestrictions))
            ) {
              publisherRestrictions = "unknown";
            } else if (hasRestrictions && rawRestrictions !== null && typeof rawRestrictions === "object") {
              // Probe only the eleven TCF purpose ids through pristine own-data
              // descriptors. Vendor maps are deliberately not enumerated: any
              // own purpose container is enough to make this purpose-only mapper
              // fail closed, while accessors and malformed containers are unknown.
              for (let purposeIndex = 0; purposeIndex < purposeIds.length; purposeIndex += 1) {
                const purposeId = purposeIds[purposeIndex];
                if (!runtime.hasOwn(rawRestrictions, purposeId)) continue;
                const rawVendors = runtime.ownValue(rawRestrictions, purposeId);
                if (
                  rawVendors === undefined ||
                  rawVendors === null ||
                  typeof rawVendors !== "object" ||
                  runtime.isArray(rawVendors)
                ) {
                  publisherRestrictions = "unknown";
                  break;
                }
                publisherRestrictions = "present";
              }
            }
          }
          const gdprApplies = runtime.ownValue(record, "gdprApplies");
          const rawEventStatus = runtime.ownValue(record, "eventStatus");
          // Project in-page onto the only statuses this interpreter understands.
          // Unknown or attacker-sized strings become null before Playwright
          // serializes the result back to the host.
          const eventStatus: TcfEventStatus | null =
            rawEventStatus === "useractioncomplete" ||
            rawEventStatus === "tcloaded" ||
            rawEventStatus === "cmpuishown"
              ? rawEventStatus
              : null;
          finish({
            status: "read",
            gdprApplies: typeof gdprApplies === "boolean" ? gdprApplies : null,
            eventStatus,
            purposeConsents: consents,
            purposeLegitimateInterests: legitimateInterests,
            publisherRestrictions
          });
        } catch {
          finish({ status: "error" });
        }
      });
    } catch {
      finish({ status: "error" });
    }
  });
}

/**
 * TCF event statuses under which purpose consents reflect a REGISTERED state:
 * "useractioncomplete" right after the click, "tcloaded" when a stored consent
 * string was restored (the post-reload read). "cmpuishown" means the banner is
 * still up and the exposed values may be defaults, so it proves nothing.
 */
const TCF_SETTLED_EVENT_STATUSES = new Set(["useractioncomplete", "tcloaded"]);

/**
 * Map a TCF read to the closed observed-state vocabulary. Classification runs
 * over the purposes the site actually exposes (the keys present), never a
 * fixed purpose list. Both TCF legal-basis vectors must be complete over the
 * same multi-purpose key set; missing or asymmetric state stays `unknown`.
 *
 * A first-layer Reject all may withdraw every consent while leaving separately
 * managed legitimate-interest objections unchanged. That state is ambiguous,
 * not a contradiction. Publisher restrictions are vendor-specific; when any
 * are present (or malformed), this bounded purpose-only read cannot apply them
 * without vendor declarations and the matching GVL, so it also stays unknown.
 * Only an all-bases-disabled vector proves rejection. With no restrictions,
 * every purpose enabled under at least one legal basis proves acceptance and a
 * genuinely mixed enabled vector is partial. Single-purpose state stays
 * `unknown` because acceptance and necessity are indistinguishable there.
 */
export function tcfObservedState(read: Extract<TcfApiReadOutcome, { status: "read" }>): ConsentObservedState {
  if (read.gdprApplies !== true) return "unknown";
  if (read.eventStatus === null || !TCF_SETTLED_EVENT_STATUSES.has(read.eventStatus)) return "unknown";
  const consentIds = Object.keys(read.purposeConsents).sort();
  const legitimateInterestIds = Object.keys(read.purposeLegitimateInterests).sort();
  if (consentIds.length < 2 || consentIds.length !== legitimateInterestIds.length) return "unknown";
  if (consentIds.some((id, index) => id !== legitimateInterestIds[index])) return "unknown";

  const consentFlags = consentIds.map((id) => read.purposeConsents[id]);
  const legitimateInterestFlags = consentIds.map((id) => read.purposeLegitimateInterests[id]);
  if (consentFlags.every((flag) => !flag)) {
    return legitimateInterestFlags.every((flag) => !flag) ? "rejected-all" : "unknown";
  }
  if (read.publisherRestrictions !== "none") return "unknown";

  const enabledPurposes = consentFlags.map((consent, index) => consent || legitimateInterestFlags[index]);
  if (enabledPurposes.every(Boolean)) return "accepted-all";
  return "partial";
}

export type OnetrustParseOutcome =
  | { parsed: true; observed: ConsentObservedState }
  | { parsed: false };

/**
 * Interpret OneTrust's `OptanonConsent` cookie `groups=` parameter
 * ("C0001:1,C0002:0,..."). Group ids are SITE-CONFIGURED, so only the
 * unambiguous extremes classify: every group granted is an accept-all
 * registration; zero or exactly one granted group (the always-active
 * strictly-necessary group) is a reject-all registration. Everything between
 * is "unknown", never "partial": without the site's group semantics, a mixed
 * vector could equally be a reject-all with two always-active groups, and
 * guessing would fabricate a contradiction.
 */
export function onetrustObservedState(cookieValue: string): OnetrustParseOutcome {
  let decoded: string;
  try {
    decoded = decodeURIComponent(cookieValue);
  } catch {
    return { parsed: false };
  }
  const groupsParam = decoded
    .split("&")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("groups="));
  if (!groupsParam) return { parsed: false };

  const flags: boolean[] = [];
  const groupIds = new Set<string>();
  for (const entry of groupsParam.slice("groups=".length).split(",")) {
    const parts = entry.split(":");
    const groupId = parts[0]?.trim() ?? "";
    if (
      parts.length !== 2 ||
      groupId === "" ||
      groupIds.has(groupId) ||
      (parts[1] !== "0" && parts[1] !== "1")
    ) {
      return { parsed: false };
    }
    groupIds.add(groupId);
    flags.push(parts[1] === "1");
  }
  if (flags.length < 2) return { parsed: true, observed: "unknown" };

  const granted = flags.filter((flag) => flag).length;
  if (granted === flags.length) return { parsed: true, observed: "accepted-all" };
  if (granted <= 1) return { parsed: true, observed: "rejected-all" };
  return { parsed: true, observed: "unknown" };
}
