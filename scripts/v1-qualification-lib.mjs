import { createServer } from "node:http";

export const CASES = Object.freeze([
  { id: "single-observation", mode: "single", expectation: "The ordinary script and image reach the server; input-triggered traffic is caused by the scanner's active probe." },
  { id: "gpc-intervention", mode: "gpc", expectation: "The server and page realm observe GPC off in baseline and on in variant; both arms execute the ordinary script." },
  { id: "blocker-intervention", mode: "blocker", expectation: "The known analytics script reaches the server in classification mode and is prevented in blocking mode; the ordinary script reaches it in both." },
  { id: "consent-intervention", mode: "consent", expectation: "The server observes an accept choice in baseline and a reject choice in variant, with each retained choice verified after reload." },
  { id: "incomplete-coverage", mode: "single", expectation: "The server returns 503; the report preserves failure and does not claim the requested page was successfully inspected." }
]);
export const LIMITATIONS = "Controlled HTTP origins routed to a loopback reference server by an explicit transport seam; real Chromium, scanner, current r2 builder and filesystem persistence are exercised. Public DNS, TLS, Cloudflare ingress, R2, public-network behavior and rendered browser UI are not established by this capture. Fixed examples provide bounded functional evidence, not calibration, population accuracy or error rates. Human reference review and the external release approval remain pending.";

