// Lean v1 qualification is separate from the research measurement programme.
// This module authenticates a source snapshot and retained evidence. It never
// turns a review, a fixture, or a healthy deployment into an error-rate claim.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const V1_PROFILE = "investigative-v1";
export const V1_BINDING_PATH = "research/v1-release-binding.json";
export const V1_BINDING_KIND = "site-behavior-v1-release-binding";
export const V1_QUALIFICATION_PATH = "research/v1-qualification/review.json";
export const V1_GATES = Object.freeze({
  "decisions-approved": "decisions",
  "release-tag-governance": "release-tag-governance",
  "release-candidate-binding": "release-candidate-binding",
  "mode-qualification": "mode-qualification",
  "compatibility-surface-pinned": "document-digest",
  "errata-resolution": "errata",
  "published-corpus-consistency": "published-corpus-consistency",
  "legal-review": "review-ledger",
  "r2-lifecycle": "lifecycle-receipt",
  "release-receipt-archive": "receipt-archive",
  "durable-soak": "durable-soak",
  "egress-backstop": "operator-attestation",
  "waf-ceilings": "operator-attestation",
  "log-retention": "operator-attestation",
  "container-image-licensing": "operator-attestation",
  "container-package-review": "container-package-review"
});
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const FIXED_EVIDENCE = Object.freeze({
  "research/measurement-candidate/site-behavior-lab-container-release-evidence.json": "container-evidence",
  "research/measurement-candidate/container-evidence-manifest.bundle.json": "container-attestation",
  "research/measurement-candidate/site-behavior-lab-container-package-inventory.json": "container-package-inventory",
  "research/measurement-candidate/container-package-inventory.bundle.json": "container-package-attestation",
  "CONTAINER_IMAGE_PACKAGE_REVIEWS.json": "container-package-review",
  "research/ops-receipts/r2-lifecycle-readback.json": "lifecycle-receipt",
  [V1_QUALIFICATION_PATH]: "mode-qualification"
});
const OPERATORS = ["egress-backstop", "waf-ceilings", "log-retention", "container-image-licensing"];
export const V1_QUALIFICATION_CASES = Object.freeze({
  "single-observation": "single",
  "gpc-intervention": "gpc",
  "blocker-intervention": "blocker",
  "consent-intervention": "consent",
  "incomplete-coverage": "single"
});
const REVIEW_QUESTIONS = [
  "observations", "unknowns", "scanner-effects", "interpretation",
  "display", "comparison", "persistence", "export"
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, expected) => record(v) && isDeepStrictEqual(Object.keys(v).sort(), [...expected].sort());
const text = (v) => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 4096;
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const instant = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

function git(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}
function bytes(rootDir, relative) {
  requireValue(typeof relative === "string" && relative.length <= 512 && !relative.includes("\\") &&
    !path.isAbsolute(relative) && relative.split("/").every((s) => s && s !== "." && s !== ".."), "unsafe evidence path");
  const absolute = path.join(rootDir, relative);
  requireValue(realpathSync(absolute) === path.join(realpathSync(rootDir), relative), `${relative} traverses a symbolic link`);
  const stat = lstatSync(absolute);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024, `${relative} is not a bounded regular evidence file`);
  return readFileSync(absolute);
}
function json(rootDir, relative) {
  const raw = bytes(rootDir, relative);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  requireValue(Buffer.from(`${JSON.stringify(value, null, 2)}\n`).equals(raw), `${relative} must be canonical JSON`);
  return value;
}

