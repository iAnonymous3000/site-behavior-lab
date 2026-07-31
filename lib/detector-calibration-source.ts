import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { recordedBuildCommit } from "./build-provenance";
import {
  analyzeDetectorCalibrationStudy,
  detectorCalibrationReadiness,
  type DetectorCalibrationAnalysis,
  type DetectorCalibrationReadiness
} from "./detector-calibration";

/**
 * Discover and re-analyze the committed calibration studies.
 *
 * Node-only (filesystem) seam kept out of lib/detector-calibration.ts so the
 * analyzer stays pure. The committed analysis.json a study ships with is a
 * point-in-time record of ITS OWN collection run; the public readiness surface
 * must never trust it, because eligibility is perishable: any commit, catalog
 * review, or Brave-list refresh changes the release identity. Every build
 * therefore re-runs the analyzer against the CURRENT identity, so a stale
 * study demotes itself to ineligible without anyone editing copy.
 *
 * The runtime digest comes only from a study's `runtime-receipt.json` sidecar,
 * written by the execution harness independently of study assembly (the
 * analyzer refuses a digest copied from the study under analysis). A study
 * without the sidecar fails closed as expected-runtime-identity-unavailable.
 */

const CALIBRATION_DIR = "calibration";

export type CommittedCalibrationStudy = {
  studyDir: string;
  analysis: DetectorCalibrationAnalysis;
};

export function committedCalibrationStudyAnalyses(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): CommittedCalibrationStudy[] {
  const base = path.join(rootDir, CALIBRATION_DIR);
  if (!existsSync(base)) return [];
  const expectedBuildCommit = recordedBuildCommit(env) ?? gitHead(rootDir);
  const studies: CommittedCalibrationStudy[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const studyPath = path.join(base, entry.name, "study.json");
    if (!existsSync(studyPath)) continue;
    const study: unknown = JSON.parse(readFileSync(studyPath, "utf8"));
    const receiptPath = path.join(base, entry.name, "runtime-receipt.json");
    let expectedRuntimeDigest: string | null = null;
    if (existsSync(receiptPath)) {
      const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
      expectedRuntimeDigest =
        typeof receipt === "object" &&
        receipt !== null &&
        typeof (receipt as { runtimeDigest?: unknown }).runtimeDigest === "string"
          ? (receipt as { runtimeDigest: string }).runtimeDigest
          : null;
    }
    studies.push({
      studyDir: entry.name,
      analysis: analyzeDetectorCalibrationStudy(study, {
        expectedBuildCommit,
        expectedRuntimeDigest
      })
    });
  }
  return studies.sort((a, b) => a.studyDir.localeCompare(b.studyDir));
}

/** Readiness over the committed studies, re-analyzed against the current identity. */
export function committedDetectorCalibrationReadiness(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): DetectorCalibrationReadiness {
  return detectorCalibrationReadiness(
    committedCalibrationStudyAnalyses(rootDir, env).map((study) => study.analysis)
  );
}

function gitHead(rootDir: string): string | null {
  // The static build runs from a clean checkout with provenance recorded; a
  // bare local invocation may have neither the env pin nor a resolvable HEAD.
  // Null fails closed inside the analyzer (current-build-commit-unavailable).
  try {
    const head = readFileSync(path.join(rootDir, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const match = head.match(/^ref: (.+)$/);
    if (!match) return null;
    const refPath = path.join(rootDir, ".git", ...match[1].split("/"));
    if (existsSync(refPath)) {
      const resolved = readFileSync(refPath, "utf8").trim();
      return /^[0-9a-f]{40}$/.test(resolved) ? resolved : null;
    }
    const packed = path.join(rootDir, ".git", "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const [sha, ref] = line.split(" ");
      if (ref === match[1] && /^[0-9a-f]{40}$/.test(sha ?? "")) return sha;
    }
    return null;
  } catch {
    return null;
  }
}
