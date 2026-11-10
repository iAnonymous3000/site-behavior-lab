import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { pathToFileURL } from "node:url";
import * as canonical from "./measurement-candidate-binding";
import * as reader from "./scan-report-reader";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { buildCorpusStats } from "./corpus-stats-builder";
import * as corpusSchema from "./corpus-stats";
import {
  makePublicSingleReportV2R2, makeGpcInterventionReportV2R2,
  makeShieldsInterventionReportV2R2, makeConsentInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";

// Test seams replace only external authentication; Git and bytes remain real.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Any>;
const contract = () => nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/v1-release-contract.mjs")).href);
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const manifest = () => JSON.parse(readFileSync(path.join(process.cwd(), "RELEASE_READINESS.json"), "utf8"));
const LIVE_OPERATOR_GATES = ["waf-ceilings", "container-image-licensing"];
const DEFERRED_OPERATOR_GATES = ["egress-backstop", "log-retention"];
const FV_REPORT = "research/measurement-candidate/site-behavior-lab-formal-verification-report.json";
const FV_BUNDLE = "research/measurement-candidate/formal-verification-report.bundle.json";
const FV_UNVERIFIED = "the formal verification report's Sigstore bundle was not verified for this subject at the candidate commit";

// The report's own module, loaded once: the fixture below builds a report with
// the builder the producer uses, so the two cannot drift.
let fv: Any;
before(async () => {
  fv = await nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/formal-verification-report-lib.mjs")).href);
});

/** The records of a run that meets every required suite exactly at its pinned minimums. */
function requiredSuiteRecords(): Any[] {
  return manifest().gates["formal-verification"].requiredSuites.map((suite: Any) => ({
    id: suite.id,
    counts: { tests: suite.minimumTests, passed: suite.minimumTests, failed: 0, cancelled: 0, skipped: 0, todo: 0, expectedFailures: 0, skippedSuites: 0, todoSuites: 0, failedSuites: 0 },
    tests: Array.from({ length: suite.minimumTests }, (_, index) => ({ name: `test ${String(index).padStart(4, "0")}`, outcome: "passed" })),
    variants: Array.from({ length: suite.minimumVariants }, (_, index) => ({ variant: `variant ${String(index).padStart(4, "0")}`, property: "the property", caughtBy: "the property" }))
  }));
}

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-v1-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let gitMoment = "2026-09-06T10:07:00Z";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_DATE: gitMoment, GIT_COMMITTER_DATE: gitMoment } }).trim();
  const write = (relative: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), typeof value === "string" ? value : serialize(value));
  };
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-b", "main"); git("config", "user.name", "Fixture Maintainer"); git("config", "user.email", "fixture@example.test");
  write("RELEASE_READINESS.json", manifest());
  write("app.js", "source version one\n");
  write("research/ops-receipts/r2-lifecycle-readback.json", { historical: true });
  const candidate = commit("Candidate");
  const candidateTree = git("rev-parse", "HEAD^{tree}");
  gitMoment = "2026-09-06T10:10:00Z";
  const evidence: Any[] = [];
  const add = (relative: string, category: string, value: unknown) => {
    write(relative, value);
    evidence.push({ category, path: relative, change: "added", sha256: hash(readFileSync(path.join(root, relative))) });
  };
  add(canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH, "container-evidence", { fixture: "source" });
  add(canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH, "container-attestation", { fixture: "bundle" });
  add(canonical.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH, "container-package-inventory", { fixture: "inventory" });
  add(canonical.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH, "container-package-attestation", { fixture: "bundle" });
  add("CONTAINER_IMAGE_PACKAGE_REVIEWS.json", "container-package-review", { fixture: "review" });
  add("research/ops-receipts/v1-r2-lifecycle-readback.json", "lifecycle-receipt", { fixture: "lifecycle" });
  // Only the live operator gates. The two deferred to 1.1 are bound by the
  // tests that exercise a carrier presenting their evidence anyway.
  for (const id of LIVE_OPERATOR_GATES) {
    add(`research/ops-evidence/${id}.json`, "operator-evidence", { fixture: id });
    add(`research/ops-receipts/${id}-attestation.json`, "operator-attestation", { fixture: id });
  }
  add(`research/ops-receipts/release-tag-governance/${"a".repeat(64)}.json`, "release-tag-governance-receipt", { fixture: "governance" });
  // The execution report CI would have signed at the candidate, and its bundle.
  const report: Any = fv.buildFormalVerificationReport({ commit: candidate, tree: candidateTree, suites: requiredSuiteRecords() });
  add(FV_REPORT, "formal-verification-report", report);
  add(FV_BUNDLE, "formal-verification-attestation", { fixture: "bundle" });
  /** Replace the bound report's bytes, keeping its binding entry true to them. */
  const rewriteReport = (value: unknown) => {
    write(FV_REPORT, value);
    evidence.find((e) => e.path === FV_REPORT).sha256 = hash(readFileSync(path.join(root, FV_REPORT)));
  };
  const review: Any = { schemaVersion: 1, artifactKind: "site-behavior-v1-mode-qualification", candidateCommit: candidate,
    reviewedBy: "Fixture reviewer", reviewedAt: "2026-09-06T10:09:59.000Z", cases: [], limitations: "Only these controlled fixtures are covered; no population accuracy estimate." };
  for (const [id, mode, factory] of [
    ["single-observation", "single", makePublicSingleReportV2R2],
    ["gpc-intervention", "gpc", makeGpcInterventionReportV2R2],
    ["blocker-intervention", "blocker", makeShieldsInterventionReportV2R2],
    ["consent-intervention", "consent", makeConsentInterventionReportV2R2],
    ["incomplete-coverage", "single", makePublicSingleReportV2R2]
  ] as const) {
    const report: Any = factory();
    for (const run of report.reportType === "single" ? [report.run] : [report.baseline, report.variant]) {
      run.provenance.buildCommit = candidate;
      run.startedAt = new Date(Date.parse(run.startedAt) + Date.parse("2026-09-06T10:08:00Z") - Date.parse("2026-07-09T10:00:00Z")).toISOString();
      run.fingerprints = buildFingerprints(run);
      if (id === "incomplete-coverage") {
        run.qualityFacts.captureLoss = [{ family: "requests", phaseId: null, kind: "dropped", count: 1 }];
        run.quality = evaluateQuality(run.qualityFacts, { observedRequests: run.evidence.requests.length });
      }
    }
    const reportPath = `research/v1-qualification/${id}/report.json`;
    const reference = `research/v1-qualification/${id}/reference.txt`;
    add(reportPath, "qualification-report", report);
    add(reference, "qualification-reference", "Independent fixture-server expectation and consumer inspection record.\n");
    const checks = Object.fromEntries(["observations", "unknowns", "scanner-effects", "interpretation", "display", "comparison", "persistence", "export"].map((q) =>
      [q, { status: "supported", evidence: reference, explanation: `Fixture review of ${q} matches the retained reference.` }]));
    review.cases.push({ id, mode, report: reportPath, reference, expectation: "The controlled request and attempted intervention agree with the retained server log.", checks });
  }
  add("research/v1-qualification/review.json", "mode-qualification", review);
  const bind = () => {
    const value = { schemaVersion: 1, artifactKind: "site-behavior-v1-release-binding", repository: "iAnonymous3000/site-behavior-lab", targetRelease: "1.0.0", candidateCommit: candidate, candidateTree, evidence };
    write("research/v1-release-binding.json", value);
    commit("Retain qualification evidence");
    return value;
  };
  const calls: Any[] = [];
  const instruments = { ...canonical,
    verifySourceEvidenceManifest: (value: unknown, c: string, tree: string, repo: string) => {
      assert.deepEqual(value, { fixture: "source" }); assert.equal(c, candidate); assert.equal(tree, candidateTree); assert.equal(repo, "iAnonymous3000/site-behavior-lab"); return { fixture: "container" };
    },
    verifyContainerPackageInventory: (value: unknown, c: string, container: unknown) => {
      assert.deepEqual(value, { fixture: "inventory" }); assert.equal(c, candidate); assert.deepEqual(container, { fixture: "container" });
    }
  };
  return { root, candidate, candidateTree, git, write, commit, add, bind, evidence, review, instruments, calls, report, rewriteReport,
    options: { attestationVerifier: (request: Any) => { calls.push(request); } } };
}

