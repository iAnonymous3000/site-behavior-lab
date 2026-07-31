// Release-1.0 readiness evaluation over RELEASE_READINESS.json.
//
// The manifest is the SINGLE SOURCE of the 1.0 gates (contract duplication is
// this repository's top defect class, so workflows and humans read the same
// file this module reads). Three gate families:
//
// - decisions: recommended values recorded in the manifest stay RED until a
//   human sets status "approved" with decidedBy/decidedAt. The gate carries
//   its own requiredDecisions list, so DELETING a pending decision is a
//   failure, not an approval;
// - derived gates: re-derived from committed evidence on every run. No
//   self-declared verdict is trusted: A/A studies are re-scored from their
//   preregistration and ledger, lifecycle rules are re-validated from the
//   recorded rule bytes, review coverage is recomputed against the inventory,
//   and runner cycles are counted as DISTINCT Actions runs;
// - operator attestations: host truths code cannot see; a uniform contract
//   requiring literally-true statements, the manifest's exact targetRelease,
//   and a per-gate freshness bound.
//
// Every gate fails closed: missing, malformed, stale, or future-dated
// evidence and malformed GATE CONFIGURATION are failures with reasons, never
// skips. A crash in one evidence source is that gate's failure, never the
// evaluator's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { verifyRunnerDestructionReceipt } from "./runner-receipt-lib.mjs";
import { validateReportsLifecycleRules } from "./r2-lifecycle-lib.mjs";
import { checkReviewLedger } from "./third-party-reviews-lib.mjs";
import { evaluateAaStudy } from "./aa-study-lib.mjs";

