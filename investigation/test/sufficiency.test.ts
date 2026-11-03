import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../core/sufficiency";
import type { EvidenceKind, KindStatus, Question, Requirement, Survey } from "../core/sufficiency";

/**
 * The assessment combines a question with a survey and reads nothing else. Every survey of two
 * attempts over two kinds, each kind present, missing, incompatible or not stated, and every state of
 * a run-level kind, is held to a plain model of the rule kept in this file, which RESTATES it.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/sufficiency"), edits);

const STATES = ["present", "missing", "incompatible", "unstated"] as const;
type State = (typeof STATES)[number];
const KINDS: readonly EvidenceKind[] = ["call-frames", "window"];

const DIGEST = "ab".repeat(32);

const statusOf = (state: State): KindStatus | undefined => (state === "unstated" ? undefined : { status: state, reason: `it is ${state}` });

function surveyOf(attempts: readonly (readonly State[])[], run: State): Survey {
  const runStatus = statusOf(run);
  return {
    runDigest: DIGEST,
    refusal: null,
    run: runStatus === undefined ? {} : { "recorder-identity": runStatus },
    attempts: attempts.map((states, index) => ({ attempt: `attempt-${index}`, kinds: Object.fromEntries(KINDS.flatMap((kind, k) => (states[k] === "unstated" ? [] : [[kind, statusOf(states[k])]]))) }))
  };
}

const REQUIREMENTS: readonly Requirement[] = [
  { kinds: KINDS, within: "one-attempt", atLeast: 1 },
  { kinds: KINDS, within: "one-attempt", atLeast: 2 },
  { kinds: KINDS, within: "every-attempt" },
  { kinds: ["window"], within: "every-attempt" },
  { kinds: ["recorder-identity"], within: "the-run" }
];

/** The rule, restated: a kind counts only when stated present. */
function modelMet(requirement: Requirement, attempts: readonly (readonly State[])[], run: State): boolean {
  if (requirement.within === "the-run") return run === "present";
  const holding = attempts.filter((states) => requirement.kinds.every((kind) => states[KINDS.indexOf(kind)] === "present")).length;
  return requirement.within === "every-attempt" ? attempts.length > 0 && holding === attempts.length : holding >= requirement.atLeast;
}

const RULE = "the verdict is met exactly when every requirement holds by present kinds alone";

function everySurvey(): readonly Readonly<{ attempts: (readonly State[])[]; run: State }>[] {
  const out: { attempts: (readonly State[])[]; run: State }[] = [];
  for (const run of STATES) {
    out.push({ attempts: [], run });
    for (const a of STATES) for (const b of STATES) for (const c of STATES) for (const d of STATES) out.push({ attempts: [[a, b], [c, d]], run });
  }
  return out;
}

const checkRule = (module: Module) => {
  let checked = 0;
  for (const { attempts, run } of everySurvey()) {
    for (let mask = 1; mask < 1 << REQUIREMENTS.length; mask += 1) {
      const requirements = REQUIREMENTS.filter((_, index) => (mask & (1 << index)) !== 0);
      const result = module.assessSufficiency({ id: "q", text: "A question.", requirements }, surveyOf(attempts, run));
      holds(RULE, result.ok, () => ({ attempts, run, result }));
      if (!result.ok) continue;
      const expected = requirements.map((requirement) => modelMet(requirement, attempts, run));
      const got = result.assessment.requirements.map(({ met }) => met);
      holds(RULE, JSON.stringify(got) === JSON.stringify(expected), () => ({ attempts, run, requirements, got, expected }));
      holds(RULE, (result.assessment.verdict === "supports-import") === expected.every(Boolean), () => ({ attempts, run, verdict: result.assessment.verdict }));
      holds(RULE, result.assessment.reasons.length === expected.filter((met) => !met).length, () => ({ attempts, run, reasons: result.assessment.reasons }));
      checked += 1;
    }
  }
  return checked;
};

test("every survey of two attempts over two kinds, and every run-level state, against every set of requirements", () => {
  assert.equal(checkRule(production), (4 + 4 * 256) * 31);
});

