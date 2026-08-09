#!/usr/bin/env node
// Report or gate on release-1.0 readiness from RELEASE_READINESS.json.
//
//   --report  print every gate's status and reasons; always exits 0
//   --check   exit 1 unless EVERY gate passes (the mode the 1.0 policy
//             widening wires into the release workflow)
import { evaluateReleaseReadiness } from "./release-readiness-lib.mjs";

const args = process.argv.slice(2);
const mode = args.shift();
if (mode !== "--report" && mode !== "--check") {
  console.error(
    "Usage: node scripts/release-readiness.mjs --report|--check [--live-artifact-context <absolute-directory> --live-artifact-context-sha256 <sha256>]"
  );
  process.exit(1);
}
let liveArtifactContext;
let liveArtifactContextSha256;
if (args.length > 0) {
  if (
    args.length !== 4 ||
    args[0] !== "--live-artifact-context" ||
    !args[1] ||
    args[2] !== "--live-artifact-context-sha256" ||
    !/^[0-9a-f]{64}$/.test(args[3] ?? "")
  ) {
    console.error(
      "Usage: node scripts/release-readiness.mjs --report|--check [--live-artifact-context <absolute-directory> --live-artifact-context-sha256 <sha256>]"
    );
    process.exit(1);
  }
  liveArtifactContext = args[1];
  liveArtifactContextSha256 = args[3];
}

const result = evaluateReleaseReadiness(
  process.cwd(),
  Date.now(),
  {
    liveArtifactContext,
    liveArtifactContextSha256,
    releaseTagGovernanceReceiptSha256:
      process.env.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256
  }
);
for (const problem of result.manifestProblems) {
  console.log(`::error title=Release readiness::${problem}`);
}
for (const gate of result.gates) {
  console.log(`${gate.status === "pass" ? "PASS" : "FAIL"} ${gate.id}: ${gate.title}`);
  for (const reason of gate.reasons) console.log(`  - ${reason}`);
}
const failing = result.gates.filter((gate) => gate.status !== "pass").length;
console.log(
  result.ready
    ? `\nRelease 1.0 readiness: READY (${result.gates.length}/${result.gates.length} gates pass).`
    : `\nRelease 1.0 readiness: NOT READY (${failing} of ${result.gates.length} gates failing).`
);
if (mode === "--check" && !result.ready) process.exit(1);