test("v1 scope cannot silently lose gates or claim the deferred capability", async () => {
  const c = await contract();
  assert.deepEqual(c.v1ProfileProblems(manifest()), []);
  for (const id of Object.keys(manifest().gates)) {
    const m = manifest(); delete m.gates[id];
    assert.ok(c.v1ProfileProblems(m).length, id);
  }
  const m = manifest(); m.releaseProfile = "anything-goes";
  assert.ok(c.v1ProfileProblems(m).length);
  m.releaseProfile = "investigative-v1"; delete m.deferredGates["aa-repeatability"];
  assert.ok(c.v1ProfileProblems(m).length);
  const future = manifest(); future.targetRelease = "1.1.0";
  assert.ok(c.v1ProfileProblems(future).length);
});

test("each operator deferral is held by name: a dropped, retargeted, hollow or doubled record is refused", async () => {
  const c = await contract();
  const refusal = (mutate: (m: Any) => void): string[] => { const m = manifest(); mutate(m); return c.v1ProfileProblems(m); };
  const GATE_SET = "investigative-v1 must retain its complete gate set and kinds";
  assert.deepEqual(c.v1ProfileProblems(manifest()), [], "the committed manifest with both deferrals is the accepted contract");
  assert.deepEqual(Object.keys(manifest().gates).filter((id) => DEFERRED_OPERATOR_GATES.includes(id)), []);
  for (const id of DEFERRED_OPERATOR_GATES) {
    const retain = `${id} must retain its explicit 1.1 deferral`;
    const doubled = `${id} is deferred to 1.1 and must not also be a live gate`;
    assert.equal(manifest().deferredGates[id].kind, "operator-attestation");
    // Absent from both places: the gate would simply vanish from 1.0 and 1.1.
    assert.deepEqual(refusal((m) => { delete m.deferredGates[id]; }), [retain]);
    assert.deepEqual(refusal((m) => { delete m.deferredGates; }).filter((p) => p.startsWith(`${id} `)), [retain]);
    for (const deferredTo of ["1.0.0", "1.2.0", "", undefined, null]) {
      assert.deepEqual(refusal((m) => { m.deferredGates[id].deferredTo = deferredTo; }), [retain], `deferredTo ${String(deferredTo)}`);
    }
    for (const reason of ["", " ", undefined, null, 7]) {
      assert.deepEqual(refusal((m) => { m.deferredGates[id].reason = reason; }), [retain], `reason ${JSON.stringify(reason)}`);
    }
    assert.deepEqual(refusal((m) => { m.deferredGates[id].kind = "review-ledger"; }), [retain]);
    // Put back without removing its deferral: one gate cannot be both.
    assert.deepEqual(refusal((m) => { m.gates[id] = { ...m.deferredGates[id] }; }), [GATE_SET, doubled]);
    // Put back and the record dropped: restoring the gate takes the reviewed
    // edit to the contract itself, never a manifest edit alone.
    assert.deepEqual(refusal((m) => { m.gates[id] = { ...m.deferredGates[id] }; delete m.deferredGates[id]; }), [GATE_SET, retain, doubled]);
  }
});

