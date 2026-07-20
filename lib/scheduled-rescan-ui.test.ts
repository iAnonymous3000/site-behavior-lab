import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCHEDULED_RESCAN_BOUNDARY_COPY,
  SCHEDULED_RESCAN_CAPABILITY_COPY,
  SCHEDULED_RESCAN_INVALID_LINK_COPY,
  SCHEDULED_RESCAN_POLICY_COPY,
  SCHEDULED_RESCAN_RETRY_COPY,
  normalizeScheduledRescanTarget,
  retainScheduledRescanCreationBeforePost,
  scheduledRescanActionState,
  scheduledRescanCanRetryCreation,
  scheduledRescanCredentialsMatchDerivedId,
  scheduledRescanPanelVisible,
  scheduledRescanRunPresentation
} from "./scheduled-rescan-ui";
import type { EncryptedWatchCredentials } from "./encrypted-watch-client";
import type { EncryptedWatchPayload } from "./encrypted-watch-contract";

const WATCH_CREDENTIALS: EncryptedWatchCredentials = Object.freeze({
  watchId: "103d0ebdaea7dce9e2910bd227af5c2c",
  capabilityToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
});
const WATCH_PAYLOAD: EncryptedWatchPayload = {
  version: 1,
  target: { url: "https://example.com/original" },
  options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
};

test("the scheduled-rescan surface is absent unless edge health explicitly advertises it", () => {
  const hidden = scheduledRescanActionState({
      featureEnabled: false,
      comparisonMode: false,
      targetReady: true,
      scanBlocked: false,
      busy: false,
      acceptedScanJob: false
    });
  assert.deepEqual(hidden, { visibility: "hidden" });
  assert.equal(scheduledRescanPanelVisible(hidden, false), false);
  assert.equal(scheduledRescanPanelVisible(hidden, true), true, "rollback must retain fragment management");
  assert.equal(
    scheduledRescanPanelVisible(hidden, false, true),
    true,
    "rollback must retain invalid-fragment cleanup"
  );
});

test("creation is single-mode only and shares the scan readiness gate", () => {
  const base = {
    featureEnabled: true,
    targetReady: true,
    busy: false,
    acceptedScanJob: false
  };

  assert.deepEqual(
    scheduledRescanActionState({ ...base, comparisonMode: true, scanBlocked: false }),
    { visibility: "disabled", reason: "Scheduled rescans support single scans only." }
  );
  assert.deepEqual(
    scheduledRescanActionState({ ...base, comparisonMode: false, scanBlocked: true }),
    { visibility: "disabled", reason: "Complete the scanner checks above before scheduling." }
  );
  assert.deepEqual(
    scheduledRescanActionState({ ...base, comparisonMode: false, scanBlocked: false }),
    { visibility: "ready" }
  );
});

test("creation is disabled while scan work or an accepted job is active", () => {
  const base = {
    featureEnabled: true,
    comparisonMode: false,
    targetReady: true,
    scanBlocked: false
  };
  assert.equal(
    scheduledRescanActionState({ ...base, busy: true, acceptedScanJob: false }).visibility,
    "disabled"
  );
  assert.equal(
    scheduledRescanActionState({ ...base, busy: false, acceptedScanJob: true }).visibility,
    "disabled"
  );
});

test("product copy pins cadence, expiry, run cap, and the non-alert boundary", () => {
  assert.match(SCHEDULED_RESCAN_POLICY_COPY, /every 7 days/);
  assert.match(SCHEDULED_RESCAN_POLICY_COPY, /30 days/);
  assert.match(SCHEDULED_RESCAN_POLICY_COPY, /maximum of 5 scheduled attempts/);
  assert.equal(SCHEDULED_RESCAN_BOUNDARY_COPY, "Scheduled rescans, not change alerts.");
  assert.match(SCHEDULED_RESCAN_CAPABILITY_COPY, /not kept in local or session storage/);
  assert.match(SCHEDULED_RESCAN_CAPABILITY_COPY, /not sent in HTTP requests/);
  assert.match(SCHEDULED_RESCAN_CAPABILITY_COPY, /browser history may retain it/);
  assert.match(SCHEDULED_RESCAN_INVALID_LINK_COPY, /no server schedule is deleted/);
  assert.match(SCHEDULED_RESCAN_RETRY_COPY, /original target, device, and GPC choice/);
  assert.match(SCHEDULED_RESCAN_RETRY_COPY, /Edits in the scan form do not change it/);
});

