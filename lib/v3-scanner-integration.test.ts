import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
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
  assert.equal(httpCookie.phase, "passive-load", "initial HTTP cookie must be attributed to passive-load");
  assert.ok(httpCookie.ttlDays !== null && httpCookie.ttlDays > 300);
  const jsCookie = lead.cookies.find((c) => c.name === "js_tracker_id");
  assert.ok(jsCookie && jsCookie.setVia === "js");
  assert.equal(jsCookie.phase, "passive-load", "initial JS cookie must be attributed to passive-load");
  assert.equal(JSON.stringify(report).includes("abc123"), false, "cookie value must never persist");
  assert.equal(JSON.stringify(report).includes("dark-mode-value-secret"), false, "storage value must never persist");
  assert.ok(lead.storage.some((s) => s.area === "localStorage" && s.keyOrStore === "visitor_pref" && s.phase === "passive-load"));

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

  // 6. Shadow DOM input typed cleanly and keystroke probe recorded complete
  assert.equal(lead.keystrokes.fieldsTyped, 1);
  assert.equal(lead.keystrokes.shadowDomFieldsTyped, 1);
  assert.equal(lead.probes.keystrokes.status, "complete");

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

test("v3 scanner marks probes.keystrokes as skipped when a page has zero eligible input fields", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="en">
<head><title>No-Form Fixture</title></head>
<body>
  <h1>Static Article</h1>
  <form role="search"><input type="search" name="q" placeholder="Search" /></form>
  <p>No email, contact, or account form fields exist on this page.</p>
</body>
</html>`);
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
    { url: baseUrl, activeInputProbe: true, policyCheck: false, scrollCheck: false },
    { allowLoopbackFixture: true, passiveDwellMs: 300, resolveCnameChain: async () => ({ chain: [], terminated: true }) }
  );

  assert.deepEqual(validateScanReportV3(report), []);
  assert.equal(report.leadArm.keystrokes.fieldsTyped, 0);
  assert.equal(report.leadArm.probes.keystrokes.status, "skipped");
  assert.equal(report.leadArm.probes.keystrokes.reason, "no-eligible-input-fields");
  assert.ok(
    report.leadArm.phases.some(
      (p) => p.name === "active-input" && p.status === "skipped" && p.reason === "no-eligible-input-fields"
    )
  );
  assert.equal(report.leadArm.probes.policy.status, "skipped");
  assert.equal(report.leadArm.probes.policy.reason, "probe-disabled");
});

test("production v3 synthetic smoke verifies fresh POST /api/v3/scan, persistence, HTML, PDF, and probe coverage", async (t) => {
  const REPORT_ID = "20261126-abcdef0123456789abcdef0123456789";
  const TOKEN = "production-v3-synthetic-test-token-123456";
  let keystrokeStatusToReturn: "skipped" | "complete" = "skipped";
  let submittedPayload: unknown = null;

  const makeMockReport = () => ({
    schemaVersion: 3,
    reportId: REPORT_ID,
    canonicalDomain: "iana.org",
    finalUrl: "https://www.iana.org/domains/reserved",
    scannedAt: new Date().toISOString(),
    leadArm: {
      loadOutcome: "ok",
      httpStatus: 200,
      summary: { totalRequests: 4 },
      keystrokes: { fieldsTyped: 0, leaks: [] },
      probes: {
        keystrokes:
          keystrokeStatusToReturn === "skipped"
            ? { status: "skipped", reason: "no-eligible-input-fields" }
            : { status: "complete" }
      }
    }
  });

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS" && req.url === "/api/v3/scan") {
      res.writeHead(204, { "access-control-allow-origin": "https://sitebehavior.org" });
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/v3/scan") {
      let body = "";
      req.on("data", (c) => {
        body += String(c);
      });
      req.on("end", () => {
        submittedPayload = JSON.parse(body);
        const report = makeMockReport();
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "https://sitebehavior.org"
        });
        res.end(
          JSON.stringify({
            ok: true,
            reportId: REPORT_ID,
            sharePath: `/v3/reports/${REPORT_ID}`,
            apiPath: `/api/v3/reports/${REPORT_ID}`,
            pdfPath: `/api/v3/reports/${REPORT_ID}/pdf`,
            report
          })
        );
      });
      return;
    }
    if (req.method === "GET" && req.url === `/api/v3/reports/${REPORT_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(makeMockReport()));
      return;
    }
    if (req.method === "GET" && req.url === `/v3/reports/${REPORT_ID}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body><h1>iana.org</h1><div>${REPORT_ID}</div></body></html>`);
      return;
    }
    if (req.method === "GET" && req.url === `/api/v3/reports/${REPORT_ID}/pdf`) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.7\n%%EOF\n"));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const origin = `http://127.0.0.1:${addr.port}`;

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const runScript = () =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), "scripts/smoke-production-v3-synthetic.mjs")], {
        env: {
          ...process.env,
          SCAN_BASE_URL: origin,
          PRODUCTION_SYNTHETIC_MONITOR_TOKEN: TOKEN
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += String(c);
      });
      child.stderr.on("data", (c) => {
        stderr += String(c);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  // 1. Honest skipped keystroke probe passes full E2E check
  const okRun = await runScript();
  assert.equal(okRun.code, 0, okRun.stderr);
  assert.match(okRun.stdout, /PASS production v3 synthetic completed.*keystroke-probe=skipped\[0 fields\]/);
  assert.deepEqual(submittedPayload, {
    url: "https://www.iana.org/domains/reserved",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  });

  // 2. Dishonest "complete" keystroke probe with 0 fields typed fails loudly
  keystrokeStatusToReturn = "complete";
  const badRun = await runScript();
  assert.notEqual(badRun.code, 0);
  assert.match(badRun.stderr, /marked probes\.keystrokes as complete despite 0 fields typed/);
});

