import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { closeSharedBrowserV3, scanSiteV3 } from "./v3/scanner";
import { validateScanReportV3 } from "./v3/schema";

/**
 * End-to-end live Chromium + CDP integration test for the modular v3 scanner.
 * Exercises:
 *  - Flattened CDP network capture (allowlisted headers, initiator call stacks)
 *  - Persisted phases (passive-load, consent-choice, scroll-interaction, active-input, policy-check)
 *  - 2-layer consent dark-pattern audit & 2nd-layer reject navigation + __tcfapi/__uspapi
 *  - First-party sGTM GA4 + scroll-depth beacon + Meta CAPI decoding
 *  - Shadow DOM active input typing & keystroke-leak detection
 *  - Canvas + MutationObserver + JS document.cookie fingerprinting detection
 *  - Local privacy policy cross-check
 *  - Concurrent multi-arm comparison execution (baseline + gpc + consent-reject)
 */
test("v3 CDP-native scanner executes concurrent multi-arm scans against a live fixture", async (t) => {
  const receivedGpcHeaders: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.headers["sec-gpc"]) receivedGpcHeaders.push(String(req.headers["sec-gpc"]));

    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "session_id=abc123; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Content-Security-Policy": "default-src 'self' 'unsafe-inline'"
      });
      res.end(`<!doctype html>
<html lang="en">
<head><title>SBL v3 Fixture</title></head>
<body style="height: 3000px;">
  <h1>Fixture Store</h1>
  <div id="shadow-host"></div>
  <div id="cookie-banner" role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:16px;">
    <p>We use cookies and privacy partners for analytics.</p>
    <button id="onetrust-accept-btn-handler" style="width:200px;height:60px;">Accept All</button>
    <button id="onetrust-pc-btn-handler" style="width:120px;height:30px;">Cookie Settings</button>
  </div>
  <div id="pref-modal" style="display:none;position:fixed;top:20px;left:20px;background:#eee;padding:16px;">
    <label><input type="checkbox" checked /> Marketing cookies</label>
    <button class="ot-pc-refuse-all-handler" style="width:120px;height:36px;">Reject All</button>
  </div>
  <footer><a href="/privacy-policy">Privacy Policy</a></footer>
  <script>
    // 1. Register __tcfapi & __uspapi
    let rejected = false;
    window.__tcfapi = (cmd, ver, cb) => {
      cb({ gdprApplies: true, eventStatus: "useractioncomplete", purpose: { consents: { "1": !rejected, "3": !rejected } } }, true);
    };
    window.__uspapi = (cmd, ver, cb) => cb({ uspString: "1YNN" }, true);

    document.getElementById("onetrust-pc-btn-handler").addEventListener("click", () => {
      document.getElementById("pref-modal").style.display = "block";
    });
    document.querySelector(".ot-pc-refuse-all-handler").addEventListener("click", () => {
      rejected = true;
      document.getElementById("pref-modal").style.display = "none";
      document.getElementById("cookie-banner").style.display = "none";
    });

    // 2. JS cookie + localStorage + MutationObserver replay + Canvas fingerprint
    document.cookie = "js_tracker_id=999; path=/; max-age=8640000";
    localStorage.setItem("visitor_pref", "dark-mode-value-secret");
    new MutationObserver(() => {}).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const c = document.createElement("canvas");
    c.width = 200; c.height = 50;
    const ctx = c.getContext("2d");
    ctx.fillText("fingerprint-probe", 10, 20);
    c.toDataURL();

    // 3. First-party sGTM GA4 + Meta CAPI beacons
    fetch("/g/collect?v=2&tid=G-FIXTURE1&en=page_view&gcs=G111");
    fetch("/tr?id=123456&ev=PageView&ud[em]=abc");

    // 4. Scroll-triggered beacon
    let scrollSent = false;
    window.addEventListener("scroll", () => {
      if (!scrollSent && window.scrollY > 200) {
        scrollSent = true;
        fetch("/g/collect?v=2&tid=G-FIXTURE1&en=scroll&epn.percent_scrolled=75");
      }
    });

    // 5. Open Shadow DOM input field
    const host = document.getElementById("shadow-host");
    const sr = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.type = "email";
    input.style.width = "220px";
    input.style.height = "32px";
    sr.appendChild(input);
  </script>
</body>
</html>`);
      return;
    }

    if (url === "/privacy-policy") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><body>
        <h1>Privacy Policy</h1>
        <p>We do not sell or share your personal information. We honor Global Privacy Control (GPC) signals sent by your browser.
        This fixture privacy policy contains detailed sections describing our data practices, storage retention limits, visitor rights,
        and contact procedures so that automated text length checks recognize it as a complete policy document rather than a navigation hub.
        We use Google Analytics for aggregated site traffic measurement, while omitting other embedded services from this notice text.</p>
      </body></html>`);
      return;
    }

    res.writeHead(204);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}/`;

  t.after(async () => {
    await closeSharedBrowserV3();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const report = await scanSiteV3(
    {
      url: baseUrl,
      scrollCheck: true,
      activeInputProbe: true,
      policyCheck: true,
      comparisons: ["gpc", "consent-reject"]
    },
    {
      allowLoopbackFixture: true,
      passiveDwellMs: 500,
      scrollDwellMs: 400,
      inputDwellMs: 400,
      resolveCnameChain: async () => ({ chain: [], terminated: true })
    }
  );

  // 1. Schema validity & redaction
  assert.deepEqual(validateScanReportV3(report), []);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.comparisonArms.length, 2);
  assert.equal(report.comparisons.length, 2);

  // 2. Persisted phases completed
  const lead = report.leadArm;
  assert.equal(lead.loadOutcome, "ok");
  assert.equal(lead.httpStatus, 200);
  for (const phaseName of ["passive-load", "consent-choice", "scroll-interaction", "active-input", "policy-check"]) {
    assert.ok(lead.phases.some((p) => p.name === phaseName && p.status === "completed"), `phase ${phaseName} must complete`);
  }

  // 3. Headers, cookies (with TTL & HTTP vs JS attribution, NO values), storage (NO values)
  const docReq = lead.network.find((r) => r.resourceType === "document");
  assert.equal(docReq?.responseHeaders.referrerPolicy, "strict-origin-when-cross-origin");
  assert.equal(docReq?.responseHeaders.contentSecurityPolicyPresent, true);
  const httpCookie = lead.cookies.find((c) => c.name === "session_id");
  assert.ok(httpCookie && httpCookie.httpOnly === true && httpCookie.setVia === "http");
  assert.ok(httpCookie.ttlDays !== null && httpCookie.ttlDays > 300);
  const jsCookie = lead.cookies.find((c) => c.name === "js_tracker_id");
  assert.ok(jsCookie && jsCookie.setVia === "js");
  assert.equal(JSON.stringify(report).includes("abc123"), false, "cookie value must never persist");
  assert.equal(JSON.stringify(report).includes("dark-mode-value-secret"), false, "storage value must never persist");
  assert.ok(lead.storage.some((s) => s.area === "localStorage" && s.keyOrStore === "visitor_pref"));

  // 4. First-party sGTM GA4 + scroll-depth + Meta CAPI beacons decoded!
  const ga = lead.beacons.find((b) => b.format === "ga4");
  assert.ok(ga, "first-party GA4 sGTM beacon must be decoded");
  assert.equal(ga.serverSideTagging, true);
  assert.ok(ga.events.includes("page_view"));
  assert.ok(ga.events.includes("scroll"));
  assert.deepEqual(ga.scrollDepths, [75]);
  assert.ok(lead.beacons.some((b) => b.format === "meta-pixel" && b.identifierCategories.includes("email")));

  // 5. Fingerprinting & MutationObserver replay detected
  const fpKinds = lead.fingerprinting.map((f) => f.kind);
  assert.ok(fpKinds.includes("canvas"));
  assert.ok(fpKinds.includes("mutation-observer-replay"));
  assert.ok(fpKinds.includes("document-cookie-writes"));

  // 6. Shadow DOM input typed cleanly
  assert.equal(lead.keystrokes.fieldsTyped, 1);
  assert.equal(lead.keystrokes.shadowDomFieldsTyped, 1);

  // 7. Consent dark-pattern audit on baseline + 2nd-layer reject on comparison arm!
  assert.equal(lead.consent.banner.detected, true);
  assert.equal(lead.consent.banner.cmp, "OneTrust");
  assert.ok(lead.consent.banner.darkPatternFlags.includes("reject-hidden-in-settings"));
  const rejectArm = report.comparisonArms.find((a) => a.armId === "consent-reject");
  assert.ok(rejectArm);
  assert.equal(rejectArm.consent.interaction.clicked, true);
  assert.equal(rejectArm.consent.interaction.layer, 2);
  assert.equal(rejectArm.consent.verification.tcf.state, "denied");
  assert.ok(rejectArm.consent.banner.darkPatternFlags.includes("pre-ticked-non-essential"));

  // 8. GPC comparison arm actually sent Sec-GPC: 1
  assert.ok(receivedGpcHeaders.includes("1"));

  // 9. Policy probe extracted claims
  assert.ok(lead.policy);
  assert.ok(lead.policy.claims.some((c) => c.kind === "no-selling-or-sharing"));
  assert.ok(lead.policy.claims.some((c) => c.kind === "honors-gpc"));
});
