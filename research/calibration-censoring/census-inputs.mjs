import fs from "node:fs";
import path from "node:path";

/**
 * The committed reports this decision package was built from, cited by id.
 *
 * The findings are true only of the exact reports behind them, and the
 * package and two docs state their count ("126 r2 runs") in the present
 * tense. Age pruning would otherwise remove the inputs one leg at a time, and
 * the committed artifact would stop reproducing. So the inputs are listed
 * beside the findings, the prune CLI keeps every listed report
 * (DECIDED_PACKAGE_INPUT_FILES in lib/prune-static-reports.ts), and the
 * analyzer refuses to run when the list and the reports it reads disagree in
 * either direction, so the list cannot drift from the package it pins.
 */
export const CENSUS_INPUTS_RELATIVE_PATH = "research/calibration-censoring/corpus-censoring-inputs.json";

export function readCensusInputs(repoRoot) {
  const wire = JSON.parse(fs.readFileSync(path.join(repoRoot, CENSUS_INPUTS_RELATIVE_PATH), "utf8"));
  if (!Array.isArray(wire?.reportIds) || !Number.isInteger(wire?.runCount)) {
    throw new Error(`${CENSUS_INPUTS_RELATIVE_PATH} must hold a reportIds list and an integer runCount`);
  }
  return { reportIds: wire.reportIds, runCount: wire.runCount };
}

/**
 * Every way the analyzer's runs disagree with the pinned inputs, one line
 * each; empty when they agree. `runs` carry the report id they came from.
 */
export function censusInputProblems(runs, inputs) {
  const read = new Set(runs.map((run) => run.reportId));
  const pinned = new Set(inputs.reportIds);
  const problems = [];
  if (pinned.size !== inputs.reportIds.length) problems.push("the pin list names a report twice");
  for (const id of [...read].sort()) if (!pinned.has(id)) problems.push(`read but not pinned: ${id}`);
  for (const id of [...pinned].sort()) if (!read.has(id)) problems.push(`pinned but not read: ${id}`);
  if (runs.length !== inputs.runCount) problems.push(`runs read: ${runs.length}, pinned runCount: ${inputs.runCount}`);
  return problems;
}