test("a deferred operator gate's evidence is not required, and is admitted and evaluated in full when a carrier binds it", async (t) => {
  const c = await contract();
  const release = await nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/release-readiness-lib.mjs")).href);
  const now = Date.parse("2026-09-06T11:00:00Z");
  // The context release readiness builds around a verified v1 binding.
  const context = (binding: Any) => ({ configured: true, profile: "investigative-v1", binding, problems: [],
    module: { measurementCandidateAcceptsProducerCommit: canonical.measurementCandidateAcceptsProducerCommit } });
  const pair = (id: string) => [`research/ops-evidence/${id}.json`, `research/ops-receipts/${id}-attestation.json`];
  // Stands for the live gates, all satisfied, so only a deferred gate can
  // decide the verdict below.
  const live = [{ id: "live-gate", title: "live", kind: "decisions", status: "pass", reasons: [] }];
  const conclude = (root: string, binding: Any) => release.concludeReleaseReadiness(live, manifest(), root, now, context(binding), null);

  // Not required: a carrier that binds neither deferred pair still verifies,
  // and neither deferred gate contributes a verdict.
  const lean = fixture(t); lean.bind();
  const leanBinding = c.verifyV1ReleaseBinding(lean.root, lean.instruments, lean.options);
  const boundPaths = leanBinding.evidence.map((e: Any) => e.path);
  for (const id of DEFERRED_OPERATOR_GATES) for (const relative of pair(id)) assert.equal(boundPaths.includes(relative), false, relative);
  const leanResult = conclude(lean.root, leanBinding);
  assert.deepEqual(leanResult.gates, live);
  assert.equal(leanResult.ready, true);
  assert.deepEqual(leanResult.manifestProblems, []);
  assert.deepEqual(leanResult.deferredGates.map((g: Any) => [g.id, g.deferredTo]), [
    ["detector-calibration", "1.1.0"], ["aa-repeatability", "1.1.0"], ["egress-backstop", "1.1.0"], ["log-retention", "1.1.0"]
  ]);

  // The relaxation is for deferred gates only: a live operator gate's pair
  // stays required, file by file.
  for (const id of LIVE_OPERATOR_GATES) for (const relative of pair(id)) {
    const f = fixture(t);
    f.evidence.splice(f.evidence.findIndex((e: Any) => e.path === relative), 1);
    unlinkSync(path.join(f.root, relative)); f.bind();
    assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, f.options),
      new RegExp(`v1 binding omits required evidence ${relative.replaceAll(".", "\\.")}$`));
  }

  // Bound anyway, whole pair or half: the binding admits the bytes under its
  // digest and single-introduction rules, and the gate is then evaluated in
  // full against its retained definition instead of being reported as
  // deferred. Its failure makes the release not ready although every live
  // gate passed. The evidence bytes are not canonical evidence, and the
  // operator left the first required claim unaffirmed, so the evaluation must
  // fail on each of those, not merely on the gate's standing refusal.
  for (const id of DEFERRED_OPERATOR_GATES) {
    const [evidencePath, attestationPath] = pair(id);
    const claims: { id: string }[] = manifest().deferredGates[id].requiredClaims;
    const attestation = release.buildReleaseAttestationScaffold(manifest(), id, {});
    attestation.attestedBy = "Fixture operator";
    attestation.attestedAt = "2026-09-06T10:09:30.000Z";
    attestation.evidenceCapturedAt = "2026-09-06T10:09:00.000Z";
    for (const statement of attestation.statements) statement.true = statement.claimId !== claims[0].id;
    for (const bound of [[evidencePath, attestationPath], [evidencePath], [attestationPath]]) {
      const f = fixture(t);
      if (bound.includes(evidencePath)) f.add(evidencePath, "operator-evidence", { fixture: id });
      if (bound.includes(attestationPath)) f.add(attestationPath, "operator-attestation", attestation);
      f.bind();
      const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
      const result = conclude(f.root, binding);
      assert.equal(result.ready, false, bound.join(" + "));
      assert.deepEqual(result.gates.map((g: Any) => [g.id, g.kind, g.status]),
        [["live-gate", "decisions", "pass"], [id, "operator-attestation", "fail"]], bound.join(" + "));
      assert.deepEqual(result.deferredGates.map((g: Any) => g.id),
        ["detector-calibration", "aa-repeatability", ...DEFERRED_OPERATOR_GATES.filter((other) => other !== id)],
        "an evaluated gate is not also reported as deferred");
      const reasons: string[] = result.gates[1].reasons;
      // The gate's own refusal still stands: no hand attestation can pass it.
      assert.ok(reasons.includes(`trusted GitHub-hosted ${id} provider capture is unavailable; caller-supplied source digests and a hand attestation cannot satisfy this gate`), reasons.join("\n"));
      assert.equal(reasons.some((reason) => reason.startsWith(`${evidencePath} failed canonical parsing`)), bound.includes(evidencePath), reasons.join("\n"));
      assert.equal(reasons.includes(`${evidencePath} does not exist`), !bound.includes(evidencePath), reasons.join("\n"));
      assert.equal(reasons.includes(`${attestationPath} does not exist`), !bound.includes(attestationPath), reasons.join("\n"));
      // The bound attestation's content is judged claim by claim.
      assert.equal(reasons.includes(`required claim ${claims[0].id} is missing`), bound.includes(attestationPath), reasons.join("\n"));
      assert.equal(reasons.includes(`required claim ${claims[1].id} is missing`), false, reasons.join("\n"));
    }
  }

  // A bound byte that differs from its digest is refused by the binding
  // itself, deferred gate or not.
  const tampered = fixture(t);
  tampered.add(pair("log-retention")[1], "operator-attestation", { fixture: "log-retention" });
  tampered.evidence.at(-1).sha256 = "f".repeat(64); tampered.bind();
  assert.throws(() => c.verifyV1ReleaseBinding(tampered.root, tampered.instruments, tampered.options), /log-retention-attestation\.json digest differs from the binding/);
});

