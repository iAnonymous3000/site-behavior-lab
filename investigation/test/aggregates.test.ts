import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../core/aggregates";
import { aggregate, evidenceForAttempt, type AggregateRow, type AttemptReading, type Measure, type MeasureKeys } from "../core/aggregates";
import * as machine from "../core/case-machine";
import type { AttemptPhase, SlotName } from "../core/case-machine";
import { EMPTY_RECORD, type EvidenceRecord, type EvidenceRow } from "../core/evidence-model";
import { ATTEMPT_IDS, captureOf, CONFIG_A, CONFIG_B, confirmOf, controlMet, driven, finishOf, frozen, OWNER, planOf, startOf, visitOf } from "./case-fixture";

/**
 * Counts across attempts. The rows are written out by hand, and so is each expected group,
 * so nothing here reads the module's own grouping. Attempts come in more than one per group
 * and more than one group, and key values differ from key names.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/aggregates"), edits);

const RELEASE_OLD = "release-old";
const RELEASE_NEW = "release-new";
const COMMIT_OLD = "commit-old";
const COMMIT_NEW = "commit-new";
const CONFIGURATION_OLD = "configuration-old";
const CONFIGURATION_NEW = "configuration-new";

const KEYS: MeasureKeys = {
  heldEqual: ["release", "commit", "configuration"],
  allowedToVary: [{ key: "arm", reason: "The measure reads a count both arms report." }],
  unknown: ["operator"]
};

const MEASURE: Measure = { id: "measure-one", subject: "subject-lantern", population: null, keys: KEYS };
/** For a row from aggregateRowsOf, which holds no operator key to leave unknown. */
const MEASURE_WITH_ARM: Measure = { ...MEASURE, keys: { ...KEYS, unknown: [] } };

const plain = (reading: AttemptReading["reading"], limits: readonly string[] = []): AttemptReading => ({ reading, limits });
const NO_LIMITS = { observed: {}, zero_in_window: {}, unknown: {} };

const rowFor = (slot: SlotName, phase: AttemptPhase, reading: "observed" | "zero_in_window" | "unknown" | null, over: Partial<AggregateRow["keys"]> = {}): AggregateRow => ({
  slot,
  attemptId: ATTEMPT_IDS[slot],
  arm: slot.startsWith("B") ? "baseline" : "instrumented",
  phase,
  basis: "control",
  keys: { release: RELEASE_OLD, commit: COMMIT_OLD, configuration: CONFIGURATION_OLD, arm: slot.startsWith("B") ? "baseline" : "instrumented", ...over },
  readings: reading === null ? {} : { "subject-lantern": plain(reading), "subject-other": plain("observed") }
});

const SIX: readonly AggregateRow[] = [
  rowFor("B1", "usable", "observed"),
  rowFor("B2", "usable", "zero_in_window"),
  rowFor("B3", "failed", null),
  rowFor("I1", "incomplete", "unknown"),
  rowFor("I2", "not_started", null),
  rowFor("I3", "planned", null)
];

const DENOMINATOR = "the denominator is every attempt in the group, and not started and failed stay in it";

