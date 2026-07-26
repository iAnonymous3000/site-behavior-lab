import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  consentShadowRootCaptureArgs,
  installConsentShadowRootCapture
} from "./consent-interaction";
import {
  ONETRUST_CONSENT_COOKIE,
  TCF_API_METHOD,
  applicableOneTrustConsentCookie,
  consentVerificationEnabled,
  onetrustObservedState,
  readTcfApiState,
  tcfObservedState,
  type TcfApiReadOutcome
} from "./consent-verification";
import { deriveObservationConsistency } from "./scan-report-v2-evaluators";

const CONSENT_RUNTIME_KEY = "__siteBehaviorLabConsentRuntimeV1";
const SHADOW_ROOT_CAPABILITY = "c".repeat(64);

function trustedTcfWindow<T extends object>(value: T): T {
  Object.defineProperty(value, CONSENT_RUNTIME_KEY, {
    configurable: false,
    value: {
      makePromise<U>(executor: (resolve: (result: U) => void) => void): Promise<U> {
        return new Promise<U>(executor);
      },
      setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
        return setTimeout(callback, delayMs);
      },
      clearTimer(handle: unknown): void {
        clearTimeout(handle as NodeJS.Timeout);
      },
      hasOwn(input: object, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(input, key);
      },
      ownValue(input: object, key: string): unknown {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
          ? descriptor.value
          : undefined;
      },
      isArray(input: unknown): boolean {
        return Array.isArray(input);
      }
    },
    writable: false
  });
  return value;
}

function tcfRead(overrides: Partial<Extract<TcfApiReadOutcome, { status: "read" }>>): Extract<TcfApiReadOutcome, { status: "read" }> {
  return {
    status: "read",
    gdprApplies: true,
    eventStatus: "useractioncomplete",
    purposeConsents: {},
    purposeLegitimateInterests: {},
    publisherRestrictions: "none",
    ...overrides
  };
}

test("consentVerificationEnabled reads only the exact opt-in value", () => {
  assert.equal(consentVerificationEnabled({}), false);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1" }), true);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "true" }), false);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0" }), false);
});

test("the current TCF interpreter projects both Purpose 11 legal-basis vectors and publisher restrictions", async () => {
  assert.equal(TCF_API_METHOD, "tcf-api@4");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: trustedTcfWindow({
      __tcfapi: (
        _command: string,
        _version: number,
        callback: (data: unknown, success: boolean) => void
      ) => callback({
        gdprApplies: true,
        eventStatus: "useractioncomplete",
        purpose: {
          consents: { "10": true, "11": false, "12": true },
          legitimateInterests: { "10": false, "11": true, "12": false }
        },
        publisher: {
          restrictions: {
            "2": { "12": 0 },
            "7": { "42": 1 },
            "10": { "99": 2 }
          }
        }
      }, true)
    })
  });
  try {
    assert.deepEqual(await readTcfApiState(100), {
      status: "read",
      gdprApplies: true,
      eventStatus: "useractioncomplete",
      purposeConsents: { "10": true, "11": false },
      purposeLegitimateInterests: { "10": false, "11": true },
      publisherRestrictions: "present"
    });
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", previousWindow);
    }
  }
});

test("the TCF reader closes attacker-sized eventStatus text before returning", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: trustedTcfWindow({
      __tcfapi: (
        _command: string,
        _version: number,
        callback: (data: unknown, success: boolean) => void
      ) => callback({
        gdprApplies: true,
        eventStatus: "x".repeat(8 * 1024 * 1024),
        purpose: {
          consents: { "1": true, "2": true },
          legitimateInterests: { "1": false, "2": false }
        }
      }, true)
    })
  });
  try {
    const result = await readTcfApiState(100);
    assert.equal(result.status, "read");
    if (result.status !== "read") throw new Error("expected TCF read outcome");
    assert.equal(result.eventStatus, null);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});

