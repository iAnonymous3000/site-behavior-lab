import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  mintScanAdmissionCredential,
  scanAdmissionSemanticsFromBody
} from "./scan-admission-capability";

test("Node scan clients emit the exact browser admission commitment contract", async () => {
  const program = `
    import { prepareScanAdmission } from "./scripts/scan-admission.mjs";
    const bytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
    console.log(JSON.stringify(prepareScanAdmission({
      url: "https://EXAMPLE.com/path?account=one#fragment",
      device: "desktop",
      gpcEnabled: true,
      consentMode: "observe"
    }, () => bytes)));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout) as {
    body: Record<string, unknown>;
    credential: { capabilityToken: string; requestCommitment: string };
    headers: Record<string, string>;
  };
  assert.equal(prepared.body.url, "https://example.com/path?account=one");
  assert.equal(prepared.body.compareGpc, false);
  assert.equal(prepared.body.compareShields, false);
  assert.equal(prepared.body.compareConsent, false);

  const semantics = scanAdmissionSemanticsFromBody(prepared.body);
  assert.ok(semantics);
  const expected = await mintScanAdmissionCredential(
    semantics,
    () => Uint8Array.from({ length: 32 }, (_value, index) => index)
  );
  assert.deepEqual(prepared.credential, expected);
  assert.deepEqual(prepared.headers, {
    "x-site-behavior-lab-scan-admission": expected.capabilityToken,
    "x-site-behavior-lab-scan-admission-commitment": expected.requestCommitment
  });
});

test("every durable-capable operator scan client uses canonical admission headers and body", () => {
  const clients = [
    "scripts/toolchain-canary.mjs",
    "scripts/smoke-durable-job-replay.mjs",
    "scripts/smoke-deployed-scanner.mjs",
    "scripts/run-ci-scan.mjs",
    "scripts/smoke-production-synthetic.mjs"
  ];
  for (const client of clients) {
    const source = readFileSync(path.join(process.cwd(), client), "utf8");
    assert.match(source, /prepareScanAdmission/);
    assert.match(source, /\.\.\.admission\.headers/);
    assert.match(source, /JSON\.stringify\(admission\.body\)/);
  }
});
