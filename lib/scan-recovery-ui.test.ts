import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("scan recovery exposes retry, cancel, and explicit tab-record dismissal", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const banner = source("app/_components/scan-recovery-banner.tsx");
  const app = source("app/site-behavior-app.tsx");

  assert.match(hook, /function dismissActiveScan\(\): void[\s\S]*forceReleaseActiveScanSession\(\)/);
  assert.match(hook, /scanJobWithCurrentAccessKey\(retainedJob, form\.accessKey\)/);
  assert.match(banner, /Resume status checks/);
  assert.match(banner, /Dismiss recovery/);
  assert.match(app, /onDismiss=\{dismissActiveScan\}/);
});

test("scan progress crosses the accepted boundary only from onAccepted or recovery", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const runScan = hook.slice(hook.indexOf("async function runScan"), hook.indexOf("async function resumeActiveScan"));

  assert.match(runScan, /setActiveScanProgress\(null\);[\s\S]*submitRuntimeScan\(/);
  assert.match(runScan, /onAccepted: \(job\) => retainActiveScanSession\(operation, job\)/);
  assert.match(hook, /function retainActiveScanSession[\s\S]*acceptedScanJobProgress\(/);
  assert.match(hook, /A recovered capability was already accepted[\s\S]*acceptedScanJobProgress\(\)/);
});

test("outcome-unknown admission is retained, recovered without POST, and exposed accessibly", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const banner = source("app/_components/scan-recovery-banner.tsx");
  const app = source("app/site-behavior-app.tsx");
  const runScan = hook.slice(hook.indexOf("async function runScan"), hook.indexOf("async function resumeActiveScan"));

  assert.match(hook, /restoreActiveScanSession[\s\S]*restorePendingScanAdmissionSession/);
  assert.match(hook, /Accepted identifiers are strictly stronger recovery authority[\s\S]*clearPendingScanAdmissionSession/);
  assert.match(hook, /recoverRuntimeScanAdmissionThroughCommitWindow\(\{/);
  assert.match(hook, /retainActiveScanSession\(operation, recovery\.job\);[\s\S]*releasePendingAdmission\(operation\)/);
  assert.match(runScan, /durableAdmissionEnabled: policy\.durableAdmissionEnabled/);
  assert.match(runScan, /admissionCredential: pendingForSubmission\.credential/);
  assert.match(runScan, /onAdmissionReady: \(credential\) => retainPendingAdmission\(operation, credential\)/);
  assert.match(runScan, /onAdmissionCleared: \(\) => releasePendingAdmission\(operation\)/);
  assert.match(banner, /Check admission/);
  assert.match(banner, /Changed request semantics are rejected before any network request/);
  assert.match(app, /pendingAdmission=\{Boolean\(pendingScanAdmission\)\}/);
  assert.match(app, /onCheckAdmission=\{\(\) => void recoverPendingAdmission\(\)\}/);
});

test("stopping the pre-admission wait does not immediately restart admission recovery", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const stop = hook.slice(
    hook.indexOf("function stopWaitingForAdmission"),
    hook.indexOf("function retryScannerHealth")
  );

  // The auto-recovery effect lists `loading` in its dependencies, so it re-runs the
  // instant this handler clears it. Without arming the once-per-capability guard the
  // effect calls recoverPendingAdmission, which sets scanNotice back to null and
  // resumes the wait the visitor just ended.
  assert.match(stop, /const pending = pendingScanAdmissionRef\.current/);
  assert.match(stop, /autoRecoveredAdmissionRef\.current = pending\.credential\.capabilityToken/);
  // The cancelled recovery lease never reaches its finalizer, so this flag would
  // otherwise stay true and disable the banner's only remaining control.
  assert.match(stop, /setRecoveringScanAdmission\(false\)/);
  assert.match(stop, /setScanNotice\(\s*"Stopped waiting for the scanner\./);
  // Stopping must not discard the retained capability; checking it later is the
  // whole point of the notice.
  assert.doesNotMatch(stop, /releasePendingAdmission|clearPendingScanAdmissionSession/);

  // The guard is only load-bearing while the effect still consults it.
  assert.match(hook, /if \(autoRecoveredAdmissionRef\.current === capability\) return;/);
});