test("v1 accepts an authenticated evidence-only carrier without a research freeze, cycles, or durable enablement", async (t) => {
  const c = await contract(); const f = fixture(t); f.bind();
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  assert.equal(binding.candidateCommit, f.candidate);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, "research/ops-receipts/r2-lifecycle-readback.json"), "utf8")), { historical: true });
  // The two container subjects and the formal verification report, each with its own bundle.
  assert.deepEqual(f.calls.map((call: Any) => [call.subject, path.relative(f.root, call.artifactPath), path.relative(f.root, call.bundlePath)]), [
    ["container-evidence", canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH, canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH],
    ["container-package-inventory", canonical.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH, canonical.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH],
    ["formal-verification-report", FV_REPORT, FV_BUNDLE]
  ]);
  for (const call of f.calls) {
    assert.equal(call.sourceDigest, f.candidate); assert.equal(call.signerDigest, f.candidate);
    assert.equal(call.sourceRef, "refs/heads/main"); assert.equal(call.denySelfHostedRunners, true);
    assert.equal(call.certIdentity, "https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml@refs/heads/main");
  }
  assert.deepEqual(c.v1QualificationProblems(f.root, { binding }, reader, Date.parse("2026-09-06T11:00:00Z")), []);
  assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, { attestationVerifier: () => { throw new Error("invalid signature"); } }), /invalid signature/);
});

test("v1 rejects hidden source changes even when they are reverted before the final carrier", async (t) => {
  const c = await contract(); const f = fixture(t);
  f.write("app.js", "altered instrument\n"); f.commit("Intervening source change");
  f.write("app.js", "source version one\n"); f.bind();
  assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, f.options), /post-candidate change/);
});

test("v1 rejects unbound bytes, duplicate evidence and missing build evidence", async (t) => {
  const c = await contract();
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.evidence[0].sha256 = "f".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.evidence.push(f.evidence[0]); },
    (f: ReturnType<typeof fixture>) => { f.evidence.splice(0, 1); }
  ]) {
    const f = fixture(t); mutate(f); f.bind();
    assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, f.options));
    assert.equal(f.calls.length, 0);
  }
});

test("candidate-tree substitution fails before external authentication", async (t) => {
  const c = await contract(); const f = fixture(t); const binding = f.bind();
  binding.candidateTree = "f".repeat(40);
  f.write("research/v1-release-binding.json", binding);
  f.git("add", "."); f.git("commit", "--amend", "--no-edit");
  assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, f.options), /candidate tree differs/);
  assert.equal(f.calls.length, 0);
});

test("preparation does not require its own final binding and archives use the released profile", async (t) => {
  const release = await nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/release-readiness-lib.mjs")).href);
  const f = fixture(t);
  // A draft must reach canonical-evidence validation before a binding exists.
  // Deliberately invalid provider bytes still cannot generate an attestation.
  assert.throws(() => release.releaseAttestationScaffold("waf-ceilings", f.root), /canonical operator evidence is required/);
  // A deferred gate keeps its definition, so its attestation can still be
  // prepared. It reaches the same evidence check instead of being refused as
  // an unknown gate, which would cut the route back to a live gate.
  for (const id of DEFERRED_OPERATOR_GATES) {
    assert.throws(() => release.releaseAttestationScaffold(id, f.root),
      new RegExp(`canonical operator evidence is required: research/ops-evidence/${id}\\.json does not exist`));
  }
  f.bind(); const released = f.git("rev-parse", "HEAD");
  const historicalProfile = manifest(); delete historicalProfile.releaseProfile;
  f.write("RELEASE_READINESS.json", historicalProfile); f.commit("Later profile");
  const old = release.archivedReleaseGovernanceProblems(f.root, released, "a".repeat(64));
  assert.ok(!old.some((p: string) => /binding\.json is unavailable/.test(p)), old.join("; "));
  f.write("RELEASE_READINESS.json", manifest());
  unlinkSync(path.join(f.root, "research/v1-release-binding.json")); f.commit("Missing current binding");
  const missing = release.archivedReleaseGovernanceProblems(f.root, f.git("rev-parse", "HEAD"), "a".repeat(64));
  assert.ok(missing.some((p: string) => /research\/v1-release-binding\.json is unavailable/.test(p)), missing.join("; "));
});

test("a small truthful corpus is release-valid while its benchmarks stay unavailable", async (t) => {
  const c = await contract();
  const root = mkdtempSync(path.join(tmpdir(), "sbl-small-corpus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/reports"), { recursive: true });
  const { stats } = await buildCorpusStats(path.join(root, "public/reports"), new Date("2026-09-06T10:00:00Z"));
  const write = (value: unknown) => writeFileSync(path.join(root, "public/corpus-stats.json"), serialize(value));
  write(stats);
  const check = () => c.publishedCorpusProblems(root, path.join(__dirname, "corpus-stats-builder.js"), corpusSchema, Date.parse("2026-09-06T11:00:00Z"));
  assert.deepEqual(check(), []);
  assert.equal(corpusSchema.CORPUS_MIN_SAMPLE, 50);
  assert.equal(corpusSchema.corpusIsUsable(stats), false);
  write({ ...stats, sampleSize: 50 });
  assert.ok(check().length, "inventing eligibility must fail");
  write({ ...stats, generatedAt: "2099-01-01T00:00:00.000Z" });
  assert.ok(check().length, "future evidence must fail");
});

test("bounded qualification refuses missing references, wrong axes, unresolved consumers and future review", async (t) => {
  const c = await contract();
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.review.cases[0].reference = "research/unbound.txt"; },
    (f: ReturnType<typeof fixture>) => { f.review.cases[1].report = f.review.cases[2].report; },
    (f: ReturnType<typeof fixture>) => { f.review.cases[0].checks.export.status = "explicitly-unavailable"; },
    (f: ReturnType<typeof fixture>) => { f.review.reviewedAt = "2099-01-01T00:00:00.000Z"; },
    (f: ReturnType<typeof fixture>) => { f.review.cases.pop(); }
  ]) {
    const f = fixture(t); mutate(f);
    f.write("research/v1-qualification/review.json", f.review);
    f.evidence.find((e) => e.category === "mode-qualification").sha256 = hash(serialize(f.review));
    f.bind(); const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
    assert.ok(c.v1QualificationProblems(f.root, { binding }, reader, Date.parse("2026-09-06T11:00:00Z")).length);
  }
});

