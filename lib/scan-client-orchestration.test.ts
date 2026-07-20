import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelRuntimeScan,
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  resumeRuntimeScan,
  shouldLoadSavedScanAccessKey,
  shouldReleaseAcceptedScanJob,
  submitRuntimeScan,
  type ActiveScanJob,
  type RuntimeScanPoller
} from "./scan-client-orchestration";
import { ScanJobEndedError } from "./scan-job-polling";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

const JOB_ID = `20260719-${"a".repeat(32)}`;
const REPORT_ID = `20260719-${"b".repeat(32)}`;
const STATUS_PATH = `/api/scans/${JOB_ID}`;

test("scanner health is validated and every unresolved or failed posture stays fail closed", async () => {
  const invalid = await fetchRuntimeScannerHealth({
    fetcher: async () => Response.json({ ok: true, capabilities: { gpcComparison: "yes" } }),
    resolveApiUrl: (path) => `https://scanner.example${path}`
  });
  assert.deepEqual(invalid, {
    health: null,
    error: "Public scanner status is unavailable. Try again shortly."
  });

  const unavailable = await fetchRuntimeScannerHealth({
    fetcher: async () => Response.json({ ok: false, error: "Durable coordinator unavailable." }),
    resolveApiUrl: (path) => path
  });
  assert.deepEqual(unavailable, { health: null, error: "Durable coordinator unavailable." });

  const unresolved = deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: false,
    reportPage: false,
    turnstileSiteKeyConfigured: true,
    turnstileToken: "",
    health: null,
    healthError: null
  });
  assert.equal(unresolved.awaitingScannerHealth, true);
  assert.equal(unresolved.scanBlocked, true);
  assert.equal(unresolved.scheduledRescansEnabled, false);

  const failed = deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: false,
    reportPage: false,
    turnstileSiteKeyConfigured: true,
    turnstileToken: "",
    health: null,
    healthError: unavailable.error
  });
  assert.equal(failed.awaitingScannerHealth, false);
  assert.equal(failed.scannerUnavailable, true);
  assert.equal(failed.scanBlocked, true);

  const timedOut = await fetchRuntimeScannerHealth({
    fetcher: async () => new Promise<Response>(() => undefined),
    resolveApiUrl: (path) => path,
    timeoutMs: 5
  });
  assert.deepEqual(timedOut, {
    health: null,
    error: "Public scanner status is unavailable. Try again shortly."
  });
  assert.equal(
    liveScannerStatusLabel({
      liveScanEnabled: true,
      staticExport: false,
      health: null,
      error: timedOut.error
    }),
    "Offline"
  );
});

test("runtime policy trusts advertised capabilities and blocks until required Turnstile completes", () => {
  const policy = deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: false,
    reportPage: false,
    turnstileSiteKeyConfigured: true,
    turnstileToken: "",
    health: {
      ok: true,
      status: "ok",
      authenticated: true,
      openAccess: false,
      turnstile: true,
      scansAvailable: true,
      capabilities: { gpcComparison: true, scheduledRescans: true, savedReportPages: false }
    },
    healthError: null
  });

  assert.equal(policy.gpcComparisonEnabled, true);
  assert.equal(policy.shieldsComparisonEnabled, false);
  assert.equal(policy.scannerRequiresAccessKey, true);
  assert.equal(policy.turnstileRequired, true);
  assert.equal(policy.awaitingTurnstile, true);
  assert.equal(policy.scanBlocked, true);
  assert.equal(policy.liveApiServesReportPages, false);
  assert.equal(policy.scheduledRescansEnabled, true);

  const dynamicResolvedFalse = deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: false,
    staticLiveScanEnabled: false,
    openAccessBuild: true,
    reportPage: false,
    turnstileSiteKeyConfigured: false,
    turnstileToken: "",
    health: {
      ok: true,
      status: "ok",
      openAccess: true,
      turnstile: false,
      scansAvailable: true,
      capabilities: { gpcComparison: true, shieldsComparison: false, consentComparison: false }
    },
    healthError: null
  });
  assert.equal(dynamicResolvedFalse.gpcComparisonEnabled, true);
  assert.equal(dynamicResolvedFalse.shieldsComparisonEnabled, false);
  assert.equal(dynamicResolvedFalse.consentComparisonEnabled, false);
});

test("resolved gated health overrides an open-access build hint and restores saved-key eligibility", () => {
  const policy = deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: true,
    reportPage: false,
    turnstileSiteKeyConfigured: false,
    turnstileToken: "",
    health: {
      ok: true,
      status: "ok",
      authenticated: true,
      openAccess: false,
      turnstile: false,
      scansAvailable: true
    },
    healthError: null
  });

  assert.equal(policy.openAccessScanner, false);
  assert.equal(policy.scannerRequiresAccessKey, true);
  assert.equal(
    shouldLoadSavedScanAccessKey({ liveScanEnabled: true, reportPage: false }),
    true,
    "every live scan surface must recover a key before health can change its posture"
  );
  assert.equal(shouldLoadSavedScanAccessKey({ liveScanEnabled: true, reportPage: true }), false);
  assert.equal(shouldLoadSavedScanAccessKey({ liveScanEnabled: false, reportPage: false }), false);
});

