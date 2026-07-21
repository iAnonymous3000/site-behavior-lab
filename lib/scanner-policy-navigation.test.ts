import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { closeSharedBrowserForTests, scanSite, stagedSingleVisitMeasurement } from "./scanner";

test("privacy-policy probing rejects server redirects and render-time navigation to another party", { timeout: 30_000 }, async () => {
  const foreignPolicyHits: string[] = [];
  const upstream = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0];
    const requestUrl = new URL(request.url ?? "/", `http://${host ?? "policy-origin.test"}`);

    if (host === "foreign-policy.test") {
      foreignPolicyHits.push(requestUrl.searchParams.get("via") ?? "unknown");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Foreign policy</title><main>
        <h1>Privacy Policy</h1>
        <p>We do not sell your personal information.</p>
        <p>${"This is another organization's policy text and must never be attributed to the scanned site. ".repeat(20)}</p>
      </main>`);
      return;
    }

    if (requestUrl.pathname === "/privacy" && requestUrl.searchParams.get("mode") === "redirect") {
      response.writeHead(302, { location: "http://foreign-policy.test/privacy?via=redirect" });
      response.end();
      return;
    }

    if (requestUrl.pathname === "/privacy") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Policy loading</title>
        <p>Loading the policy.</p>
        <script>setTimeout(() => location.replace("http://foreign-policy.test/privacy?via=render"), 50)</script>`);
      return;
    }

    const mode = requestUrl.searchParams.get("mode") === "redirect" ? "redirect" : "render";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Policy origin</title>
      <a href="http://policy-origin.test/privacy?mode=${mode}">Privacy Policy</a>
      <p>Fixture page.</p>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  try {
    for (const mode of ["redirect", "render"] as const) {
      const result = await scanSite(
        {
          url: `http://policy-origin.test/?mode=${mode}`,
          device: "desktop",
          gpcEnabled: false,
          consentMode: "observe"
        },
        {
          publicUrlAlreadyVerified: true,
          verifyPublicUrl: async () => undefined,
          resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
          connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
          resolveCnameChain: async () => []
        }
      );

      const staged = stagedSingleVisitMeasurement(result);
      assert.notEqual(staged, null);
      const policyPhase = staged!.measurement.phases.find((phase) => phase.kind === "policy-analysis");
      assert.notEqual(policyPhase, undefined);
      const policyDetector = staged!.measurement.detectors["privacy-policy"];
      assert.equal(policyDetector.status, "failed");
      assert.equal(policyDetector.reason, "load-failed");
      assert.equal(policyDetector.phaseId, policyPhase!.phaseId);
      assert.equal(staged!.evidence.privacyPolicy, undefined);
      assert.equal(
        result.warnings.some((warning) => warning.includes("foreign-policy.test")),
        false,
        "foreign policy destinations must not leak into stored warnings"
      );
    }

    assert.deepEqual(foreignPolicyHits.sort(), ["redirect", "render"]);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("observe-mode consent probing ignores page-owned geometry navigation hooks", { timeout: 30_000 }, async () => {
  const upstream = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0];
    if (host === "other-observe-subject.test") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Other observe subject</title><script>
        document.cookie = "other-subject-cookie=must-not-be-retained; path=/";
        localStorage.setItem("other-subject-storage", "must-not-be-retained");
      </script>`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Trusted observe subject</title>
      <button id="onetrust-accept-btn-handler">Accept all</button>
      <script>
        const control = document.getElementById("onetrust-accept-btn-handler");
        control.getBoundingClientRect = () => {
          location.replace("http://other-observe-subject.test/");
          return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30, toJSON() {} };
        };
      </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://observe-subject.test/",
        device: "desktop",
        gpcEnabled: false,
        consentMode: "observe"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    assert.equal(result.summary.pageTitle, "Trusted observe subject");
    assert.equal(result.cookies.some((cookie) => cookie.name === "other-subject-cookie"), false);
    assert.equal(result.storage.some((entry) => entry.key === "other-subject-storage"), false);
    assert.equal(result.warnings.some((warning) => warning.includes("left the recorded site")), false);

    const staged = stagedSingleVisitMeasurement(result);
    assert.notEqual(staged, null);
    for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
      assert.equal(
        staged!.measurement.qualityFacts.captureLoss.some(
          (loss) => loss.family === family && loss.phaseId === 0 && loss.kind === "dropped"
        ),
        false,
        `page-owned geometry must not cause ${family} capture loss`
      );
    }
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
