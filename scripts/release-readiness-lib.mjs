// Release-1.0 readiness evaluation over RELEASE_READINESS.json.
//
// The manifest is the SINGLE SOURCE of the 1.0 gates ([[contract-duplication]]
// is this repository's top defect class, so workflows and humans read the
// same file this module reads; nothing restates the gate list). Three gate
// families exist:
//
// - decisions: recommended values recorded in the manifest stay RED until a
//   human sets status "approved" with decidedBy/decidedAt, so a session's
//   recommendation can never silently become policy;
// - derived gates: re-evaluated from committed evidence (corpus statistics,
//   A/A evaluations, calibration re-analysis, review ledger, receipts) on
//   every run, so readiness can only reflect what the repository can prove
//   right now;
// - operator attestations: host truths code cannot see; a uniform attestation
//   file whose statements must all be literally true, bound to a named
//   operator and date.
//
// Every gate fails closed: missing evidence, malformed evidence, and stale
// evidence are failures with reasons, never skips.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { verifyRunnerDestructionReceipt } from "./runner-receipt-lib.mjs";

const requireFromHere = createRequire(import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;

export const READINESS_MANIFEST = "RELEASE_READINESS.json";
export const OPERATOR_ATTESTATION_KIND = "site-behavior-operator-attestation";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function evaluateDecisions(id, gate, manifest) {
  const reasons = [];
  for (const [name, decision] of Object.entries(manifest.decisions ?? {})) {
    if (!isRecord(decision)) {
      reasons.push(`decision ${name} is malformed`);
      continue;
    }
    if (decision.status !== "approved") {
      reasons.push(`decision ${name} is ${decision.status ?? "undeclared"}`);
      continue;
    }
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.trim().length === 0) {
      reasons.push(`decision ${name} is approved without decidedBy`);
    }
    if (typeof decision.decidedAt !== "string" || Number.isNaN(Date.parse(decision.decidedAt))) {
      reasons.push(`decision ${name} is approved without a valid decidedAt`);
    }
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateDocumentDigest(id, gate, manifest, rootDir) {
  const decision = manifest.decisions?.compatibilitySurface;
  const reasons = [];
  const documentPath = path.join(rootDir, gate.document);
  if (!existsSync(documentPath)) {
    return gateResult(id, gate, "fail", [`${gate.document} does not exist`]);
  }
  const pinned = decision?.sha256;
  if (typeof pinned !== "string" || !SHA256.test(pinned)) {
    reasons.push("the compatibilitySurface decision pins no valid sha256");
  } else if (sha256OfFile(documentPath) !== pinned) {
    reasons.push(`${gate.document} does not match the pinned digest; approve the edit by updating the pin`);
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateErrata(id, gate, manifest) {
  const resolver = manifest.decisions?.[gate.resolvedBy];
  const open = Array.isArray(gate.openErrata) ? gate.openErrata : [];
  if (open.length === 0) return gateResult(id, gate, "pass");
  if (resolver?.status === "approved") return gateResult(id, gate, "pass");
  return gateResult(id, gate, "fail", [
    `${open.join(", ")} remain open and the ${gate.resolvedBy} decision is ${resolver?.status ?? "undeclared"}`
  ]);
}

function evaluateCorpus(id, gate, rootDir) {
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
  return gateResult(id, gate, "pass", [`cohort ${clearing[0].id} clears every metric denominator`]);
}

function evaluateAaStudies(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) return gateResult(id, gate, "fail", [`${gate.directory}/ does not exist`]);
  const reasons = [];
  let passing = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const evaluationPath = path.join(directory, entry.name, "evaluation.json");
    if (!existsSync(evaluationPath)) {
      reasons.push(`${entry.name}: no evaluation.json`);
      continue;
    }
    try {
      const evaluation = readJson(evaluationPath);
      if (evaluation.kind !== "site-behavior-aa-evaluation") {
        reasons.push(`${entry.name}: not an A/A evaluation artifact`);
      } else if (evaluation.status === "pass") {
        passing += 1;
      } else {
        reasons.push(`${entry.name}: status ${evaluation.status}`);
      }
    } catch {
      reasons.push(`${entry.name}: evaluation.json is not valid JSON`);
    }
  }
  if (passing >= 1) return gateResult(id, gate, "pass", [`${passing} passing preregistered stud${passing === 1 ? "y" : "ies"}`]);
  reasons.unshift("no passing preregistered A/A study is committed");
  return gateResult(id, gate, "fail", reasons);
}

function evaluateCalibration(id, gate, rootDir) {
  let source;
  const candidates = [
    "../dist/schema/lib/detector-calibration-source.js",
    "../.unit-test-dist/lib/detector-calibration-source.js"
  ];
  for (const candidate of candidates) {
    try {
      source = requireFromHere(candidate);
      break;
    } catch {
      // fall through to the next compiled location
    }
  }
  if (!source) {
    return gateResult(id, gate, "fail", [
      "the compiled calibration source is unavailable; build the schema artifact first (tsc -p tsconfig.schema.json)"
    ]);
  }
  const studies = source.committedCalibrationStudyAnalyses(rootDir);
  const eligibleByDetector = new Set(
    studies
      .filter((study) => study.analysis.status === "descriptive-only" || study.analysis.status === "sample-estimate")
      .map((study) => study.analysis.detector)
  );
  const missing = gate.requiredDetectors.filter((detector) => !eligibleByDetector.has(detector));
  if (missing.length === 0) {
    return gateResult(id, gate, "pass", [`eligible studies cover all ${gate.requiredDetectors.length} claim-bearing detectors`]);
  }
  return gateResult(id, gate, "fail", [
    `no eligible study at the current identity for: ${missing.join(", ")}`
  ]);
}

function evaluateReviewLedger(id, gate, rootDir) {
  const ledgerPath = path.join(rootDir, gate.artifact);
  if (!existsSync(ledgerPath)) return gateResult(id, gate, "fail", [`${gate.artifact} does not exist`]);
  let ledger;
  try {
    ledger = readJson(ledgerPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.artifact} is not valid JSON`]);
  }
  const rows = Array.isArray(ledger.reviews) ? ledger.reviews : [];
  const runtimeRows = rows.filter((row) => row.runtime === true);
  const unreviewed = runtimeRows.filter((row) => row.status !== "reviewed");
  if (runtimeRows.length === 0) return gateResult(id, gate, "fail", ["the review ledger lists no runtime items"]);
  if (unreviewed.length === 0) {
    return gateResult(id, gate, "pass", [`all ${runtimeRows.length} runtime items reviewed`]);
  }
  return gateResult(id, gate, "fail", [
    `${unreviewed.length} of ${runtimeRows.length} runtime items are unreviewed`
  ]);
}

function evaluateRunnerReceipts(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ does not exist (${gate.minimumReceipts} verifying receipts required)`]);
  }
  const reasons = [];
  let verified = 0;
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const verdict = verifyRunnerDestructionReceipt(readJson(path.join(directory, entry)));
      if (verdict.ok) verified += 1;
      else reasons.push(`${entry}: ${verdict.issues[0]}`);
    } catch {
      reasons.push(`${entry}: not valid JSON`);
    }
  }
  if (verified >= gate.minimumReceipts) {
    return gateResult(id, gate, "pass", [`${verified} verifying destruction receipts`]);
  }
  reasons.unshift(`${verified} of ${gate.minimumReceipts} required verifying receipts`);
  return gateResult(id, gate, "fail", reasons);
}