for (const [name, edits] of [
  ["incompatible read as present", [{ find: 'requirement.kinds.every((kind) => statusIn(held, kind).status === "present")', replace: 'requirement.kinds.every((kind) => statusIn(held, kind).status !== "missing")' }]],
  ["a kind the survey does not state read as present", [{ find: 'const SAID_NOTHING = { status: "missing", reason: "the survey says nothing of it" };', replace: 'const SAID_NOTHING = { status: "present", reason: "the survey says nothing of it" };' }]],
  ["every attempt of none met", [{ find: "survey.attempts.length > 0 && holding.length === survey.attempts.length", replace: "holding.length === survey.attempts.length" }]],
  ["one attempt enough whatever atLeast says", [{ find: "holding.length >= requirement.atLeast", replace: "holding.length >= 1" }]],
  ["a run-level kind met by an incompatible status", [{ find: "const met = kinds.every(({ present }) => present.length === 1);", replace: "const met = kinds.every(({ missing }) => missing.length === 0);" }]]
] as const) {
  test(`the rule catches ${name}`, async () => {
    await assertCaughtBy(name, RULE, () => checkRule(variant(...edits)));
  });
}

test("what each kind is, for every kind, and nothing else", () => {
  assert.deepEqual(Object.keys(production.KIND_MEANINGS).sort(), [...production.EVIDENCE_KINDS].sort());
  for (const meaning of Object.values(production.KIND_MEANINGS)) assert.ok(meaning.length > 10);
});

test("a malformed question or survey is refused by field, never judged", () => {
  const survey = surveyOf([["present", "present"]], "present");
  const bad: readonly (readonly [unknown, string])[] = [
    [{ id: "", text: "q", requirements: [{ kinds: ["window"], within: "the-run" }] }, "question"],
    [{ id: "q", text: 7, requirements: [{ kinds: ["window"], within: "the-run" }] }, "question"],
    [{ id: "q", text: "q", requirements: [] }, "requirements"],
    [{ id: "q", text: "q", requirements: [{ kinds: ["no-such-kind"], within: "the-run" }] }, "requirements[0].kinds"],
    [{ id: "q", text: "q", requirements: [{ kinds: [], within: "the-run" }] }, "requirements[0].kinds"],
    [{ id: "q", text: "q", requirements: [{ kinds: ["window", "window"], within: "the-run" }] }, "requirements[0].kinds"],
    [{ id: "q", text: "q", requirements: [{ kinds: ["window"], within: "one-attempt", atLeast: 0 }] }, "requirements[0].atLeast"],
    [{ id: "q", text: "q", requirements: [{ kinds: ["window"], within: "one-attempt" }] }, "requirements[0].atLeast"],
    [{ id: "q", text: "q", requirements: [{ kinds: ["window"], within: "some-attempts" }] }, "requirements[0].within"]
  ];
  for (const [question, at] of bad) assert.deepEqual(production.assessSufficiency(question as Question, survey), { ok: false, refusal: "question-malformed", at }, at);
  const question: Question = { id: "q", text: "q", requirements: [{ kinds: ["window"], within: "the-run" }] };
  const badSurveys: readonly (readonly [unknown, string])[] = [
    [null, "survey"],
    [{ runDigest: DIGEST, refusal: null, run: { "no-such-kind": { status: "present", reason: "" } }, attempts: [] }, "run"],
    [{ runDigest: DIGEST, refusal: null, run: { window: { status: "maybe", reason: "" } }, attempts: [] }, "run"],
    [{ runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "a", kinds: {} }, { attempt: "a", kinds: {} }] }, "attempts[1]"],
    [{ runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "run", kinds: {} }] }, "attempts[0]"],
    [{ runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "a", kinds: { window: { status: "present" } } }] }, "attempts[0].kinds"],
    [{ runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "a", kinds: { "no-such-kind": { status: "present", reason: "" } } }] }, "attempts[0].kinds"],
    [{ runDigest: "nope", refusal: null, run: {}, attempts: [] }, "runDigest"],
    [{ runDigest: DIGEST, run: {}, attempts: [] }, "refusal"],
    [{ runDigest: DIGEST, refusal: null, run: [], attempts: [] }, "survey"]
  ];
  for (const [bad, at] of badSurveys) assert.deepEqual(production.assessSufficiency(question, bad as Survey), { ok: false, refusal: "survey-malformed", at }, at);
});

