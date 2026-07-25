import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelRuntimeScan,
  deriveScanRuntimePolicy,
  fetchRuntimeScannerHealth,
  friendlyScanError,
  isAbortError,
  liveScannerStatusLabel,
  recoverRuntimeScanAdmission,
  recoverRuntimeScanAdmissionThroughCommitWindow,
  resumeRuntimeScan,
  scanJobWithCurrentAccessKey,
  shouldReleaseAcceptedScanJob,
  submitRuntimeScan,
  type ActiveScanJob,
  type RuntimeScanPoller
} from "./scan-client-orchestration";
import { PublicUrlDnsTimeoutError, PublicUrlDnsUnavailableError } from "./url-safety";
import {
  SCAN_ADMISSION_CAPABILITY_HEADER,
  SCAN_ADMISSION_COMMITMENT_HEADER,
  SCAN_ADMISSION_RECOVERY_PATH,
  mintScanAdmissionCredential,
  scanAdmissionCredentialFromHeaders,
  scanAdmissionSemanticsFromBody
} from "./scan-admission-capability";
import { ScanJobEndedError } from "./scan-job-polling";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";

const JOB_ID = `20260719-${"a".repeat(32)}`;
const REPORT_ID = `20260719-${"b".repeat(32)}`;
const STATUS_PATH = `/api/scans/${JOB_ID}`;
const ADMISSION_BYTES = Uint8Array.from({ length: 32 }, (_value, index) => index);

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
  assert.equal(unresolved.durableAdmissionEnabled, false);

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
  assert.equal(policy.durableAdmissionEnabled, false);

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
  assert.equal(dynamicResolvedFalse.durableAdmissionEnabled, false);
});

test("runtime policy advertises idempotent browser admission only for a ready durable edge", () => {
  const base = {
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: true,
    reportPage: false,
    turnstileSiteKeyConfigured: false,
    turnstileToken: "",
    healthError: null
  } as const;
  const ready = deriveScanRuntimePolicy({
    ...base,
    health: {
      ok: true,
      scansAvailable: true,
      checks: { durableJobs: { requested: true, enabled: true, readiness: "ready" as const } }
    }
  });
  assert.equal(ready.durableAdmissionEnabled, true);
  const nodeOnly = deriveScanRuntimePolicy({
    ...base,
    health: {
      ok: true,
      scansAvailable: true,
      checks: { durableJobs: { requested: true, enabled: true, readiness: "node-ready" as const } }
    }
  });
  assert.equal(nodeOnly.durableAdmissionEnabled, false);
});

test("resolved gated health overrides an open-access build hint", () => {
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
});

test("resume authentication uses a newly entered in-memory key without changing recovery identifiers", () => {
  const job: ActiveScanJob = {
    jobId: JOB_ID,
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    accessKey: ""
  };
  assert.deepEqual(scanJobWithCurrentAccessKey(job, "  replacement-key  "), {
    ...job,
    accessKey: "replacement-key"
  });
  assert.deepEqual(scanJobWithCurrentAccessKey({ ...job, accessKey: "admission-key" }, ""), {
    ...job,
    accessKey: "admission-key"
  });
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
        assert.equal(init.signal instanceof AbortSignal, true);
        assert.notEqual(init.signal, controller.signal, "the bounded reader composes its own deadline signal");
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
    jobId: JOB_ID,
    statusPath: STATUS_PATH,
    accessKey: "secret-key",
    reportId: REPORT_ID
  });
  assert.equal(shouldReleaseAcceptedScanJob(new Error("transport failed")), false);
  assert.equal(shouldReleaseAcceptedScanJob(new Error("Unauthorized.")), false);
  assert.equal(shouldReleaseAcceptedScanJob(new ScanJobEndedError("expired", "deadline elapsed")), true);
});