test("submission captures the accepted job capability before polling and retains it on resumable faults", async () => {
  const controller = new AbortController();
  let accepted: ActiveScanJob | null = null;
  let requestBody: Record<string, unknown> | null = null;
  const poller: RuntimeScanPoller = async (options) => {
    assert.equal(accepted?.statusPath, STATUS_PATH, "the recovery capability must be retained before polling starts");
    assert.equal(options.statusPath, STATUS_PATH);
    assert.equal(options.reportId, REPORT_ID);
    assert.equal(options.accessKey, "secret-key");
    assert.equal(options.signal, controller.signal);
    throw new Error("status backend temporarily unavailable");
  };

  await assert.rejects(
    submitRuntimeScan({
      targetUrl: "https://example.com/",
      form: {
        device: "desktop",
        gpcEnabled: true,
        compareGpc: true,
        compareShields: true,
        compareConsent: true,
        accessKey: "  secret-key  "
      },
      gpcComparisonEnabled: true,
      shieldsComparisonEnabled: false,
      consentComparisonEnabled: false,
      scannerRequiresAccessKey: true,
      turnstileRequired: true,
      turnstileToken: "one-shot-token",
      signal: controller.signal,
      resolveApiUrl: (path) => `https://scanner.example${path}`,
      fetcher: async (url, init) => {
        assert.equal(url, "https://scanner.example/api/scan");
        assert.equal(init.method, "POST");
        assert.equal(init.signal, controller.signal);
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-key");
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          ok: true,
          jobId: JOB_ID,
          reportId: REPORT_ID,
          status: "queued",
          statusPath: STATUS_PATH
        });
      },
      poller,
      onAccepted: (job) => {
        accepted = job;
      }
    }),
    /temporarily unavailable/
  );

  assert.deepEqual(requestBody, {
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: true,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe",
    turnstileToken: "one-shot-token"
  });
  assert.deepEqual(accepted, {
    statusPath: STATUS_PATH,
    accessKey: "secret-key",
    reportId: REPORT_ID
  });
  assert.equal(shouldReleaseAcceptedScanJob(new Error("transport failed")), false);
  assert.equal(shouldReleaseAcceptedScanJob(new ScanJobEndedError("expired", "deadline elapsed")), true);
});

test("synchronous scan reports still pass through the canonical reader", async () => {
  let accepted = false;
  const loaded = await submitRuntimeScan({
    targetUrl: "https://example.com/",
    form: {
      device: "mobile",
      gpcEnabled: false,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      accessKey: "ignored"
    },
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    scannerRequiresAccessKey: false,
    turnstileRequired: false,
    turnstileToken: "",
    resolveApiUrl: (path) => path,
    fetcher: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>).Authorization, undefined);
      return Response.json(makeScanReportV1());
    },
    onAccepted: () => {
      accepted = true;
    }
  });

  assert.equal(loaded.source, "v1");
  assert.equal(accepted, false);
});

test("resume and cancel use the access key captured at admission and preserve abort signals", async () => {
  const job: ActiveScanJob = { statusPath: STATUS_PATH, accessKey: "admission-key", reportId: REPORT_ID };
  const controller = new AbortController();
  const resumed = await resumeRuntimeScan({
    job,
    signal: controller.signal,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    poller: async (options) => {
      assert.equal(options.accessKey, "admission-key");
      assert.equal(options.reportId, REPORT_ID);
      assert.equal(options.signal, controller.signal);
      return {
        source: "v1",
        wire: makeScanReportV1(),
        view: (await import("./scan-report-views")).viewFromV1Report(makeScanReportV1())
      };
    }
  });
  assert.equal(resumed.source, "v1");

  const message = await cancelRuntimeScan({
    job,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    fetcher: async (url, init) => {
      assert.equal(url, `https://scanner.example${STATUS_PATH}`);
      assert.equal(init.method, "DELETE");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer admission-key");
      assert.equal(init.signal instanceof AbortSignal, true);
      return Response.json({ ok: true, jobId: JOB_ID, status: "cancelled", error: "Cancelled by visitor." });
    }
  });
  assert.equal(message, "Cancelled by visitor.");

  await assert.rejects(
    cancelRuntimeScan({
      job,
      resolveApiUrl: (path) => path,
      fetcher: async () => new Promise<Response>(() => undefined),
      timeoutMs: 5
    }),
    /cancellation timed out/i
  );

  controller.abort();
  const aborted = controller.signal.reason;
  assert.equal(isAbortError(aborted), true);
});

test("friendly scan errors preserve the existing public explanations", () => {
  assert.match(friendlyScanError("Navigation timeout", false), /did not finish loading/);
  assert.match(friendlyScanError("private address", false), /only visits public web pages/);
  assert.match(friendlyScanError("Unauthorized", false), /valid access key/);
  assert.match(friendlyScanError("Unauthorized", true), /still rejecting open scans/);
  assert.equal(friendlyScanError("specific upstream failure", false), "specific upstream failure");
});