test("creation retains a minted capability and immutable payload before the POST caller", async () => {
  const events: string[] = [];
  const creation = await retainScheduledRescanCreationBeforePost({
    pendingCreation: null,
    candidatePayload: WATCH_PAYLOAD,
    mintCredentials: async () => {
      events.push("mint");
      return WATCH_CREDENTIALS;
    },
    retainCreation: (retained) => {
      assert.equal(retained.credentials, WATCH_CREDENTIALS);
      events.push("retain");
    }
  });
  events.push("post");

  assert.equal(creation.credentials, WATCH_CREDENTIALS);
  assert.notEqual(creation.payload, WATCH_PAYLOAD);
  assert.deepEqual(creation.payload, WATCH_PAYLOAD);
  assert.equal(Object.isFrozen(creation.payload), true);
  assert.equal(Object.isFrozen(creation.payload.target), true);
  assert.equal(Object.isFrozen(creation.payload.options), true);
  assert.deepEqual(events, ["mint", "retain", "post"]);
});

test("an uncertain retry reuses the exact capability and payload after form changes", async () => {
  const pending = await retainScheduledRescanCreationBeforePost({
    pendingCreation: null,
    candidatePayload: WATCH_PAYLOAD,
    mintCredentials: async () => WATCH_CREDENTIALS,
    retainCreation: () => undefined
  });
  let minted = false;
  const changedPayload: EncryptedWatchPayload = {
    version: 1,
    target: { url: "https://changed.example/" },
    options: { device: "mobile", gpcEnabled: false, reportMode: "r2", comparison: "none" }
  };
  const retry = await retainScheduledRescanCreationBeforePost({
    pendingCreation: pending,
    candidatePayload: changedPayload,
    mintCredentials: async () => {
      minted = true;
      return WATCH_CREDENTIALS;
    },
    retainCreation: () => undefined
  });

  assert.equal(minted, false);
  assert.equal(retry, pending);
  assert.equal(retry.credentials, WATCH_CREDENTIALS);
  assert.equal(retry.payload.target.url, "https://example.com/original");
  assert.equal(retry.payload.options.device, "desktop");
  assert.equal(retry.payload.options.gpcEnabled, true);
});

test("fragment-only recovery cannot retry a POST without payload provenance", () => {
  assert.equal(scheduledRescanCanRetryCreation(null, WATCH_CREDENTIALS), false);
  assert.equal(
    scheduledRescanCanRetryCreation(
      { credentials: WATCH_CREDENTIALS, payload: WATCH_PAYLOAD },
      WATCH_CREDENTIALS
    ),
    true
  );
  assert.equal(
    scheduledRescanCanRetryCreation(
      { credentials: WATCH_CREDENTIALS, payload: WATCH_PAYLOAD },
      { ...WATCH_CREDENTIALS, watchId: "f".repeat(32) }
    ),
    false
  );
});

test("canonical-looking fragment credentials must preserve the token-derived ID", async () => {
  assert.equal(await scheduledRescanCredentialsMatchDerivedId(WATCH_CREDENTIALS), true);
  assert.equal(
    await scheduledRescanCredentialsMatchDerivedId({
      ...WATCH_CREDENTIALS,
      watchId: "f".repeat(32)
    }),
    false
  );
});

test("attempt history links only succeeded admitted runs and labels every terminal state honestly", () => {
  const admitted = {
    sequence: 1,
    admittedAt: 1_752_880_000_000,
    jobId: `20260719-${"c".repeat(32)}`,
    statusPath: `/api/scans/20260719-${"c".repeat(32)}`,
    reportId: `20260719-${"d".repeat(32)}`,
    errorCode: null
  } as const;
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "succeeded" }), {
    label: "Succeeded",
    reportId: admitted.reportId
  });
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "queued" }), {
    label: "Queued",
    reportId: null
  });
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "running" }), {
    label: "Running",
    reportId: null
  });
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "failed" }), {
    label: "Failed",
    reportId: null
  });
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "expired" }), {
    label: "Expired",
    reportId: null
  });
  assert.deepEqual(scheduledRescanRunPresentation({ ...admitted, status: "cancelled" }), {
    label: "Cancelled",
    reportId: null
  });
  assert.deepEqual(
    scheduledRescanRunPresentation({
      sequence: 2,
      admittedAt: null,
      jobId: null,
      statusPath: null,
      reportId: null,
      status: "failed",
      errorCode: "admission-failed"
    }),
    { label: "Admission failed", reportId: null }
  );
});

test("scheduled targets strip query and fragment and reject non-web or credentialed URLs", () => {
  assert.deepEqual(normalizeScheduledRescanTarget("example.com/path?token=secret#receipt"), {
    url: "https://example.com/path",
    removedPrivateParts: true
  });
  assert.equal(normalizeScheduledRescanTarget("file:///etc/passwd"), null);
  assert.equal(normalizeScheduledRescanTarget("https://user:pass@example.com/"), null);
  assert.equal(normalizeScheduledRescanTarget("https://exa mple.com/"), null);
});