export function v1ProfileProblems(manifest) {
  if (manifest.releaseProfile === undefined) return []; // Historical research contract.
  const problems = [];
  if (manifest.releaseProfile !== V1_PROFILE) return ["unknown releaseProfile"];
  if (manifest.targetRelease !== "1.0.0") problems.push("investigative-v1 only qualifies target release 1.0.0");
  const actual = Object.fromEntries(Object.entries(manifest.gates ?? {}).map(([id, gate]) => [id, gate?.kind]));
  if (!isDeepStrictEqual(actual, V1_GATES)) problems.push("investigative-v1 must retain its complete gate set and kinds");
  const scope = manifest.decisions?.v1EvidenceScope;
  if (scope?.selected !== V1_PROFILE || scope?.status !== "approved" || !text(scope.decidedBy) || !instant(scope.decidedAt)) {
    problems.push("investigative-v1 requires the approved v1EvidenceScope decision");
  }
  if (manifest.decisions?.jobRecovery?.selected !== "explicit-failure-safe-retry" ||
      manifest.decisions?.stableApiClaim?.recommended !== false) problems.push("investigative-v1 must preserve its lean recovery and API scope");
  for (const [id, kind] of [["detector-calibration", "calibration"], ["aa-repeatability", "aa-study"]]) {
    const deferred = manifest.deferredGates?.[id];
    if (deferred?.kind !== kind || deferred.deferredTo !== "1.1.0" || !text(deferred.reason)) problems.push(`${id} must retain its explicit 1.1 deferral`);
  }
  if (manifest.gates?.["release-candidate-binding"]?.artifact !== V1_BINDING_PATH ||
      manifest.gates?.["mode-qualification"]?.artifact !== V1_QUALIFICATION_PATH ||
      manifest.gates?.["published-corpus-consistency"]?.artifact !== "public/corpus-stats.json") problems.push("v1 evidence paths must remain fixed");
  return problems;
}

function allowedEvidence(entry) {
  if (FIXED_EVIDENCE[entry.path]) return entry.category === FIXED_EVIDENCE[entry.path];
  for (const id of OPERATORS) {
    if (entry.path === `research/ops-evidence/${id}.json`) return entry.category === "operator-evidence";
    if (entry.path === `research/ops-receipts/${id}-attestation.json`) return entry.category === "operator-attestation";
  }
  if (/^research\/ops-receipts\/release-tag-governance\/[0-9a-f]{64}\.json$/.test(entry.path)) return entry.category === "release-tag-governance-receipt";
  if (/^research\/hosted-evidence\/[a-z0-9-]+\/[0-9a-f]{64}\/[a-zA-Z0-9._/-]+$/.test(entry.path)) return entry.category === "hosted-evidence-archive";
  if (/^research\/v1-qualification\/[a-z0-9-]+\/(report\.json|reference\.(json|txt|png)|review-evidence\.(json|txt|png))$/.test(entry.path)) {
    return entry.category === (entry.path.endsWith("/report.json") ? "qualification-report" : "qualification-reference");
  }
  return false;
}

/** Authenticate C and every C..S edit. Only evidence may be added after C;
 * existing reports, source, configuration, policies and workflows stay pinned.
 * A package review can be completed once after the exact image is inventoried.
 * No calendar, corpus size, calibration or durable-enable prerequisite exists.
 */
