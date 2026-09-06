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
  for (const id of ["egress-backstop", "waf-ceilings", "log-retention", "container-image-licensing"]) {
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