test("the TCF reader distinguishes absent, empty, and malformed publisher restrictions", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const readWith = async (publisher: unknown): Promise<TcfApiReadOutcome> => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: trustedTcfWindow({
        __tcfapi: (
          _command: string,
          _version: number,
          callback: (data: unknown, success: boolean) => void
        ) => callback({
          gdprApplies: true,
          eventStatus: "useractioncomplete",
          purpose: {
            consents: { "1": false, "2": false },
            legitimateInterests: { "1": false, "2": false }
          },
          ...(publisher === undefined ? {} : { publisher })
        }, true)
      })
    });
    return readTcfApiState(100);
  };
  const restrictionsWith = async (publisher: unknown): Promise<"none" | "present" | "unknown"> => {
    const outcome = await readWith(publisher);
    assert.equal(outcome.status, "read");
    if (outcome.status !== "read") throw new Error("expected TCF read outcome");
    return outcome.publisherRestrictions;
  };
  try {
    const accessorPublisher: Record<string, unknown> = {};
    Object.defineProperty(accessorPublisher, "restrictions", {
      enumerable: true,
      get(): never {
        throw new Error("publisher restriction getter must not run");
      }
    });
    assert.equal(await restrictionsWith(undefined), "none");
    assert.equal(await restrictionsWith({ restrictions: {} }), "none");
    assert.equal(await restrictionsWith({ restrictions: { "2": { "12": 3 } } }), "present");
    assert.equal(await restrictionsWith({ restrictions: "not-an-object" }), "unknown");
    assert.equal(await restrictionsWith(accessorPublisher), "unknown");
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", previousWindow);
    }
  }
});

test("the TCF reader uses fixed own-purpose probes without enumerating hostile vendor maps", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const readWithRestrictions = async (restrictions: object): Promise<TcfApiReadOutcome> => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: trustedTcfWindow({
        __tcfapi: (
          _command: string,
          _version: number,
          callback: (data: unknown, success: boolean) => void
        ) => callback({
          gdprApplies: true,
          eventStatus: "useractioncomplete",
          purpose: {
            consents: { "1": false, "2": false },
            legitimateInterests: { "1": false, "2": false }
          },
          publisher: { restrictions }
        }, true)
      })
    });
    return readTcfApiState(100);
  };

  try {
    const tooManyPurposeContainers: Record<string, object> = {};
    for (let purposeId = 1; purposeId <= 11; purposeId += 1) {
      tooManyPurposeContainers[String(purposeId)] = {};
    }
    Object.defineProperty(tooManyPurposeContainers, "12", {
      enumerable: true,
      get(): never {
        throw new Error("the excess purpose value must not be evaluated");
      }
    });
    const purposeOutcome = await readWithRestrictions(tooManyPurposeContainers);
    assert.equal(purposeOutcome.status, "read");
    if (purposeOutcome.status !== "read") throw new Error("expected bounded TCF read outcome");
    assert.equal(purposeOutcome.publisherRestrictions, "present");

    const tooManyVendorRestrictions: Record<string, number> = {};
    for (let vendorId = 1; vendorId <= 4_096; vendorId += 1) {
      tooManyVendorRestrictions[String(vendorId)] = 0;
    }
    Object.defineProperty(tooManyVendorRestrictions, "4097", {
      enumerable: true,
      get(): never {
        throw new Error("the excess vendor restriction must not be evaluated");
      }
    });
    const vendorOutcome = await readWithRestrictions({ "2": tooManyVendorRestrictions });
    assert.equal(vendorOutcome.status, "read");
    if (vendorOutcome.status !== "read") throw new Error("expected bounded TCF read outcome");
    assert.equal(vendorOutcome.publisherRestrictions, "present");

    const inheritedOnly = Object.create({ "2": { "12": 0 } }) as object;
    const inheritedOutcome = await readWithRestrictions(inheritedOnly);
    assert.equal(inheritedOutcome.status, "read");
    if (inheritedOutcome.status !== "read") throw new Error("expected own-only TCF read outcome");
    assert.equal(inheritedOutcome.publisherRestrictions, "none");

    const accessorContainer: Record<string, unknown> = {};
    Object.defineProperty(accessorContainer, "2", {
      enumerable: true,
      get(): never {
        throw new Error("a restriction-container getter must not be evaluated");
      }
    });
    const accessorOutcome = await readWithRestrictions(accessorContainer);
    assert.equal(accessorOutcome.status, "read");
    if (accessorOutcome.status !== "read") throw new Error("expected accessor-safe TCF read outcome");
    assert.equal(accessorOutcome.publisherRestrictions, "unknown");
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", previousWindow);
    }
  }
});