export function verifyV1ReleaseBinding(rootDir, canonical, { attestationVerifier } = {}) {
  if (!existsSync(path.join(rootDir, V1_BINDING_PATH))) return null;
  const binding = json(rootDir, V1_BINDING_PATH);
  requireValue(keys(binding, ["schemaVersion", "artifactKind", "repository", "targetRelease", "candidateCommit", "candidateTree", "evidence"]) &&
    binding.schemaVersion === 1 && binding.artifactKind === V1_BINDING_KIND && binding.repository === REPOSITORY &&
    binding.targetRelease === "1.0.0" && SHA.test(binding.candidateCommit) && SHA.test(binding.candidateTree), "v1 release binding has an invalid identity or shape");
  const manifest = json(rootDir, "RELEASE_READINESS.json");
  requireValue(manifest.releaseProfile === V1_PROFILE && v1ProfileProblems(manifest).length === 0, "v1 binding requires the complete approved investigative-v1 contract");
  requireValue(git(rootDir, ["status", "--porcelain", "--untracked-files=normal"]) === "", "v1 binding verification requires a clean worktree");
  const carrierCommit = git(rootDir, ["rev-parse", "HEAD"]);
  requireValue(git(rootDir, ["rev-parse", `${binding.candidateCommit}^{tree}`]) === binding.candidateTree, "candidate tree differs from Git");
  git(rootDir, ["merge-base", "--is-ancestor", binding.candidateCommit, carrierCommit]);
  requireValue(Array.isArray(binding.evidence) && binding.evidence.length > 0 && binding.evidence.length <= 10000, "v1 binding needs a bounded evidence set");
  const entries = new Map();
  for (const entry of binding.evidence) {
    requireValue(keys(entry, ["category", "path", "change", "sha256"]) && DIGEST.test(entry.sha256) &&
      allowedEvidence(entry) && !entries.has(entry.path) &&
      (entry.change === "added" || (entry.path === "CONTAINER_IMAGE_PACKAGE_REVIEWS.json" && entry.change === "refreshed")), "v1 binding has an unsupported or duplicate evidence entry");
    requireValue(sha256(bytes(rootDir, entry.path)) === entry.sha256, `${entry.path} digest differs from the binding`);
    entries.set(entry.path, entry);
  }
  for (const relative of [...Object.keys(FIXED_EVIDENCE), ...OPERATORS.flatMap((id) => [
    `research/ops-evidence/${id}.json`, `research/ops-receipts/${id}-attestation.json`
  ])]) requireValue(entries.has(relative), `v1 binding omits required evidence ${relative}`);
  requireValue(binding.evidence.some((e) => e.category === "release-tag-governance-receipt"), "v1 binding omits release governance evidence");
  const range = `${binding.candidateCommit}..${carrierCommit}`;
  requireValue(git(rootDir, ["rev-list", "--merges", range]) === "", "v1 evidence carrier history must be linear");
  const commits = git(rootDir, ["rev-list", "--reverse", range]).split("\n").filter(Boolean);
  const introduced = {};
  const introducedTime = {};
  let bindingIntroduced = false;
  for (const commit of commits) {
    const changes = git(rootDir, ["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", commit]).split("\n").filter(Boolean);
    for (const change of changes) {
      const [status, relative, extra] = change.split("\t");
      requireValue(extra === undefined, "unsupported evidence path in Git diff");
      if (relative === V1_BINDING_PATH) {
        requireValue(status === "A" && !bindingIntroduced && commit === carrierCommit, "v1 binding must be added once in the final carrier commit");
        bindingIntroduced = true;
        continue;
      }
      const entry = entries.get(relative);
      requireValue(entry && !introduced[relative] && status === (entry.change === "added" ? "A" : "M"), `post-candidate change is not single-introduction evidence: ${relative}`);
      introduced[relative] = commit;
      introducedTime[relative] = new Date(git(rootDir, ["show", "-s", "--format=%cI", commit])).toISOString();
    }
  }
  requireValue(bindingIntroduced && entries.size === Object.keys(introduced).length, "every bound artifact must be introduced after C, and the binding added at S");
  const sourcePath = canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH;
  const inventoryPath = canonical.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH;
  const container = canonical.verifySourceEvidenceManifest(json(rootDir, sourcePath), binding.candidateCommit, binding.candidateTree, REPOSITORY);
  canonical.verifyContainerPackageInventory(json(rootDir, inventoryPath), binding.candidateCommit, container);
  const signerWorkflow = `${REPOSITORY}/.github/workflows/ci.yml`;
  const attestations = {};
  for (const [name, subject, artifactPath, bundlePath] of [
    ["containerEvidence", "container-evidence", sourcePath, canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH],
    ["containerPackageInventory", "container-package-inventory", inventoryPath, canonical.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH]
  ]) {
    const request = { subject, artifactPath: path.join(rootDir, artifactPath), bundlePath: path.join(rootDir, bundlePath),
      repository: REPOSITORY, signerWorkflow, certIdentity: `https://github.com/${signerWorkflow}@refs/heads/main`,
      signerDigest: binding.candidateCommit, sourceDigest: binding.candidateCommit, sourceRef: "refs/heads/main",
      denySelfHostedRunners: true, predicateType: "https://slsa.dev/provenance/v1", oidcIssuer: "https://token.actions.githubusercontent.com" };
    (attestationVerifier ?? ((r) => canonical.verifyAttestationWithGh(r, rootDir)))(request);
    attestations[name] = { ...request, status: "verified-by-gh-attestation" };
  }
  return { ...binding, carrierCommit, acceptedProducerCommits: [binding.candidateCommit, ...commits],
    evidenceIntroducedAt: introduced, evidenceIntroducedAtTime: introducedTime,
    bindingSha256: sha256(bytes(rootDir, V1_BINDING_PATH)), evidenceSetDigest: sha256(JSON.stringify(binding.evidence)),
    attestationVerifications: attestations };
}