function evaluateLifecycleReceipt(id, gate, rootDir, now) {
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
  if (receipt.ok !== true) reasons.push("the readback recorded violations");
  const recordedAt = Date.parse(receipt.recordedAt ?? "");
  if (Number.isNaN(recordedAt)) {
    reasons.push("recordedAt is missing or invalid");
  } else if (now - recordedAt > gate.maxAgeDays * 86_400_000) {
    reasons.push(`receipt is older than ${gate.maxAgeDays} days; re-run the readback`);
  }
  return gateResult(id, gate, reasons.length === 0 ? "pass" : "fail", reasons);
}

function evaluateReceiptArchive(id, gate, rootDir) {
  const directory = path.join(rootDir, gate.directory);
  if (!existsSync(directory)) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ holds no archived release receipt yet`]);
  }
  const archived = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (archived.length === 0) {
    return gateResult(id, gate, "fail", [`${gate.directory}/ holds no archived release receipt yet`]);
  }
  return gateResult(id, gate, "pass", [`${archived.length} archived release receipt(s)`]);
}

/** Uniform operator attestation: named human, dated, every statement literally true. */
export function operatorAttestationIssues(attestation, gateId) {
  if (!isRecord(attestation)) return ["attestation must be an object"];
  const issues = [];
  if (attestation.kind !== OPERATOR_ATTESTATION_KIND) issues.push(`kind must be ${OPERATOR_ATTESTATION_KIND}`);
  if (attestation.gateId !== gateId) issues.push(`gateId must be ${gateId}`);
  if (typeof attestation.attestedBy !== "string" || attestation.attestedBy.trim().length === 0) {
    issues.push("attestedBy must name the operator");
  }
  if (typeof attestation.attestedAt !== "string" || Number.isNaN(Date.parse(attestation.attestedAt))) {
    issues.push("attestedAt must be an ISO 8601 timestamp");
  }
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

function evaluateAttestation(id, gate, rootDir) {
  const attestationPath = path.join(rootDir, gate.attestation);
  if (!existsSync(attestationPath)) return gateResult(id, gate, "fail", [`${gate.attestation} does not exist`]);
  let attestation;
  try {
    attestation = readJson(attestationPath);
  } catch {
    return gateResult(id, gate, "fail", [`${gate.attestation} is not valid JSON`]);
  }
  const issues = operatorAttestationIssues(attestation, id);
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
  if (manifest.artifactKind !== "site-behavior-release-readiness-manifest") {
    return { ready: false, manifestProblems: ["wrong artifactKind"], gates: [] };
  }

  const gates = [];
  for (const [id, gate] of Object.entries(manifest.gates ?? {})) {
    switch (gate.kind) {
      case "decisions":
        gates.push(evaluateDecisions(id, gate, manifest));
        break;
      case "document-digest":
        gates.push(evaluateDocumentDigest(id, gate, manifest, rootDir));
        break;
      case "errata":
        gates.push(evaluateErrata(id, gate, manifest));
        break;
      case "corpus":
        gates.push(evaluateCorpus(id, gate, rootDir));
        break;
      case "aa-study":
        gates.push(evaluateAaStudies(id, gate, rootDir));
        break;
      case "calibration":
        gates.push(evaluateCalibration(id, gate, rootDir));
        break;
      case "review-ledger":
        gates.push(evaluateReviewLedger(id, gate, rootDir));
        break;
      case "runner-receipts":
        gates.push(evaluateRunnerReceipts(id, gate, rootDir));
        break;
      case "lifecycle-receipt":
        gates.push(evaluateLifecycleReceipt(id, gate, rootDir, now));
        break;
      case "receipt-archive":
        gates.push(evaluateReceiptArchive(id, gate, rootDir));
        break;
      case "operator-attestation":
        gates.push(evaluateAttestation(id, gate, rootDir));
        break;
      default:
        gates.push(gateResult(id, gate, "fail", [`unknown gate kind ${JSON.stringify(gate.kind)}`]));
    }
  }
  return {
    ready: gates.length > 0 && gates.every((gate) => gate.status === "pass"),
    manifestProblems: [],
    gates
  };
}