const checkDenominator = (module: Module) => {
  const result = module.aggregate(SIX, MEASURE);
  holds(DENOMINATOR, result.ok && result.groups.length === 1, () => result);
  const [group] = (result as Extract<production.AggregateResult, { ok: true }>).groups;
  const expected = {
    measure: "measure-one",
    subject: "subject-lantern",
    group: { commit: COMMIT_OLD, configuration: CONFIGURATION_OLD, release: RELEASE_OLD, basis: "ordinary" },
    n: 1,
    of: 6,
    zero: 1,
    unknown: 4,
    limits: NO_LIMITS,
    notStarted: 2,
    failed: 1,
    outsideDenominator: 0,
    whyOutside: null,
    presentedAs: "aggregate across attempts, not one execution",
    compatibility: KEYS
  };
  holds(DENOMINATOR, JSON.stringify(group) === JSON.stringify(expected), () => group);

  // Every way an attempt can stand, all in one group and all still counted: none of them has a reading.
  const phases: readonly AttemptPhase[] = ["planned", "starting", "capturing", "finalizing", "usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started"];
  const every = module.aggregate(phases.map((phase) => rowFor("B1", phase, null)), MEASURE);
  holds(DENOMINATOR, every.ok && every.groups.length === 1, () => every);
  const [all] = (every as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(DENOMINATOR, all.of === 11 && all.n === 0 && all.zero === 0 && all.unknown === 11 && all.notStarted === 2 && all.failed === 1, () => all);
  // And walled, timed_out and cancelled beside ones that read, which is how a dropped one would hide.
  const mixed = module.aggregate([rowFor("B1", "walled", "observed"), rowFor("B2", "timed_out", "zero_in_window"), rowFor("B3", "cancelled", "unknown"), rowFor("I1", "usable", "observed")], MEASURE);
  holds(DENOMINATOR, mixed.ok && mixed.groups.length === 1 && mixed.groups[0].n === 2 && mixed.groups[0].of === 4 && mixed.groups[0].zero === 1 && mixed.groups[0].unknown === 1 && mixed.groups[0].notStarted === 0 && mixed.groups[0].failed === 0, () => mixed);
};

test("every planned attempt is in the denominator, and only observed counts toward n", async () => {
  checkDenominator(production);
  await assertCaughtBy("dropping not_started", DENOMINATOR, () => checkDenominator(variant({ find: 'const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);', replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "not_started" && phase !== "planned");' })));
  await assertCaughtBy("dropping timed-out and cancelled", DENOMINATOR, () => checkDenominator(variant({ find: 'const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);', replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "timed_out" && phase !== "cancelled");' })));
  await assertCaughtBy("dropping walled", DENOMINATOR, () => checkDenominator(variant({ find: 'const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);', replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "walled");' })));
  await assertCaughtBy("dropping failed", DENOMINATOR, () => checkDenominator(variant({ find: 'const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);', replace: 'const inside = (population === null ? members : members.filter(({ arm }) => arm === population.arm)).filter(({ phase }) => phase !== "failed");' })));
  await assertCaughtBy("no record read as 0", DENOMINATOR, () => checkDenominator(variant({ find: '(_a = ownValue(row.readings, measure.subject)) !== null && _a !== void 0 ? _a : { reading: "unknown", limits: [] }', replace: '(_a = ownValue(row.readings, measure.subject)) !== null && _a !== void 0 ? _a : { reading: "zero_in_window", limits: [] }' })));
  await assertCaughtBy("a planned slot not counted as not started", DENOMINATOR, () => checkDenominator(variant({ find: 'phase === "planned" || phase === "not_started"', replace: 'phase === "not_started"' })));
  await assertCaughtBy("a count of the wrong subject", DENOMINATOR, () => checkDenominator(variant({ find: "(_a = ownValue(row.readings, measure.subject))", replace: '(_a = ownValue(row.readings, "subject-other"))' })));
});

const SPLIT = "a different release, commit, configuration, other held key or visit basis splits a group";

const checkSplit = (module: Module) => {
  const rows: readonly AggregateRow[] = [
    rowFor("B1", "usable", "observed"),
    rowFor("B2", "usable", "observed"),
    rowFor("B3", "usable", "observed", { release: RELEASE_NEW }),
    rowFor("I1", "usable", "observed", { commit: COMMIT_NEW }),
    rowFor("I2", "usable", "observed", { configuration: CONFIGURATION_NEW }),
    rowFor("I3", "not_started", null, { configuration: CONFIGURATION_NEW })
  ];
  const result = module.aggregate(rows, MEASURE);
  holds(SPLIT, result.ok, () => result);
  const { groups } = result as Extract<production.AggregateResult, { ok: true }>;
  const shape = groups.map(({ group, n, of }) => [group.release, group.commit, group.configuration, n, of].join("/")).sort();
  holds(SPLIT, JSON.stringify(shape) === JSON.stringify([`${RELEASE_NEW}/${COMMIT_OLD}/${CONFIGURATION_OLD}/1/1`, `${RELEASE_OLD}/${COMMIT_NEW}/${CONFIGURATION_OLD}/1/1`, `${RELEASE_OLD}/${COMMIT_OLD}/${CONFIGURATION_NEW}/1/2`, `${RELEASE_OLD}/${COMMIT_OLD}/${CONFIGURATION_OLD}/2/2`].sort()), () => shape);
  // A key allowed to vary does not split: both arms sit together above.
  const allowed = module.aggregate([rowFor("B1", "usable", "observed"), rowFor("I1", "usable", "observed")], MEASURE);
  holds(SPLIT, allowed.ok && allowed.groups.length === 1 && allowed.groups[0].of === 2, () => allowed);
  // The order rows arrive in decides nothing.
  const reversed = module.aggregate([...rows].reverse(), MEASURE);
  holds(SPLIT, reversed.ok && JSON.stringify(reversed.groups) === JSON.stringify(groups), () => reversed);

  // A fourth key held equal splits just as those three do, and says so in the group.
  const fourKeys: Measure = { ...MEASURE, keys: { heldEqual: ["release", "commit", "configuration", "arm"], allowedToVary: [], unknown: [] } };
  const byArm = module.aggregate([rowFor("B1", "usable", "observed"), rowFor("B2", "usable", "observed"), rowFor("I1", "usable", "observed")], fourKeys);
  holds(SPLIT, byArm.ok && byArm.groups.length === 2, () => byArm);
  const armGroups = (byArm as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(SPLIT, JSON.stringify(armGroups.map(({ group, of }) => [group, of])) === JSON.stringify([[{ arm: "baseline", commit: COMMIT_OLD, configuration: CONFIGURATION_OLD, release: RELEASE_OLD, basis: "ordinary" }, 2], [{ arm: "instrumented", commit: COMMIT_OLD, configuration: CONFIGURATION_OLD, release: RELEASE_OLD, basis: "ordinary" }, 1]]), () => armGroups);

  // Values that read the same when joined stay two groups.
  const slashed = module.aggregate([rowFor("B1", "usable", "observed", { commit: "a/b", configuration: "c" }), rowFor("I1", "usable", "observed", { commit: "a", configuration: "b/c" })], MEASURE);
  holds(SPLIT, slashed.ok && slashed.groups.length === 2 && slashed.groups.every(({ of }) => of === 1), () => slashed);
  const commaed = module.aggregate([rowFor("B1", "usable", "observed", { commit: 'x","y', configuration: "z" }), rowFor("I1", "usable", "observed", { commit: "x", configuration: 'y","z' })], MEASURE);
  holds(SPLIT, commaed.ok && commaed.groups.length === 2, () => commaed);

  // What a visit rested on splits, whatever a measure declares, in the group a reader sees.
  const onException: AggregateRow = { ...rowFor("B2", "usable", "observed"), basis: "exception" };
  const split = module.aggregate([rowFor("B1", "usable", "observed"), onException, rowFor("I1", "usable", "zero_in_window")], MEASURE);
  holds(SPLIT, split.ok, () => split);
  const basisShape = (split as Extract<production.AggregateResult, { ok: true }>).groups.map(({ group, n, of, zero }) => [group.basis, n, of, zero]);
  holds(SPLIT, JSON.stringify(basisShape) === JSON.stringify([["exception", 1, 1, 0], ["ordinary", 1, 2, 1]]), () => basisShape);
  // A visit on the met control and a slot no visit reached are both ordinary, and pool. An exception's visit pools with neither, and notStarted says which is which.
  const threeKinds = module.aggregate([rowFor("B1", "usable", "observed"), { ...rowFor("B2", "not_started", null), basis: "not_visited" }, onException], MEASURE);
  holds(SPLIT, threeKinds.ok, () => threeKinds);
  const kindShape = (threeKinds as Extract<production.AggregateResult, { ok: true }>).groups.map(({ group, of, notStarted }) => [group.basis, of, notStarted]);
  holds(SPLIT, JSON.stringify(kindShape) === JSON.stringify([["exception", 1, 0], ["ordinary", 2, 1]]), () => kindShape);
  // A key a measure happens to call basis cannot stand in for it, whether or not the rows agree on it.
  const named: Measure = { ...MEASURE, keys: { ...KEYS, heldEqual: ["release", "commit", "configuration", "basis"] } };
  const samePretence = module.aggregate([rowFor("B1", "usable", "observed", { basis: "control" }), { ...rowFor("B2", "usable", "observed", { basis: "control" }), basis: "exception" }], named);
  holds(SPLIT, samePretence.ok && JSON.stringify(samePretence.groups.map(({ group, of }) => [group.basis, of])) === JSON.stringify([["exception", 1], ["ordinary", 1]]), () => samePretence);
  // A row that does not say is refused, and so is one that says something else: nothing defaults it to controlled.
  for (const basis of [undefined, "exploratory", "", "ordinary"]) {
    const refused = module.aggregate([rowFor("B1", "usable", "observed"), { ...rowFor("B2", "usable", "observed"), basis } as unknown as AggregateRow], MEASURE);
    holds(SPLIT, !refused.ok && refused.refusal === "basis-unknown" && refused.at === "rows[1].basis", () => ({ basis, refused }));
  }
};

test("what is held equal splits, and what may vary does not", async () => {
  checkSplit(production);
  await assertCaughtBy("nothing split", SPLIT, () => checkSplit(variant({ find: "const name = JSON.stringify(group);", replace: 'const name = "one";' })));
  await assertCaughtBy("split on an allowed key too", SPLIT, () => checkSplit(variant({ find: "...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key)])", replace: "...[...declared].sort().map((key) => [key, ownValue(row.keys, key)])" })));
  await assertCaughtBy("split on the three keys only", SPLIT, () => checkSplit(variant({ find: "...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key)])", replace: "...[...exports.SPLIT_KEYS].sort().map((key) => [key, ownValue(row.keys, key)])" })));
  await assertCaughtBy("a label that joins its values", SPLIT, () => checkSplit(variant({ find: "const name = JSON.stringify(group);", replace: 'const name = Object.values(group).join("/");' })));
  await assertCaughtBy("no split on what a visit rested on", SPLIT, () => checkSplit(variant({ find: 'const label = row.basis === "exception" ? "exception" : "ordinary";', replace: 'const label = "ordinary";' })));
  await assertCaughtBy("a measure's own key standing in for the basis", SPLIT, () => checkSplit(variant({ find: 'Object.fromEntries([...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key)]), ["basis", label]])', replace: 'Object.fromEntries([["basis", label], ...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key)])])' })));
  await assertCaughtBy("a slot no visit reached pooled apart", SPLIT, () => checkSplit(variant({ find: 'const label = row.basis === "exception" ? "exception" : "ordinary";', replace: "const label = row.basis;" })));
  await assertCaughtBy("a slot no visit reached taken as an exception", SPLIT, () => checkSplit(variant({ find: 'const label = row.basis === "exception" ? "exception" : "ordinary";', replace: 'const label = row.basis === "control" ? "ordinary" : "exception";' })));
  await assertCaughtBy("a row that says nothing of its basis pooled", SPLIT, () => checkSplit(variant({ find: 'if (row.basis !== "control" && row.basis !== "exception" && row.basis !== "not_visited")\n            return refuse("basis-unknown", `rows[${at}].basis`);', replace: "" })));
  await assertCaughtBy("only a missing basis refused", SPLIT, () => checkSplit(variant({ find: 'if (row.basis !== "control" && row.basis !== "exception" && row.basis !== "not_visited")', replace: "if (row.basis === undefined)" })));
});

const DECLARED = "only declared keys, with release, commit and configuration among those held equal";

const checkDeclared = (module: Module) => {
  const refusal = (rows: readonly AggregateRow[], keys: MeasureKeys | null) => {
    const result = module.aggregate(rows, { ...MEASURE, keys });
    return result.ok ? "ok" : result.refusal;
  };
  const table: readonly (readonly [string, readonly AggregateRow[], MeasureKeys | null, string])[] = [
    ["no keys at all", SIX, null, "no-declared-keys"],
    ["no keys held equal", SIX, { ...KEYS, heldEqual: [] }, "no-declared-keys"],
    ["release not held", SIX, { ...KEYS, heldEqual: ["commit", "configuration"], allowedToVary: [...KEYS.allowedToVary, { key: "release", reason: "It may vary." }] }, "split-key-not-held"],
    ["commit not held", SIX, { ...KEYS, heldEqual: ["release", "configuration"], allowedToVary: [...KEYS.allowedToVary, { key: "commit", reason: "It may vary." }] }, "split-key-not-held"],
    ["configuration not held", SIX, { ...KEYS, heldEqual: ["release", "commit"], allowedToVary: [...KEYS.allowedToVary, { key: "configuration", reason: "It may vary." }] }, "split-key-not-held"],
    ["a key no one declared, on the last row only", [...SIX.slice(0, 5), rowFor("I3", "usable", "observed", { region: "region-west" })], KEYS, "undeclared-key"],
    ["a held key missing from a row", [{ ...SIX[0], keys: { release: RELEASE_OLD, commit: COMMIT_OLD, arm: "baseline" } }], KEYS, "declared-key-missing"],
    ["a held key null on a row", [rowFor("B1", "usable", "observed", { commit: null })], KEYS, "held-key-unknown"],
    ["an allowed key missing from a row", [{ ...SIX[0], keys: { release: RELEASE_OLD, commit: COMMIT_OLD, configuration: CONFIGURATION_OLD } }], KEYS, "declared-key-missing"],
    ["a key said to be unknown with a value", [rowFor("B1", "usable", "observed", { operator: "operator-one" })], KEYS, "unknown-key-has-value"],
    ["a key said to be unknown, null on a row", [rowFor("B1", "usable", "observed", { operator: null })], KEYS, "ok"],
    ["a key said to be unknown, absent from a row", [rowFor("B1", "usable", "observed")], KEYS, "ok"],
    ["an allowed key's reason empty", SIX, { ...KEYS, allowedToVary: [{ key: "arm", reason: "" }] }, "empty-reason"],
    ["an allowed key's reason only spaces", SIX, { ...KEYS, allowedToVary: [{ key: "arm", reason: " \t " }] }, "empty-reason"],
    ["the second allowed key's reason empty", SIX, { ...KEYS, allowedToVary: [{ key: "arm", reason: "It may." }, { key: "region", reason: "" }] }, "empty-reason"]
  ];
  for (const [name, rows, keys, expected] of table) {
    const answer = refusal(rows, keys);
    holds(DECLARED, answer === expected, () => ({ name, answer, expected }));
  }
  // A reason names what it is the reason for, and a population's says it is the population's.
  const atOf = (measure: Measure) => {
    const result = module.aggregate(SIX, measure);
    return result.ok ? "ok" : `${result.refusal} at ${result.at}`;
  };
  holds(DECLARED, atOf({ ...MEASURE, keys: { ...KEYS, allowedToVary: [{ key: "arm", reason: "" }] } }) === "empty-reason at allowedToVary[0]", () => "allowed");
  for (const whyOutside of ["", "   "]) holds(DECLARED, atOf({ ...MEASURE, population: { arm: "baseline", whyOutside } }) === "empty-reason at population.whyOutside", () => ({ whyOutside }));
  holds(DECLARED, atOf({ ...MEASURE, population: { arm: "baseline", whyOutside: "Baseline only." } }) === "ok", () => "a reason");

  // A name every object answers to is no key and no subject, unless a row actually holds it.
  const reading = (subject: string, rows: readonly AggregateRow[]) => {
    const result = module.aggregate(rows, { ...MEASURE, subject });
    holds(DECLARED, result.ok && result.groups.length === 1, () => ({ subject, result }));
    const [group] = (result as Extract<production.AggregateResult, { ok: true }>).groups;
    return [group.n, group.zero, group.unknown, group.of];
  };
  for (const subject of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    holds(DECLARED, JSON.stringify(reading(subject, SIX)) === "[0,0,6,6]", () => ({ subject, counts: reading(subject, SIX) }));
    const holding: AggregateRow = { ...rowFor("B1", "usable", null), readings: JSON.parse(`{"${subject}":{"reading":"observed","limits":[]}}`) };
    holds(DECLARED, JSON.stringify(reading(subject, [holding, rowFor("B2", "usable", null)])) === "[1,0,1,2]", () => ({ subject, counts: reading(subject, [holding]) }));
  }
  for (const key of ["constructor", "__proto__", "toString"]) {
    const asHeld = module.aggregate([rowFor("B1", "usable", "observed")], { ...MEASURE, keys: { ...KEYS, heldEqual: [...KEYS.heldEqual, key] } });
    holds(DECLARED, !asHeld.ok && asHeld.refusal === "declared-key-missing" && asHeld.at === "rows[0] heldEqual[3]", () => ({ key, asHeld }));
    const asAllowed = module.aggregate([rowFor("B1", "usable", "observed")], { ...MEASURE, keys: { ...KEYS, allowedToVary: [...KEYS.allowedToVary, { key, reason: "It may vary." }] } });
    holds(DECLARED, !asAllowed.ok && asAllowed.refusal === "declared-key-missing" && asAllowed.at === "rows[0] allowedToVary[1]", () => ({ key, asAllowed }));
    const asUnknown = module.aggregate([rowFor("B1", "usable", "observed")], { ...MEASURE, keys: { ...KEYS, unknown: [...KEYS.unknown, key] } });
    holds(DECLARED, asUnknown.ok, () => ({ key, asUnknown }));
    // Held on rows that really have it, it splits, and a group can carry it.
    const twoValues = ["value-one", "value-two"].map((value, index) => ({ ...rowFor(index === 0 ? "B1" : "B2", "usable", "observed"), keys: Object.fromEntries([...Object.entries(rowFor("B1", "usable", "observed").keys), [key, value]]) }));
    const split = module.aggregate(twoValues, { ...MEASURE, keys: { ...KEYS, heldEqual: [...KEYS.heldEqual, key] } });
    holds(DECLARED, split.ok && split.groups.length === 2, () => ({ key, split }));
  }
};

test("a measure pools only over what it declares", async () => {
  checkDeclared(production);
  await assertCaughtBy("no keys allowed", DECLARED, () => checkDeclared(variant({ find: 'if (keys === null || keys.heldEqual.length === 0)\n        return refuse("no-declared-keys", "measure.keys");', replace: 'if (keys === null)\n        return { ok: true, groups: [] };' })));
  await assertCaughtBy("an empty held list allowed", DECLARED, () => checkDeclared(variant({ find: "keys === null || keys.heldEqual.length === 0", replace: "keys === null" })));
  await assertCaughtBy("a split key left to vary", DECLARED, () => checkDeclared(variant({ find: 'if (!keys.heldEqual.includes(key))\n            return refuse("split-key-not-held", key);', replace: "" })));
  await assertCaughtBy("an undeclared key pooled", DECLARED, () => checkDeclared(variant({ find: 'if (!declared.includes(key))\n                return refuse("undeclared-key", `rows[${at}].keys`);', replace: "" })));
  await assertCaughtBy("a held key taken as present", DECLARED, () => checkDeclared(variant({ find: 'if (value === undefined)\n                return refuse("declared-key-missing", `rows[${at}] heldEqual[${index}]`);\n            if (value === null)', replace: "if (value === null)" })));
  await assertCaughtBy("a null held equal to itself", DECLARED, () => checkDeclared(variant({ find: 'if (value === null)\n                return refuse("held-key-unknown", `rows[${at}] heldEqual[${index}]`);', replace: "" })));
  await assertCaughtBy("an allowed key taken as present", DECLARED, () => checkDeclared(variant({ find: 'for (const [index, { key }] of keys.allowedToVary.entries()) {\n            if (ownValue(row.keys, key) === undefined)\n                return refuse("declared-key-missing", `rows[${at}] allowedToVary[${index}]`);\n        }', replace: "" })));
  await assertCaughtBy("an unknown key with a value", DECLARED, () => checkDeclared(variant({ find: 'if (value !== undefined && value !== null)\n                return refuse("unknown-key-has-value", `rows[${at}] unknown[${index}]`);', replace: "" })));
  await assertCaughtBy("an empty reason let through", DECLARED, () => checkDeclared(variant({ find: 'if (isBlank(reason))\n            return refuse("empty-reason", `allowedToVary[${index}]`);', replace: "" })));
  await assertCaughtBy("an empty reason outside let through", DECLARED, () => checkDeclared(variant({ find: 'if (population !== null && isBlank(population.whyOutside))\n        return refuse("empty-reason", "population.whyOutside");', replace: "" })));
  await assertCaughtBy("spaces taken as a reason", DECLARED, () => checkDeclared(variant({ find: 'return text.trim() === "";', replace: 'return text === "";' })));
  await assertCaughtBy("only the first allowed key's reason read", DECLARED, () => checkDeclared(variant({ find: "for (const [index, { reason }] of keys.allowedToVary.entries()) {", replace: "for (const [index, { reason }] of [...keys.allowedToVary.entries()].slice(0, 1)) {" })));
  await assertCaughtBy("a name every object answers to read as a key or a subject", DECLARED, () => checkDeclared(variant({ find: "return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;", replace: "return record[key];" })));
  await assertCaughtBy("a group built on a plain object", DECLARED, () => checkDeclared(variant({ find: 'const group = Object.fromEntries([...[...keys.heldEqual].sort().map((key) => [key, ownValue(row.keys, key)]), ["basis", label]]);', replace: 'const group = {};\n        for (const key of [...keys.heldEqual].sort())\n            group[key] = ownValue(row.keys, key);\n        group.basis = label;' })));
  await assertCaughtBy("only the first row checked", DECLARED, () => checkDeclared(variant({ find: "for (const [at, row] of rows.entries()) {", replace: "for (const [at, row] of [...rows.entries()].slice(0, 1)) {" })));
});

const SENTINEL = "SENTINEL-VALUE-3f1a";
const ROLES = "an aggregate's refusal names a role and a position, and repeats none of what it was handed";

/** Every refusal, each with the sentinel wherever the caller could put a string, and the `at` written out. */
const checkRoles = (module: Module) => {
  const row = rowFor("B1", "usable", "observed");
  const keysWith = (extra: Record<string, string | null>) => ({ ...row.keys, ...extra });
  const held = { ...KEYS, heldEqual: [...KEYS.heldEqual, SENTINEL] };
  const table: readonly (readonly [string, readonly AggregateRow[], Measure, string, string])[] = [
    ["no keys", [row], { ...MEASURE, id: SENTINEL, subject: SENTINEL, keys: null }, "no-declared-keys", "measure.keys"],
    ["no key held", [row], { ...MEASURE, id: SENTINEL, keys: { ...KEYS, heldEqual: [] } }, "no-declared-keys", "measure.keys"],
    ["a reason left empty", [row], { ...MEASURE, id: SENTINEL, keys: { ...KEYS, allowedToVary: [{ key: "arm", reason: "It may." }, { key: SENTINEL, reason: " " }] } }, "empty-reason", "allowedToVary[1]"],
    ["why outside left empty", [row], { ...MEASURE, id: SENTINEL, population: { arm: "baseline", whyOutside: " " } }, "empty-reason", "population.whyOutside"],
    ["a key no one declared", [row, { ...row, keys: keysWith({ [SENTINEL]: SENTINEL }) }], MEASURE, "undeclared-key", "rows[1].keys"],
    ["a held key missing", [row], { ...MEASURE, keys: held }, "declared-key-missing", "rows[0] heldEqual[3]"],
    ["a held key null", [{ ...row, keys: keysWith({ [SENTINEL]: null }) }], { ...MEASURE, keys: held }, "held-key-unknown", "rows[0] heldEqual[3]"],
    ["an allowed key missing", [row], { ...MEASURE, keys: { ...KEYS, allowedToVary: [...KEYS.allowedToVary, { key: SENTINEL, reason: "It may." }] } }, "declared-key-missing", "rows[0] allowedToVary[1]"],
    ["an unknown key with a value", [row, { ...row, keys: keysWith({ operator: SENTINEL }) }], MEASURE, "unknown-key-has-value", "rows[1] unknown[0]"],
    ["a basis nobody defined", [{ ...row, slot: SENTINEL as SlotName, basis: SENTINEL as never }], MEASURE, "basis-unknown", "rows[0].basis"],
    ["a reading nobody defined", [{ ...row, readings: { "subject-lantern": { reading: SENTINEL, limits: [] } as never } }], MEASURE, "reading-malformed", "rows[0].readings"]
  ];
  for (const [name, rows, measure, refusal, at] of table) {
    const answer = module.aggregate(rows, measure);
    holds(ROLES, !answer.ok && answer.refusal === refusal && answer.at === at, () => ({ name, answer }));
    holds(ROLES, !JSON.stringify(answer).includes(SENTINEL), () => ({ name, answer }));
  }
  // The one name it does say is its own constant, and not the caller's.
  const notHeld = module.aggregate([row], { ...MEASURE, id: SENTINEL, keys: { ...KEYS, heldEqual: ["commit", "configuration", SENTINEL] } });
  holds(ROLES, !notHeld.ok && notHeld.refusal === "split-key-not-held" && notHeld.at === "release", () => notHeld);
};

test("an aggregate's refusals repeat nothing they were handed", async () => {
  checkRoles(production);
  const echoing = (find: string, replace: string) => () => checkRoles(variant({ find, replace }));
  await assertCaughtBy("a refusal naming the measure by its id", ROLES, echoing('return refuse("no-declared-keys", "measure.keys");', 'return refuse("no-declared-keys", measure.id);'));
  await assertCaughtBy("an undeclared key repeated", ROLES, echoing('return refuse("undeclared-key", `rows[${at}].keys`);', 'return refuse("undeclared-key", key);'));
  await assertCaughtBy("a missing held key repeated", ROLES, echoing('if (value === undefined)\n                return refuse("declared-key-missing", `rows[${at}] heldEqual[${index}]`);', 'if (value === undefined)\n                return refuse("declared-key-missing", key);'));
  await assertCaughtBy("an unknown held key repeated", ROLES, echoing('return refuse("held-key-unknown", `rows[${at}] heldEqual[${index}]`);', 'return refuse("held-key-unknown", key);'));
  await assertCaughtBy("a missing allowed key repeated", ROLES, echoing('return refuse("declared-key-missing", `rows[${at}] allowedToVary[${index}]`);', 'return refuse("declared-key-missing", key);'));
  await assertCaughtBy("an unknown key's name repeated", ROLES, echoing('return refuse("unknown-key-has-value", `rows[${at}] unknown[${index}]`);', 'return refuse("unknown-key-has-value", key);'));
  await assertCaughtBy("an empty reason's key repeated", ROLES, echoing('return refuse("empty-reason", `allowedToVary[${index}]`);', 'return refuse("empty-reason", keys.allowedToVary[index].key);'));
  await assertCaughtBy("a slot repeated for its basis", ROLES, echoing('return refuse("basis-unknown", `rows[${at}].basis`);', 'return refuse("basis-unknown", row.slot);'));
  await assertCaughtBy("a malformed reading let through", ROLES, echoing('if (held !== undefined && !isAttemptReading(held))\n            return refuse("reading-malformed", `rows[${at}].readings`);', ""));
});

const GROUP_LIMITS = "a group says what limited its readings, counted per reading, and n, zero and unknown still partition its denominator";

const checkGroupLimits = (module: Module) => {
  const withReading = (slot: SlotName, reading: AttemptReading["reading"], limits: readonly string[]): AggregateRow => ({ ...rowFor(slot, "usable", null), readings: { "subject-lantern": plain(reading, limits) } });
  const rows = [
    withReading("B1", "observed", ["coverage_not_complete", "late"]),
    withReading("B2", "observed", ["coverage_not_complete"]),
    withReading("B3", "observed", []),
    withReading("I1", "zero_in_window", ["attempt_walled"]),
    withReading("I2", "zero_in_window", ["attempt_incomplete", "attempt_incomplete"]),
    withReading("I3", "unknown", ["no_record"]),
    rowFor("I3", "not_started", null)
  ];
  const whole = module.aggregate(rows, MEASURE);
  holds(GROUP_LIMITS, whole.ok && whole.groups.length === 1, () => whole);
  const [group] = (whole as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(GROUP_LIMITS, JSON.stringify([group.n, group.zero, group.unknown, group.of]) === "[3,2,2,7]", () => group);
  // Each limit by the reading it came with, and an attempt counts once however its limits are listed.
  holds(GROUP_LIMITS, JSON.stringify(group.limits) === JSON.stringify({ observed: { coverage_not_complete: 2, late: 1 }, zero_in_window: { attempt_incomplete: 1, attempt_walled: 1 }, unknown: { no_record: 1 } }), () => group.limits);
  // A population's group counts only those inside it.
  const narrowed = module.aggregate(rows, { ...MEASURE, population: { arm: "baseline", whyOutside: "Baseline only." } });
  holds(GROUP_LIMITS, narrowed.ok && JSON.stringify(narrowed.groups[0].limits) === JSON.stringify({ observed: { coverage_not_complete: 2, late: 1 }, zero_in_window: {}, unknown: {} }), () => narrowed);
  // Another subject's limits are not this one's.
  const elsewhere = module.aggregate([{ ...rowFor("B1", "usable", null), readings: { "subject-lantern": plain("observed"), "subject-other": plain("zero_in_window", ["attempt_walled"]) } }], MEASURE);
  holds(GROUP_LIMITS, elsewhere.ok && JSON.stringify(elsewhere.groups[0].limits) === JSON.stringify(NO_LIMITS), () => elsewhere);
  // A reading that is not one is refused, so the partition cannot lose it.
  const BAD_READINGS: readonly unknown[] = ["observed", 7, { reading: "seen", limits: [] }, { reading: "observed" }, { reading: "observed", limits: "late" }, null, { reading: "observed", limits: [7] }, { reading: "observed", limits: [null] }, { reading: "observed", limits: [{ a: 1 }] }, { reading: "observed", limits: ["CANARY-held"] }, { reading: "zero_in_window", limits: ["late", "CANARY-held"] }];
  for (const bad of BAD_READINGS) {
    const refused = module.aggregate([{ ...rowFor("B1", "usable", null), readings: { "subject-lantern": bad as never } }], MEASURE);
    holds(GROUP_LIMITS, !refused.ok && refused.refusal === "reading-malformed" && !JSON.stringify(refused).includes("CANARY"), () => ({ bad, refused }));
    // A row the population leaves out is still held to it, since its reading is still what the caller handed in.
    const outside = module.aggregate([rowFor("I1", "usable", "observed"), { ...rowFor("B1", "usable", null), readings: { "subject-lantern": bad as never } }], { ...MEASURE, population: { arm: "instrumented", whyOutside: "Instrumented only." } });
    holds(GROUP_LIMITS, !outside.ok && outside.refusal === "reading-malformed" && outside.at === "rows[1].readings", () => ({ bad, outside }));
  }
  // Every limit a reading can carry passes, and reaches the count: what withholds complete, and each state of a row with nothing to read.
  const EVERY_LIMIT = ["attempt_incomplete", "attempt_walled", "before_window", "cleanup_unresolved", "coverage_not_complete", "function_only", "late", "malformed_record", "no_record", "not_read", "operation_failed", "out_of_scope", "truncated", "window_not_closed"];
  const all = module.aggregate([{ ...rowFor("B1", "usable", null), readings: { "subject-lantern": plain("unknown", EVERY_LIMIT) } }], MEASURE);
  holds(GROUP_LIMITS, all.ok && JSON.stringify(all.groups[0].limits.unknown) === JSON.stringify(Object.fromEntries(EVERY_LIMIT.map((limit) => [limit, 1]))), () => all);
};

/** Through a real case: the readings' limits, each read from its own attempt, reach the group. */
const checkLimitsFromCase = (module: Module) => {
  const world = driven(machine, GROUP_LIMITS, planOf("B1", "B2", "B3", "I1"), frozen, controlMet(), ...visitOf("B1", "walled"), ...visitOf("B2", "incomplete"), ...visitOf("B3", "failed"));
  const complete = (slot: SlotName) => ({ slot, instrument: "coverage", completeness: "complete" as const, reason: null });
  const zeroOf = (slot: SlotName) => row(`row-${slot.toLowerCase()}`, slot, { observation: observation(0) });
  const record: EvidenceRecord = { ...EMPTY_RECORD, rows: [zeroOf("B1"), zeroOf("B2"), zeroOf("B3")], instruments: [complete("B1"), complete("B2"), complete("B3")] };
  const keysOf = () => ({ release: RELEASE_OLD, commit: COMMIT_OLD });
  const rows = module.aggregateRowsOf(world, record, keysOf);
  const held = (slot: SlotName) => rows.find((candidate) => candidate.slot === slot)?.readings["subject-lantern"];
  holds(GROUP_LIMITS, JSON.stringify(held("B1")) === JSON.stringify(plain("zero_in_window", ["attempt_walled"])), () => held("B1"));
  holds(GROUP_LIMITS, JSON.stringify(held("B2")) === JSON.stringify(plain("zero_in_window", ["attempt_incomplete"])), () => held("B2"));
  holds(GROUP_LIMITS, JSON.stringify(held("B3")) === JSON.stringify(plain("unknown", ["operation_failed"])), () => held("B3"));
  const result = module.aggregate(rows, MEASURE_WITH_ARM);
  holds(GROUP_LIMITS, result.ok, () => result);
  const [group] = (result as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(GROUP_LIMITS, group.zero === 2 && group.unknown === 2 && group.n === 0 && group.of === 4, () => group);
  holds(GROUP_LIMITS, JSON.stringify(group.limits) === JSON.stringify({ observed: {}, zero_in_window: { attempt_incomplete: 1, attempt_walled: 1 }, unknown: { operation_failed: 1 } }), () => group.limits);

  // A late positive keeps late. The row beside it on the same attempt keeps its own, under the reading it gave.
  const usable = driven(machine, GROUP_LIMITS, planOf("B1", "I1"), frozen, controlMet(), ...visitOf("B1"));
  const late = row("row-late", "B1", { state: "late", observation: observation(4) });
  const lateZero = row("row-late-zero", "B1", { state: "late", observation: { ...observation(0), subject: "subject-thimble" } });
  const noRecord = row("row-nothing", "B1", { state: "no_record", digest: null, observation: { ...observation(null), subject: "subject-quill" } });
  const withLate: EvidenceRecord = { ...EMPTY_RECORD, rows: [late, lateZero, noRecord], instruments: [complete("B1")] };
  const [first] = module.aggregateRowsOf(usable, withLate, keysOf);
  holds(GROUP_LIMITS, JSON.stringify(first.readings["subject-lantern"]) === JSON.stringify(plain("observed", ["late"])), () => first.readings);
  holds(GROUP_LIMITS, JSON.stringify(first.readings["subject-thimble"]) === JSON.stringify(plain("unknown", ["late"])), () => first.readings);
  holds(GROUP_LIMITS, JSON.stringify(first.readings["subject-quill"]) === JSON.stringify(plain("unknown", ["no_record"])), () => first.readings);
  // A positive's limits are its own rows', and a 0 beside it does not lend it any.
  const mixed: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-seen", "B1", { observation: observation(4) }), row("row-narrow", "B1", { observation: { ...observation(0), granularity: "function" } })], instruments: [complete("B1")] };
  holds(GROUP_LIMITS, JSON.stringify(module.aggregateRowsOf(usable, mixed, keysOf)[0].readings["subject-lantern"]) === JSON.stringify(plain("observed")), () => "a positive beside a limited 0");
  // Every row's limits stand on an unknown and on a 0 made of several rows, once each and in order.
  const several: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-one", "B1", { observation: { ...observation(0), granularity: "function" } }), row("row-two", "B1", { observation: { ...observation(0), granularity: "function", windowEnd: "truncated" } }), row("row-three", "B1", { state: "not_read", digest: null, observation: observation(null) })], instruments: [complete("B1")] };
  holds(GROUP_LIMITS, JSON.stringify(module.aggregateRowsOf(usable, several, keysOf)[0].readings["subject-lantern"]) === JSON.stringify(plain("unknown", ["function_only", "not_read", "window_not_closed"])), () => module.aggregateRowsOf(usable, several, keysOf)[0].readings);
};

test("a group carries every limit its readings carried, and overstates nothing", async () => {
  checkGroupLimits(production);
  checkLimitsFromCase(production);
  const counted = (name: string, find: string, replace: string) => assertCaughtBy(name, GROUP_LIMITS, () => checkGroupLimits(variant({ find, replace })));
  const fromCase = (name: string, find: string, replace: string) => assertCaughtBy(name, GROUP_LIMITS, () => checkLimitsFromCase(variant({ find, replace })));
  await counted("a group with no limits", "limits: { observed: limitCounts(reading(\"observed\")), zero_in_window: limitCounts(reading(\"zero_in_window\")), unknown: limitCounts(reading(\"unknown\")) },", "limits: { observed: {}, zero_in_window: {}, unknown: {} },");
  await counted("a 0's limits counted under the positives", 'observed: limitCounts(reading("observed")), zero_in_window: limitCounts(reading("zero_in_window"))', 'observed: limitCounts(held), zero_in_window: limitCounts(reading("zero_in_window"))');
  await counted("an attempt counted once per repeat", "for (const limit of new Set(limits))", "for (const limit of limits)");
  await counted("limits read over the whole group", "const held = inside.map((row) =>", "const held = members.map((row) =>");
  await counted("a malformed reading counted as nothing", 'if (held !== undefined && !isAttemptReading(held))\n            return refuse("reading-malformed", `rows[${at}].readings`);', "");
  await counted("a reading with no limits list taken", '(reading === "observed" || reading === "zero_in_window" || reading === "unknown") && Array.isArray(limits) && limits.every((limit) => LIMIT_NAMES.includes(limit))', '(reading === "observed" || reading === "zero_in_window" || reading === "unknown")');
  await counted("a list of anything taken as limits", " && limits.every((limit) => LIMIT_NAMES.includes(limit))", "");
  await counted("only the first limit looked at", "limits.every((limit) => LIMIT_NAMES.includes(limit))", "limits.slice(0, 1).every((limit) => LIMIT_NAMES.includes(limit))");
  await counted("a row's own states refused as limits", "const LIMIT_NAMES = [...readings_1.COMPLETENESS_LIMITS, ...evidence_model_1.UNREAD_STATES];", "const LIMIT_NAMES = [...readings_1.COMPLETENESS_LIMITS];");
  await counted("what withholds complete refused as limits", "const LIMIT_NAMES = [...readings_1.COMPLETENESS_LIMITS, ...evidence_model_1.UNREAD_STATES];", "const LIMIT_NAMES = [...evidence_model_1.UNREAD_STATES];");
  await counted("a malformed reading refused only inside the population", 'if (held !== undefined && !isAttemptReading(held))', "if (held !== undefined && !isAttemptReading(held) && (population === null || row.arm === population.arm))");
  await counted("limits read off another subject", 'const held = inside.map((row) => { var _a; return (_a = ownValue(row.readings, measure.subject))', 'const held = inside.map((row) => { var _a; return (_a = ownValue(row.readings, "subject-other"))');
  await fromCase("a positive's limits dropped", 'return { reading: "observed", limits: limitsOfAll(saw) };', 'return { reading: "observed", limits: [] };');
  await fromCase("a positive borrowing every row's limits", 'return { reading: "observed", limits: limitsOfAll(saw) };', 'return { reading: "observed", limits: limitsOfAll(readings) };');
  await fromCase("a 0's limits dropped", "return { reading, limits: limitsOfAll(readings) };", "return { reading, limits: [] };");
  await fromCase("a row's own state not carried", 'return "reason" in reading ? [reading.reason] : [];', "return [];");
  await fromCase("limits repeated across rows", "return [...new Set(readings.flatMap(limitsOfReading))].sort();", "return readings.flatMap(limitsOfReading).sort();");
  await fromCase("limits left in row order", "return [...new Set(readings.flatMap(limitsOfReading))].sort();", "return [...new Set(readings.flatMap(limitsOfReading))];");
});

const POPULATION = "a population narrows by arm alone, and says who it left out and why";

const checkPopulation = (module: Module) => {
  const narrowed = module.aggregate(SIX, { ...MEASURE, population: { arm: "instrumented", whyOutside: "baseline-has-no-coverage" } });
  holds(POPULATION, narrowed.ok, () => narrowed);
  const [group] = (narrowed as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(POPULATION, group.of === 3 && group.outsideDenominator === 3 && group.whyOutside === "baseline-has-no-coverage", () => group);
  holds(POPULATION, group.of + group.outsideDenominator === SIX.length, () => group);
  holds(POPULATION, group.n + group.zero + group.unknown === group.of, () => group);
  holds(POPULATION, group.notStarted === 2 && group.failed === 0, () => group);
  // Members the population left out are counted as outside, and in none of its figures.
  const outside = module.aggregate([rowFor("B1", "not_started", null), rowFor("B2", "failed", null), rowFor("B3", "planned", null), rowFor("I1", "usable", "observed")], { ...MEASURE, population: { arm: "instrumented", whyOutside: "baseline-has-no-coverage" } });
  holds(POPULATION, outside.ok && outside.groups.length === 1, () => outside);
  const [theirs] = (outside as Extract<production.AggregateResult, { ok: true }>).groups;
  holds(POPULATION, JSON.stringify([theirs.n, theirs.of, theirs.zero, theirs.unknown, theirs.notStarted, theirs.failed, theirs.outsideDenominator]) === "[1,1,0,0,0,0,3]", () => theirs);
  // Limits too: those of the attempts inside it, in each reading, and none of those it left out.
  const limited = (slot: SlotName, reading: AttemptReading["reading"], limits: readonly string[]): AggregateRow => ({ ...rowFor(slot, "usable", null), readings: { "subject-lantern": plain(reading, limits) } });
  const both = module.aggregate(
    [limited("B1", "observed", ["late"]), limited("B2", "zero_in_window", ["attempt_walled"]), limited("B3", "unknown", ["no_record"]), limited("I1", "observed", ["coverage_not_complete"]), limited("I2", "zero_in_window", ["attempt_incomplete"]), limited("I3", "unknown", ["operation_failed"])],
    { ...MEASURE, population: { arm: "instrumented", whyOutside: "baseline-has-no-coverage" } }
  );
  holds(POPULATION, both.ok && JSON.stringify(both.groups[0].limits) === JSON.stringify({ observed: { coverage_not_complete: 1 }, zero_in_window: { attempt_incomplete: 1 }, unknown: { operation_failed: 1 } }), () => both);
};

test("a measure's population can only narrow by arm, and its totals still add up", async () => {
  checkPopulation(production);
  await assertCaughtBy("the population ignored", POPULATION, () => checkPopulation(variant({ find: "const inside = population === null ? members : members.filter(({ arm }) => arm === population.arm);", replace: "const inside = members;" })));
  await assertCaughtBy("limits counted over the whole group", POPULATION, () => checkPopulation(variant({ find: 'limits: { observed: limitCounts(reading("observed")), zero_in_window: limitCounts(reading("zero_in_window")), unknown: limitCounts(reading("unknown")) },', replace: 'limits: { observed: limitCounts(members.map((row) => row.readings[measure.subject]).filter((one) => one !== undefined && one.reading === "observed")), zero_in_window: limitCounts(members.map((row) => row.readings[measure.subject]).filter((one) => one !== undefined && one.reading === "zero_in_window")), unknown: limitCounts(members.map((row) => row.readings[measure.subject]).filter((one) => one !== undefined && one.reading === "unknown")) },' })));
  await assertCaughtBy("no reason kept", POPULATION, () => checkPopulation(variant({ find: "whyOutside: population === null ? null : population.whyOutside,", replace: "whyOutside: null," })));
  await assertCaughtBy("not started read over the whole group", POPULATION, () => checkPopulation(variant({ find: 'notStarted: inside.filter(({ phase }) => phase === "planned" || phase === "not_started").length', replace: 'notStarted: members.filter(({ phase }) => phase === "planned" || phase === "not_started").length' })));
  await assertCaughtBy("failed read over the whole group", POPULATION, () => checkPopulation(variant({ find: 'failed: inside.filter(({ phase }) => phase === "failed").length', replace: 'failed: members.filter(({ phase }) => phase === "failed").length' })));
  await assertCaughtBy("the left-out count lost", POPULATION, () => checkPopulation(variant({ find: "outsideDenominator: members.length - inside.length,", replace: "outsideDenominator: 0," })));
});

const SAYS = "an aggregate says it is one, on every group";

const checkSays = (module: Module) => {
  const result = module.aggregate([rowFor("B1", "usable", "observed"), rowFor("B2", "usable", "observed", { commit: COMMIT_NEW })], MEASURE);
  holds(SAYS, result.ok && result.groups.length === 2, () => result);
  const { groups } = result as Extract<production.AggregateResult, { ok: true }>;
  holds(SAYS, groups[0].presentedAs === "aggregate across attempts, not one execution" && groups[1].presentedAs === "aggregate across attempts, not one execution", () => groups);
};

test("an aggregate says what it is", async () => {
  checkSays(production);
  await assertCaughtBy("an aggregate that reads as one execution", SAYS, () => checkSays(variant({ find: 'presentedAs: "aggregate across attempts, not one execution",', replace: 'presentedAs: "one execution",' })));
  assert.deepEqual(aggregate([], MEASURE), { ok: true, groups: [] });
});

const ONE_ATTEMPT = "evidence comes one attempt at a time, and of that attempt only";

function row(id: string, slot: SlotName, over: Partial<EvidenceRow> = {}): EvidenceRow {
  return rowShape(id, slot, over);
}

const rowShape = (id: string, slot: SlotName, over: Partial<EvidenceRow> = {}): EvidenceRow => ({ id, slot, instrument: "coverage", state: "present", window: { clock: "page", startMs: 0, endMs: 10 }, limits: [], digest: "ab".repeat(32), observation: null, ...over });

const checkOneAttempt = (module: Module) => {
  const world = driven(machine, ONE_ATTEMPT, planOf("B1", "B2", "I1"), frozen, controlMet());
  const record: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-one", "B1"), row("row-two", "I1"), row("row-three", "B1"), row("row-four", "B2")] };
  const answer = (slots: readonly SlotName[]) => module.evidenceForAttempt(world, record, slots);
  for (const slots of [["B1", "I1"], ["B1", "B1"], ["B1", "B2", "I1"], []] as const) {
    const refused = answer(slots);
    holds(ONE_ATTEMPT, !refused.ok && refused.refusal === "one-attempt-at-a-time", () => ({ slots, refused }));
  }
  const unplanned = answer(["I3"]);
  holds(ONE_ATTEMPT, !unplanned.ok && unplanned.refusal === "no-such-attempt", () => unplanned);
  const one = answer(["B1"]);
  holds(ONE_ATTEMPT, one.ok && one.rows.map(({ id }) => id).join() === "row-one,row-three", () => one);
  const empty = answer(["I1"]);
  holds(ONE_ATTEMPT, empty.ok && empty.rows.map(({ id }) => id).join() === "row-two", () => empty);

  // Rows of every state are handed back, in order, as the record holds them: what is not present is the point of asking.
  const states: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-seen", "B1"), row("row-not-recorded", "B1", { state: "no_record", digest: null }), row("row-after", "B1", { state: "late" }), row("row-elsewhere", "I1"), row("row-outside", "B1", { state: "out_of_scope", digest: null })] };
  const everyState = module.evidenceForAttempt(world, states, ["B1"]);
  holds(ONE_ATTEMPT, everyState.ok && JSON.stringify(everyState.rows.map(({ id, state }) => [id, state])) === JSON.stringify([["row-seen", "present"], ["row-not-recorded", "no_record"], ["row-after", "late"], ["row-outside", "out_of_scope"]]), () => everyState);
  // Each row comes with its reading, so a bare count of 0 does not leave without what limits it.
  const walled = driven(machine, ONE_ATTEMPT, planOf("B1", "B2", "I1"), frozen, controlMet(), ...visitOf("B1", "walled"));
  // Limits of its own, so a row handed back without them is noticed.
  const zeroRow = row("row-zero", "B1", { limits: ["main-frame-only"], observation: observation(0) });
  const bareRow = row("row-bare", "B1");
  const notRead = row("row-unread", "B1", { state: "no_record", digest: null, observation: observation(null) });
  const instrumented: EvidenceRecord = { ...EMPTY_RECORD, rows: [zeroRow, bareRow, notRead], instruments: [{ slot: "B1", instrument: "coverage", completeness: "complete", reason: null }] };
  const handedBack = module.evidenceForAttempt(walled, instrumented, ["B1"]);
  holds(ONE_ATTEMPT, handedBack.ok, () => handedBack);
  const withReadings = (handedBack as Extract<production.AttemptEvidence, { ok: true }>).rows;
  holds(
    ONE_ATTEMPT,
    JSON.stringify(withReadings.map(({ id, reading }) => [id, reading])) ===
      JSON.stringify([
        ["row-zero", { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_walled"] }],
        ["row-bare", { reading: "recorded" }],
        ["row-unread", { reading: "unknown", reason: "no_record", complete: false }]
      ]),
    () => withReadings
  );
  // And the row itself is still all there.
  const { reading: _reading, ...sameRow } = withReadings[0];
  holds(ONE_ATTEMPT, JSON.stringify(sameRow) === JSON.stringify(zeroRow), () => withReadings[0]);
  // Rows and nothing else of the record: the owner's claims and unknowns are not evidence, and do not come with it.
  const withClaims: EvidenceRecord = { ...states, unknowns: [{ kind: "unknown", id: "question-one", question: "Which loader?", reason: "Not covered.", detail: null, wouldResolve: null }], facts: [{ kind: "fact", id: "fact-one", version: 1, status: "current", statement: "It ran.", links: [], history: [], retraction: null }] };
  const onlyRows = module.evidenceForAttempt(world, withClaims, ["B1"]);
  holds(ONE_ATTEMPT, JSON.stringify(Object.keys(onlyRows).sort()) === '["ok","rows"]', () => Object.keys(onlyRows));
  holds(ONE_ATTEMPT, onlyRows.ok && !JSON.stringify(onlyRows).includes("question-one") && !JSON.stringify(onlyRows).includes("fact-one"), () => onlyRows);
};

test("cross-attempt evidence is refused", async () => {
  checkOneAttempt(production);
  await assertCaughtBy("a cross-attempt link", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: 'if (slots.length !== 1)\n        return { ok: false, refusal: "one-attempt-at-a-time" };', replace: "" })));
  await assertCaughtBy("rows of every attempt handed back", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "rows: record.rows.filter((row) => row.slot === slot)", replace: "rows: record.rows" })));
  await assertCaughtBy("only present rows handed back", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "rows: record.rows.filter((row) => row.slot === slot)", replace: 'rows: record.rows.filter((row) => row.slot === slot && row.state === "present")' })));
  await assertCaughtBy("no_record rows hidden", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "rows: record.rows.filter((row) => row.slot === slot)", replace: 'rows: record.rows.filter((row) => row.slot === slot && row.state !== "no_record")' })));
  await assertCaughtBy("late rows hidden", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "rows: record.rows.filter((row) => row.slot === slot)", replace: 'rows: record.rows.filter((row) => row.slot === slot && row.state !== "late")' })));
  await assertCaughtBy("the owner's unknowns handed back with the rows", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "return { ok: true, rows: record.rows.filter((row) => row.slot === slot).map(", replace: "return { ok: true, unknowns: record.unknowns, rows: record.rows.filter((row) => row.slot === slot).map(" })));
  await assertCaughtBy("a row's own limits dropped as it is handed back", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "Object.assign(Object.assign({}, row), { reading: (0, evidence_model_1.readRow)(record, machine, row) })", replace: "Object.assign(Object.assign({}, row), { limits: [], reading: (0, evidence_model_1.readRow)(record, machine, row) })" })));
  await assertCaughtBy("rows handed back with no reading", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: ".map((row) => (Object.assign(Object.assign({}, row), { reading: (0, evidence_model_1.readRow)(record, machine, row) })))", replace: "" })));
  await assertCaughtBy("a row's reading read from no record", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: "{ reading: (0, evidence_model_1.readRow)(record, machine, row) }", replace: "{ reading: (0, evidence_model_1.readRow)(evidence_model_1.EMPTY_RECORD, machine, row) }" })));
  await assertCaughtBy("an attempt not in the plan answered", ONE_ATTEMPT, () => checkOneAttempt(variant({ find: 'if (!machine.attempts.some((attempt) => attempt.slot === slot))\n        return { ok: false, refusal: "no-such-attempt" };', replace: "" })));
  assert.deepEqual(evidenceForAttempt(driven(machine, "runs", planOf("B1"), frozen), EMPTY_RECORD, []), { ok: false, refusal: "one-attempt-at-a-time" });
});