const requireFromHere = createRequire(import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;
// Tolerate small clock skew between evidence writers and the evaluator, but
// never a genuinely future-dated artifact: a mistyped year must not read as
// "fresh forever".
const FUTURE_SKEW_MS = 10 * 60 * 1000;

export const READINESS_MANIFEST = "RELEASE_READINESS.json";
export const OPERATOR_ATTESTATION_KIND = "site-behavior-operator-attestation";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256OfFile(filePath) {
  const { createHash } = requireFromHere("node:crypto");
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function gateResult(id, gate, status, reasons = []) {
  return { id, title: gate.title ?? id, kind: gate.kind, status, reasons };
}

/** null when the timestamp is a plausible, non-future, non-stale instant. */
function timestampProblem(label, value, now, maxAgeDays) {
  const parsed = Date.parse(value ?? "");
  if (Number.isNaN(parsed)) return `${label} is missing or invalid`;
  if (parsed > now + FUTURE_SKEW_MS) return `${label} (${value}) is in the future`;
  if (maxAgeDays !== undefined && now - parsed > maxAgeDays * 86_400_000) {
    return `${label} is older than ${maxAgeDays} days; re-capture the evidence`;
  }
  return null;
}

function decisionProblems(name, decision) {
  if (!isRecord(decision)) return [`decision ${name} is malformed`];
  if (decision.status !== "approved") return [`decision ${name} is ${decision.status ?? "undeclared"}`];
  const problems = [];
  if (typeof decision.decidedBy !== "string" || decision.decidedBy.trim().length === 0) {
    problems.push(`decision ${name} is approved without decidedBy`);
  }
  if (typeof decision.decidedAt !== "string" || Number.isNaN(Date.parse(decision.decidedAt))) {
    problems.push(`decision ${name} is approved without a valid decidedAt`);
  }
  return problems;
}

function evaluateDecisions(id, gate, manifest) {
  if (!isNonEmptyStringArray(gate.requiredDecisions)) {
    return gateResult(id, gate, "fail", ["gate config: requiredDecisions must name every governed decision"]);
  }
  const reasons = [];
  const decisions = isRecord(manifest.decisions) ? manifest.decisions : {};
  for (const name of gate.requiredDecisions) {
    if (!(name in decisions)) {
      reasons.push(`required decision ${name} is missing from the manifest; deleting a decision is not approving it`);
      continue;
    }
    reasons.push(...decisionProblems(name, decisions[name]));
  }
  for (const [name, decision] of Object.entries(decisions)) {
    if (!gate.requiredDecisions.includes(name)) reasons.push(...decisionProblems(name, decision));
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateDocumentDigest(id, gate, manifest, rootDir) {
  const decision = manifest.decisions?.compatibilitySurface;
  if (!isRecord(decision) || typeof decision.document !== "string" || decision.document.length === 0) {
    return gateResult(id, gate, "fail", ["the compatibilitySurface decision names no document"]);
  }
  const documentPath = path.join(rootDir, decision.document);
  if (!existsSync(documentPath)) {
    return gateResult(id, gate, "fail", [`${decision.document} does not exist`]);
  }
  const reasons = [];
  if (typeof decision.sha256 !== "string" || !SHA256.test(decision.sha256)) {
    reasons.push("the compatibilitySurface decision pins no valid sha256");
  } else if (sha256OfFile(documentPath) !== decision.sha256) {
    reasons.push(`${decision.document} does not match the pinned digest; approve the edit by updating the pin`);
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateErrata(id, gate, manifest) {
  if (!Array.isArray(gate.openErrata) || gate.openErrata.some((entry) => typeof entry !== "string")) {
    return gateResult(id, gate, "fail", ["gate config: openErrata must be an array of erratum ids"]);
  }
  if (gate.openErrata.length === 0) return gateResult(id, gate, "pass");
  const resolver = manifest.decisions?.[gate.resolvedBy];
  if (resolver?.status === "approved") return gateResult(id, gate, "pass");
  return gateResult(id, gate, "fail", [
    `${gate.openErrata.join(", ")} remain open and the ${gate.resolvedBy} decision is ${resolver?.status ?? "undeclared"}`
  ]);
}

function evaluateCorpus(id, gate, rootDir) {
  if (
    !isNonEmptyStringArray(gate.requiredMetrics) ||
    !Number.isSafeInteger(gate.minimumSitesPerMetric) ||
    gate.minimumSitesPerMetric < 1 ||
    !isRecord(gate.requiredCohort)
  ) {
    return gateResult(id, gate, "fail", [
      "gate config: requiredMetrics must be a non-empty list and minimumSitesPerMetric a positive integer"
    ]);
  }
  const artifactPath = path.join(rootDir, gate.artifact);
  if (!existsSync(artifactPath)) return gateResult(id, gate, "fail", [`${gate.artifact} does not exist`]);
  let corpus;
  try {
    corpus = readJson(artifactPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.artifact} is not valid JSON`]);
  }
  const cohorts = Array.isArray(corpus.cohorts) ? corpus.cohorts : [];
  const candidates = cohorts.filter(
    (cohort) =>
      cohort.schemaVersion === gate.requiredCohort.schemaVersion &&
      cohort.schemaRevision === gate.requiredCohort.schemaRevision
  );
  if (candidates.length === 0) {
    return gateResult(id, gate, "fail", [
      `no cohort matches schemaVersion ${gate.requiredCohort.schemaVersion} revision ${gate.requiredCohort.schemaRevision}`
    ]);
  }
  const clearing = candidates.filter((cohort) =>
    gate.requiredMetrics.every(
      (metric) => (cohort.metrics?.[metric]?.count ?? 0) >= gate.minimumSitesPerMetric
    )
  );
  if (clearing.length === 0) {
    const best = candidates.reduce((leader, cohort) => {
      const floor = Math.min(...gate.requiredMetrics.map((metric) => cohort.metrics?.[metric]?.count ?? 0));
      return floor > leader.floor ? { floor, id: cohort.id } : leader;
    }, { floor: -1, id: null });
    return gateResult(id, gate, "fail", [
      `no current-method cohort clears ${gate.minimumSitesPerMetric} sites on every required metric (best: ${best.id ?? "none"} with a ${best.floor}-site floor)`
    ]);
  }
  // Clearing counts alone are not enough: the cohort must be the one the
  // product's claims actually come from (primaryCohortId) and must carry the
  // artifact's CURRENT metric-contract identity, or a superseded-era cohort
  // could green the gate exactly the way eras were never allowed to pool.
  const reasons = [];
  const bound = clearing.filter((cohort) => {
    let ok = true;
    if (cohort.id !== corpus.primaryCohortId) {
      reasons.push(`cohort ${cohort.id} clears the floors but is not the primary claim-backing cohort (${String(corpus.primaryCohortId)})`);
      ok = false;
    }
    if (cohort.metricContractDigest !== corpus.metricContractDigest) {
      reasons.push(`cohort ${cohort.id} carries a superseded metric-contract identity`);
      ok = false;
    }
    return ok;
  });
  if (bound.length === 0) return gateResult(id, gate, "fail", reasons);
  return gateResult(id, gate, "pass", [`cohort ${bound[0].id} clears every metric denominator as the primary claim-backing cohort`]);
}

function evaluateAaStudies(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) return gateResult(id, gate, "fail", [`${gate.directory}/ does not exist`]);
  const reasons = [];
  let passing = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const studyDir = path.join(directory, entry.name);
    try {
      // Never trust the committed evaluation.json verdict: re-score the
      // committed preregistration and ledger, then require the committed
      // verdict to AGREE so a stale or hand-written evaluation is loud.
      const preregistration = readJson(path.join(studyDir, "preregistration.json"));
      const ledger = readJson(path.join(studyDir, "attempt-ledger.json"));
      const rederived = evaluateAaStudy({ preregistration, ledger });
      const committedPath = path.join(studyDir, "evaluation.json");
      const committed = existsSync(committedPath) ? readJson(committedPath) : null;
      if (rederived.status !== "pass") {
        reasons.push(`${entry.name}: re-derived status ${rederived.status}`);
      } else if (committed?.status !== "pass") {
        reasons.push(`${entry.name}: re-derivation passes but the committed evaluation says ${String(committed?.status)}; regenerate it`);
      } else {
        passing += 1;
      }
    } catch (error) {
      reasons.push(`${entry.name}: ${String(error).slice(0, 160)}`);
    }
  }
  if (passing >= 1) {
    return gateResult(id, gate, "pass", [
      `${passing} preregistered stud${passing === 1 ? "y" : "ies"} re-derived as passing`,
      ...reasons.map((reason) => `note: ${reason}`)
    ]);
  }
  reasons.unshift("no committed A/A study re-derives as passing");
  return gateResult(id, gate, "fail", reasons);
}

function loadCompiled(name) {
  for (const candidate of [`../dist/schema/lib/${name}.js`, `../.unit-test-dist/lib/${name}.js`]) {
    try {
      return requireFromHere(candidate);
    } catch {
      // try the next compiled location
    }
  }
  return null;
}

function evaluateCalibration(id, gate, rootDir) {
  if (!isNonEmptyStringArray(gate.requiredDetectors)) {
    return gateResult(id, gate, "fail", ["gate config: requiredDetectors must be a non-empty list"]);
  }
  const source = loadCompiled("detector-calibration-source");
  const calibration = loadCompiled("detector-calibration");
  const schema = loadCompiled("scan-report-v2");
  if (!source || !calibration || !schema) {
    return gateResult(id, gate, "fail", [
      "the compiled schema artifact is unavailable; build it first (tsc -p tsconfig.schema.json)"
    ]);
  }
  // The manifest list must stay in lockstep with the detector registry in
  // BOTH directions: an unknown name is a config error, and a registry
  // detector missing from the list would silently escape release gating.
  const registry = Array.isArray(schema.DETECTOR_IDS) ? schema.DETECTOR_IDS : [];
  const reasons = [];
  for (const detector of gate.requiredDetectors) {
    if (!registry.includes(detector)) reasons.push(`gate config: ${detector} is not a registry detector id`);
  }
  for (const detector of registry) {
    if (!gate.requiredDetectors.includes(detector)) {
      reasons.push(`registry detector ${detector} is not covered by requiredDetectors; cover it or record why it bears no claims`);
    }
  }
  if (reasons.length > 0) return gateResult(id, gate, "fail", reasons);

  let studies;
  try {
    studies = source.committedCalibrationStudyAnalyses(rootDir);
  } catch (error) {
    return gateResult(id, gate, "fail", [`committed calibration studies are unreadable: ${String(error).slice(0, 160)}`]);
  }
  const eligibleByDetector = new Set(
    studies
      .filter((study) => calibration.isEligibleCalibrationStatus(study.analysis.status))
      .map((study) => study.analysis.detector)
  );
  const missing = gate.requiredDetectors.filter((detector) => !eligibleByDetector.has(detector));
  if (missing.length === 0) {
    return gateResult(id, gate, "pass", [`eligible studies cover all ${gate.requiredDetectors.length} claim-bearing detectors`]);
  }
  return gateResult(id, gate, "fail", [`no eligible study at the current identity for: ${missing.join(", ")}`]);
}

function evaluateReviewLedger(id, gate, rootDir) {
  const ledgerPath = path.join(rootDir, gate.artifact);
  const inventoryPath = path.join(rootDir, gate.inventory);
  for (const [label, filePath] of [[gate.artifact, ledgerPath], [gate.inventory, inventoryPath]]) {
    if (!existsSync(filePath)) return gateResult(id, gate, "fail", [`${label} does not exist`]);
  }
  let ledger;
  let inventory;
  try {
    ledger = readJson(ledgerPath);
    inventory = readJson(inventoryPath);
  } catch {
    return gateResult(id, gate, "fail", ["the review ledger or inventory is not valid JSON"]);
  }
  // The canonical checker owns drift, completeness, and runtime-flag truth;
  // this gate only adds the release bar: zero unreviewed runtime items.
  const verdict = checkReviewLedger(inventory, ledger);
  const reasons = [...verdict.problems];
  let runtimeTotal = 0;
  let unreviewedRuntime = 0;
  for (const bucket of Object.values(verdict.summary ?? {})) {
    runtimeTotal += bucket.total;
    unreviewedRuntime += bucket.unreviewedRuntime;
  }
  if (runtimeTotal === 0) reasons.push("the inventory lists no items to review");
  if (unreviewedRuntime > 0) reasons.push(`${unreviewedRuntime} runtime item(s) are unreviewed`);
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateRunnerReceipts(id, gate, rootDir) {
  if (!Number.isSafeInteger(gate.minimumReceipts) || gate.minimumReceipts < 1) {
    return gateResult(id, gate, "fail", ["gate config: minimumReceipts must be a positive integer"]);
  }
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ does not exist (${gate.minimumReceipts} verifying receipts required)`]);
  }
  const reasons = [];
  // Distinct CYCLES, not files: the same receipt under two names is one run.
  const verifiedRuns = new Set();
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const receipt = readJson(path.join(directory, entry));
      const verdict = verifyRunnerDestructionReceipt(receipt);
      if (verdict.ok) verifiedRuns.add(receipt.actionsRunId);
      else reasons.push(`${entry}: ${verdict.issues[0]}`);
    } catch (error) {
      reasons.push(`${entry}: ${String(error).slice(0, 160)}`);
    }
  }
  if (verifiedRuns.size >= gate.minimumReceipts) {
    return gateResult(id, gate, "pass", [`${verifiedRuns.size} distinct verified runner cycles`]);
  }
  reasons.unshift(`${verifiedRuns.size} of ${gate.minimumReceipts} required distinct verified cycles`);
  return gateResult(id, gate, "fail", reasons);
}

function evaluateLifecycleReceipt(id, gate, rootDir, now) {
  if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1) {
    return gateResult(id, gate, "fail", ["gate config: maxAgeDays must be a positive integer"]);
  }
  const receiptPath = path.join(rootDir, gate.receipt);
  if (!existsSync(receiptPath)) return gateResult(id, gate, "fail", [`${gate.receipt} does not exist`]);
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.receipt} is not valid JSON`]);
  }
  const reasons = [];
  if (receipt.kind !== "site-behavior-r2-lifecycle-readback") reasons.push("wrong receipt kind");
  // Re-validate the recorded rules; the receipt's own ok flag is only
  // required to AGREE, never trusted alone.
  const verdict = validateReportsLifecycleRules(receipt.rules);
  if (!verdict.ok) reasons.push(...verdict.violations.map((violation) => `recorded rules: ${violation}`));
  if (receipt.ok !== verdict.ok) reasons.push("the receipt's ok flag disagrees with re-validation of its recorded rules");
  const staleness = timestampProblem("recordedAt", receipt.recordedAt, now, gate.maxAgeDays);
  if (staleness) reasons.push(staleness);
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateReceiptArchive(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ holds no archived release receipt yet`]);
  }
  const reasons = [];
  let archived = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(directory, entry.name, "release-receipt.json");
    if (!existsSync(receiptPath)) {
      reasons.push(`${entry.name}/ carries no release-receipt.json`);
      continue;
    }
    try {
      const receipt = readJson(receiptPath);
      if (isRecord(receipt) && Object.keys(receipt).length > 0) archived += 1;
      else reasons.push(`${entry.name}/release-receipt.json is empty`);
    } catch {
      reasons.push(`${entry.name}/release-receipt.json is not valid JSON`);
    }
  }
  if (archived >= 1) return gateResult(id, gate, "pass", [`${archived} archived release receipt(s)`]);
  reasons.unshift(`${gate.directory}/ holds no archived release receipt yet`);
  return gateResult(id, gate, "fail", reasons);
}

