import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
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

async function newConsentPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(
    installConsentShadowRootCapture,
    consentShadowRootCaptureArgs(SHADOW_ROOT_CAPABILITY)
  );
  return context.newPage();
}

test("whole-label matching accepts the known accept/reject phrases", () => {
  assert.equal(matchesConsentChoice("accept-all", "Accept all"), true);
  assert.equal(matchesConsentChoice("accept-all", "  Accept All Cookies  "), true);
  assert.equal(matchesConsentChoice("accept-all", "I agree"), true);
  assert.equal(matchesConsentChoice("accept-all", "Tout accepter"), true);
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
    const page = await newConsentPage(browser);

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
        document.querySelector("#generic-agree").addEventListener("click", (event) => {
          genericAgreeClicks += 1;
          event.currentTarget.disabled = true;
        });
        document.querySelector("#generic-decline").addEventListener("click", (event) => {
          genericDeclineClicks += 1;
          event.currentTarget.disabled = true;
        });
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
        <button id="localized-reject">Rechazar todo</button>
      </section>
      <script>
        document.querySelector("#localized-reject").addEventListener("click", (event) => {
          event.currentTarget.disabled = true;
        });
      </script>
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
        document.querySelector("#onetrust-accept-btn-handler").addEventListener("click", (event) => {
          knownCmpClicks += 1;
          event.currentTarget.disabled = true;
        });
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
        accept.addEventListener("click", () => accept.remove());
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

test("browser probes reject hidden and no-op decoys and continue to a genuine reacting control", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newConsentPage(browser);

    await page.setContent(`<!doctype html><body>
      <div style="opacity: 0">
        <button id="onetrust-accept-btn-handler">Accept all</button>
        <button id="onetrust-reject-all-handler">Reject all</button>
      </div>
      <script>
        hiddenClicks = 0;
        document.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", () => hiddenClicks += 1);
        });
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false,
      "an opaque control is not visible merely because its own opacity is nonzero"
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "hiddenClicks")), 0);

    await page.setContent(`<!doctype html><body>
      <div id="usercentrics-root" style="opacity: 0"></div>
      <script>
        const root = document.querySelector("#usercentrics-root").attachShadow({ mode: "open" });
        const button = document.createElement("button");
        button.dataset.testid = "uc-accept-all-button";
        button.textContent = "Accept all";
        button.addEventListener("click", () => window.shadowHiddenClicks = (window.shadowHiddenClicks || 0) + 1);
        root.append(button);
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false,
      "the visibility walk crosses a shadow boundary to the hidden host"
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "shadowHiddenClicks") ?? 0), 0);

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler" style="filter: opacity(.01); width: 120px; height: 30px">
        Accept all
      </button>
      <div style="position: relative; width: 1px; height: 1px; overflow: hidden">
        <button id="onetrust-reject-all-handler" style="position: absolute; left: 20px; top: 20px; width: 120px; height: 30px">
          Reject all
        </button>
      </div>
      <script>
        hiddenCssClicks = 0;
        document.querySelectorAll("button").forEach((button) => {
          button.addEventListener("click", (event) => {
            hiddenCssClicks += 1;
            event.currentTarget.disabled = true;
          });
        });
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false,
      "filter-hidden and fully ancestor-clipped decoys are not visible"
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "hiddenCssClicks")), 0);

    await page.setContent(`<!doctype html><body>
      <div style="opacity: .1">
        <div style="filter: opacity(.1)">
          <button id="onetrust-reject-all-handler" style="width: 120px; height: 30px">Reject all</button>
        </div>
      </div>
      <script>
        cumulativeOpacityClicks = 0;
        document.querySelector("button").addEventListener("click", (event) => {
          cumulativeOpacityClicks += 1;
          event.currentTarget.disabled = true;
        });
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false,
      "ordinary and filter opacity factors are cumulative across ancestors"
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "cumulativeOpacityClicks")), 0);

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler" style="position: absolute; left: 20px; top: 20px; width: 120px; height: 30px">
        Accept all
      </button>
      <div style="position: fixed; inset: 0; z-index: 9999; background: white"></div>
      <script>
        occludedClicks = 0;
        document.querySelector("button").addEventListener("click", (event) => {
          occludedClicks += 1;
          event.currentTarget.disabled = true;
        });
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      false,
      "a fully opaque overlay above a control prevents a visibility signal"
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false },
      "a fully occluded known-selector decoy is not clicked"
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "occludedClicks")), 0);

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler">Stale decoy</button>
      <section id="real-banner">
        <button id="onetrust-accept-btn-handler">Accept all</button>
      </section>
      <script>
        decoyClicks = 0;
        realClicks = 0;
        document.querySelector("body > #onetrust-accept-btn-handler").addEventListener("click", () => {
          decoyClicks += 1;
        });
        document.querySelector("#real-banner button").addEventListener("click", () => {
          realClicks += 1;
          setTimeout(() => document.querySelector("#real-banner").remove(), 275);
        });
      </script>
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" },
      "a no-op duplicate must not suppress a genuine control with a 200-300ms exit animation"
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        decoy: Reflect.get(window, "decoyClicks"),
        real: Reflect.get(window, "realClicks")
      })),
      { decoy: 1, real: 1 }
    );

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-reject-all-handler">No-op reject</button>
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false },
      "dispatching a synthetic click without a control reaction is not activation proof"
    );

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler">Forged click override</button>
      <script>
        overrideEvents = 0;
        const overridden = document.querySelector("button");
        overridden.addEventListener("click", () => overrideEvents += 1);
        overridden.click = () => { overridden.disabled = true; };
      </script>
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false },
      "an own click override cannot forge event dispatch or a reacting activation"
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        events: Reflect.get(window, "overrideEvents"),
        disabled: (document.querySelector("button") as HTMLButtonElement).disabled
      })),
      { events: 1, disabled: false },
      "the trusted MouseEvent bypasses the override without accepting its fake disabled state"
    );

    await page.setContent(`<!doctype html><body>
      <section id="async-banner">
        <button id="onetrust-reject-all-handler">Reject all</button>
      </section>
      <script>
        document.querySelector("#onetrust-reject-all-handler").addEventListener("click", () => {
          setTimeout(() => document.querySelector("#async-banner").remove(), 300);
        });
      </script>
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, cmp: "OneTrust", selector: "#onetrust-reject-all-handler" },
      "the upper end of a bounded 200-300ms asynchronous dismissal is accepted"
    );

    await page.setContent(`<!doctype html><body>
      <button id="onetrust-reject-all-handler">Timer sabotage</button>
      <script>window.setTimeout = () => 1;</script>
    </body>`);
    const timerSabotageStarted = Date.now();
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false },
      "page-authored timers cannot bypass the 350ms reaction bound"
    );
    const timerSabotageElapsed = Date.now() - timerSabotageStarted;
    assert.ok(timerSabotageElapsed >= 300 && timerSabotageElapsed < 1_500);
  } finally {
    await browser.close();
  }
});