const FROM_CASE = "rows come from the machine and the record, one per planned slot, each read in its own attempt";

function observation(count: number | null): NonNullable<EvidenceRow["observation"]> {
  return { subject: "subject-lantern", count, granularity: "block", windowEnd: "window_closed", scope: "in_scope" };
}

const checkRowsOf = (module: Module) => {
  const world = driven(
    machine,
    FROM_CASE,
    planOf("B1", "B2", "B3", "I1"),
    frozen,
    controlMet(),
    startOf("B1"),
    ...captureOf("B1"),
    finishOf("B1"),
    confirmOf("B1"),
    { type: "configuration-changed", configuration: CONFIG_B, by: OWNER },
    controlMet(CONFIG_B),
    startOf("B2"),
    ...captureOf("B2"),
    finishOf("B2", "failed"),
    confirmOf("B2"),
    { type: "case-cancelled", by: OWNER }
  );
  const record: EvidenceRecord = {
    ...EMPTY_RECORD,
    rows: [
      // Two rows on one subject: a positive and a 0, which together stay observed.
      row("row-one", "B1", { observation: observation(0) }),
      row("row-two", "B1", { observation: observation(4) }),
      // A 0 and a row that cannot say, on the usable attempt: unknown, since one row that cannot say leaves it open.
      row("row-three", "B1", { observation: { ...observation(0), subject: "subject-thimble" } }),
      row("row-four", "B1", { state: "no_record", digest: null, observation: { ...observation(null), subject: "subject-thimble" } }),
      // A failed attempt's 0 says nothing.
      row("row-seven", "B2", { observation: observation(0) })
    ],
    visitBases: [{ slot: "B1", basis: "control" }, { slot: "B2", basis: "exception" }]
  };
  const keysOf = (configuration: string) => (configuration === CONFIG_A ? { release: RELEASE_OLD, commit: COMMIT_OLD } : { release: RELEASE_NEW, commit: COMMIT_NEW });
  const rows = module.aggregateRowsOf(world, record, keysOf);
  holds(FROM_CASE, rows.map(({ slot }) => slot).join() === "B1,B2,B3,I1", () => rows);
  holds(FROM_CASE, rows.map(({ phase }) => phase).join() === "usable,failed,not_started,not_started", () => rows);
  holds(FROM_CASE, rows[0].readings["subject-lantern"].reading === "observed" && rows[0].readings["subject-thimble"].reading === "unknown", () => rows[0]);
  // Each row's own arm, attempt and basis, spelled, on a plan of both arms.
  holds(FROM_CASE, JSON.stringify(rows.map(({ keys }) => keys.arm)) === '["baseline","baseline","baseline","instrumented"]', () => rows.map(({ keys }) => keys));
  holds(FROM_CASE, JSON.stringify(rows.map(({ arm }) => arm)) === '["baseline","baseline","baseline","instrumented"]', () => rows);
  holds(FROM_CASE, JSON.stringify(rows.map(({ attemptId }) => attemptId)) === JSON.stringify([ATTEMPT_IDS.B1, ATTEMPT_IDS.B2, ATTEMPT_IDS.B3, ATTEMPT_IDS.I1]), () => rows);
  // A slot no visit reached rested on nothing, control or exception.
  holds(FROM_CASE, JSON.stringify(rows.map(({ basis }) => basis)) === '["control","exception","not_visited","not_visited"]', () => rows);
  holds(FROM_CASE, rows[1].readings["subject-lantern"].reading === "unknown", () => rows[1]);
  holds(FROM_CASE, JSON.stringify(rows[2].readings) === "{}", () => rows[2]);
  // What ran under the first configuration splits from what was closed under the second.
  holds(FROM_CASE, rows[0].keys.configuration === CONFIG_A && rows[0].keys.release === RELEASE_OLD, () => rows[0]);
  holds(FROM_CASE, rows[2].keys.configuration === CONFIG_B && rows[2].keys.release === RELEASE_NEW && rows[2].keys.commit === COMMIT_NEW, () => rows[2]);

  // A slot still waiting reads the configuration in force.
  const waiting = driven(machine, FROM_CASE, planOf("B1"), frozen, { type: "configuration-changed", configuration: CONFIG_B, by: OWNER });
  const waitingRows = module.aggregateRowsOf(waiting, EMPTY_RECORD, keysOf);
  holds(FROM_CASE, waitingRows[0].keys.configuration === CONFIG_B && waitingRows[0].phase === "planned", () => waitingRows);
  // A slot still waiting has rested on nothing yet, the same as one closed unstarted.
  holds(FROM_CASE, waitingRows[0].basis === "not_visited", () => waitingRows);

  // A 0 from every row is a 0.
  const zeros: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-five", "B1", { observation: observation(0) }), row("row-six", "B1", { observation: observation(0) })] };
  holds(FROM_CASE, module.aggregateRowsOf(world, zeros, keysOf)[0].readings["subject-lantern"].reading === "zero_in_window", () => "two zeros");
  // In either order: a positive that came first stays, and so does a row that could not say.
  const positiveFirst: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-ten", "B1", { observation: observation(4) }), row("row-eleven", "B1", { observation: observation(0) })] };
  holds(FROM_CASE, module.aggregateRowsOf(world, positiveFirst, keysOf)[0].readings["subject-lantern"].reading === "observed", () => "a positive, then a 0");
  const unknownFirst: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-twelve", "B1", { state: "no_record", digest: null, observation: observation(null) }), row("row-thirteen", "B1", { observation: observation(0) })] };
  holds(FROM_CASE, module.aggregateRowsOf(world, unknownFirst, keysOf)[0].readings["subject-lantern"].reading === "unknown", () => "a row that could not say, then a 0");

  // A subject named like something every object has is still just a subject.
  const oddlyNamed: EvidenceRecord = { ...EMPTY_RECORD, rows: [row("row-eight", "B1", { observation: { ...observation(4), subject: "__proto__" } }), row("row-nine", "B1", { observation: { ...observation(4), subject: "constructor" } })] };
  const [odd] = module.aggregateRowsOf(world, oddlyNamed, keysOf);
  holds(FROM_CASE, JSON.stringify(Object.entries(odd.readings).map(([subject, { reading }]) => [subject, reading])) === '[["__proto__","observed"],["constructor","observed"]]', () => odd.readings);
};