/**
 * Uniform operator attestation: named human, dated within the gate's window,
 * bound to the manifest's exact targetRelease, every statement literally true.
 */
export function operatorAttestationIssues(attestation, gateId, binding = {}) {
  if (!isRecord(attestation)) return ["attestation must be an object"];
  const issues = [];
  if (attestation.kind !== OPERATOR_ATTESTATION_KIND) issues.push(`kind must be ${OPERATOR_ATTESTATION_KIND}`);
  if (attestation.gateId !== gateId) issues.push(`gateId must be ${gateId}`);
  if (typeof attestation.attestedBy !== "string" || attestation.attestedBy.trim().length === 0) {
    issues.push("attestedBy must name the operator");
  }
  if (binding.targetRelease !== undefined && attestation.targetRelease !== binding.targetRelease) {
    issues.push(`targetRelease must be ${binding.targetRelease}; an attestation for another release cannot satisfy this one`);
  }
  const staleness = timestampProblem(
    "attestedAt",
    attestation.attestedAt,
    binding.now ?? Date.now(),
    binding.maxAgeDays
  );
  if (staleness) issues.push(staleness);
  if (!Array.isArray(attestation.statements) || attestation.statements.length === 0) {
    issues.push("statements must list what is being attested");
  } else {
    for (const statement of attestation.statements) {
      if (!isRecord(statement) || typeof statement.claim !== "string" || statement.true !== true) {
        issues.push(`every statement must carry a claim and be literally true (offender: ${JSON.stringify(statement).slice(0, 80)})`);
      }
    }
  }
  if (!Array.isArray(attestation.evidenceRefs) || attestation.evidenceRefs.length === 0) {
    issues.push("evidenceRefs must reference the underlying evidence");
  }
  return issues;
}