test("durable submission retains a request-bound admission before POST and clears it only after accepted IDs", async () => {
  const events: string[] = [];
  let retainedCapability = "";
  const loaded = await submitRuntimeScan({
    targetUrl: "https://example.com/",
    form: {
      device: "desktop",
      gpcEnabled: true,
      compareGpc: true,
      compareShields: false,
      compareConsent: false,
      accessKey: " admission-access-key "
    },
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: false,
    consentComparisonEnabled: false,
    scannerRequiresAccessKey: true,
    turnstileRequired: true,
    turnstileToken: "one-shot-token",
    durableAdmissionEnabled: true,
    admissionRandomBytes: () => ADMISSION_BYTES,
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    onAdmissionReady: async (credential) => {
      events.push("admission-retained");
      retainedCapability = credential.capabilityToken;
    },
    onAccepted: async (job) => {
      events.push("accepted-persisted");
      assert.equal(job.jobId, JOB_ID);
    },
    onAdmissionCleared: async () => {
      events.push("admission-cleared");
    },
    fetcher: async (input, init) => {
      events.push("post-dispatched");
      assert.equal(events[0], "admission-retained");
      assert.equal(input, "https://scanner.example/api/scan");
      assert.equal(init.method, "POST");
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.referrerPolicy, "no-referrer");
      const body = JSON.parse(String(init.body)) as unknown;
      const semantics = scanAdmissionSemanticsFromBody(body);
      assert.ok(semantics);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer admission-access-key");
      const credential = await scanAdmissionCredentialFromHeaders(headers, semantics);
      assert.ok(credential);
      assert.equal(credential.capabilityToken, retainedCapability);
      assert.equal(input.includes(retainedCapability), false);
      assert.equal(String(init.body).includes(retainedCapability), false);
      assert.equal(String(init.body).includes("admission-access-key"), false);
      return Response.json(
        { ok: true, jobId: JOB_ID, reportId: REPORT_ID, status: "queued", statusPath: STATUS_PATH },
        { status: 202 }
      );
    },
    poller: async () => {
      events.push("polling");
      return {
        source: "v1",
        wire: makeScanReportV1(),
        view: (await import("./scan-report-views")).viewFromV1Report(makeScanReportV1())
      };
    }
  });

  assert.equal(loaded.source, "v1");
  assert.deepEqual(events, [
    "admission-retained",
    "post-dispatched",
    "accepted-persisted",
    "admission-cleared",
    "polling"
  ]);
});

test("outcome-unknown durable failures retain admission while definitive 4xx rejection clears it", async () => {
  async function attempt(
    fetcher: Parameters<typeof submitRuntimeScan>[0]["fetcher"]
  ): Promise<{ retained: number; cleared: number; error: unknown }> {
    let retained = 0;
    let cleared = 0;
    let error: unknown;
    try {
      await submitRuntimeScan({
        targetUrl: "https://example.com/",
        form: {
          device: "desktop",
          gpcEnabled: true,
          compareGpc: false,
          compareShields: false,
          compareConsent: false,
          accessKey: ""
        },
        gpcComparisonEnabled: true,
        shieldsComparisonEnabled: true,
        consentComparisonEnabled: true,
        scannerRequiresAccessKey: false,
        turnstileRequired: false,
        turnstileToken: "",
        durableAdmissionEnabled: true,
        admissionRandomBytes: () => ADMISSION_BYTES,
        resolveApiUrl: (path) => path,
        fetcher,
        onAdmissionReady: () => { retained += 1; },
        onAdmissionCleared: () => { cleared += 1; },
        onAccepted: () => undefined
      });
    } catch (caught) {
      error = caught;
    }
    return { retained, cleared, error };
  }

  const lost = await attempt(async () => {
    throw new TypeError("response lost");
  });
  assert.equal(lost.retained, 1);
  assert.equal(lost.cleared, 0);
  assert.match(String(lost.error), /response lost/);

  const malformed = await attempt(async () =>
    new Response("not json", { status: 202, headers: { "content-type": "application/json" } })
  );
  assert.equal(malformed.retained, 1);
  assert.equal(malformed.cleared, 0);
  assert.match(String(malformed.error), /invalid JSON/);

  const unavailable = await attempt(async () =>
    Response.json({ ok: false, error: "Coordinator outcome is unknown." }, { status: 503 })
  );
  assert.equal(unavailable.retained, 1);
  assert.equal(unavailable.cleared, 0);
  assert.match(String(unavailable.error), /outcome is unknown/);

  const oversized = await attempt(async () =>
    Response.json({ ok: false, error: "x".repeat(17 * 1024) }, { status: 503 })
  );
  assert.equal(oversized.retained, 1);
  assert.equal(oversized.cleared, 0);
  assert.match(String(oversized.error), /16 KB response limit/);

  const rejected = await attempt(async () =>
    Response.json({ ok: false, error: "Choose one comparison mode." }, { status: 400 })
  );
  assert.equal(rejected.retained, 1);
  assert.equal(rejected.cleared, 1);
  assert.match(String(rejected.error), /Choose one comparison mode/);
});

