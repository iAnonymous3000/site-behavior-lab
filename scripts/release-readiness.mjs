#!/usr/bin/env node
// Report or gate on release-1.0 readiness from RELEASE_READINESS.json.
//
//   --report  print every gate's status and reasons; always exits 0
//   --check   exit 1 unless EVERY gate passes (the mode the 1.0 policy
//             widening wires into the release workflow)
import { evaluateReleaseReadiness } from "./release-readiness-lib.mjs";

const mode = process.argv[2];
if (mode !== "--report" && mode !== "--check") {
  console.error("Usage: node scripts/release-readiness.mjs --report|--check");
  process.exit(1);
}

const result = evaluateReleaseReadiness();
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