test("rows are read from the case itself", async () => {
  checkRowsOf(production);
  await assertCaughtBy("a 0 beating a positive", FROM_CASE, () => checkRowsOf(variant({ find: 'if (saw.length > 0)\n        return { reading: "observed", limits: limitsOfAll(saw) };', replace: "" })));
  await assertCaughtBy("one 0 being enough", FROM_CASE, () => checkRowsOf(variant({ find: 'readings.every((row) => row.reading === "zero_in_window")', replace: 'readings.some((row) => row.reading === "zero_in_window")' })));
  await assertCaughtBy("a row read into every attempt", FROM_CASE, () => checkRowsOf(variant({ find: "if (row.slot !== attempt.slot || row.observation === null)", replace: "if (row.observation === null)" })));
  await assertCaughtBy("only the last row on a subject counted", FROM_CASE, () => checkRowsOf(variant({ find: "[...((_b = bySubject.get(row.observation.subject)) !== null && _b !== void 0 ? _b : []), (0, evidence_model_1.readRow)(record, machine, row)]", replace: "[(0, evidence_model_1.readRow)(record, machine, row)]" })));
  await assertCaughtBy("the arm key on every row says baseline", FROM_CASE, () => checkRowsOf(variant({ find: "keys: { release, commit, configuration, arm: attempt.arm }", replace: 'keys: { release, commit, configuration, arm: "baseline" }' })));
  await assertCaughtBy("every visit read as control", FROM_CASE, () => checkRowsOf(variant({ find: 'const basis = visit === undefined ? "not_visited" : visit.basis;', replace: 'const basis = "control";' })));
  await assertCaughtBy("a visit's basis read from another slot", FROM_CASE, () => checkRowsOf(variant({ find: "const visit = record.visitBases.find(({ slot }) => slot === attempt.slot);", replace: "const visit = record.visitBases[0];" })));
  await assertCaughtBy("a waiting slot read as on the control", FROM_CASE, () => checkRowsOf(variant({ find: 'const basis = visit === undefined ? "not_visited" : visit.basis;', replace: 'const basis = visit === undefined ? (attempt.phase === "planned" ? "control" : "not_visited") : visit.basis;' })));
  await assertCaughtBy("a slot with no visit read as on the control", FROM_CASE, () => checkRowsOf(variant({ find: 'const basis = visit === undefined ? "not_visited" : visit.basis;', replace: 'const basis = visit === undefined ? "control" : visit.basis;' })));
  await assertCaughtBy("readings built on a plain object", FROM_CASE, () => checkRowsOf(variant({ find: "const readings = Object.fromEntries([...bySubject].map(([subject, list]) => [subject, combined(list)]));", replace: "const readings = {};\n        for (const [subject, list] of bySubject)\n            readings[subject] = combined(list);" })));
  await assertCaughtBy("no rows read as a 0", FROM_CASE, () => checkRowsOf(variant({ find: 'if (row.slot !== attempt.slot || row.observation === null)\n                continue;', replace: 'if (row.slot !== attempt.slot || row.observation === null)\n                continue;\n            if (row.state === "no_record")\n                continue;' })));
  await assertCaughtBy("every slot on the configuration in force", FROM_CASE, () => checkRowsOf(variant({ find: "const configuration = (_a = attempt.configuration) !== null && _a !== void 0 ? _a : machine.configuration;", replace: "const configuration = machine.configuration;" })));
});
