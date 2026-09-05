import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  CONSENT_CANDIDATE_BUDGET,
  CONSENT_CMP_SELECTORS,
  CONSENT_CONTEXT_ANCESTOR_DEPTH,
  CONSENT_CONTEXT_TEXT_MAX_LENGTH,
  CONSENT_PROBE_OUTCOMES,
  CONSENT_QUALIFIED_CHOICE_CONTROLS,
  cmpSelectorsForChoice,
  consentChoiceLabel,
  consentClickArgs,
  consentControlQualification,
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

test("the recognition budgets are the pinned values the page functions carry", () => {
  // These three numbers decide what the scanner will treat as a consent
  // control. They are published measurement boundaries, so a change must be
  // deliberate and reviewed rather than an edit that every test still passes.
  assert.equal(CONSENT_CONTEXT_ANCESTOR_DEPTH, 7);
  assert.equal(CONSENT_CONTEXT_TEXT_MAX_LENGTH, 2_000);
  assert.equal(CONSENT_CANDIDATE_BUDGET, 1_500);

  // The page functions are serialized into the browser and cannot close over
  // module scope, so a budget only takes effect if it is carried in.
  const captureArgs = consentShadowRootCaptureArgs(SHADOW_ROOT_CAPABILITY);
  assert.equal(captureArgs.contextAncestorDepth, CONSENT_CONTEXT_ANCESTOR_DEPTH);
  assert.equal(captureArgs.contextTextMaxLength, CONSENT_CONTEXT_TEXT_MAX_LENGTH);
  for (const args of [
    consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY),
    consentVisibilityArgs(SHADOW_ROOT_CAPABILITY)
  ]) {
    assert.equal(args.candidateBudget, CONSENT_CANDIDATE_BUDGET);
    assert.equal(args.contextAncestorDepth, CONSENT_CONTEXT_ANCESTOR_DEPTH);
    assert.equal(args.contextTextMaxLength, CONSENT_CONTEXT_TEXT_MAX_LENGTH);
  }
});