test("smoke-production-v3-synthetic falls back to the second candidate target on loadOutcome timeout", async (t) => {
  const TOKEN = "v3-synthetic-fallback-test-token-1234567890";
  const REPORT_ID = "20261126-1234567890abcdef1234567890abcdef";
  const submittedUrls: string[] = [];

  const makeMockReport = (loadOutcome: "ok" | "timeout") => ({
    schemaVersion: 3,
    reportId: REPORT_ID,
    scannedAt: new Date().toISOString(),
    targetUrl: "https://www.w3.org/TR/",
    finalUrl: "https://www.w3.org/TR/",
    canonicalDomain: "w3.org",
    provenance: {
      schemaVersion: 3,
      scannerVersion: "sbl-v3.0.0",
      buildCommit: "a".repeat(40),
      engineVersions: {
        chromium: "139.0",
        playwright: "1.65.1",
        adblockRust: "0.10.2",
        filterListsDigest: "abc",
        entityCatalogDigest: "def"
      },
      egressRegion: "us-east",
      locale: "en-US",
      timezone: "UTC",
      acquisition: "live-api"
    },
    leadArm: {
      armId: "baseline",
      label: "Baseline visit",
      conditions: {
        device: "desktop",
        gpcEnabled: true,
        shieldsMode: "off",
        consentMode: "observe",
        scrollCheck: true,
        activeInputProbe: true,
        policyCheck: true
      },
      finalUrl: "https://www.w3.org/TR/",
      httpStatus: loadOutcome === "ok" ? 200 : null,
      loadOutcome,
      durationMs: 1200,
      phases: [],
      probes: {
        network: { status: "complete" },
        websockets: { status: "complete" },
        serviceWorkers: { status: "complete" },
        cookies: { status: "complete" },
        storage: { status: "complete" },
        beacons: { status: "complete" },
        cname: { status: "complete" },
        fingerprinting: { status: "complete" },
        keystrokes: { status: "skipped", reason: "no-eligible-input-fields" },
        consent: { status: "complete" },
        policy: { status: "complete" }
      },
      network: [],
      websockets: [],
      serviceWorkers: [],
      cookies: [],
      storage: [],
      beacons: [],
      cnameCloaks: [],
      fingerprinting: [],
      keystrokes: { fieldsTyped: 0, preSubmissionLeaks: [] },
      consent: { cmpDetected: null, bannerPresent: false, actionAttempted: "observe", actionSucceeded: false, darkPatterns: [], darkPatternScore: 0 },
      policy: null,
      summary: { totalRequests: 5 }
    },
    comparisonArms: [],
    comparisons: [],
    highlights: []
  });

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS" && req.url === "/api/v3/scan") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/v3/scan") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { url: string };
        submittedUrls.push(parsed.url);
        const outcome = submittedUrls.length === 1 ? "timeout" : "ok";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            reportId: REPORT_ID,
            sharePath: `/v3/reports/${REPORT_ID}`,
            apiPath: `/api/v3/reports/${REPORT_ID}`,
            pdfPath: `/api/v3/reports/${REPORT_ID}/pdf`,
            report: makeMockReport(outcome)
          })
        );
      });
      return;
    }
    if (req.method === "GET" && req.url === `/api/v3/reports/${REPORT_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(makeMockReport("ok")));
      return;
    }
    if (req.method === "GET" && req.url === `/v3/reports/${REPORT_ID}`) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${REPORT_ID}</body></html>`);
      return;
    }
    if (req.method === "GET" && req.url === `/api/v3/reports/${REPORT_ID}/pdf`) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.7\n%%EOF\n"));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "scripts/smoke-production-v3-synthetic.mjs")], {
      env: {
        ...process.env,
        SCAN_BASE_URL: `http://127.0.0.1:${addr.port}`,
        PRODUCTION_SYNTHETIC_MONITOR_TOKEN: TOKEN
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(submittedUrls, [
    "https://www.iana.org/domains/reserved",
    "https://www.w3.org/TR/"
  ]);
  assert.match(result.stderr, /WARN v3 synthetic target https:\/\/www\.iana\.org\/domains\/reserved failed/);
  assert.match(result.stdout, /PASS production v3 synthetic completed/);
});
