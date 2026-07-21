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

  assert.match(hook, /function dismissActiveScan\(\): void[\s\S]*releaseActiveScanSession\(\)/);
  assert.match(hook, /scanJobWithCurrentAccessKey\(activeScanJob, form\.accessKey\)/);
  assert.match(banner, /Resume status checks/);
  assert.match(banner, /Dismiss recovery/);
  assert.match(app, /onDismiss=\{dismissActiveScan\}/);
});

test("scan progress crosses the accepted boundary only from onAccepted or recovery", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const runScan = hook.slice(hook.indexOf("async function runScan"), hook.indexOf("async function resumeActiveScan"));

  assert.match(runScan, /setActiveScanProgress\(null\);[\s\S]*submitRuntimeScan\(/);
  assert.match(runScan, /onAccepted: retainActiveScanSession/);
  assert.match(hook, /function retainActiveScanSession[\s\S]*acceptedScanJobProgress\(/);
  assert.match(hook, /A recovered capability was already accepted[\s\S]*acceptedScanJobProgress\(\)/);
});