/** The oracle records incoming HTTP requests without consulting scanner output. */
export function createQualificationOrigin() {
  const events = [];
  let arm = "unassigned";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://qualification.example.com");
    const status = url.pathname === "/incomplete-coverage" ? 503 : 200;
    if (events.length >= 2000) { response.writeHead(507).end(); return; }
    events.push({ arm, observedAt: new Date().toISOString(), method: request.method,
      host: request.headers.host, path: url.pathname, status,
      secGpc: request.headers["sec-gpc"] ?? null,
      realmGpc: url.searchParams.get("gpc"), choice: url.searchParams.get("choice") });
    response.setHeader("cache-control", "no-store");
    response.setHeader("access-control-allow-origin", "*");
    if (url.pathname === "/incomplete-coverage") {
      response.writeHead(503, { "content-type": "text/html" }).end("<!doctype html><title>Unavailable</title><h1>Service unavailable</h1>");
    } else if (url.pathname === "/control.js" || url.pathname === "/ads/banner.js") {
      response.writeHead(200, { "content-type": "application/javascript" }).end("void 0;");
    } else if (url.pathname === "/pixel.gif") {
      response.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    } else if (["/realm", "/input", "/choice"].includes(url.pathname)) {
      response.writeHead(200).end("observed");
    } else {
      const consent = url.pathname === "/consent-intervention";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
        <title>Controlled observation reference</title>
        <main><h1>Controlled observation reference</h1><p>A deterministic page for bounded scanner qualification.</p>
        <label>Email <input type="email" id="email" autocomplete="off"></label></main>
        <script src="/control.js"></script><img src="/pixel.gif" alt="Reference pixel">
        ${url.pathname === "/blocker-intervention" ? '<script src="http://analytics.example.org/ads/banner.js"></script>' : ""}
        <script>
          fetch('/realm?gpc=' + String(navigator.globalPrivacyControl) + '&choice=' + String(localStorage.getItem('reference-choice')));
          document.getElementById('email').addEventListener('input', () => fetch('http://collector.example.net/input', {method:'POST',body:'controlled-input-event'}));
          ${consent ? `
          const chosen = localStorage.getItem('reference-choice');
          const purposes = (value) => ({ consents: {'1': value, '2': value}, legitimateInterests: {'1': value, '2': value} });
          const tcData = {gdprApplies: true, eventStatus: chosen ? 'tcloaded' : 'cmpuishown', purpose: chosen ? purposes(chosen === 'accepted') : {consents:{}, legitimateInterests:{}}};
          window.__tcfapi = (_command, _version, callback) => callback(tcData, true);
          window.choose = (choice) => {
            localStorage.setItem('reference-choice', choice);
            tcData.eventStatus = 'useractioncomplete'; tcData.purpose = purposes(choice === 'accepted');
            document.getElementById('consent-banner').hidden = true;
            fetch('/choice?choice=' + choice);
          };` : ""}
        </script>
        ${consent ? '<div id="consent-banner" role="dialog" aria-label="Cookie consent"><p>We use cookies for analytics. Choose your consent preferences.</p><button onclick="choose(\'rejected\')">Reject all</button><button onclick="choose(\'accepted\')">Accept all</button></div><script>if(chosen) document.getElementById("consent-banner").hidden=true;</script>' : ""}
      `);
    }
  });
  return { server, events, setArm(value) { arm = value; } };
}

/** Fixed external expectations. Never derive the expected value from the report. */
export function referenceProblems(id, report, events) {
  const problems = [];
  const require = (condition, message) => { if (!condition) problems.push(message); };
  const single = id === "single-observation" || id === "incomplete-coverage";
  require(report?.reportType === (single ? "single" : "comparison"), "unexpected report shape");
  const arms = single ? [["single", report?.run]] : [["baseline", report?.baseline], ["variant", report?.variant]];
  for (const [arm, run] of arms) {
    const observed = events.filter((event) => event.arm === arm);
    const requests = run?.evidence?.requests ?? [];
    const document = observed.find((event) => event.path === `/${id}`);
    require(document !== undefined, `${arm}: independent document receipt missing`);
    require(document?.status === (id === "incomplete-coverage" ? 503 : 200), `${arm}: reference document contradicts the controlled response`);
    require(run?.qualityFacts?.status === (id === "incomplete-coverage" ? 503 : 200), `${arm}: document status contradicts the controlled response`);
    if (id === "incomplete-coverage") continue;
    require(observed.some((event) => event.path === "/control.js"), `${arm}: positive control never reached the server`);
    require(observed.some((event) => event.path === "/pixel.gif"), `${arm}: reference image never reached the server`);
    require(requests.some((request) => request.domain?.endsWith(".example.com") && request.resourceType === "script" && request.status === 200), `${arm}: positive control missing from report`);
    require(requests.some((request) => request.domain?.endsWith(".example.com") && request.resourceType === "image" && request.status === 200), `${arm}: image missing from report`);
    if (id === "single-observation") {
      require(observed.some((event) => event.path === "/input"), "active input did not reach the independent server");
      const phases = new Set((run?.phases ?? []).filter((phase) => phase.kind === "active-probe").map((phase) => phase.phaseId));
      const inputRequests = requests.filter((request) => request.domain?.endsWith(".example.net") && request.method === "POST");
      require(inputRequests.length === observed.filter((event) => event.path === "/input").length && inputRequests.every((request) => phases.has(request.phaseId)), "scanner-induced input traffic is not recorded in an active-probe phase");
    }
    if (id === "gpc-intervention") {
      const expected = arm === "variant";
      require(observed.some((event) => event.path === "/realm" && event.realmGpc === (expected ? "true" : "undefined")), `${arm}: page realm GPC disagrees with requested treatment`);
      require(observed.filter((event) => event.path !== "/input").every((event) => event.secGpc === (expected ? "1" : null)), `${arm}: server-observed Sec-GPC disagrees with treatment`);
      require(run?.conditions?.gpc === expected, `${arm}: recorded GPC condition contradicts the oracle`);
    }
    if (id === "blocker-intervention") {
      const received = observed.some((event) => event.host === "analytics.example.org" && event.path === "/ads/banner.js");
      require(received === (arm === "baseline"), `${arm}: analytics delivery contradicts the blocker expectation`);
      const analytics = requests.filter((request) => request.domain?.endsWith(".example.org") && request.resourceType === "script");
      // Frozen wire naming: in classification mode blockedByShields is a
      // filter match. Successfully aborted attempts are excluded from the
      // observed-request table and counted in the explicit verification facts.
      require(arm === "baseline" ? analytics.length === 1 && analytics[0].status === 200 && analytics[0].blockedByShields === true : analytics.length === 0,
        `${arm}: delivered-request evidence contradicts analytics delivery`);
      require(run?.verificationFacts?.shields?.requestsActuallyBlocked === (arm === "variant" ? 1 : 0), `${arm}: actual block count contradicts the controlled delivery`);
    }
    if (id === "consent-intervention") {
      const expected = arm === "baseline" ? "accepted" : "rejected";
      require(observed.some((event) => event.path === "/choice" && event.choice === expected), `${arm}: independent consent choice missing`);
      require(!observed.some((event) => event.path === "/choice" && event.choice !== expected), `${arm}: contradictory consent choice`);
      require(observed.some((event) => event.path === "/realm" && event.choice === expected), `${arm}: retained consent choice was not observed after reload`);
    }
  }
  if (!single) {
    const axis = { "gpc-intervention": "gpc", "blocker-intervention": "shields", "consent-intervention": "consent" }[id];
    require(report?.experiment?.axis === axis, "incorrect comparison axis");
    for (const arm of ["baseline", "variant"]) require(report?.experiment?.verification?.[arm]?.outcome === "passed", `${arm}: treatment was not verified`);
  }
  return problems;
}

export function qualificationPresentationProblems(id, headline) {
  if (typeof headline?.semantic?.reassuring !== "boolean") return ["headline meaning is unavailable"];
  return id === "incomplete-coverage" &&
    (headline.semantic.story !== "load-failure" || headline.semantic.reassuring !== false)
    ? ["failed document does not render an explicit non-reassuring load failure"] : [];
}