test("the context gate honors its exact depth and text budgets in the browser", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newConsentPage(browser);
    const nest = (depth: number, inner: string): string =>
      Array.from({ length: depth }, () => "<div>").join("") + inner + Array.from({ length: depth }, () => "</div>").join("");
    // The probe only reports a control that reacts, so every fixture button
    // disables itself exactly as a real banner control would.
    const reacts = `<script>
        document.querySelector("#agree").addEventListener("click", (event) => { event.currentTarget.disabled = true; });
      </script>`;
    const banner = (wrappers: number): string => `<!doctype html><body>
      <div id="cookie-banner">${nest(wrappers, '<button id="agree">I agree</button>')}</div>
      ${reacts}
    </body>`;

    // The gate examines the control plus CONSENT_CONTEXT_ANCESTOR_DEPTH - 1
    // ancestors, and the marker lives on the outermost one.
    const reachableWrappers = CONSENT_CONTEXT_ANCESTOR_DEPTH - 2;
    await page.setContent(banner(reachableWrappers));
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "i agree" },
      "a marker within the depth budget is banner context"
    );

    await page.setContent(banner(reachableWrappers + 1));
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 },
      "one wrapper past the depth budget is out of reach"
    );

    // Text context: an ancestor whose copy fits the budget is banner copy; one
    // character more reads as page prose. The marker is removed so the text
    // rule alone decides.
    const consentCopy = "We use cookies to store your consent preferences. ";
    const withinBudget = consentCopy.padEnd(CONSENT_CONTEXT_TEXT_MAX_LENGTH - 20, "x");
    await page.setContent(`<!doctype html><body>
      <div><p>${withinBudget}</p><button id="agree">I agree</button></div>
      ${reacts}
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, matchedText: "i agree" },
      "banner-sized consent copy is context"
    );

    const overBudget = consentCopy.padEnd(CONSENT_CONTEXT_TEXT_MAX_LENGTH + 200, "x");
    await page.setContent(`<!doctype html><body>
      <div><p>${overBudget}</p><button id="agree">I agree</button></div>
      ${reacts}
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 },
      "page-length prose is not banner context"
    );
  } finally {
    await browser.close();
  }
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
      { clicked: false, dispatched: 0 }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 }
    );
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("reject-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 }
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
      { clicked: false, dispatched: 0 },
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
      // The click LANDED. It is still not activation proof, but the count is
      // what stops the report from calling this an empty search: the page was
      // clicked, so this visit's evidence can span both sides of a choice.
      { clicked: false, dispatched: 1 },
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
      // A trusted MouseEvent still reached the control, so the dispatch is real
      // even though the page's forged `disabled` cannot buy an activation.
      { clicked: false, dispatched: 1 },
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
      { clicked: false, dispatched: 1 },
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
      clicked: false,
      dispatched: 0
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
      clicked: false,
      dispatched: 0
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

test("the allow-all control wins over the qualified one on a banner carrying both", { timeout: 20_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await newConsentPage(browser);
    const reacts = (id: string): string => `<script>
        document.querySelector("#${id}").addEventListener("click", (event) => { event.currentTarget.disabled = true; });
      </script>`;

    // Both ids visible: the dedicated allow-all must be the one clicked, which
    // is what keeps a two-selector entry safe on a fully-featured banner.
    await page.setContent(`<!doctype html><body>
      <div id="CybotCookiebotDialog">
        <button id="CybotCookiebotDialogBodyButtonAccept">OK</button>
        <button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll">Allow all</button>
      </div>
      ${reacts("CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll")}
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      {
        clicked: true,
        cmp: "Cookiebot",
        selector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"
      },
      "the allow-all control must be preferred when both are present"
    );

    // Only the qualified control present: it is still clicked (dropping it
    // would lose coverage), and the recorded selector is what makes the
    // disclosure name it rather than claim a full accept-all.
    await page.setContent(`<!doctype html><body>
      <div id="CybotCookiebotDialog">
        <button id="CybotCookiebotDialogBodyButtonAccept">OK</button>
      </div>
      ${reacts("CybotCookiebotDialogBodyButtonAccept")}
    </body>`);
    assert.deepEqual(
      await page.evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY)),
      { clicked: true, cmp: "Cookiebot", selector: "#CybotCookiebotDialogBodyButtonAccept" },
      "the qualified control is still a real consent control"
    );
  } finally {
    await browser.close();
  }
});

test("the consent click never submits a form, while link and non-submit controls still activate", { timeout: 30_000 }, async () => {
  // A synthetic click on a form's submit control runs the form's activation
  // behaviour, which once made this scanner POST a site's own form with the
  // visitor's fields. The refusal lives in the page-side dispatch and is only
  // observable against a real server: a fixture on loopback records every
  // POST it receives, and the assertions are on what reached it and where the
  // page ended up, not on how the dispatch is written.
  const posts: { path: string; body: string }[] = [];
  const gets: string[] = [];
  const fixture = createServer((request, response) => {
    const path = request.url ?? "/";
    if (request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        posts.push({ path, body });
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>submitted</title>");
      });
      return;
    }
    gets.push(path);
    response.setHeader("Content-Type", "text/html");
    response.end(FORM_FIXTURE_PAGES[path] ?? "<!doctype html><title>missing</title>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await newConsentPage(browser);
    const click = () =>
      page
        .evaluate(findAndClickConsentControl, consentClickArgs("accept-all", SHADOW_ROOT_CAPABILITY))
        // A submission would tear down the execution context mid-evaluate;
        // keep that visible as a value instead of an exception.
        .catch((error: unknown) => ({ evaluateError: String(error) }));

    for (const path of ["/bare-button", "/input-submit"]) {
      await page.goto(`${origin}${path}`);
      const outcome = await click();
      await page.waitForTimeout(300);
      assert.deepEqual(posts, [], `${path}: the click must not submit the form`);
      assert.equal(page.url(), `${origin}${path}`, `${path}: the page must stay where it was`);
      assert.deepEqual(
        outcome,
        { clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" },
        `${path}: the page's own click handler still runs, so the control reacts`
      );
      assert.equal(await page.evaluate(() => document.title), "banner", path);
    }

    // The cancellation is scoped to submit controls: a link consent control
    // registers its choice by navigating, and must still do so.
    await page.goto(`${origin}/anchor`);
    await click();
    await page.waitForURL(`${origin}/accepted`, { timeout: 5_000 }).catch(() => {
      assert.fail("the link control must still navigate: a blanket cancellation would suppress it");
    });
    assert.equal(gets.at(-1), "/accepted", "the link control must still navigate");
    assert.deepEqual(posts, []);

    // A type="button" inside the same form is not a submit control: its
    // handler runs, the form stays put.
    await page.goto(`${origin}/type-button`);
    const typeButtonOutcome = await click();
    await page.waitForTimeout(300);
    assert.deepEqual(typeButtonOutcome, { clicked: true, cmp: "OneTrust", selector: "#onetrust-accept-btn-handler" });
    assert.deepEqual(posts, []);
    assert.equal(page.url(), `${origin}/type-button`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

const FORM_FIXTURE_BANNER_TEXT = "<p>We use cookies to improve your experience. Leave your email for updates.</p>";
const FORM_FIXTURE_REACT_SCRIPT = `<script>
    document.querySelector("#onetrust-accept-btn-handler").addEventListener("click", (event) => {
      event.currentTarget.closest("form, div").hidden = true;
    });
  </script>`;
const FORM_FIXTURE_PAGES: Record<string, string> = {
  "/bare-button": `<!doctype html><title>banner</title><body>
    <form method="post" action="/newsletter">
      ${FORM_FIXTURE_BANNER_TEXT}
      <input name="email" value="visitor@example.test">
      <button id="onetrust-accept-btn-handler">Accept all</button>
    </form>
    ${FORM_FIXTURE_REACT_SCRIPT}
  </body>`,
  "/input-submit": `<!doctype html><title>banner</title><body>
    <form method="post" action="/newsletter">
      ${FORM_FIXTURE_BANNER_TEXT}
      <input name="email" value="visitor@example.test">
      <input type="submit" id="onetrust-accept-btn-handler" value="Accept all">
    </form>
    ${FORM_FIXTURE_REACT_SCRIPT}
  </body>`,
  "/anchor": `<!doctype html><title>banner</title><body>
    <div>
      ${FORM_FIXTURE_BANNER_TEXT}
      <a href="/accepted" id="onetrust-accept-btn-handler">Accept all</a>
    </div>
  </body>`,
  "/type-button": `<!doctype html><title>banner</title><body>
    <form method="post" action="/newsletter">
      ${FORM_FIXTURE_BANNER_TEXT}
      <input name="email" value="visitor@example.test">
      <button type="button" id="onetrust-accept-btn-handler">Accept all</button>
    </form>
    ${FORM_FIXTURE_REACT_SCRIPT}
  </body>`,
  "/accepted": "<!doctype html><title>accepted</title>"
};

test("the reviewed accept/reject pairs stay symmetric and keep their vendor semantics", () => {
  const entryFor = (cmp: string) => {
    const entry = CONSENT_CMP_SELECTORS.find((candidate) => candidate.cmp === cmp);
    assert.ok(entry, `missing catalog entry for ${cmp}`);
    return entry;
  };

  // Osano renders the same allow-all/deny-all actions under two class shapes;
  // the genuine save-current-selections control (.osano-cm-save) is NOT a
  // choice control and must stay out of both lists.
  const osano = entryFor("Osano");
  assert.deepEqual(osano.accept, [".osano-cm-accept-all", ".osano-cm-accept"]);
  assert.deepEqual(osano.reject, [".osano-cm-denyAll", ".osano-cm-deny"]);
  for (const selector of [...osano.accept, ...osano.reject]) {
    assert.doesNotMatch(selector, /osano-cm-save/);
  }

  // The two OneTrust preference-center controls are a symmetric pair. Keeping
  // one arm's -pc- control without the other would bias the accept/reject diff
  // toward whichever arm could still find a control.
  const oneTrust = entryFor("OneTrust");
  assert.equal(oneTrust.accept.includes("#accept-recommended-btn-handler"), true);
  assert.equal(oneTrust.reject.includes(".ot-pc-refuse-all-handler"), true);
  assert.equal(oneTrust.accept.length, oneTrust.reject.length);

  // TrustArc's reject is its required-cookies-only control, which is what
  // "reject all" means on every CMP here: reject all non-essential cookies.
  assert.deepEqual(entryFor("TrustArc").reject, ["#truste-consent-required"]);

  // Sourcepoint numbers its actions, and the numbers are the vendor's own:
  // SPAction.swift in SourcePointUSA/ios-cmp-app declares SaveAndExit = 1,
  // PMCancel = 2, AcceptAll = 11, ShowPrivacyManager = 12, RejectAll = 13.
  // So 11 and 13 are whole-choice actions, not staged selections, and the two
  // controls that would NOT express the requested choice have their own
  // distinct identifiers which this catalog deliberately omits: SaveAndExit
  // (the real save-current-selection action) and ShowPrivacyManager (which
  // only opens the settings layer this scanner never navigates).
  const sourcepoint = entryFor("Sourcepoint");
  assert.deepEqual(sourcepoint.accept, [".sp_choice_type_11", ".message-button.sp_choice_type_ACCEPT_ALL"]);
  assert.deepEqual(sourcepoint.reject, [".sp_choice_type_13", ".message-button.sp_choice_type_REJECT_ALL"]);
  for (const selector of [...sourcepoint.accept, ...sourcepoint.reject]) {
    assert.doesNotMatch(selector, /SAVE_AND_EXIT|sp_choice_type_1\b|sp_choice_type_12\b/);
  }
  // The named classes are the privacy manager's rendering of the same two
  // actions, symmetric across both arms and reached only when that layer is
  // already the visible one, exactly like the OneTrust `-pc-` pair. The
  // first-layer numeric control is listed first so it always wins.
  assert.equal(sourcepoint.accept[0], ".sp_choice_type_11");
  assert.equal(sourcepoint.reject[0], ".sp_choice_type_13");

  // Every entry offers both arms, so no platform can produce a one-sided diff.
  for (const entry of CONSENT_CMP_SELECTORS) {
    assert.ok(entry.accept.length > 0, `${entry.cmp} has no accept control`);
    assert.ok(entry.reject.length > 0, `${entry.cmp} has no reject control`);
  }
});

test("every qualified-control entry names a catalogued selector and sorts last in its list", () => {
  const catalogued = new Set(
    CONSENT_CMP_SELECTORS.flatMap((entry) => [...entry.accept, ...entry.reject])
  );
  for (const selector of Object.keys(CONSENT_QUALIFIED_CHOICE_CONTROLS)) {
    assert.ok(catalogued.has(selector), `${selector} is qualified but not catalogued`);
  }

  // The ordering invariant the whole disclosure rests on: findAndClickConsentControl
  // returns at the FIRST visible match, so a control that may not express the whole
  // choice must never be tried before one that does on the same banner.
  for (const entry of CONSENT_CMP_SELECTORS) {
    for (const list of [entry.accept, entry.reject]) {
      const firstQualified = list.findIndex((selector) =>
        Object.prototype.hasOwnProperty.call(CONSENT_QUALIFIED_CHOICE_CONTROLS, selector)
      );
      if (firstQualified === -1) continue;
      const unqualifiedAfter = list
        .slice(firstQualified + 1)
        .filter((selector) => !Object.prototype.hasOwnProperty.call(CONSENT_QUALIFIED_CHOICE_CONTROLS, selector));
      assert.deepEqual(
        unqualifiedAfter,
        [],
        `${entry.cmp} tries qualified ${list[firstQualified]} before ${unqualifiedAfter.join(", ")}`
      );
    }
  }
});

test("the qualification is carried by the recorded selector, not by the producer sentence", () => {
  // The disclosure is derived READ-side from the recorded selector, so it
  // reaches already-published reports too. The producer sentence is
  // deliberately unchanged: it is an admitted public string, and moving it
  // would retire the r2 normalization identity that live reports validate
  // against.
  assert.equal(
    consentControlQualification("#CybotCookiebotDialogBodyButtonAccept"),
    "the platform's general accept control, which on some deployments submits only the cookie categories already selected"
  );
  assert.equal(consentControlQualification("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"), null);
  assert.equal(consentControlQualification(undefined), null);
  // An inherited Object.prototype key must not resolve to a qualification.
  assert.equal(consentControlQualification("constructor"), null);
  assert.equal(consentControlQualification("toString"), null);

  const warning = consentInteractionWarning({
    mode: "accept-all",
    clicked: true,
    cmp: "Cookiebot",
    selector: "#CybotCookiebotDialogBodyButtonAccept"
  });
  assert.equal(warning, consentInteractionWarning({ mode: "accept-all", clicked: true, cmp: "Cookiebot" }));
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

  // A control that reloads the page on click destroys the context carrying the
  // result, so the loudest evidence that the click WORKED arrives as a lost
  // read. This line must never claim the page stayed pre-consent.
  const interrupted = consentInteractionWarning(summary, "search-interrupted");
  assert.match(interrupted, /moved out from under the search/);
  assert.match(interrupted, /Whether a control was found or clicked is unknown/);
  assert.match(interrupted, /both sides of that choice/);
  assert.doesNotMatch(interrupted, /no recognizable control was found/);
  assert.doesNotMatch(interrupted, /pre-consent state/);

  // An unreadable frame has two causes that look identical from outside, and
  // only one of them is the page moving. A third-party iframe detaching
  // mid-probe leaves the top document exactly where it was, so this sentence
  // must claim incomplete COVERAGE and never a navigation the visit did not
  // observe.
  const framesUnreadable = consentInteractionWarning(summary, "frames-unreadable");
  assert.match(framesUnreadable, /one or more frames could not be read/);
  assert.match(framesUnreadable, /did not cover the whole page/);
  assert.doesNotMatch(framesUnreadable, /moved out from under the search/);
  assert.doesNotMatch(framesUnreadable, /no recognizable control was found/);
  assert.doesNotMatch(framesUnreadable, /pre-consent state/);

  // A click that landed on a control which never visibly responded is neither
  // a click nor an empty search: the page WAS clicked, so "results reflect the
  // pre-consent state" would be false about it.
  const unconfirmed = consentInteractionWarning(summary, "dispatch-unconfirmed");
  assert.match(unconfirmed, /clicked a control that never visibly responded/);
  assert.match(unconfirmed, /whether a choice registered is unknown/);
  assert.match(unconfirmed, /traffic from after that click/);
  assert.doesNotMatch(unconfirmed, /no recognizable control was found/);
  assert.doesNotMatch(unconfirmed, /pre-consent state/);

  // Every outcome the producer can record has its own sentence.
  const sentences = new Set(CONSENT_PROBE_OUTCOMES.map((outcome) => consentInteractionWarning(summary, outcome)));
  assert.equal(sentences.size, CONSENT_PROBE_OUTCOMES.length);

  // A real click is unaffected by the probe-failure channel.
  assert.match(
    consentInteractionWarning({ mode: "accept-all", clicked: true }, null),
    /dispatched, not verified as registered/
  );
});