test("an exact retry reuses one capability and contradictory semantics fail before network", async () => {
  const originalBody = {
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  } as const;
  const semantics = scanAdmissionSemanticsFromBody(originalBody);
  assert.ok(semantics);
  const credential = await mintScanAdmissionCredential(semantics, () => ADMISSION_BYTES);
  let calls = 0;
  const base = {
    targetUrl: originalBody.url,
    form: {
      device: originalBody.device,
      gpcEnabled: originalBody.gpcEnabled,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      accessKey: ""
    },
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    scannerRequiresAccessKey: false,
    turnstileRequired: false,
    turnstileToken: "",
    durableAdmissionEnabled: true,
    admissionCredential: credential,
    admissionRandomBytes: () => {
      throw new Error("must not remint");
    },
    resolveApiUrl: (path: string) => path,
    onAdmissionReady: () => undefined,
    onAdmissionCleared: () => undefined,
    onAccepted: () => undefined,
    fetcher: async (_input: string, init: RequestInit) => {
      calls += 1;
      assert.equal(
        new Headers(init.headers).get(SCAN_ADMISSION_CAPABILITY_HEADER),
        credential.capabilityToken
      );
      return Response.json({ ok: false, error: "definitive refusal" }, { status: 400 });
    }
  };
  await assert.rejects(submitRuntimeScan(base), /definitive refusal/);
  assert.equal(calls, 1);

  await assert.rejects(
    submitRuntimeScan({
      ...base,
      form: { ...base.form, gpcEnabled: false }
    }),
    /does not match this scan request/
  );
  assert.equal(calls, 1);
});

test("durable mode refuses to dispatch without explicit recovery lifecycle ownership", async () => {
  let attempted = false;
  await assert.rejects(
    submitRuntimeScan({
      targetUrl: "https://example.com/",
      form: {
        device: "desktop",
        gpcEnabled: true,
        compareGpc: false,
        compareShields: false,
        compareConsent: false,
        accessKey: ""
      },
      gpcComparisonEnabled: true,
      shieldsComparisonEnabled: true,
      consentComparisonEnabled: true,
      scannerRequiresAccessKey: false,
      turnstileRequired: false,
      turnstileToken: "",
      durableAdmissionEnabled: true,
      resolveApiUrl: (path) => path,
      fetcher: async () => {
        attempted = true;
        return Response.json({ ok: false, error: "unexpected" }, { status: 400 });
      },
      onAccepted: () => undefined
    }),
    /requires explicit recovery lifecycle callbacks/
  );
  assert.equal(attempted, false);
});

