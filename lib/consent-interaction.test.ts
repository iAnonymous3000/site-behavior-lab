import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  cmpSelectorsForChoice,
  consentChoiceLabel,
  consentClickArgs,
  consentInteractionWarning,
  consentShadowRootCaptureArgs,
  consentVisibilityArgs,
  findAndClickConsentControl,
  findVisibleConsentControl,
  installConsentShadowRootCapture,
  matchesConsentChoice,
  normalizeConsentLabel
} from "./consent-interaction";

const SHADOW_ROOT_CAPABILITY = "c".repeat(64);

test("whole-label matching accepts the known accept/reject phrases", () => {
  assert.equal(matchesConsentChoice("accept-all", "Accept all"), true);
  assert.equal(matchesConsentChoice("accept-all", "  Accept All Cookies  "), true);
  assert.equal(matchesConsentChoice("accept-all", "I agree"), true);
  assert.equal(matchesConsentChoice("reject-all", "Reject all"), true);
  assert.equal(matchesConsentChoice("reject-all", "Decline all cookies"), true);
  assert.equal(matchesConsentChoice("reject-all", "Only necessary cookies"), true);
  assert.equal(matchesConsentChoice("reject-all", "Continue without accepting"), true);
});

test("whole-label matching rejects partial and page-authored phrases", () => {
  // Whole-label only: no phrase embedded in a longer sentence may match, so
  // matchedText can never carry arbitrary page text into the stored report.
  assert.equal(matchesConsentChoice("accept-all", "Accept all the great deals"), false);
  assert.equal(matchesConsentChoice("accept-all", "Learn how we use cookies"), false);
  assert.equal(matchesConsentChoice("reject-all", "Reject all suggestions from the editor"), false);
  assert.equal(matchesConsentChoice("reject-all", "Manage cookie settings"), false);
  // An opposite-choice label never matches.
  assert.equal(matchesConsentChoice("accept-all", "Reject all"), false);
  assert.equal(matchesConsentChoice("reject-all", "Accept all"), false);
});

test("generic matching does not mistake ambiguous preference labels for Accept all", () => {
  assert.equal(matchesConsentChoice("accept-all", "Consent"), false);
  assert.equal(matchesConsentChoice("accept-all", "Agree"), false);
  // Explicit choice phrases remain supported.
  assert.equal(matchesConsentChoice("accept-all", "I agree"), true);
  assert.equal(matchesConsentChoice("accept-all", "Agree and close"), true);
});

test("label normalization collapses whitespace and trailing punctuation", () => {
  assert.equal(normalizeConsentLabel("  Accept\n all!  "), "accept all");
  assert.equal(matchesConsentChoice("accept-all", "Accept all!"), true);
  // Over-long labels never match, whatever they contain.
  assert.equal(matchesConsentChoice("accept-all", `accept all${" ".repeat(10)}${"x".repeat(60)}`), false);
});

test("the CMP selector catalog covers both choices for every platform", () => {
  const acceptSelectors = cmpSelectorsForChoice("accept-all");
  const rejectSelectors = cmpSelectorsForChoice("reject-all");
  const acceptCmps = new Set(acceptSelectors.map((entry) => entry.cmp));
  const rejectCmps = new Set(rejectSelectors.map((entry) => entry.cmp));

  for (const cmp of ["OneTrust", "Cookiebot", "Didomi", "Usercentrics", "Sourcepoint"]) {
    assert.ok(acceptCmps.has(cmp), `missing accept selectors for ${cmp}`);
    assert.ok(rejectCmps.has(cmp), `missing reject selectors for ${cmp}`);
  }
  assert.ok(acceptSelectors.some((entry) => entry.selector === "#onetrust-accept-btn-handler"));
  assert.ok(rejectSelectors.some((entry) => entry.selector === "#onetrust-reject-all-handler"));
});

test("consentClickArgs serializes the regex source for the page function", () => {
  const args = consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY);
  const pattern = new RegExp(args.textPatternSource);
  assert.equal(pattern.test("reject all"), true);
  assert.equal(pattern.test("accept all"), false);
  assert.ok(args.selectors.length > 0);
  assert.ok(args.shadowHosts.includes("#usercentrics-root"));
});