test("the in-page TCF timeout survives hostile page timer overrides", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(
      installConsentShadowRootCapture,
      consentShadowRootCaptureArgs(SHADOW_ROOT_CAPABILITY)
    );
    const page = await context.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.evaluate(() => {
      window.setTimeout = (() => 1) as unknown as typeof window.setTimeout;
      window.clearTimeout = (() => {
        throw new Error("page timer cleanup sabotage");
      }) as typeof window.clearTimeout;
      Reflect.set(window, "__tcfapi", () => undefined);
    });
    const started = Date.now();
    assert.deepEqual(await page.evaluate(readTcfApiState, 100), { status: "timeout" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 75 && elapsed < 1_500);

    await page.evaluate(() => {
      Reflect.set(window, "__tcfapi", (
        _command: string,
        _version: number,
        callback: (data: unknown, success: boolean) => void
      ) => callback({
        gdprApplies: true,
        eventStatus: "useractioncomplete",
        purpose: {
          consents: { "1": true, "2": true },
          legitimateInterests: { "1": false, "2": false }
        },
        publisher: { restrictions: {} }
      }, true));
    });
    const read = await page.evaluate(readTcfApiState, 100);
    assert.equal(read.status, "read");
    if (read.status !== "read") throw new Error("expected a trusted-timer TCF read");
    assert.equal(read.publisherRestrictions, "none");
  } finally {
    await browser.close();
  }
});

test("tcfObservedState only classifies settled registrations", () => {
  // Outside the GDPR regime or before the CMP settles, nothing is provable.
  const allGranted = {
    purposeConsents: { "1": true, "2": true },
    purposeLegitimateInterests: { "1": false, "2": false }
  };
  assert.equal(tcfObservedState(tcfRead({ gdprApplies: false, ...allGranted })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ gdprApplies: null, ...allGranted })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ eventStatus: "cmpuishown", ...allGranted })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ eventStatus: null })), "unknown");

  // Settled, complete states classify over the purposes the site exposes.
  assert.equal(tcfObservedState(tcfRead(allGranted)), "accepted-all");
  assert.equal(
    tcfObservedState(tcfRead({
      eventStatus: "tcloaded",
      purposeConsents: { "1": false, "2": false },
      purposeLegitimateInterests: { "1": false, "2": false }
    })),
    "rejected-all"
  );

  // A single granted purpose cannot distinguish acceptance from necessity.
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": true },
    purposeLegitimateInterests: { "1": false }
  })), "unknown");

  // Empty or incomplete vectors cannot prove either choice.
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: {} })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: { "1": true, "2": true } })), "unknown");
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": false, "2": false },
    purposeLegitimateInterests: { "1": false }
  })), "unknown");
});

test("tcfObservedState classifies mixed enabled state but never contradicts lawful retained LI", () => {
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": true, "2": false },
    purposeLegitimateInterests: { "1": false, "2": false }
  })), "partial");
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": true, "2": true, "3": false },
    purposeLegitimateInterests: { "1": false, "2": false, "3": true }
  })), "accepted-all");
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": false, "2": false },
    purposeLegitimateInterests: { "1": true, "2": false }
  })), "unknown");
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": false, "2": false },
    purposeLegitimateInterests: { "1": true, "2": true }
  })), "unknown");

  // Reject all commonly withdraws consent while leaving the separate LI
  // objection controls untouched (Purposes 2/7/8/9/10). That is ambiguous,
  // never affirmative evidence that the site contradicted the click.
  const lawfulReject = tcfObservedState(tcfRead({
    purposeConsents: {
      "1": false, "2": false, "3": false, "4": false, "5": false,
      "6": false, "7": false, "8": false, "9": false, "10": false
    },
    purposeLegitimateInterests: {
      "1": false, "2": true, "3": false, "4": false, "5": false,
      "6": false, "7": true, "8": true, "9": true, "10": true
    }
  }));
  assert.equal(lawfulReject, "unknown");
  assert.equal(deriveObservationConsistency("reject-all", lawfulReject), null);
});