test("generic context supports large first-layer banners and the dominant French accept label", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newConsentPage(browser);
    await page.setContent(`<!doctype html><body>
      <section role="dialog" aria-label="Préférences de confidentialité">
        <p>Choix de confidentialité et consentement pour les cookies</p>
        ${Array.from({ length: 25 }, (_, index) => `<button>Option ${index + 1}</button>`).join("")}
        <button id="french-accept">Tout accepter</button>
      </section>
      <script>
        document.querySelector("#french-accept").addEventListener("click", (event) => {
          event.currentTarget.disabled = true;
        });
      </script>
    </body>`);
    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "tout accepter" }
    );
  } finally {
    await browser.close();
  }
});

test("browser probes retain trusted DOM brands and methods after hostile intrinsic poisoning", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newConsentPage(browser);
    await page.setContent(`<!doctype html><body>
      <button id="onetrust-accept-btn-handler">Accept all</button>
      <script>
        intrinsicPoisonClickEvents = 0;
        const target = document.querySelector("button");
        target.addEventListener("click", () => {
          intrinsicPoisonClickEvents += 1;
          target.remove();
        });
      </script>
    </body>`);
    await page.evaluate(() => {
      Reflect.set(window, "HTMLElement", class FakeHTMLElement {});
      Reflect.set(window, "HTMLInputElement", class FakeHTMLInputElement {});
      Reflect.set(window, "RegExp", class FakeRegExp {});
      Document.prototype.querySelectorAll = (() => {
        throw new Error("poisoned Document.querySelectorAll");
      }) as typeof Document.prototype.querySelectorAll;
      DocumentFragment.prototype.querySelectorAll = (() => {
        throw new Error("poisoned DocumentFragment.querySelectorAll");
      }) as typeof DocumentFragment.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = (() => {
        throw new Error("poisoned Element.querySelectorAll");
      }) as typeof Element.prototype.querySelectorAll;
      Element.prototype.getBoundingClientRect = (() => {
        throw new Error("poisoned geometry");
      }) as typeof Element.prototype.getBoundingClientRect;
      Element.prototype.getAttribute = (() => {
        throw new Error("poisoned attributes");
      }) as typeof Element.prototype.getAttribute;
      Array.from = (() => []) as typeof Array.from;
      Array.prototype.some = (() => false) as typeof Array.prototype.some;
      Array.prototype.includes = (() => false) as typeof Array.prototype.includes;
      RegExp.prototype.test = (() => false) as typeof RegExp.prototype.test;
      window.setTimeout = (() => 1) as unknown as typeof window.setTimeout;
    });

    assert.equal(
      await page.evaluate(findVisibleConsentControl, consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)),
      true
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" }
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "intrinsicPoisonClickEvents")), 1);
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
        reject.disabled = true;
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

test("a consent probe that never searched does not report a completed search", () => {
  // clicked:false is produced by four different outcomes. Reporting all of them
  // as "no recognizable control was found" turns a failure of the instrument
  // into a claim about the site.
  const summary = { mode: "reject-all" as const, clicked: false };
  const searched = consentInteractionWarning(summary, null);
  assert.match(searched, /no recognizable control was found/);

  const budget = consentInteractionWarning(summary, "budget-unavailable");
  assert.match(budget, /time budget ran out before the banner search could run/);
  assert.match(budget, /Nothing was searched or clicked/);
  assert.doesNotMatch(budget, /no recognizable control was found/);

  const failed = consentInteractionWarning(summary, "scan-failed");
  assert.match(failed, /banner search itself failed/);
  assert.match(failed, /Whether a control exists on this page is unknown/);
  assert.doesNotMatch(failed, /no recognizable control was found/);

  const unreadable = consentInteractionWarning(summary, "engine-unavailable");
  assert.match(unreadable, /no frame could be read/);
  assert.doesNotMatch(unreadable, /no recognizable control was found/);

  // A real click is unaffected by the probe-failure channel.
  assert.match(
    consentInteractionWarning({ mode: "accept-all", clicked: true }, null),
    /dispatched, not verified as registered/
  );
});
