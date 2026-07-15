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