test("durable mode never dispatches when pre-POST recovery retention fails", async () => {
  let dispatched = false;
  await assert.rejects(
    submitRuntimeScan({
      targetUrl: "https://example.com/",
      form: {
        device: "desktop",
        gpcEnabled: true,
        compareGpc: false,
        compareShields: false,
        compareConsent: false,
        accessKey: ""
      },
      gpcComparisonEnabled: true,
      shieldsComparisonEnabled: true,
      consentComparisonEnabled: true,
      scannerRequiresAccessKey: false,
      turnstileRequired: false,
      turnstileToken: "",
      durableAdmissionEnabled: true,
      admissionRandomBytes: () => ADMISSION_BYTES,
      resolveApiUrl: (path) => path,
      onAdmissionReady: () => {
        throw new Error("session storage blocked");
      },
      onAdmissionCleared: () => undefined,
      onAccepted: () => undefined,
      fetcher: async () => {
        dispatched = true;
        return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
      }
    }),
    /session storage blocked/
  );
  assert.equal(dispatched, false);
});

test("outcome-unknown admission recovery uses fixed header-only GET and returns the accepted tuple", async () => {
  const semantics = scanAdmissionSemanticsFromBody({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  });
  assert.ok(semantics);
  const credential = await mintScanAdmissionCredential(semantics, () => ADMISSION_BYTES);
  const accepted = await recoverRuntimeScanAdmission({
    credential,
    accessKey: " recovery-key ",
    resolveApiUrl: (path) => `https://scanner.example${path}`,
    fetcher: async (input, init) => {
      assert.equal(input, `https://scanner.example${SCAN_ADMISSION_RECOVERY_PATH}`);
      assert.equal(input.includes(credential.capabilityToken), false);
      assert.equal(init.method, "GET");
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.referrerPolicy, "no-referrer");
      const headers = new Headers(init.headers);
      assert.equal(headers.get(SCAN_ADMISSION_CAPABILITY_HEADER), credential.capabilityToken);
      assert.equal(headers.get(SCAN_ADMISSION_COMMITMENT_HEADER), credential.requestCommitment);
      assert.equal(headers.get("Authorization"), "Bearer recovery-key");
      return Response.json({
        ok: true,
        jobId: JOB_ID,
        reportId: REPORT_ID,
        status: "queued",
        statusPath: STATUS_PATH
      });
    }
  });
  assert.deepEqual(accepted, {
    status: "accepted",
    job: {
      jobId: JOB_ID,
      reportId: REPORT_ID,
      statusPath: STATUS_PATH,
      accessKey: "recovery-key"
    }
  });

  const missing = await recoverRuntimeScanAdmission({
    credential,
    resolveApiUrl: (path) => path,
    fetcher: async () => Response.json({ ok: false, error: "Admission not found." }, { status: 404 })
  });
  assert.deepEqual(missing, { status: "not-found" });
});