// ---------------------------------------------------------------------------
// The formal-verification gate: its contract, its binding and its verdict.
// ---------------------------------------------------------------------------

const releaseLib = () => nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/release-readiness-lib.mjs")).href);
/** The context release readiness builds around a verified v1 binding, or around its failure. */
const verifiedContext = (binding: Any) => ({ configured: true, profile: "investigative-v1", binding, problems: [],
  module: { measurementCandidateAcceptsProducerCommit: canonical.measurementCandidateAcceptsProducerCommit } });
const failedContext = (problem: string) => ({ configured: true, profile: "investigative-v1", binding: null, module: null,
  problems: [`v1 release candidate verification failed: ${problem}`] });
const fvGate = () => manifest().gates["formal-verification"];

test("the profile holds the formal-verification gate, its kind, its paths and every required suite with its minimums", async () => {
  const c = await contract();
  const refusal = (mutate: (m: Any) => void): string[] => { const m = manifest(); mutate(m); return c.v1ProfileProblems(m); };
  const GATE_SET = "investigative-v1 must retain its complete gate set and kinds";
  const PATHS = "v1 evidence paths must remain fixed";
  const suites: Any[] = fvGate().requiredSuites;
  assert.deepEqual(suites, c.V1_REQUIRED_SUITES, "the committed manifest lists exactly the contract's suites");
  assert.ok(suites.length > 0);
  assert.deepEqual(c.v1ProfileProblems(manifest()), []);

  // The gate removed, or its kind changed.
  assert.deepEqual(refusal((m) => { delete m.gates["formal-verification"]; }),
    [GATE_SET, ...suites.map((suite) => `formal-verification must retain required suite ${suite.id}`), PATHS]);
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].kind = "review-ledger"; }), [GATE_SET]);
  assert.deepEqual(refusal((m) => { m.deferredGates["formal-verification"] = { ...m.gates["formal-verification"], deferredTo: "1.1.0", reason: "later" }; delete m.gates["formal-verification"]; }).slice(0, 1),
    [GATE_SET], "moving the gate to the deferred list is not a deferral this contract knows");

  // Each entry is held by name: dropped, or made to ask for less, or for more.
  for (const [index, suite] of suites.entries()) {
    assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites.splice(index, 1); }),
      [`formal-verification must retain required suite ${suite.id}`]);
    for (const field of ["minimumTests", "minimumVariants"]) {
      for (const change of [-1, 1]) {
        if (suite[field] + change < 0) continue;
        assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites[index][field] += change; }),
          [`formal-verification must keep the pinned minimums of ${suite.id}`], `${suite.id} ${field} ${change}`);
      }
    }
    assert.deepEqual(refusal((m) => { delete m.gates["formal-verification"].requiredSuites[index].minimumVariants; }),
      [`formal-verification must keep the pinned minimums of ${suite.id}`]);
    assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites[index].note = "reviewed"; }),
      [`formal-verification must keep the pinned minimums of ${suite.id}`]);
  }
  // The whole list gone, emptied, or no list at all.
  for (const value of [undefined, [], null, "all", {}]) {
    assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites = value; }),
      suites.map((suite) => `formal-verification must retain required suite ${suite.id}`), JSON.stringify(value));
  }
  // A suite the contract does not pin, a repeated entry, another order.
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites.push({ id: "lib/fv-unreviewed.test.ts", minimumTests: 1, minimumVariants: 0 }); }),
    ["formal-verification names a suite this contract does not pin: lib/fv-unreviewed.test.ts"]);
  const EXACT = "formal-verification must list its required suites exactly as this contract does";
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites.push(m.gates["formal-verification"].requiredSuites[0]); }), [EXACT]);
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites.reverse(); }), [EXACT]);
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].requiredSuites.push("lib/fv-coverage-loss.test.ts"); }), [EXACT]);
  // The evidence paths.
  assert.deepEqual(refusal((m) => { m.gates["formal-verification"].report = "research/elsewhere/report.json"; }), [PATHS]);
  assert.deepEqual(refusal((m) => { delete m.gates["formal-verification"].bundle; }), [PATHS]);
});

test("the formal-verification gate passes on a carrier that binds a report CI signed at the candidate", async (t) => {
  const c = await contract(); const release = await releaseLib(); const f = fixture(t); f.bind();
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  const verified = binding.attestationVerifications.formalVerificationReport;
  assert.equal(verified.status, "verified-by-gh-attestation");
  assert.equal(verified.subject, "formal-verification-report");
  assert.equal(verified.signerDigest, f.candidate);
  assert.equal(verified.sourceDigest, f.candidate);
  assert.equal(verified.certIdentity, "https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml@refs/heads/main");

  const result = release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(binding));
  const suites: Any[] = fvGate().requiredSuites;
  const tests = suites.reduce((sum, suite) => sum + suite.minimumTests, 0);
  const variants = suites.reduce((sum, suite) => sum + suite.minimumVariants, 0);
  assert.deepEqual(result, {
    id: "formal-verification", title: fvGate().title, kind: "formal-verification", status: "pass",
    reasons: [
      `${suites.length} required suite files ran at the candidate: ${tests} tests passed, none skipped, and ${variants} variants were caught, each by the property its suite names.`,
      "This shows the suites ran and passed at the candidate. It adds nothing to what each test claims over its own domain."
    ]
  });
  // Bound like any other evidence, it leaves the other gates of the carrier as they were.
  assert.deepEqual(c.v1QualificationProblems(f.root, { binding }, reader, Date.parse("2026-09-06T11:00:00Z")), []);
});