test("tcfObservedState fails closed when publisher restrictions need vendor/GVL interpretation", () => {
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": true, "2": true },
    purposeLegitimateInterests: { "1": false, "2": false },
    publisherRestrictions: "present"
  })), "unknown");
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": true, "2": false },
    purposeLegitimateInterests: { "1": false, "2": false },
    publisherRestrictions: "unknown"
  })), "unknown");
  // Restrictions cannot create processing when both legal-basis vectors are
  // unanimously off; this remains the one unambiguous reject registration.
  assert.equal(tcfObservedState(tcfRead({
    purposeConsents: { "1": false, "2": false },
    purposeLegitimateInterests: { "1": false, "2": false },
    publisherRestrictions: "present"
  })), "rejected-all");
});

test("onetrustObservedState classifies only the unambiguous extremes", () => {
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:1,C0003:1"), { parsed: true, observed: "accepted-all" });
  // The single granted group is the always-active strictly-necessary one.
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:0,C0003:0"), { parsed: true, observed: "rejected-all" });
  assert.deepEqual(onetrustObservedState("groups=C0001:0,C0002:0"), { parsed: true, observed: "rejected-all" });
  // Two granted among three could be a reject with two always-active groups;
  // never guess "partial" from site-configured group ids.
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:1,C0003:0"), { parsed: true, observed: "unknown" });
  // A single group cannot distinguish accept from reject.
  assert.deepEqual(onetrustObservedState("groups=C0001:1"), { parsed: true, observed: "unknown" });
  // URL-encoded cookie values decode before parsing.
  assert.deepEqual(onetrustObservedState("groups%3DC0001%3A1%2CC0002%3A0"), { parsed: true, observed: "rejected-all" });
  // Surrounding OneTrust bookkeeping parameters are ignored.
  assert.deepEqual(
    onetrustObservedState("isGpcEnabled=0&datestamp=xyz&groups=C0001:1,C0002:0&geolocation=US"),
    { parsed: true, observed: "rejected-all" }
  );
});

test("onetrustObservedState refuses unparseable state instead of guessing", () => {
  assert.deepEqual(onetrustObservedState("datestamp=xyz&geolocation=US"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001:2"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=:1"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0001:1"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0001:0"), { parsed: false });
  assert.deepEqual(onetrustObservedState("%E0%A4%A"), { parsed: false });
});

test("a OneTrust cookie speaks for the page only when exactly one applies to it", () => {
  // The caller passes cookies the browser already scoped to the current URL,
  // so these cases are about ownership and ambiguity, not path matching.
  const thirdParty = (hostname: string, candidate: string) =>
    hostname.split(".").slice(-2).join(".") !== candidate.split(".").slice(-2).join(".");
  const cookie = (value: string, domain: string) => ({ name: ONETRUST_CONSENT_COOKIE, value, domain });

  assert.equal(
    applicableOneTrustConsentCookie([cookie("groups=C0001:1", "shop.example.com")], "shop.example.com", thirdParty),
    "groups=C0001:1"
  );
  // A leading dot is the domain-cookie spelling of the same site.
  assert.equal(
    applicableOneTrustConsentCookie([cookie("groups=C0001:1", ".example.com")], "shop.example.com", thirdParty),
    "groups=C0001:1"
  );

  // An embedded vendor's own registration is not the site's.
  assert.equal(
    applicableOneTrustConsentCookie([cookie("groups=C0004:1", "cmp.vendor-cmp.test")], "shop.example.com", thirdParty),
    null
  );
  // Nothing to read is not a registration either.
  assert.equal(applicableOneTrustConsentCookie([], "shop.example.com", thirdParty), null);
  assert.equal(
    applicableOneTrustConsentCookie([{ name: "other", value: "x", domain: "shop.example.com" }], "shop.example.com", thirdParty),
    null
  );

  // Both of these are sent on the same request and their order is not a
  // contract: answering with either would state a registration the site may
  // not hold, so ambiguity must read as no answer.
  assert.equal(
    applicableOneTrustConsentCookie(
      [cookie("groups=C0004:0", "shop.example.com"), cookie("groups=C0004:1", ".example.com")],
      "shop.example.com",
      thirdParty
    ),
    null
  );
});