function evaluateAttestation(id, gate, manifest, rootDir, now) {
  if (!Number.isSafeInteger(gate.maxAgeDays) || gate.maxAgeDays < 1) {
    return gateResult(id, gate, "fail", ["gate config: maxAgeDays must be a positive integer"]);
  }
  const attestationPath = path.join(rootDir, gate.attestation);
  if (!existsSync(attestationPath)) return gateResult(id, gate, "fail", [`${gate.attestation} does not exist`]);
  let attestation;
  try {
    attestation = readJson(attestationPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.attestation} is not valid JSON`]);
  }
  const issues = operatorAttestationIssues(attestation, id, {
    targetRelease: manifest.targetRelease,
    maxAgeDays: gate.maxAgeDays,
    now
  });
  return gateResult(id, gate, issues.length === 0 ? "pass" : "fail", issues);
}

/** Evaluate the committed manifest against the repository's current evidence. */
export function evaluateReleaseReadiness(rootDir = process.cwd(), now = Date.now()) {
  const manifestPath = path.join(rootDir, READINESS_MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ready: false, manifestProblems: [`${READINESS_MANIFEST} does not exist`], gates: [] };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return { ready: false, manifestProblems: [`${READINESS_MANIFEST} is not valid JSON`], gates: [] };
  }
  const manifestProblems = [];
  if (manifest.artifactKind !== "site-behavior-release-readiness-manifest") {
    manifestProblems.push("wrong artifactKind");
  }
  if (typeof manifest.targetRelease !== "string" || manifest.targetRelease.length === 0) {
    manifestProblems.push("targetRelease must name the release this manifest gates");
  }
  if (manifestProblems.length > 0) return { ready: false, manifestProblems, gates: [] };

  const gates = [];
  for (const [id, gate] of Object.entries(manifest.gates ?? {})) {
    let result;
    try {
      switch (gate.kind) {
        case "decisions":
          result = evaluateDecisions(id, gate, manifest);
          break;
        case "document-digest":
          result = evaluateDocumentDigest(id, gate, manifest, rootDir);
          break;
        case "errata":
          result = evaluateErrata(id, gate, manifest);
          break;
        case "corpus":
          result = evaluateCorpus(id, gate, rootDir);
          break;
        case "aa-study":
          result = evaluateAaStudies(id, gate, rootDir);
          break;
        case "calibration":
          result = evaluateCalibration(id, gate, rootDir);
          break;
        case "review-ledger":
          result = evaluateReviewLedger(id, gate, rootDir);
          break;
        case "runner-receipts":
          result = evaluateRunnerReceipts(id, gate, rootDir);
          break;
        case "lifecycle-receipt":
          result = evaluateLifecycleReceipt(id, gate, rootDir, now);
          break;
        case "receipt-archive":
          result = evaluateReceiptArchive(id, gate, rootDir);
          break;
        case "operator-attestation":
          result = evaluateAttestation(id, gate, manifest, rootDir, now);
          break;
        default:
          result = gateResult(id, gate, "fail", [`unknown gate kind ${JSON.stringify(gate.kind)}`]);
      }
    } catch (error) {
      result = gateResult(id, gate, "fail", [`gate evaluation threw: ${String(error).slice(0, 200)}`]);
    }
    gates.push(result);
  }
  return {
    ready: gates.length > 0 && gates.every((gate) => gate.status === "pass"),
    manifestProblems: [],
    gates
  };
}