// What a report can say that the gate must refuse, each with the reason it gives.
const FIRST = "investigation/test/case-exploration.test.ts";
const REFUSED_REPORTS = [
  ["a report for another commit", (r: Any) => { r.source.commit = "c".repeat(40); },
    (f: Any) => [`the report is for commit ${"c".repeat(40)}, not ${f.candidate}`]],
  ["a report for another tree", (r: Any) => { r.source.tree = "d".repeat(40); },
    (f: Any) => [`the report is for tree ${"d".repeat(40)}, not ${f.candidateTree}`]],
  ["a required suite absent from the report", (r: Any) => { r.suites.shift(); },
    () => [`required suite ${FIRST} is absent from the report`]],
  ["a suite the manifest does not require", (r: Any) => { r.suites.push({ ...r.suites.at(-1), id: "lib/zz-unrequired.test.ts" }); },
    () => ["the report names lib/zz-unrequired.test.ts, which is not a required suite"]],
  ["a suite with a skipped test", (r: Any) => { r.suites[0].tests.push({ name: "zz left out", outcome: "skipped" }); r.suites[0].counts.tests += 1; r.suites[0].counts.skipped = 1; },
    () => [`${FIRST}: 1 test skipped, the first by name "zz left out"`]],
  ["a suite with a skipped describe block", (r: Any) => { r.suites[0].counts.skippedSuites = 2; },
    () => [`${FIRST}: 2 describe blocks skipped`]],
  ["a suite with a describe block left todo", (r: Any) => { r.suites[0].counts.todoSuites = 1; },
    () => [`${FIRST}: 1 describe block left todo`]],
  // node counts no failure for a block that fails as a block, and exits 0: this count is what holds it.
  ["a suite with a describe block that failed as a block", (r: Any) => { r.suites[0].counts.failedSuites = 1; },
    () => [`${FIRST}: 1 describe block failed as a block`]],
  // node counts a test that failed as expected among its passes: it is no pass, and counts toward no minimum.
  ["a suite with a test that failed as expected", (r: Any) => { r.suites[0].tests.at(-1).outcome = "expected-failure"; r.suites[0].counts.expectedFailures = 1; },
    (_f: Any, suite: Any) => [`${FIRST}: 1 test failed as expected, which is no pass, the first by name "test ${String(suite.minimumTests - 1).padStart(4, "0")}"`,
      `${FIRST}: ${suite.minimumTests - 1} tests passed, below its pinned minimum of ${suite.minimumTests}`]],
  ["a suite with a test left todo", (r: Any) => { r.suites[0].tests.push({ name: "zz to be written", outcome: "todo" }); r.suites[0].counts.tests += 1; r.suites[0].counts.todo = 1; },
    () => [`${FIRST}: 1 test left todo, the first by name "zz to be written"`]],
  ["a suite with a failed test", (r: Any) => { r.suites[0].tests.at(-1).outcome = "failed"; r.suites[0].counts.passed -= 1; r.suites[0].counts.failed = 1; },
    (_f: Any, suite: Any) => [`${FIRST}: 1 test failed or cancelled, the first by name "test ${String(suite.minimumTests - 1).padStart(4, "0")}"`,
      `${FIRST}: ${suite.minimumTests - 1} tests passed, below its pinned minimum of ${suite.minimumTests}`]],
  ["a cardinality below its pin", (r: Any) => { r.suites[0].tests.pop(); r.suites[0].counts.tests -= 1; r.suites[0].counts.passed -= 1; },
    (_f: Any, suite: Any) => [`${FIRST}: ${suite.minimumTests - 1} tests passed, below its pinned minimum of ${suite.minimumTests}`]],
  ["a variant that was not caught", (r: Any) => { r.suites[0].variants.pop(); },
    (_f: Any, suite: Any) => [`${FIRST}: ${suite.minimumVariants - 1} variants caught for its reason, below its pinned minimum of ${suite.minimumVariants}`]],
  ["a variant caught without its reason", (r: Any) => { r.suites[0].variants[0].caughtBy = "another property"; },
    (_f: Any, suite: Any) => [`${FIRST}: variant "variant 0000" was caught by "another property", not by its reason "the property"`,
      `${FIRST}: ${suite.minimumVariants - 1} variants caught for its reason, below its pinned minimum of ${suite.minimumVariants}`]],
  ["an unknown field in the report", (r: Any) => { r.reviewedBy = "someone"; },
    () => [`${FV_REPORT}: malformed report: the report must hold exactly schemaVersion, artifactKind, source and suites, in that order`]],
  ["an unknown field in a suite", (r: Any) => { r.suites[0].method = "exhaustive"; },
    () => [`${FV_REPORT}: malformed report: ${FIRST} must hold exactly id, counts, tests and variants, in that order`]],
  ["another artifact's kind", (r: Any) => { r.artifactKind = "exact-source-and-tested-artifact-manifest"; },
    () => [`${FV_REPORT}: malformed report: artifactKind must be site-behavior-formal-verification-execution-report`]]
] as const;

test(`the formal-verification gate refuses each report that does not meet its rule: ${REFUSED_REPORTS.map(([name]) => name).join("; ")}`, async (t) => {
  const c = await contract(); const release = await releaseLib(); const f = fixture(t); f.bind();
  assert.equal(f.report.suites[0].id, FIRST);
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  for (const [name, change, reasons] of REFUSED_REPORTS) {
    const report = structuredClone(f.report);
    (change as (r: Any) => void)(report);
    // Each report is held by the binding like the good one, so only the
    // gate's reading of its content stands in its way.
    f.write(FV_REPORT, report);
    const bound = structuredClone(binding);
    bound.evidence.find((e: Any) => e.path === FV_REPORT).sha256 = hash(readFileSync(path.join(f.root, FV_REPORT)));
    const result = release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(bound));
    assert.equal(result.status, "fail", name);
    assert.deepEqual(result.reasons, (reasons as (f: Any, suite: Any) => string[])(f, fvGate().requiredSuites[0]), name);
  }
  // The good report, put back, passes again: each refusal above was the report's.
  f.write(FV_REPORT, f.report);
  assert.equal(release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(binding)).status, "pass");
});

