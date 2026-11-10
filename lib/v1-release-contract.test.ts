import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
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
  return { root, candidate, candidateTree, git, write, commit, add, bind, evidence, review, instruments, calls,
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
  assert.equal(f.calls.length, 2);
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