test("generic consent labels require bounded banner context while known CMP selectors remain direct", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    await page.setContent(`<!doctype html><body>
      <button id="standalone-agree">I agree</button>
      <button id="standalone-decline">No thanks</button>
      <script>
        standaloneAgreeClicks = 0;
        standaloneDeclineClicks = 0;
        document.querySelector("#standalone-agree").addEventListener("click", () => standaloneAgreeClicks += 1);
        document.querySelector("#standalone-decline").addEventListener("click", () => standaloneDeclineClicks += 1);
      </script>
    </body>`);

    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        agree: Reflect.get(window, "standaloneAgreeClicks"),
        decline: Reflect.get(window, "standaloneDeclineClicks")
      })),
      { agree: 0, decline: 0 }
    );

    // A localized privacy-policy link is common in unrelated newsletter and
    // terms dialogs; a bare privacy word is not banner context.
    await page.setContent(`<!doctype html><body>
      <section role="dialog" aria-label="Newsletter">
        <p>Suscríbete para recibir novedades. Consulta nuestra política de privacidad.</p>
        <button>I agree</button>
        <button>No thanks</button>
      </section>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );

    await page.setContent(`<!doctype html><body>
      <section role="dialog" aria-label="Cookie preferences">
        <p>We use cookies and similar tracking technologies.</p>
        <button id="generic-agree">I agree</button>
        <button id="generic-decline">No thanks</button>
      </section>
      <script>
        genericAgreeClicks = 0;
        genericDeclineClicks = 0;
        document.querySelector("#generic-agree").addEventListener("click", () => genericAgreeClicks += 1);
        document.querySelector("#generic-decline").addEventListener("click", () => genericDeclineClicks += 1);
      </script>
    </body>`);

    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "i agree" }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "no thanks" }
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        agree: Reflect.get(window, "genericAgreeClicks"),
        decline: Reflect.get(window, "genericDeclineClicks")
      })),
      { agree: 1, decline: 1 }
    );

    // Localized context still works when it describes privacy choices rather
    // than merely linking to a privacy policy.
    await page.setContent(`<!doctype html><body>
      <section role="dialog">
        <p>Preferencias de privacidad</p>
        <button>Rechazar todo</button>
      </section>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "rechazar todo" }
    );

    // Stable CMP controls remain the first tier and do not need generic text
    // or a surrounding context marker.
    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler">Continue</button>
      <script>
        knownCmpClicks = 0;
        document.querySelector("#onetrust-accept-btn-handler").addEventListener("click", () => knownCmpClicks += 1);
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "knownCmpClicks")), 1);

    // A generic exact-label control inside a catalogued shadow host inherits
    // that already-bounded CMP context even when the root has no extra copy.
    await page.setContent(`<!doctype html><body>
      <div id="cmpwrapper"></div>
      <script>
        const root = document.querySelector("#cmpwrapper").attachShadow({ mode: "open" });
        const accept = document.createElement("button");
        accept.textContent = "Accept all";
        root.append(accept);
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "accept all" }
    );
  } finally {
    await browser.close();
  }
});

test("the browser probes reach closed known CMP roots while leaving unrelated roots closed", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(
      installConsentShadowRootCapture,
      consentShadowRootCaptureArgs(SHADOW_ROOT_CAPABILITY)
    );
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent(`<!doctype html><body>
      <script>
        const pageNativeWeakMapGet = WeakMap.prototype.get;
        const pageNativeWeakMapSet = WeakMap.prototype.set;
        window.pageWeakMapGets = 0;
        window.pageWeakMapSets = 0;
        window.pageLeakedClosedRoot = false;
        WeakMap.prototype.get = function(key) {
          window.pageWeakMapGets += 1;
          const value = Reflect.apply(pageNativeWeakMapGet, this, [key]);
          if (value instanceof ShadowRoot) window.pageLeakedClosedRoot = true;
          return value;
        };
        WeakMap.prototype.set = function(key, value) {
          window.pageWeakMapSets += 1;
          if (value instanceof ShadowRoot) window.pageLeakedClosedRoot = true;
          return Reflect.apply(pageNativeWeakMapSet, this, [key, value]);
        };

        const knownHost = document.createElement("div");
        let closedModeReads = 0;
        const knownRoot = knownHost.attachShadow({
          get mode() {
            closedModeReads += 1;
            return "closed";
          }
        });
        window.closedModeReads = closedModeReads;
        knownHost.id = "usercentrics-root";
        const accept = document.createElement("button");
        accept.dataset.testid = "uc-accept-all-button";
        accept.textContent = "Accept all";
        accept.disabled = true;
        window.enableKnownAccept = () => { accept.disabled = false; };
        accept.addEventListener("click", () => {
          window.knownAcceptClicks = (window.knownAcceptClicks || 0) + 1;
          accept.remove();
        });
        knownRoot.append(accept);
        document.body.append(knownHost);

        const unrelatedHost = document.createElement("div");
        const unrelatedRoot = unrelatedHost.attachShadow({ mode: "closed" });
        unrelatedHost.id = "unrelated-root";
        const unrelatedAccept = document.createElement("button");
        unrelatedAccept.textContent = "Accept all";
        unrelatedAccept.addEventListener("click", () => {
          window.unrelatedClicks = (window.unrelatedClicks || 0) + 1;
        });
        unrelatedRoot.append(unrelatedAccept);
        document.body.append(unrelatedHost);
      </script>
    </body>`);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(
      await page.evaluate(() => ({
        modeReads: Reflect.get(window, "closedModeReads"),
        weakMapGets: Reflect.get(window, "pageWeakMapGets"),
        weakMapSets: Reflect.get(window, "pageWeakMapSets"),
        leaked: Reflect.get(window, "pageLeakedClosedRoot")
      })),
      { modeReads: 1, weakMapGets: 0, weakMapSets: 0, leaked: false },
      "page-patched intrinsics must not observe the private registry or duplicate the mode getter"
    );
    assert.equal(await page.locator("#usercentrics-root").count(), 1);
    assert.equal(
      await page.evaluate(() => document.querySelector("#usercentrics-root")?.shadowRoot === null),
      true,
      "capture must not convert a closed root to open"
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const host = document.querySelector("#usercentrics-root");
        const registry = Object.getOwnPropertySymbols(globalThis)
          .map((symbol) => Reflect.get(globalThis, symbol) as unknown)
          .find(
            (value): value is { rootFor: (...args: unknown[]) => unknown } =>
              typeof value === "object" &&
              value !== null &&
              typeof Reflect.get(value, "rootFor") === "function"
          );
        if (!host || !registry) return { found: false, withoutCapability: false, wrongCapability: false };
        return {
          found: true,
          withoutCapability: Reflect.apply(registry.rootFor, registry, [host]) instanceof ShadowRoot,
          wrongCapability:
            Reflect.apply(registry.rootFor, registry, [host, "0".repeat(64)]) instanceof ShadowRoot
        };
      }),
      { found: true, withoutCapability: false, wrongCapability: false },
      "page-authored code must not recover a captured closed root"
    );
    assert.equal(
      await page.evaluate(
        findVisibleConsentControl,
        consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)
      ),
      true
    );
    assert.deepEqual(await page.evaluate(
      findAndClickConsentControl,
      consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)
    ), {
      clicked: false
    });
    assert.equal(await page.evaluate(() => Reflect.get(window, "knownAcceptClicks") ?? 0), 0);
    await page.evaluate(() => (Reflect.get(window, "enableKnownAccept") as () => void)());
    assert.deepEqual(await page.evaluate(
      findAndClickConsentControl,
      consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)
    ), {
      clicked: true,
      cmp: "Usercentrics",
      selector: "[data-testid=uc-accept-all-button]"
    });
    assert.equal(await page.evaluate(() => Reflect.get(window, "knownAcceptClicks")), 1);
    assert.deepEqual(
      await page.evaluate(() => ({
        weakMapGets: Reflect.get(window, "pageWeakMapGets"),
        weakMapSets: Reflect.get(window, "pageWeakMapSets"),
        leaked: Reflect.get(window, "pageLeakedClosedRoot")
      })),
      { weakMapGets: 0, weakMapSets: 0, leaked: false }
    );

    // Once the known control is gone, the same label in an unrelated closed
    // root is neither reported nor clicked.
    assert.equal(
      await page.evaluate(
        findVisibleConsentControl,
        consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)
      ),
      false
    );
    assert.deepEqual(await page.evaluate(
      findAndClickConsentControl,
      consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)
    ), {
      clicked: false
    });
    assert.equal(await page.evaluate(() => Reflect.get(window, "unrelatedClicks") ?? 0), 0);

    // Existing open-shadow behavior remains intact.
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "cmpwrapper";
      const root = host.attachShadow({ mode: "open" });
      const reject = document.createElement("button");
      reject.dataset.testid = "uc-deny-all-button";
      reject.textContent = "Reject all";
      reject.addEventListener("click", () => {
        Reflect.set(window, "openRejectClicks", (Reflect.get(window, "openRejectClicks") ?? 0) + 1);
      });
      root.append(reject);
      document.body.append(host);
    });
    assert.equal(
      await page.evaluate(
        findVisibleConsentControl,
        consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)
      ),
      true
    );
    assert.deepEqual(await page.evaluate(
      findAndClickConsentControl,
      consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)
    ), {
      clicked: true,
      cmp: "Usercentrics",
      selector: "[data-testid=uc-deny-all-button]"
    });
    assert.equal(await page.evaluate(() => Reflect.get(window, "openRejectClicks")), 1);
  } finally {
    await browser.close();
  }
});

test("interaction warnings disclose the click or the honest failure", () => {
  assert.equal(consentChoiceLabel("accept-all"), "Accept all");
  assert.equal(consentChoiceLabel("reject-all"), "Reject all");

  const clicked = consentInteractionWarning({ mode: "reject-all", clicked: true, cmp: "OneTrust" });
  assert.match(clicked, /clicked "Reject all" on the OneTrust banner/);
  // The click is dispatched, never verified as registered, and recording spans
  // the whole visit; the disclosure must not claim a post-choice state.
  assert.match(clicked, /dispatched, not verified/);
  assert.match(clicked, /before and after the click/);
  assert.doesNotMatch(clicked, /post-choice state/);

  const textClicked = consentInteractionWarning({ mode: "accept-all", clicked: true, matchedText: "accept all" });
  assert.match(textClicked, /a control labeled "accept all"/);

  const failed = consentInteractionWarning({ mode: "reject-all", clicked: false });
  assert.match(failed, /no recognizable control was found/);
  assert.match(failed, /pre-consent state/);
});