test("a report that cannot be read as one fails the formal-verification gate and no other", async (t) => {
  const c = await contract(); const release = await releaseLib(); const f = fixture(t);
  // Bound and signed as it is: the carrier authenticates bytes, and does not read them.
  writeFileSync(path.join(f.root, FV_REPORT), "{ not json\n");
  f.evidence.find((e) => e.path === FV_REPORT).sha256 = hash(readFileSync(path.join(f.root, FV_REPORT)));
  f.bind();
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  assert.deepEqual(release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(binding)).reasons,
    [`${FV_REPORT}: the report is not JSON`]);
  // The same carrier, read by another gate, is untouched by it.
  assert.deepEqual(c.v1QualificationProblems(f.root, { binding }, reader, Date.parse("2026-09-06T11:00:00Z")), []);

  for (const [bytes, reason] of [
    [Buffer.from([0xff, 0xfe, 0x00, 0x7b]), `${FV_REPORT}: the report is not UTF-8`],
    ["[]\n", `${FV_REPORT}: malformed report: the report must hold exactly schemaVersion, artifactKind, source and suites, in that order`],
    // Valid JSON of a good report, in another serialization.
    [JSON.stringify(f.report), `${FV_REPORT}: the report is not in its canonical serialization`],
    [`${serialize(f.report)}\n`, `${FV_REPORT}: the report is not in its canonical serialization`]
  ] as const) {
    writeFileSync(path.join(f.root, FV_REPORT), bytes);
    const bound = structuredClone(binding);
    bound.evidence.find((e: Any) => e.path === FV_REPORT).sha256 = hash(readFileSync(path.join(f.root, FV_REPORT)));
    assert.deepEqual(release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(bound)).reasons, [reason]);
  }
});

test("a carrier with no report, or no bundle for it, is refused, and the gate says which is missing", async (t) => {
  const c = await contract(); const release = await releaseLib();
  for (const relative of [FV_REPORT, FV_BUNDLE]) {
    const f = fixture(t);
    f.evidence.splice(f.evidence.findIndex((e: Any) => e.path === relative), 1);
    unlinkSync(path.join(f.root, relative)); f.bind();
    let problem = "";
    assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, f.options), (error: Error) => { problem = error.message; return true; });
    assert.equal(problem, `v1 binding omits required evidence ${relative}`);
    assert.equal(f.calls.length, 0, "nothing is sent for authentication from an incomplete carrier");
    const result = release.evaluateFormalVerification("formal-verification", fvGate(), f.root, failedContext(problem));
    assert.equal(result.status, "fail");
    assert.deepEqual(result.reasons, [
      `v1 release candidate verification failed: v1 binding omits required evidence ${relative}`,
      FV_UNVERIFIED,
      ...(relative === FV_REPORT ? [`${FV_REPORT} does not exist`] : [])
    ]);
  }
});

test("a bundle that does not verify, or that was signed for another subject, fails the carrier by the report's name", async (t) => {
  const c = await contract(); const release = await releaseLib();
  // Stands for the host verifier, which holds a bundle to the digest of the
  // one file it was made for. A fixture bundle names that digest in the open.
  const subjectBound = (request: Any) => {
    const bundle = JSON.parse(readFileSync(request.bundlePath, "utf8"));
    if (bundle.subjectSha256 !== hash(readFileSync(request.artifactPath))) throw new Error("the bundle's subject digest is not this artifact's");
  };
  const bundles: [string, string][] = [
    [canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH, canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH],
    [canonical.MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH, canonical.MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH],
    [FV_REPORT, FV_BUNDLE]
  ];
  const signed = (f: ReturnType<typeof fixture>, artifact: string) => ({ subjectSha256: hash(readFileSync(path.join(f.root, artifact))) });
  const withBundles = (rewire: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture(t);
    for (const [artifact, bundle] of bundles) {
      f.write(bundle, signed(f, artifact));
      f.evidence.find((e: Any) => e.path === bundle).sha256 = hash(readFileSync(path.join(f.root, bundle)));
    }
    rewire(f); f.bind();
    return f;
  };

  // Each bundle signed for its own artifact: the carrier verifies.
  const good = withBundles(() => {});
  const binding = c.verifyV1ReleaseBinding(good.root, good.instruments, { attestationVerifier: subjectBound });
  assert.equal(release.evaluateFormalVerification("formal-verification", fvGate(), good.root, verifiedContext(binding)).status, "pass");

  // The container evidence's bundle, a real signature of another subject, put in the report's place.
  const swapped = withBundles((f) => {
    f.write(FV_BUNDLE, signed(f, canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH));
    f.evidence.find((e: Any) => e.path === FV_BUNDLE).sha256 = hash(readFileSync(path.join(f.root, FV_BUNDLE)));
  });
  const OTHER_SUBJECT = "formal-verification-report attestation did not verify: the bundle's subject digest is not this artifact's";
  assert.throws(() => c.verifyV1ReleaseBinding(swapped.root, swapped.instruments, { attestationVerifier: subjectBound }), (error: Error) => error.message === OTHER_SUBJECT);
  assert.deepEqual(release.evaluateFormalVerification("formal-verification", fvGate(), swapped.root, failedContext(OTHER_SUBJECT)).reasons,
    [`v1 release candidate verification failed: ${OTHER_SUBJECT}`, FV_UNVERIFIED]);

  // A report edited after it was signed: the bundle no longer covers its bytes.
  const edited = withBundles((f) => {
    const report = structuredClone(f.report);
    report.suites[0].variants.pop();
    f.rewriteReport(report);
  });
  assert.throws(() => c.verifyV1ReleaseBinding(edited.root, edited.instruments, { attestationVerifier: subjectBound }), (error: Error) => error.message === OTHER_SUBJECT);

  // A verifier that refuses only this subject, as a bad signature would.
  const f = fixture(t); f.bind();
  const calls: string[] = [];
  const refusing = (request: Any) => { calls.push(request.subject); if (request.subject === "formal-verification-report") throw new Error("invalid signature"); };
  assert.throws(() => c.verifyV1ReleaseBinding(f.root, f.instruments, { attestationVerifier: refusing }),
    (error: Error) => error.message === "formal-verification-report attestation did not verify: invalid signature");
  assert.deepEqual(calls, ["container-evidence", "container-package-inventory", "formal-verification-report"]);
});