/** A bounded independent review, not calibration. Raw reports are deep-read;
 * every case retains an independent reference and a specific disposition for
 * each consumer. A machine cannot establish that the human's reference is true.
 * The external whole-binding approval remains required before release authority.
 */
export function v1QualificationProblems(rootDir, context, reader, now = Date.now()) {
  const problems = [];
  try {
    const review = json(rootDir, V1_QUALIFICATION_PATH);
    requireValue(keys(review, ["schemaVersion", "artifactKind", "candidateCommit", "reviewedBy", "reviewedAt", "cases", "limitations"]) &&
      review.schemaVersion === 1 && review.artifactKind === "site-behavior-v1-mode-qualification" &&
      review.candidateCommit === context.binding?.candidateCommit && text(review.reviewedBy) && instant(review.reviewedAt) &&
      Date.parse(review.reviewedAt) <= now && text(review.limitations), "mode qualification requires a candidate-bound named review, nonfuture date and limitations");
    requireValue(Array.isArray(review.cases) && review.cases.length === Object.keys(V1_QUALIFICATION_CASES).length, "mode qualification must cover every declared scenario exactly once");
    const seen = new Set();
    const bound = new Map((context.binding?.evidence ?? []).map((e) => [e.path, e]));
    const readBound = (relative, category) => {
      const entry = bound.get(relative);
      requireValue(entry?.category === category && entry.sha256 === sha256(bytes(rootDir, relative)), `${relative} is not digest-bound ${category} evidence`);
      return relative;
    };
    readBound(V1_QUALIFICATION_PATH, "mode-qualification");
    const reviewedAt = Date.parse(review.reviewedAt);
    const candidateAt = Date.parse(git(rootDir, ["show", "-s", "--format=%cI", context.binding.candidateCommit]));
    const introducedAt = Date.parse(context.binding.evidenceIntroducedAtTime[V1_QUALIFICATION_PATH]);
    requireValue(reviewedAt >= candidateAt && reviewedAt <= introducedAt + 1000, "review must follow the candidate and precede its evidence introduction");
    for (const item of review.cases) {
      requireValue(keys(item, ["id", "mode", "report", "reference", "expectation", "checks"]) &&
        Object.hasOwn(V1_QUALIFICATION_CASES, item.id) && !seen.has(item.id) && item.mode === V1_QUALIFICATION_CASES[item.id] &&
        text(item.expectation), "qualification has a missing, duplicate or unsupported scenario");
      seen.add(item.id);
      readBound(item.reference, "qualification-reference");
      const report = JSON.parse(bytes(rootDir, readBound(item.report, "qualification-report")));
      const parsed = reader.readStoredScanReport(report);
      requireValue(parsed.ok && report.schemaVersion === 2 && report.schemaRevision === 2, `${item.id} report fails the current deep reader: ${JSON.stringify(parsed.violations ?? parsed.error)}`);
      const runs = report.reportType === "single" ? [report.run] : [report.baseline, report.variant,
        ...(report.experiment?.supportingPairs ?? []).flatMap((pair) => [pair.baseline, pair.variant])];
      requireValue(runs.every((run) => context.binding.acceptedProducerCommits.includes(run?.provenance?.buildCommit)), `${item.id} report producer is outside the qualified source`);
      for (const run of runs) {
        const producer = run.provenance.buildCommit;
        const intro = context.binding.evidenceIntroducedAt[item.report];
        requireValue(producer !== intro, `${item.id} cannot be produced by its own evidence introduction`);
        git(rootDir, ["merge-base", "--is-ancestor", producer, intro]);
        const producerAt = Date.parse(git(rootDir, ["show", "-s", "--format=%cI", producer]));
        const completedAt = Date.parse(run.startedAt) + run.summary.durationMs;
        requireValue(instant(run.startedAt) && Date.parse(run.startedAt) >= producerAt &&
          completedAt <= reviewedAt && completedAt <= Date.parse(context.binding.evidenceIntroducedAtTime[item.report]) + 1000,
          `${item.id} acquisition must follow its producer and precede review and introduction`);
      }
      requireValue(item.mode === "single" ? report.reportType === "single" : report.reportType === "comparison", `${item.id} has the wrong report shape`);
      if (item.mode !== "single") requireValue(report.experiment?.kind === "intervention" &&
        report.experiment.axis === ({ gpc: "gpc", blocker: "shields", consent: "consent" })[item.mode], `${item.id} has the wrong intervention axis`);
      if (item.id === "incomplete-coverage") requireValue(runs.some((run) => run.qualityFacts?.captureLoss?.length > 0 ||
        run.qualityFacts?.status === null || run.qualityFacts?.status >= 400), "incomplete-coverage case needs recorded loss or failed document coverage");
      requireValue(keys(item.checks, REVIEW_QUESTIONS), `${item.id} must review every consumer and evidence boundary`);
      for (const [question, check] of Object.entries(item.checks)) {
        requireValue(keys(check, ["status", "evidence", "explanation"]) && ["supported", "explicitly-unavailable"].includes(check.status) && text(check.explanation), `${item.id}/${question} is unresolved or lacks an explanation`);
        readBound(check.evidence, "qualification-reference");
      }
      for (const question of REVIEW_QUESTIONS.filter((q) => q !== "comparison" || item.mode !== "single")) {
        requireValue(item.checks[question].status === "supported", `${item.id}/${question} must be established against the retained reference`);
      }
      if (item.mode !== "single") requireValue(report.experiment.verification.baseline.outcome === "passed" &&
        report.experiment.verification.variant.outcome === "passed", `${item.id} needs a successfully verified intervention pair`);
      if (item.id === "incomplete-coverage") requireValue(item.checks.unknowns.status === "supported", "incomplete coverage must be visibly explained");
    }
  } catch (error) { problems.push(String(error.message ?? error)); }
  return problems;
}