test("a kind is read from the survey's own keys, so nothing inherited stands in for one", () => {
  const inherited = Object.create({ window: { status: "present", reason: "inherited" } }) as Record<string, KindStatus>;
  const result = production.assessSufficiency({ id: "q", text: "q", requirements: [{ kinds: ["window"], within: "one-attempt", atLeast: 1 }] }, { runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "a", kinds: inherited }] });
  assert.ok(result.ok);
  assert.equal(result.assessment.verdict, "does-not-support-import");
  assert.deepEqual(result.assessment.requirements[0].kinds[0].missing, [{ attempt: "a", reason: "the survey says nothing of it" }]);
});

test("the reasons name each kind that kept a requirement unmet, and where, and keep the survey's own words beside it", () => {
  const survey: Survey = {
    runDigest: DIGEST,
    refusal: null,
    run: { "recorder-identity": { status: "present", reason: "pinned" } },
    attempts: [
      { attempt: "first", kinds: { "call-frames": { status: "present", reason: "kept" }, "observer-outcome": { status: "incompatible", reason: "a frame-level flag only" } } },
      { attempt: "second", kinds: { "call-frames": { status: "missing", reason: "no logger" }, "observer-outcome": { status: "incompatible", reason: "a frame-level flag only" } } }
    ]
  };
  const result = production.assessSufficiency({ id: "q", text: "q", requirements: [{ kinds: ["call-frames", "observer-outcome"], within: "one-attempt", atLeast: 1 }, { kinds: ["recorder-identity"], within: "the-run" }] }, survey);
  assert.ok(result.ok);
  assert.equal(result.assessment.verdict, "does-not-support-import");
  assert.deepEqual(result.assessment.reasons, ["call-frames, observer-outcome needed together in at least 1 attempt; 0 attempts hold all of them; short: call-frames (missing in 1); observer-outcome (incompatible in 2)"]);
  assert.deepEqual(result.assessment.requirements[0].kinds[1].incompatible, [
    { attempt: "first", reason: "a frame-level flag only" },
    { attempt: "second", reason: "a frame-level flag only" }
  ]);
  assert.deepEqual(result.assessment.requirements[1], { requirement: { kinds: ["recorder-identity"], within: "the-run" }, met: true, holding: ["run"], kinds: [{ kind: "recorder-identity", present: ["run"], missing: [], incompatible: [] }] });
});

test("a survey whose reading refuses the run supports no question, whatever its kinds say, and the assessment names the run it judged", () => {
  const question: Question = { id: "q", text: "q", requirements: [{ kinds: ["recorder-identity"], within: "the-run" }] };
  const survey: Survey = { runDigest: DIGEST, refusal: null, run: { "recorder-identity": { status: "present", reason: "pinned" } }, attempts: [] };
  const fine = production.assessSufficiency(question, survey);
  assert.ok(fine.ok);
  assert.deepEqual([fine.assessment.verdict, fine.assessment.runDigest, fine.assessment.reasons], ["supports-import", DIGEST, []]);
  const refused = production.assessSufficiency(question, { ...survey, refusal: "source-mismatch: source.appliesTo" });
  assert.ok(refused.ok);
  assert.deepEqual([refused.assessment.verdict, refused.assessment.reasons], ["does-not-support-import", ["the survey's reading refuses this run: source-mismatch: source.appliesTo"]]);
});

test("a question part no evidence kind in the core can answer reads missing in every attempt, so it can never be met", () => {
  const survey: Survey = { runDigest: DIGEST, refusal: null, run: {}, attempts: [{ attempt: "a", kinds: Object.fromEntries(production.EVIDENCE_KINDS.filter((kind) => kind !== "registrable-domain-rule").map((kind) => [kind, { status: "present", reason: "all of it" }])) }] };
  const result = production.assessSufficiency({ id: "q", text: "q", requirements: [{ kinds: ["window", "registrable-domain-rule"], within: "one-attempt", atLeast: 1 }] }, survey);
  assert.ok(result.ok);
  assert.equal(result.assessment.verdict, "does-not-support-import");
  assert.deepEqual(result.assessment.requirements[0].kinds[1].missing, [{ attempt: "a", reason: "the survey says nothing of it" }]);
  assert.match(production.KIND_MEANINGS["registrable-domain-rule"], /no survey states it/);
});
