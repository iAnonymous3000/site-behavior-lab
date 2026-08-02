#!/usr/bin/env node
// Evaluate a preregistered A/A repeatability study directory:
//   <dir>/preregistration.json  declared BEFORE collection
//   <dir>/attempt-ledger.json   the scanner-fidelity attempt ledger collected
//                               under that preregistration
// Writes <dir>/evaluation.json and exits 0 only on a passing study, so a
// workflow can gate on it. Identity violations and invalid preregistrations
// exit 1; a bound-but-failing study exits 2 with its evaluation preserved.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateAaStudy } from "./aa-study-lib.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/evaluate-aa-study.mjs <study-directory>");
  process.exit(1);
}

const preregistration = JSON.parse(readFileSync(path.join(dir, "preregistration.json"), "utf8"));
const targetFrameText = readFileSync(
  path.join(dir, "target-frame.json"),
  "utf8"
);
const targetFrame = JSON.parse(targetFrameText);
const ledger = JSON.parse(readFileSync(path.join(dir, "attempt-ledger.json"), "utf8"));
const evaluation = evaluateAaStudy({
  preregistration,
  targetFrame,
  targetFrameText,
  ledger
});
writeFileSync(path.join(dir, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);

console.log(`status: ${evaluation.status}`);
for (const check of evaluation.checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
}
for (const issue of evaluation.issues) console.log(`ISSUE ${issue}`);
if (evaluation.failingTargets?.length) {
  for (const target of evaluation.failingTargets) {
    console.log(`THRESHOLD ${target.url}: ${target.failures.join("; ")}`);
  }
}

process.exit(evaluation.status === "pass" ? 0 : evaluation.status === "fail" ? 2 : 1);