/** Run the existing managed-corpus builder in an isolated process so the sync
 * release evaluator shares its full admission/correction/aggregation contract.
 * Fix generatedAt to the published timestamp; do not rewrite any report.
 */
export function publishedCorpusProblems(rootDir, builderModulePath, schema, now = Date.now()) {
  try {
    const corpus = JSON.parse(bytes(rootDir, "public/corpus-stats.json"));
    requireValue(corpus.version === schema.CORPUS_STATS_ARTIFACT_VERSION && schema.isCorpusStats(corpus), "published corpus fails the canonical current-version reader");
    requireValue(instant(corpus.generatedAt) && Date.parse(corpus.generatedAt) <= now, "published corpus timestamp is invalid or future-dated");
    const raw = execFileSync(process.execPath, ["-e",
      'require(process.argv[1]).buildCorpusStats(process.argv[2], new Date(process.argv[3])).then(({stats}) => process.stdout.write(JSON.stringify(stats))).catch(e => { console.error(e.message); process.exitCode = 1; });',
      builderModulePath, path.join(rootDir, "public/reports"), corpus.generatedAt
    ], { cwd: rootDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    requireValue(isDeepStrictEqual(corpus, JSON.parse(raw)), "published corpus does not equal the managed-report aggregation across every cohort");
    return [];
  } catch (error) { return [String(error.message ?? error).slice(0, 500)]; }
}