test("admission recovery treats 404 as transient through the edge commit window", async () => {
  const semantics = scanAdmissionSemanticsFromBody({
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  });
  assert.ok(semantics);
  const credential = await mintScanAdmissionCredential(semantics, () => ADMISSION_BYTES);
  let clock = 1_000;
  let requests = 0;
  const recovered = await recoverRuntimeScanAdmissionThroughCommitWindow({
    credential,
    createdAt: clock,
    resolveApiUrl: (path) => path,
    now: () => clock,
    wait: async (delayMs) => {
      assert.ok(delayMs > 0 && delayMs <= 2_000);
      clock += delayMs;
    },
    fetcher: async () => {
      requests += 1;
      if (requests < 3) {
        return Response.json({ ok: false, error: "Admission not found." }, { status: 404 });
      }
      return Response.json({
        ok: true,
        jobId: JOB_ID,
        reportId: REPORT_ID,
        status: "queued",
        statusPath: STATUS_PATH
      });
    }
  });
  assert.equal(requests, 3);
  assert.equal(recovered.status, "accepted");

  requests = 0;
  const settledMissing = await recoverRuntimeScanAdmissionThroughCommitWindow({
    credential,
    createdAt: 0,
    resolveApiUrl: (path) => path,
    now: () => 35_001,
    wait: async () => assert.fail("must not wait after the commit race window"),
    fetcher: async () => {
      requests += 1;
      return Response.json({ ok: false, error: "Admission not found." }, { status: 404 });
    }
  });
  assert.deepEqual(settledMissing, { status: "not-found" });
  assert.equal(requests, 1);
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

test("non-durable scan responses bound stalled headers, stalled bodies, and oversized reports", async () => {
  const base = {
    targetUrl: "https://example.com/",
    form: {
      device: "desktop" as const,
      gpcEnabled: true,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      accessKey: ""
    },
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    scannerRequiresAccessKey: false,
    turnstileRequired: false,
    turnstileToken: "",
    resolveApiUrl: (path: string) => path,
    onAccepted: () => undefined
  };

  await assert.rejects(
    submitRuntimeScan({
      ...base,
      responseConnectTimeoutMs: 5,
      responseOperationTimeoutMs: 50,
      fetcher: async () => new Promise<Response>(() => undefined)
    }),
    /did not respond/
  );

  await assert.rejects(
    submitRuntimeScan({
      ...base,
      responseConnectTimeoutMs: 50,
      responseOperationTimeoutMs: 5,
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))
    }),
    /did not finish loading/
  );

  await assert.rejects(
    submitRuntimeScan({
      ...base,
      fetcher: async () => new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES + 1)
        }
      })
    }),
    /8 MB response limit/
  );
});

test("resume and cancel use the access key captured at admission and preserve abort signals", async () => {
  const job: ActiveScanJob = {
    jobId: JOB_ID,
    statusPath: STATUS_PATH,
    accessKey: "admission-key",
    reportId: REPORT_ID
  };
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

test("cancellation requires a 2xx response bound to the exact accepted job", async () => {
  const job: ActiveScanJob = {
    jobId: JOB_ID,
    reportId: REPORT_ID,
    statusPath: STATUS_PATH,
    accessKey: ""
  };

  await assert.rejects(
    cancelRuntimeScan({
      job,
      resolveApiUrl: (path) => path,
      fetcher: async () => Response.json(
        { ok: true, jobId: JOB_ID, status: "cancelled" },
        { status: 500 }
      )
    }),
    /could not be cancelled \(HTTP 500\)/
  );

  await assert.rejects(
    cancelRuntimeScan({
      job,
      resolveApiUrl: (path) => path,
      fetcher: async () => Response.json({
        ok: true,
        jobId: `20260719-${"c".repeat(32)}`,
        status: "cancelled"
      })
    }),
    /could not be cancelled/
  );
});

test("friendly scan errors preserve the existing public explanations", () => {
  assert.match(friendlyScanError("Navigation timeout", false), /did not finish loading/);
  assert.match(friendlyScanError("private address", false), /only visits public web pages/);
  assert.match(friendlyScanError("Unauthorized", false), /valid access key/);
  assert.match(friendlyScanError("Unauthorized", true), /still rejecting open scans/);
  assert.equal(friendlyScanError("specific upstream failure", false), "specific upstream failure");
});

test("a scanner-side verification outage is never rewritten as a bad address", () => {
  // This layer classifies by substring, so a server message and this mapping are
  // coupled with nothing between them. A resolver that never answered proves
  // nothing about the target, and both of the rewrites below would blame it:
  // one tells the visitor the address cannot be scanned, the other tells them
  // the site is down. The honest sentence must survive to the reader intact.
  for (const message of [
    new PublicUrlDnsUnavailableError("EAI_AGAIN").message,
    new PublicUrlDnsUnavailableError(null).message,
    new PublicUrlDnsTimeoutError(5_000).message
  ]) {
    const friendly = friendlyScanError(message, true);
    assert.doesNotMatch(friendly, /only visits public web pages/, message);
    assert.doesNotMatch(friendly, /site may be down/, message);
    assert.equal(friendly, message, "the scanner's own honest sentence must reach the reader");
  }
});
