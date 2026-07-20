import type { ConsentObservedState } from "./scan-report-v2";

/**
 * Kernel step 3: read the site's REGISTERED consent state after a dispatched
 * banner click (RFC 15.4). The interpreters here map raw CMP state into the
 * closed `ConsentObservedState` vocabulary before anything leaves the read;
 * raw CMP payloads are never retained. Method identifiers are the r2
 * evaluator's closed set (`tcf-api@3`, `onetrust-cookie@1`); readers retain
 * `tcf-api@1` and `tcf-api@2` only for historical validation. Nothing in this
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

export const TCF_API_METHOD = "tcf-api@3";
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

export type TcfApiReadOutcome =
  | {
      status: "read";
      gdprApplies: boolean | null;
      eventStatus: string | null;
      /** Purpose id -> consent flag, ids "1".."11" only; never the raw TCData. */
      purposeConsents: Record<string, boolean>;
      /** Purpose id -> legitimate-interest flag, ids "1".."11" only. */
      purposeLegitimateInterests: Record<string, boolean>;
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
export function readTcfApiState(timeoutMs: number): Promise<TcfApiReadOutcome> {
  type TcfPage = Window & {
    __tcfapi?: (command: string, version: number, callback: (data: unknown, success: boolean) => void) => void;
  };
  const api = (window as TcfPage).__tcfapi;
  if (typeof api !== "function") {
    return Promise.resolve({ status: "unavailable" as const });
  }

  return new Promise<TcfApiReadOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: TcfApiReadOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    try {
      api("getTCData", 2, (data: unknown, success: boolean) => {
        if (!success || data === null || typeof data !== "object") {
          finish({ status: "error" });
          return;
        }
        const record = data as {
          gdprApplies?: unknown;
          eventStatus?: unknown;
          purpose?: { consents?: unknown; legitimateInterests?: unknown };
        };
        const consents: Record<string, boolean> = {};
        const legitimateInterests: Record<string, boolean> = {};
        const rawConsents = record.purpose?.consents;
        const rawLegitimateInterests = record.purpose?.legitimateInterests;
        if (rawConsents !== null && typeof rawConsents === "object") {
          for (const id of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]) {
            const value = (rawConsents as Record<string, unknown>)[id];
            if (typeof value === "boolean") consents[id] = value;
          }
        }
        if (rawLegitimateInterests !== null && typeof rawLegitimateInterests === "object") {
          for (const id of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]) {
            const value = (rawLegitimateInterests as Record<string, unknown>)[id];
            if (typeof value === "boolean") legitimateInterests[id] = value;
          }
        }
        finish({
          status: "read",
          gdprApplies: typeof record.gdprApplies === "boolean" ? record.gdprApplies : null,
          eventStatus: typeof record.eventStatus === "string" ? record.eventStatus : null,
          purposeConsents: consents,
          purposeLegitimateInterests: legitimateInterests
        });
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
 * A purpose remains enabled when either consent was granted or legitimate
 * interest was established without an objection. Every purpose enabled is an
 * unambiguous accept registration; every purpose disabled under both legal
 * bases is an unambiguous reject registration. Any other complete pair is
 * `partial`: in particular, a reject click that leaves legitimate interests
 * enabled must remain detectable as a contradiction rather than being mistaken
 * for rejection. Single-purpose state stays `unknown` because acceptance and
 * necessity are indistinguishable there.
 */
export function tcfObservedState(read: Extract<TcfApiReadOutcome, { status: "read" }>): ConsentObservedState {
  if (read.gdprApplies !== true) return "unknown";
  if (read.eventStatus === null || !TCF_SETTLED_EVENT_STATUSES.has(read.eventStatus)) return "unknown";
  const consentIds = Object.keys(read.purposeConsents).sort();
  const legitimateInterestIds = Object.keys(read.purposeLegitimateInterests).sort();
  if (consentIds.length < 2 || consentIds.length !== legitimateInterestIds.length) return "unknown";
  if (consentIds.some((id, index) => id !== legitimateInterestIds[index])) return "unknown";

  const enabledPurposes = consentIds.map(
    (id) => read.purposeConsents[id] || read.purposeLegitimateInterests[id]
  );
  if (enabledPurposes.every(Boolean)) return "accepted-all";
  if (enabledPurposes.every((flag) => !flag)) return "rejected-all";
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
  for (const entry of groupsParam.slice("groups=".length).split(",")) {
    const parts = entry.split(":");
    if (parts.length !== 2 || parts[0].trim() === "" || (parts[1] !== "0" && parts[1] !== "1")) {
      return { parsed: false };
    }
    flags.push(parts[1] === "1");
  }
  if (flags.length < 2) return { parsed: true, observed: "unknown" };

  const granted = flags.filter((flag) => flag).length;
  if (granted === flags.length) return { parsed: true, observed: "accepted-all" };
  if (granted <= 1) return { parsed: true, observed: "rejected-all" };
  return { parsed: true, observed: "unknown" };
}
