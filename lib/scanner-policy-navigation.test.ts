import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { closeSharedBrowserForTests, scanSiteWithMeasurement } from "./scanner";

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
      const { result, measurement } = await scanSiteWithMeasurement(
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

      const policyPhase = measurement.measurement.phases.find((phase) => phase.kind === "policy-analysis");
      assert.notEqual(policyPhase, undefined);
      const policyDetector = measurement.measurement.detectors["privacy-policy"];
      assert.equal(policyDetector.status, "failed");
      assert.equal(policyDetector.reason, "load-failed");
      assert.equal(policyDetector.phaseId, policyPhase!.phaseId);
      assert.equal(measurement.evidence.privacyPolicy, undefined);
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

test("privacy-policy probing reads only a same-site document that is a policy", { timeout: 120_000 }, async () => {
  // Every site below loads a Google Analytics pixel its homepage never names,
  // so reading a non-policy page as the policy publishes "Google is not named
  // in the privacy policy". Each negative page except "no-signal" carries the
  // site footer with its "Privacy Policy" label, as real site pages do: the
  // text alone cannot tell these pages from a policy, so each case isolates
  // the check that has to reject it.
  const filler = "Lamps, rugs and chairs for every room, delivered to your door. ".repeat(16);
  const footer = `<footer>Example Lamps. <a href="/privacy-policy">Privacy Policy</a> Terms of use.</footer>`;
  const pixel = `<img src="http://www.google-analytics.com/collect?v=1&t=pageview" width="1" height="1" alt="">`;
  const page = (title: string, heading: string, body: string, chrome = footer) =>
    `<!doctype html><title>${title}</title><main><h1>${heading}</h1><p>${body}</p></main>${chrome}${pixel}`;
  const homepage = page("Example Lamps", "Welcome", filler);
  const policy = page(
    "Privacy Policy | Example Lamps",
    "Privacy Policy",
    `This privacy policy explains what we collect. We use Google Analytics to measure visits. ${filler}`
  );

  const upstream = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    const redirect = (location: string) => {
      response.writeHead(302, { location });
      response.end();
    };
    if (host === "www.google-analytics.com") {
      response.writeHead(204);
      response.end();
      return;
    }
    const site = host.replace(/\.test$/, "");
    if (path === "/") {
      if (site === "text-only-root") {
        // The bing.com shape: the page's only policy label points at the homepage.
        html(page("Example Lamps", "Welcome", filler, `<footer><a href="/">Privacy Statement</a></footer>`));
      } else if (site === "legal-to-root") {
        html(page("Example Lamps", "Welcome", filler, `<footer><a href="/legal">Privacy Policy</a></footer>`));
      } else {
        html(homepage);
      }
      return;
    }
    if (site === "legal-to-root" && path === "/legal") return redirect("/");
    if (site === "welcome" && path === "/welcome") return html(page("Welcome | Example Lamps", "Welcome back", filler));
    if (path !== "/privacy-policy") return html(homepage);
    switch (site) {
      case "redirect-home":
        return redirect("/");
      case "welcome":
        return redirect("/welcome");
      case "title-404":
        return html(page("Page not found | Example Lamps", "Example Lamps", filler));
      case "heading-404":
        return html(page("Example Lamps", "Sorry, this page could not be found", filler));
      case "no-signal":
        return html(page("Example Lamps", "Our stores", filler, ""));
      default:
        return html(policy);
    }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const scan = (site: string) =>
    scanSiteWithMeasurement(
      { url: `http://${site}.test/`, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

  try {
    for (const site of [
      "redirect-home",
      "welcome",
      "legal-to-root",
      "title-404",
      "heading-404",
      "text-only-root",
      "no-signal"
    ]) {
      const { result, measurement } = await scan(site);
      const policyPhase = measurement.measurement.phases.find((phase) => phase.kind === "policy-analysis");
      assert.notEqual(policyPhase, undefined, `${site}: the page offered a policy link, so the visit was attempted`);
      assert.deepEqual(
        measurement.measurement.detectors["privacy-policy"],
        { version: "policy-text-cross-check@7", status: "failed", reason: "load-failed", phaseId: policyPhase!.phaseId },
        site
      );
      assert.equal(measurement.evidence.privacyPolicy, undefined, site);
      assert.equal(result.privacyPolicy, undefined, site);
      assert.equal(
        measurement.measurement.qualityFacts.captureLoss.some(
          (loss) => loss.detail === "policy-visit" && loss.kind === "dropped" && loss.phaseId === policyPhase!.phaseId
        ),
        true,
        `${site}: the failed policy visit censors its family`
      );
      assert.equal(
        result.warnings.some((warning) => warning.startsWith("Read the site's privacy policy")),
        false,
        `${site}: no page is announced as the policy that was read`
      );
    }

    const { result, measurement } = await scan("real-policy");
    const policyPhase = measurement.measurement.phases.find((phase) => phase.kind === "policy-analysis");
    assert.deepEqual(measurement.measurement.detectors["privacy-policy"], {
      version: "policy-text-cross-check@7",
      status: "complete",
      phaseId: policyPhase!.phaseId
    });
    // The stored wire redacts this fixture's .test host; the raw evidence keeps it.
    assert.equal(measurement.evidence.privacyPolicy?.url, "http://real-policy.test/privacy-policy");
    assert.deepEqual(result.privacyPolicy?.mentionedEntities, ["Google"]);
    assert.deepEqual(result.privacyPolicy?.unmentionedEntities, []);
    assert.equal(result.warnings.some((warning) => warning.startsWith("Read the site's privacy policy")), true);
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
    const { result, measurement } = await scanSiteWithMeasurement(
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

    assert.equal(result.summary.pageTitle, "", "page-authored titles are withheld by redaction policy");
    assert.equal(result.summary.status, 200, "the trusted observe subject answered the recorded visit");
    assert.equal(result.cookies.some((cookie) => cookie.name === "other-subject-cookie"), false);
    assert.equal(result.storage.some((entry) => entry.key === "other-subject-storage"), false);
    assert.equal(result.warnings.some((warning) => warning.includes("left the recorded site")), false);

    for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
      assert.equal(
        measurement.measurement.qualityFacts.captureLoss.some(
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