test("the formal-verification gate trusts no verdict but a verified one for this subject, this file and this candidate", async (t) => {
  const c = await contract(); const release = await releaseLib(); const f = fixture(t); f.bind();
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  const evaluate = (change: (b: Any) => void) => {
    const copy = structuredClone(binding);
    change(copy);
    return release.evaluateFormalVerification("formal-verification", fvGate(), f.root, verifiedContext(copy));
  };
  assert.equal(evaluate(() => {}).status, "pass");
  for (const [name, change] of [
    ["no verdict", (b: Any) => { delete b.attestationVerifications.formalVerificationReport; }],
    ["no verdicts at all", (b: Any) => { delete b.attestationVerifications; }],
    ["an unverified status", (b: Any) => { b.attestationVerifications.formalVerificationReport.status = "skipped"; }],
    ["another subject's verdict", (b: Any) => { b.attestationVerifications.formalVerificationReport = b.attestationVerifications.containerEvidence; }],
    ["another subject's name", (b: Any) => { b.attestationVerifications.formalVerificationReport.subject = "container-evidence"; }],
    ["another file", (b: Any) => { b.attestationVerifications.formalVerificationReport.artifactPath = path.join(f.root, canonical.MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH); }],
    ["another bundle", (b: Any) => { b.attestationVerifications.formalVerificationReport.bundlePath = path.join(f.root, canonical.MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH); }],
    ["a signer at another commit", (b: Any) => { b.attestationVerifications.formalVerificationReport.signerDigest = "e".repeat(40); }],
    ["a source at another commit", (b: Any) => { b.attestationVerifications.formalVerificationReport.sourceDigest = "e".repeat(40); }]
  ] as const) {
    const result = evaluate(change as (b: Any) => void);
    assert.equal(result.status, "fail", name);
    assert.deepEqual(result.reasons, [FV_UNVERIFIED], name);
  }
  // The report on disk is no longer the bytes the binding holds.
  const later = structuredClone(f.report);
  later.suites[0].variants.push({ variant: "zz added later", property: "the property", caughtBy: "the property" });
  f.write(FV_REPORT, later);
  assert.deepEqual(evaluate(() => {}).reasons, [`${FV_REPORT} is not the report the binding holds by digest`]);
  // The binding names the report under another category.
  f.write(FV_REPORT, f.report);
  assert.equal(evaluate(() => {}).status, "pass");
  assert.deepEqual(evaluate((b) => { b.evidence.find((e: Any) => e.path === FV_REPORT).category = "qualification-reference"; }).reasons,
    [`${FV_REPORT} is not the report the binding holds by digest`]);
});

test("the gate's own configuration is held, and a report source that cannot be read fails this gate alone", async (t) => {
  const release = await releaseLib();
  const c = await contract(); const f = fixture(t); f.bind();
  const binding = c.verifyV1ReleaseBinding(f.root, f.instruments, f.options);
  const withGate = (change: (gate: Any) => void) => { const gate = fvGate(); change(gate); return release.evaluateFormalVerification("formal-verification", gate, f.root, verifiedContext(binding)).reasons; };
  assert.deepEqual(withGate((gate) => { gate.report = "research/elsewhere.json"; }), [`gate config: report must be ${FV_REPORT}`]);
  assert.deepEqual(withGate((gate) => { gate.bundle = "research/elsewhere.bundle.json"; }), [`gate config: bundle must be ${FV_BUNDLE}`]);
  assert.deepEqual(withGate((gate) => { delete gate.requiredSuites; }), ["gate config: requiredSuites must name every required suite"]);
  assert.deepEqual(withGate((gate) => { gate.requiredSuites[0].minimumTests = 0; }), [`gate config: ${FIRST}: minimumTests must be a whole number of at least 1`]);
  // A gate that asks for more than the report shows is not satisfied by it.
  assert.deepEqual(withGate((gate) => { gate.requiredSuites[0].minimumTests += 1; }),
    [`${FIRST}: ${fvGate().requiredSuites[0].minimumTests} tests passed, below its pinned minimum of ${fvGate().requiredSuites[0].minimumTests + 1}`]);

  // Through the whole evaluator, on a manifest of two gates: a directory where
  // the report should be cannot be read, and only this gate says so.
  const root = mkdtempSync(path.join(tmpdir(), "sbl-fv-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const decided = { status: "approved", decidedBy: "Fixture Maintainer", decidedAt: "2026-09-06T10:00:00.000Z" };
  const two = (gates: Any) => ({ schemaVersion: 1, artifactKind: "site-behavior-release-readiness-manifest", targetRelease: "1.0.0", decisions: { scope: decided }, gates });
  const decisions = { kind: "decisions", title: "Decisions", requiredDecisions: ["scope"] };
  const now = Date.parse("2026-09-06T11:00:00Z");
  writeFileSync(path.join(root, "RELEASE_READINESS.json"), serialize(two({ "decisions-approved": decisions })));
  const alone = release.evaluateReleaseReadiness(root, now);
  assert.deepEqual(alone.gates.map((gate: Any) => [gate.id, gate.status]), [["decisions-approved", "pass"]]);
  writeFileSync(path.join(root, "RELEASE_READINESS.json"), serialize(two({ "decisions-approved": decisions, "formal-verification": fvGate() })));
  mkdirSync(path.join(root, FV_REPORT), { recursive: true });
  const both = release.evaluateReleaseReadiness(root, now);
  assert.equal(both.ready, false);
  assert.deepEqual(both.gates[0], alone.gates[0], "the other gate's verdict and reasons are the ones it has alone");
  assert.deepEqual([both.gates[1].id, both.gates[1].kind, both.gates[1].status], ["formal-verification", "formal-verification", "fail"]);
  assert.ok(both.gates[1].reasons.includes(`${FV_REPORT} could not be read: EISDIR`), both.gates[1].reasons.join("\n"));
  assert.ok(both.gates[1].reasons.includes(FV_UNVERIFIED));
});
