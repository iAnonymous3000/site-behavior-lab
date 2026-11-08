import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { after, test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { assertCaughtBy, Counterexample, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { decodeEvent, digestsNamed } from "../core/case-events";
import * as productionMachine from "../core/case-machine";
import type { MachineState, PlanInput } from "../core/case-machine";
import * as productionStore from "../core/case-store";
import type { CaseState } from "../core/case-store";
import * as productionPurge from "../core/purge";
import * as productionReadings from "../core/readings";
import type { Position, ScriptIdentity } from "../core/readings";
import { actorsFor, CASE_SCRIPT, FULL_PLAN, planOf, risingClock, runScript } from "./case-fixture";
import {
  assertCovered,
  assertFoldCovered,
  CAP,
  CLOSURES,
  contextOf,
  DIGEST_ZERO,
  exploreMachine,
  F,
  FOLD_INSTANCES,
  FOLD_OWNER,
  FOLD_SMALL,
  FOLD_TWO,
  foldCodec,
  identityOf,
  M,
  MACHINE_STATE_BOUND,
  machineCodec,
  PHASES,
  planStepOf,
  prepareMachine,
  purgeVariant,
  S,
  shareKeys,
  sliceDigest,
  walkMachine,
  walkPurgeSlice,
  type Explored,
  type FoldInstance,
  type FoldSetup,
  type FoldWalk,
  type MachineSetup,
  type MachineWalk
} from "./case-exploration-walk";
import type { Answer, Job } from "./case-exploration-worker";
import { CASE_A, verifiedOwnerActor } from "./log-fixture";
import { memoryStores } from "./memory-log-store";
import { NOW_MS } from "./token-fixture";

/**
 * Batch F5 of the bounded formal verification: an exhaustive exploration of the private
 * workspace's case machine, its purge slice and the case store's fold. Every claim below has the
 * form "for all inputs in D, under bounds B and axioms A, function F satisfies P, checked by test T
 * at the commit that holds this file". Nothing here is proved. Exhaustive means every member of a
 * closed domain; bounded exploration means every input within the bound and nothing beyond it;
 * sampled means it passed these cases and nothing more.
 *
 * What the oracles read. Each reads either the subject state's own fields, named where they are
 * read (phases, cleanup, the configuration an attempt ran under, arms, the closure, what a manifest
 * lists, and for F.apart and F.rawStays the case's keptObjects beside the shadow), or a shadow kept
 * here from the bodies of accepted events. None calls the production predicate it checks. The
 * machine's bookkeeping (controlMet, controlMisses, exceptionFor, exploratory, baselineRule, the
 * configuration in force and the count of changes) is read only to be held equal to the shadow,
 * two-sided, by M.gate, M.caps and M.mark; that the shadow splits no state is a pin beside them.
 *
 * Two properties RESTATE W2's rules on purpose: M.guard (each event is accepted exactly when its
 * stated guard holds) and M.effect (an accepted event leaves exactly the fields its rule names).
 * guardOf and effectOf cite each rule's source: the header of case-machine.ts, W2's commit 3fef1027,
 * a comment in case-machine.ts named by its line, or "code only" where no comment states it. case-machine-walk.test.ts restates the same
 * rules for four small plans and also their refusal reasons and order, all but purgeStep's refusal of
 * a manifest that repeats a path, which its alphabet never sends; these say nothing of either,
 * and run on the six-slot plan. purgeAnswer restates purgeStep the same way, as purge.test.ts's map
 * does. The other properties are stated apart from both restatements, so each can fail alone.
 *
 * Every property has a named variant through loadVariant, on the module's emitted bytes, caught by
 * that property with the others switched off. The domain and the caps cannot be switched off, since
 * the key needs them; no listed variant is caught by them in place of its own property. Variants
 * run on small plans or the smaller fold instance, so each stops at its first counterexample, and
 * an edit that no longer lands throws. The space-growing variants found so far die by name on the
 * small plans; one that grows the space only on the six-slot plan stops at the walk's state bound,
 * below, with an error that names no property. Where a property reads two things (F.apart and F.rawStays, the shadow and keptObjects), a
 * variant pins each half. Reachable counts are pinned as change detectors, never as evidence.
 *
 * Domains and bounds.
 * - Machine, M: plannedState and step from FULL_PLAN (B1 to B3, I1 to I3, ids from case-fixture,
 *   configuration alder, one change to birch) over a 92-event alphabet, to every reachable state.
 *   The alphabet holds plan-frozen with the fixture's digest; changes to alder and to birch; the
 *   rule met and not met; case-deadline, case-cancelled, reconcile; controls under both keys with all
 *   three results; and for each slot its exception, start, start retry, capture began and finished,
 *   the four reportable finishes, attempt-deadline and the three cleanup events, each from the actor
 *   its rule names. It leaves out evidence-recorded (W2's walk covers ids on small plans), every
 *   purge event (walked apart, below), any other key or digest, and any event from an actor its rule
 *   does not name, which authority probes and nothing walks. The six-slot plan is one test. Its
 *   walk runs once, in the test's own thread, and holds the domain, the caps and the arm on every
 *   edge, the planned state, and acyclicity over the whole graph; every per-state property then runs
 *   over ranges of the walk's states in worker threads (one per available core, at most eight),
 *   which read the states' keys and shadows from shared memory. A counterexample from the walk is
 *   reported first; otherwise the one at the lowest state index, which is the one the same checks in
 *   one thread report first, so the answer does not depend on the number of threads, and a test
 *   below holds the two equal on production and on a variant. A range counts the states it held to
 *   every property and folds their keys and shadows into a digest; a clean answer names its range,
 *   that count and that digest, which must equal the digest of the walk's own states there, and the
 *   answered ranges must tile the walk's states exactly once. An answer with nothing in it, under
 *   another id, from a worker with no job out or from a worker that died fails with what was wrong,
 *   never as a clean range. A test below plants each such fault and holds the suite to failing on it
 *   with a message naming it. What stays outside: a worker that computes the right count and digest
 *   without holding the properties. The walk stops with an error at MACHINE_STATE_BOUND states,
 *   twice the pinned count. The scenario plans I1 to I3 and B1 to B3,
 *   and the plans B1 and I1, and B1, B2, I1 and I2, are their own instances, each walked whole in one
 *   worker. plannedState accepts 58 other ordered slot subsets; none is claimed here.
 * - "Planned equals running plus terminal plus not_started": with every phase inside the key's
 *   domain each attempt falls in exactly one class, so the equation holds of the fields by
 *   construction; what is checked is denominatorOf's agreement with them.
 * - Authority: on every reachable state, each body of that alphabet plus evidence-recorded and the
 *   three purge bodies, from each of the nine actors (owner, the control run, another case's runner,
 *   a runner for each of the six slots) its rule does not allow, which is seven or eight per body;
 *   applyRecordEvent on every reachable state, against an empty record and one holding a row for
 *   each slot, for two claims, a reconstruction, and each slot's instrument and source records.
 * - Purge, M.purgeSlice: on every reachable six-slot state, the slice's events with no manifest, one
 *   of three paths all present and the same all absent, and every other event beside those two; on
 *   the four small instances, every manifest the slice reaches (64) instead.
 * - Purge slice, S: purgeStep from no manifest, open and closed, over every manifest of up to three
 *   paths and every status, every state reached.
 * - Fold, F: foldEntry from case-planned on slots B1 and B2, over three instances, each with its own
 *   enumerated identity set and nothing beyond it: two digests with the plan's identity and every
 *   identity over them on another image (FOLD_TWO); three digests, two free, with one other identity
 *   naming both free digests (FOLD_THREE); and three digests with the plan's fixture and criterion
 *   apart, as a real configuration's are, and one other identity sharing the criterion and naming the
 *   free digest (FOLD_PAIR). The alphabet holds every event naming a digest (a row as raw, the same
 *   row late, plan-frozen, configuration-changed, control met, not met and not evaluated under the
 *   identity in force or another, the owner's patch), from the actor its rule names, each manifest
 *   subset in one order, each path read absent or remaining, and the machine events that carry a case
 *   there (an exception, a start, a failed finish, a confirmed cleanup, a cancel). It leaves out
 *   captures and every other finish, deadlines, reconcile, the other cleanup events, retries, the
 *   instrumented slots and the rule, rows not present, more than one row per slot, and claims,
 *   instrument and source records as steps: those are probed for authority on every fold state's
 *   own record. The walk enters below runCommand's actor derivation and the log's object checks; a
 *   test below holds the pure entry equal to the store path on the whole synthetic case.
 *   The fold walk holds F.domain's round trip on each state it adds (a new key, or a split), not on
 *   an accepted edge whose state encodes to a key already added under the same shadow: that state is
 *   merged into the key without being compared with what the key rebuilds, and is never expanded, and
 *   every other fold property is held on what the key rebuilds. So a fold defect the key cannot hold
 *   (a field outside a configuration's identity, say), shown only on an interleaving whose twin the walk
 *   added first, passes every fold property and the pinned counts. The machine walk compares on every
 *   accepted edge.
 *
 * Axioms assumed and not checked: alarms are delivered eventually; the store eventually accepts a
 * write. No claim is made of any wall-clock bound.
 *
 * Equivalent mutants, within these domains. A visit before the plan froze needs a control or an
 * exception, and both need a frozen plan. An exception on a closed case finds every slot settled.
 * A start while another attempt runs meets that attempt's pending cleanup. A start that spends only
 * its own exception spends the one pending, which is always its own. The raw check made only before a
 * manifest refuses the same events, since after one every raw digest is listed. In the machine alone,
 * a visit basis that puts the control first: step reads only whether there is a basis, and the fold,
 * which records which, holds it by F.basis. None of these moves an answer or a field the walk reads,
 * so no property here can tell them from production. Two that move only a
 * field are not equivalent here: a gate kept at close (the header says it is cleared) dies by M.gate,
 * and retries kept past starting (AttemptState says they are counted only while starting) by M.caps.
 *
 * Ruled in, not stated in the prose: a met control clears the misses. The code states it
 * (controlRecorded), and the owner's batch ruled it in as W2's rule, so the restatement holds it and
 * misses kept once a control met die by M.caps and M.effect. No answer stands behind it: once a
 * control is met further controls are refused, and a configuration change resets the misses anyway,
 * so the clearing is bookkeeping.
 *
 * Termination, scoped by W2's own definition of terminal: closed, with no cleanup pending. An
 * unconfirmed cleanup counts as terminal, and from a closed state whose cleanup is unconfirmed no
 * supervisor event is accepted (case-deadline is refused once closed, and reconcile finds nothing
 * pending); none is needed there, since the state is terminal. Checked: retry counters are in the
 * state; the machine's transition graph without the purge slice is acyclic; every sink is terminal,
 * which the supervisor property already implies and is kept as its own check; from each non-terminal
 * state case-deadline or reconcile is accepted. Purge path statuses can cycle (absent, remains,
 * absent), so acyclicity is a claim about the machine without the slice; the slice test asserts only
 * that its graph has a cycle. "A supervisor's event is accepted" is a claim about the machine: at the
 * log layer an owner token past its exp gets actor-expired, and what an alarm acts as is an open W2
 * item. The stop after two consecutive walls is outside step, and this walk never sees it.
 *
 * The genuine paths. Each must be an accepted edge whose target still reaches SUMMARY_ONLY. The
 * masks have no order, so a path can say a row named a digest, not that it did so first. Kind 2, the
 * owner adopting an identity a control missed under, reads a digest a control named and the owner did
 * not keep; where two identities name that digest, as in FOLD_TWO, the control may have been under
 * the other one. Kind 4 takes a met control for the plan's identity once a control naming its fixture
 * is on record and a row has named it; in FOLD_TWO another identity names the same digest, so the
 * earlier control may be that one's. Kind 8, a change keeping a fixture the case already keeps after
 * a row named it (3fef1027), is accepted in every instance, and reaches SUMMARY_ONLY only in FOLD_TWO,
 * where the identity it adopts adds no digest: elsewhere every digest is then kept, and after a visit
 * no manifest can be recorded, which is W2's open item on a case whose rows name only kept objects.
 *
 * The property table. T is a test in this file unless another file is named.
 *
 * | Property | D | B | A | Method | T | Variant it must catch |
 * |---|---|---|---|---|---|---|
 * | every state the walk reaches lies inside the domain its key encodes | M | M | none | exhaustive over reachable states | "the six-slot plan", "the scenario plans and two small plans" | planned slots closed as skipped; a capture that writes evidence |
 * | each event is accepted exactly when the rule W2 states for it holds | M, each reachable state against each of the 92 events | M | none | exhaustive; a restatement | "the six-slot plan" | a change to the configuration in force; a control while an attempt runs; a visit out of plan order; usable reported from starting; unconfirmed cleanup made final; a change the remaining baseline cannot meet |
 * | an accepted event changes exactly the fields W2's rule for it names, to the values it names | M, each accepted transition, and the planned state | M | none | exhaustive; a restatement | "the six-slot plan" | a deadline read as a failure; a case deadline cancelling the running attempt; a cancel recorded as a deadline |
 * | retry counters are what the accepted events count, and stay within their caps | M | caps 2, 2, 1 | none | exhaustive | "the six-slot plan" | a change keeping the misses; a retry in any phase; a finish keeping the retries; a control cap gone; a start retry cap gone; a second configuration change |
 * | the gate and the rule hold what the accepted events made them, and a closed case keeps no gate | M | M | none | exhaustive | "the six-slot plan" | a close keeping the gate; a change keeping a met control |
 * | a case is closed exactly when no slot is planned or running, and a slot closed unstarted carries the configuration in force | M | M | none | exhaustive | "the six-slot plan" | not met leaving slots planned; a slot closed unstarted with no configuration; no close when the last attempt ends; a close leaving the running attempt running |
 * | a closed case never reopens: its closure never changes, and nothing but cleanup changes after it | M | M | none | exhaustive over reachable transitions | "the six-slot plan" | a control on a closed case; a rule recorded on a closed case |
 * | the baseline rule, once recorded, never changes | M | M | none | exhaustive | "the six-slot plan" | the rule recorded again with the other result |
 * | cleanup changes only by the events that name it, and reconcile reads what it states | M | M | none | exhaustive | "the six-slot plan" | reconcile confirming pending cleanup; reconcile leaving a running attempt's cleanup pending; reconcile timing a running attempt out; cleanup confirmed while the attempt runs; a destroyed environment read as confirmed |
 * | a begun attempt ran under the configuration in force when it began, and that never changes | M | M | none | exhaustive | "the six-slot plan" | a change relabelling earlier attempts; a start recording no configuration |
 * | denominatorOf agrees with the phases | M | M | none | exhaustive | "the six-slot plan" | dropping not_started |
 * | isTerminal agrees with closed and no cleanup pending | M | M | none | exhaustive | "the six-slot plan" | terminal reading only the first attempt |
 * | continuationOf agrees with an open case and its unresolved cleanup | M | M | none | exhaustive | "the six-slot plan" | continuation reading only pending cleanup |
 * | at most one attempt runs | M | M | none | exhaustive | "the six-slot plan" | two attempts at once |
 * | an arm never changes | M | M | none | exhaustive over reachable transitions | "the six-slot plan" | an arm rewritten at the start of a visit |
 * | instrumented waits on baseline's rule, and begins under the configuration it was met under | M; vacuous on a plan of one arm | M | none | exhaustive | "the six-slot plan" | the instrumented arm not waiting; the rule recorded before the baseline ended; the floor gone; a change after the rule is met |
 * | a terminal attempt never reopens | M | M | none | exhaustive | "the six-slot plan" | a terminal attempt finishing again; a deadline reopening a slot that never started |
 * | continuation blocks on unresolved cleanup | M | M | none | exhaustive | "the six-slot plan" | continuing past unresolved cleanup; a visit past unconfirmed cleanup |
 * | unresolved cleanup changes no acquisition | M, each state with cleanup unresolved against the same state resolved | M | none | exhaustive | "the six-slot plan" | a cancel waiting on cleanup; a deadline waiting on cleanup; an unconfirmed cleanup capping an outcome; a change waiting on cleanup; an exception waiting on unconfirmed cleanup |
 * | a purge answers as the restated reducer does on the closed flag and the manifest, and changes nothing else, and nothing else reads the manifest | M with no manifest, all present and all absent; the four small instances with every manifest the slice reaches | M | none | exhaustive within that pairing; a restatement | "the six-slot plan", "the scenario plans and two small plans"; signature pinned by purge.test.ts "the reducer's signature is the closed flag, the manifest and the event" | a purge only of a cancelled case; a purge held by pending cleanup; an empty manifest refused while cleanup is pending; a purge clearing the exploratory mark; a purge refusal reading the exploratory mark; a cleanup refused once a manifest exists; cleanup refused once a listed path reads remaining |
 * | an event from an actor the rule does not allow is refused | Authority | M | none | exhaustive | "the six-slot plan" | a capture from another slot's runner; cleanup from another attempt's runner; a visit started by a runner; a control from the owner; a purge from a runner; a claim from the control run; a claim from a runner once rows exist |
 * | the actors a rule allows get the same answer | M, cleanup events from the owner and from the attempt's runner | M | none | exhaustive | "the six-slot plan" | cleanup refused from its own runner |
 * | a visit begins only on a met control for the configuration in force, or on the owner's exception for it | M | M | none | exhaustive | "the six-slot plan" | a failed control unlocking visits; a merely recorded control; a control from another configuration |
 * | an exception is recorded only for a visit that has not begun | M | M | none | exhaustive | "the six-slot plan" | an exception made after the visit |
 * | the exploratory mark is on exactly when an exception was recorded | M | M | none | exhaustive | "the six-slot plan" | a later pass clearing the exploratory mark; an exception that does not mark the case |
 * | without the purge slice, no event returns to a state | M | M | none | exhaustive over the reachable graph | "the six-slot plan" | a retry that does not count; a control miss that does not count |
 * | every sink is terminal (implied by the next row) | M | M | none | exhaustive | "the six-slot plan" | a closed case's cleanup that nothing can answer |
 * | a supervisor's event is accepted from every non-terminal state | M | M | none | exhaustive | "the six-slot plan" | a case deadline that does not close; reconcile refused once the case is closed |
 * | purgeStep answers as the restated reducer does, accepting exactly when it does, with its refusal and its manifest | S | three paths | none | exhaustive over reachable states; a restatement | "the purge slice" | a path dropped when it reads absent; purging an open case; remaining refused straight from present; absent refused once a path reads remaining |
 * | SUMMARY_ONLY holds exactly when a manifest exists and every path on it reads absent | S | three paths | none | exhaustive | "the purge slice" | a remaining path read as purged |
 * | every fold state the walk reaches has a key, and each state it adds is held whole by its key | F | F | none | exhaustive over the states the walk adds; a state merged into a key already added, under the same shadow, is not compared with what that key rebuilds (see Fold, F, above) | the three "the fold, ..." walks | a configuration stored with a field no identity has |
 * | SUMMARY_ONLY implies every digest the log names is kept by the owner or listed and confirmed absent | F | F | none | exhaustive | same | 3fef1027: a control keeping nothing while a manifest omits its digests |
 * | nothing is both kept and listed, by the shadow and by the case's own keptObjects | F | F | none | exhaustive | same | 3fef1027: a listed path a control alone named kept by a later patch; a row after the manifest keeping a listed digest; the owner's events keeping nothing, so a manifest lists what the owner kept (the shadow half alone) |
 * | a digest a row names as raw never becomes kept, by the shadow and by the case's own keptObjects | F | F | none | exhaustive | same | the raw rule gone; the raw rule gone, and nothing after the plan keeping anything; a row keeping its own digest, which stays raw to the owner (the keptObjects half alone) |
 * | a manifest subset walked here is taken exactly when it is what rows and controls named, less what the owner keeps | F, each subset in one order | F | none | exhaustive | same | the kept objects not taken off the purge set; a part of the purge set taken as the whole; the exact purge set refused when it lists a control's digest |
 * | an empty manifest is taken only when no attempt began | F | F | none | exhaustive | same | an empty manifest taken after a visit; a cancelled visit not counted as begun |
 * | raw-object-cannot-be-kept is heard exactly when an owner's event would start keeping a raw digest, or a listed path once a manifest exists, and nothing else refuses it first | F, each such event against the same event naming fresh bytes | F | none | exhaustive | same | the raw rule heard ahead of the machine's; keeping a digest only a control named refused once any row exists |
 * | the genuine paths stay reachable | F | F | none | exhaustive: each is an accepted edge whose target still reaches SUMMARY_ONLY, as scoped above | same | a row naming a digest the case keeps refused, as an earlier version of the rule did; a control's objects counted raw; a control re-recorded for an identity already named refused; a control after rows naming its fixture refused; a change keeping a fixture the case already keeps refused once a row named it |
 * | a fold entry from an actor the rule does not allow is refused | F, each accepted pair resent from every other actor, case-planned at the null state, and record events probed on every fold state's record | F | none | exhaustive over those | same | every actor read as the owner; a plan from a runner; a claim from a runner once rows exist; an instrument record from any runner once rows exist |
 * | a visit begins only on a control met under the identity in force, or on the owner's exception for it | F | F | none | exhaustive | same | a control under another identity taken as in force |
 * | a visit's basis on record is the exception when one was pending for it, and the control otherwise | F | F | none | exhaustive | same | a visit's basis recorded as control while an exception was pending |
 * | a row is recorded late exactly when its attempt had ended | F | F | none | exhaustive | same | no late label; a row late while its attempt is starting |
 * | a row is taken exactly when its attempt began, its id is unused and no manifest exists | F | F | none | exhaustive | same | a row taken after the manifest |
 * | a patch is taken exactly when none was and the visit it names ended, where no raw digest or listed path is involved | F | F | none | exhaustive | same | a patch before the visit ends |
 * | a case is planned once | F, case-planned from the owner on every fold state | F | none | exhaustive | same | a second plan taken |
 * | a count above 0 stays observed under every limit | readObservation inputs, counts as six representatives | 18,432 inputs | none | exhaustive over that product | readings.test.ts "every observation, over the full product of its axes" (POSITIVE) | incompleteness, unconfirmed cleanup, a failed operation or a cut-short window erasing a positive |
 * | a 0 speaks only of its window, at the granularity reported | same | same | none | exhaustive | same (NOT_ABSENT, GRANULARITY); readRow over 298,760 combinations in evidence-model.test.ts "a row is read in its own attempt, by its own instrument" | function-only read as branch-level |
 * | no record, truncation and out of scope never read absent | same | same | none | exhaustive | same (NO_RECORD, NOT_ABSENT); "a reading's vocabulary has no word for absent" | no record read as 0; a truncated or out-of-scope 0 read as a 0 |
 * | complete is withheld unless every condition holds | same | same | none | exhaustive | same (COMPLETE, LIMITS) | each condition not withholding complete |
 * | a join needs the same attempt, target, frame and loader; an unmet condition is no join with its reason | 7 conditions broken in every subset | 128 subsets | none | exhaustive over subsets | readings.test.ts "every subset of broken conditions" | a cross-attempt link; a replaced document (loader unchecked) |
 * | script identity by id where present, else URL, start and digest unique in that inventory; a repeated URL is ambiguous | 157 enumerated cases | none | none | sampled | readings.test.ts "each condition of a join, alone" (FAULTS, compared as whole JSON) | a repeated URL read as a join, and the other JOIN variants there |
 * | a position falls in a range only after conversion: stack one-based, range zero-based with an exclusive end, inline resource_start | a grid of 2,000 points; every (start, end, offset) of one ASCII document | grid bounds | none | bounded exploration | readings.test.ts "positions on a grid", "positions read off a real document's text", "the boundaries of a range" | off-by-one columns on either line; an inclusive end |
 * | the same, with columns in UTF-16 code units on both sides | every (start, end, offset) of one document holding a character outside the BMP | that document | none | bounded exploration | "UTF-16 columns" | off-by-one columns on the first line; a stack read in code points is shown to land wrong, which is a change to the test's input, not a variant |
 * | a time falls inside the armed window, or the declared uncertainty across clocks | FAULTS | none | none | sampled | readings.test.ts FAULTS | an exclusive window start or end; an uncertainty widening one clock |
 * | a met join reads position_consistent, never caused | FAULTS and two worded cases | none | none | sampled | readings.test.ts "the only words a join can say" | a met join reading as a cause |
 *
 * Overlap with W2. case-machine-walk.test.ts walks small plans against a restated model and holds
 * termination on three of them. Its scenario walk is I1 to I3 with the same alphabet, so the I1 to I3
 * instance here walks the same 45,967 states, and both suites hold the denominator, one running
 * attempt, the arm, a terminal attempt staying and termination on them, and both restate the rules;
 * W2's model also restates the refusals, but for a manifest that repeats a path, which it takes and
 * purgeStep refuses. The six-slot plan and B1 to B3 share no state with W2's
 * walks, only claims. purge.test.ts holds every manifest of up to three paths and a depth-7 walk; the
 * slice test here is the reachable fixpoint of the same reducer. No W2 test is removed.
 */


/** Peak resident memory of this process so far, and the time since `started`, for a heavy test to report. */
function report(t: TestContext, label: string, started: number, counts: Readonly<Record<string, number>>): void {
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  t.diagnostic(`${label}: ${seconds} s, peak RSS ${peak} MB so far in this process, ${JSON.stringify(counts)}`);
}


// ---------------------------------------------------------------------------------------------
// Threads. Nothing else runs during this chained stage, so the walks may use every core.
// ---------------------------------------------------------------------------------------------

/** One worker per available core, at most eight. A CI runner has four. */
const THREADS = Math.max(1, Math.min(availableParallelism(), 8));
const WORKER = require.resolve("./case-exploration-worker");
const PLANT_WORKER = require.resolve("./case-exploration-plant-worker");

/** A job as the suite queues it: the worker's own id is added when it is sent. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type JobBody = WithoutId<Job>;

/** A job waiting or out, with the id it went out under once it has. */
type Pending = { readonly job: JobBody; readonly resolve: (answer: Answer) => void; id: number };

/** The order jobs leave the queue in: the six-slot ranges first, then the longest walks, then the rest. */
const URGENT = 0;
const LONG = 1;
const SHORT = 2;

/** What is wrong with an answer to the job sent as `id`, or null: it must carry that id and exactly one of a value, a failure or an error. */
function answerFault(id: number, answer: Answer): string | null {
  if (typeof answer !== "object" || answer === null) return `job ${id} came back as ${String(answer)}`;
  if (answer.id !== id) return `job ${id} was answered as job ${String(answer.id)}`;
  const carried = [answer.value !== undefined && answer.value !== null, answer.failure !== undefined, answer.error !== undefined].filter(Boolean).length;
  if (carried === 0) return `job ${id} came back with no value, failure or error`;
  return carried === 1 ? null : `job ${id} came back with more than one of a value, a failure and an error`;
}

const describe = (answer: unknown): string => {
  try {
    return JSON.stringify(answer).slice(0, 200);
  } catch {
    return String(answer);
  }
};

/**
 * A queue of jobs over a fixed set of workers, each answering one job at a time. A job goes ahead of
 * every job of a later rank, and after those of its own rank that came before it. An answer counts
 * only as the answer to the job its worker was sent, under that job's id, with exactly one of a
 * value, a failure or an error: anything else fails that job with an error that says what was
 * wrong, never as a clean answer. An answer under another job's id, or from a worker with no job
 * out, is also a fault of the run: it is kept, and every job still queued or sent later fails with
 * it. A worker that exits or throws fails its job at once and is replaced, unless workers keep dying.
 */
class Pool {
  private readonly idle: Worker[] = [];
  private readonly queues: Pending[][] = [[], [], []];
  private readonly busy = new Map<Worker, Pending>();
  private readonly all = new Set<Worker>();
  private next = 0;
  private deaths = 0;
  private closing = false;
  /** The first answer no job out was waiting for, or the reason workers stopped being replaced. */
  fault: string | null = null;

  constructor(
    private readonly size: number,
    private readonly file = WORKER,
    private readonly data: unknown = null
  ) {
    for (let at = 0; at < size; at += 1) this.idle.push(this.spawn());
  }

  run(job: JobBody, rank: typeof URGENT | typeof LONG | typeof SHORT = SHORT): Promise<Answer> {
    return new Promise((resolve) => {
      if (this.fault !== null) resolve({ id: 0, error: `not sent, since the run has a fault: ${this.fault}` });
      else {
        this.queues[rank].push({ job, resolve, id: 0 });
        this.pump();
      }
    });
  }

  close(): Promise<number[]> {
    this.closing = true;
    return Promise.all([...this.all].map((worker) => worker.terminate()));
  }

  private spawn(): Worker {
    const worker = new Worker(this.file, { execArgv: [], workerData: this.data });
    worker.on("message", (answer: Answer) => this.answered(worker, answer));
    worker.on("messageerror", (error: Error) => this.lost(worker, `an answer could not be read: ${String(error)}`, false));
    worker.on("error", (error: Error) => this.lost(worker, `the worker threw: ${error.stack ?? String(error)}`, true));
    worker.on("exit", (code: number) => this.lost(worker, `the worker exited with code ${code}`, true));
    this.all.add(worker);
    return worker;
  }

  private pump(): void {
    for (;;) {
      const queue = this.queues.find((waiting) => waiting.length > 0);
      if (this.idle.length === 0 || queue === undefined) return;
      const worker = this.idle.pop() as Worker;
      const pending = queue.shift() as Pending;
      pending.id = this.next += 1;
      this.busy.set(worker, pending);
      worker.postMessage({ ...pending.job, id: pending.id });
    }
  }

  private answered(worker: Worker, answer: Answer): void {
    const pending = this.busy.get(worker);
    if (pending === undefined) {
      this.failRun(`a worker sent an answer with no job out: ${describe(answer)}`);
      return;
    }
    this.busy.delete(worker);
    this.idle.push(worker);
    const fault = answerFault(pending.id, answer);
    if (fault !== null && (typeof answer !== "object" || answer === null || answer.id !== pending.id)) this.failRun(fault);
    pending.resolve(fault === null ? answer : { id: pending.id, error: fault });
    this.pump();
  }

  private lost(worker: Worker, why: string, gone: boolean): void {
    if (this.closing || !this.all.has(worker)) return;
    const pending = this.busy.get(worker);
    this.busy.delete(worker);
    if (gone) {
      this.all.delete(worker);
      const at = this.idle.indexOf(worker);
      if (at >= 0) this.idle.splice(at, 1);
      this.deaths += 1;
      if (this.deaths <= this.size * 4 + 4) this.idle.push(this.spawn());
      else this.failRun(`workers keep dying (${this.deaths} so far), the last because ${why}`);
    } else if (pending !== undefined) this.idle.push(worker);
    if (pending !== undefined) pending.resolve({ id: pending.id, error: `job ${pending.id}: ${why}` });
    else if (!gone) this.failRun(why);
    this.pump();
  }

  private failRun(why: string): void {
    this.fault ??= why;
    for (const queue of this.queues) for (const pending of queue.splice(0)) pending.resolve({ id: pending.id, error: `not sent, since the run has a fault: ${this.fault}` });
  }
}

let shared: Pool | null = null;
const pool = (): Pool => (shared ??= new Pool(THREADS));
after(async () => {
  const fault = shared?.fault ?? null;
  await shared?.close();
  if (fault !== null) throw new Error(`the suite's threads had a fault: ${fault}`);
});

/** A worker's answer as the main thread's: its value, or its counterexample raised again under the same name, or its error. */
function settle(answer: Answer): unknown {
  if (answer.error !== undefined) throw new Error(answer.error);
  if (answer.failure !== undefined) throw new Counterexample(answer.failure.property, answer.failure.input);
  return answer.value;
}

/** How long the last walk spent in each phase, for a heavy test to report. */
const phases = { walk: 0, checks: 0 };

type Range = readonly [from: number, to: number];

/** States 0 to `states`, cut into at most `blocks` contiguous ranges of near equal size. */
function rangesOf(states: number, blocks: number): Range[] {
  const size = Math.max(1, Math.ceil(states / blocks));
  const ranges: Range[] = [];
  for (let from = 0; from < states; from += size) ranges.push([from, Math.min(states, from + size)]);
  return ranges;
}

/** What a range job answers when every state in it was held to every property, as the worker reports it. */
type RangeDone = Readonly<{ from: number; to: number; checked: number; digest: number }>;

/**
 * Every per-state property over the walk's states, in a pool's workers, one job per range. Each
 * answer must be for the range it was sent: a counterexample at a state inside it, or, as the
 * worker reports it, every one of its states checked, with a digest of the keys and shadows it held
 * them on that equals the digest of the walk's own states there, read from `explored` and not from
 * the shared memory the workers read. Every range asked for must have exactly one answer, and the
 * answered ranges must tile the walk's states exactly once, so the reported counts add up to the
 * walk. Anything else fails with what was wrong. Then the counterexample reported is the one at the
 * lowest state index, which is the one the same checks in one thread report first, so the answer
 * does not depend on the number of threads. `sent` is the ranges sent, which is all of them except
 * in the self-test that sends one fewer.
 */
async function checkRanges(on: Pool, setup: MachineSetup, explored: Explored, ranges: readonly Range[], sent: readonly Range[] = ranges): Promise<void> {
  const { keys, shadows, width } = shareKeys(explored);
  const answers = await Promise.all(sent.map(([from, to]) => on.run({ kind: "machine-range", setup, keys, shadows, width, from, to }, URGENT)));
  const errors = answers.flatMap(({ error }) => (error === undefined ? [] : [error]));
  if (errors.length > 0) throw new Error(errors[0]);
  if (answers.length !== ranges.length) throw new Error(`${ranges.length} ranges were to be checked and ${answers.length} answered`);
  const keyAt = (index: number): string => explored.keys[index];
  const shadowAt = (index: number): number => explored.shadows[index];
  const answered: Range[] = [];
  answers.forEach(({ value, failure }, at) => {
    const [from, to] = ranges[at];
    if (failure !== undefined) {
      if (!(failure.index >= from && failure.index < to)) throw new Error(`the range ${from} to ${to} reported a counterexample at state ${failure.index}, outside it`);
      answered.push([from, to]);
      return;
    }
    const done = value as RangeDone;
    if (done.from !== from || done.to !== to) throw new Error(`the range ${from} to ${to} was answered as ${describe(done)}`);
    if (done.checked !== to - from) throw new Error(`the range ${from} to ${to} checked ${String(done.checked)} of its ${to - from} states`);
    const digest = sliceDigest(keyAt, shadowAt, from, to);
    if (done.digest !== digest) throw new Error(`the range ${from} to ${to} answered digest ${String(done.digest)}, where the walk's own states there give ${digest}`);
    answered.push([done.from, done.to]);
  });
  const asked = new Map(ranges.map(([from, to]) => [`${from} to ${to}`, 0]));
  for (const [from, to] of answered) {
    const times = asked.get(`${from} to ${to}`);
    if (times === undefined) throw new Error(`the range ${from} to ${to} was answered and never asked for`);
    asked.set(`${from} to ${to}`, times + 1);
  }
  for (const [range, times] of asked) if (times !== 1) throw new Error(`the range ${range} was answered ${times} times`);
  let reached = 0;
  for (const [from, to] of [...answered].sort(([left], [right]) => left - right)) {
    if (from !== reached || to <= from) throw new Error(`the answered ranges do not tile the walk's ${explored.states} states: one runs ${from} to ${to} where ${reached} was next`);
    reached = to;
  }
  if (reached !== explored.states) throw new Error(`the answered ranges do not tile the walk's ${explored.states} states: they stop at ${reached}`);
  const failures = answers.flatMap(({ failure }) => (failure === undefined ? [] : [failure])).sort((left, right) => left.index - right.index);
  if (failures.length > 0) throw new Counterexample(failures[0].property, failures[0].input);
}

/** The six-slot walk's way: the walk once, in this thread, and every per-state property over ranges of its states in the workers. */
async function walkAcross(setup: MachineSetup, blocks = THREADS * 24, on: Pool = pool()): Promise<MachineWalk> {
  const begun = performance.now();
  const explored = exploreMachine(prepareMachine(setup));
  phases.walk = (performance.now() - begun) / 1000;
  const checking = performance.now();
  await checkRanges(on, setup, explored, rangesOf(explored.states, blocks));
  phases.checks = (performance.now() - checking) / 1000;
  return { states: explored.states, edges: explored.edges, splits: explored.splits, coverage: explored.coverage, acyclic: explored.acyclic };
}

// ---------------------------------------------------------------------------------------------
// The machine.
// ---------------------------------------------------------------------------------------------

const SIX_SLOT = { states: 2985379, edges: 11848870 };
const SCENARIO_INSTRUMENTED = planOf("I1", "I2", "I3");
const SCENARIO_BASELINE = planOf("B1", "B2", "B3");
const ONE_EACH = planOf("B1", "I1");
const TWO_BASELINES = planOf("B1", "B2");
const TWO_EACH = planOf("B1", "B2", "I1", "I2");
const INSTRUMENTED_PAIR = planOf("I1", "I2");

const SMALL_PLAN_LIST = [
  ["I1 to I3", SCENARIO_INSTRUMENTED],
  ["B1 to B3", SCENARIO_BASELINE],
  ["B1 and I1", ONE_EACH],
  ["B1, B2, I1 and I2", TWO_EACH]
] as const;

let smallJobs: Map<string, Promise<Answer>> | null = null;

/** The scenario plans and two small plans, each walked whole in one worker, queued together when the first is asked for. */
function smallJob(name: string): Promise<Answer> {
  smallJobs ??= new Map(SMALL_PLAN_LIST.map(([label, plan]) => [label, pool().run({ kind: "machine-walk", setup: { plan, manifests: "all" } }, label === "I1 to I3" || label === "B1 to B3" ? LONG : SHORT)]));
  return smallJobs.get(name) as Promise<Answer>;
}

/**
 * Everything that does not wait on the six-slot walk, queued on the threads before that walk
 * begins, so the workers are not idle while this thread walks: the three fold walks and the two
 * scenario plans first, as the longest, then the variants and the two small plans. Each test still
 * waits on its own job and reads its own answer. The six-slot ranges go ahead of whatever is left.
 */
function queueBackground(): void {
  void foldJob("FOLD_TWO");
  void smallJob("I1 to I3");
  void machineJob(MACHINE_VARIANTS[0][0]);
}

test("the six-slot plan: every reachable state, under every machine property", async (t) => {
  const started = performance.now();
  queueBackground();
  const walk = await walkAcross({ plan: FULL_PLAN });
  // Change detectors, not evidence: the count matches an independent sizing of the same alphabet.
  assert.deepEqual({ states: walk.states, edges: walk.edges }, SIX_SLOT);
  assert.equal(walk.splits, 0, "the shadow is a function of a correct state, so it splits none and the count is the machine's own");
  assertCovered(walk.coverage, { phases: PHASES, closures: CLOSURES, rules: ["pending", "met", "not_met"], changed: true });
  assert.equal(walk.acyclic, true);
  report(t, `six-slot walk on ${THREADS} threads`, started, { states: walk.states, edges: walk.edges, closedStates: walk.coverage.closed, walkSeconds: Math.round(phases.walk), checkSeconds: Math.round(phases.checks) });
});

const SMALL_PLANS = { "I1 to I3": { states: 45967, edges: 182358 }, "B1 to B3": { states: 45967, edges: 182358 }, "B1 and I1": { states: 1165, edges: 5642 }, "B1, B2, I1 and I2": { states: 16909, edges: 77970 } };

test("the scenario plans and two small plans, every machine property, each closed state paired with every manifest the slice reaches", async (t) => {
  const started = performance.now();
  const counts: Record<string, { states: number; edges: number }> = {};
  for (const [name] of SMALL_PLAN_LIST) {
    const walk = settle(await smallJob(name)) as MachineWalk;
    assert.equal(walk.splits, 0);
    assert.equal(walk.acyclic, true);
    if (name === "I1 to I3" || name === "B1 to B3") {
      // No rule applies to a plan of one arm, so "instrumented waits" holds there by having nothing to hold. I1 to I3 with this
      // alphabet is also W2's scenario walk in case-machine-walk.test.ts, so the two suites walk the same states there.
      assertCovered(walk.coverage, { phases: PHASES, closures: [null, "completed", "cancelled", "deadline"], rules: ["not_applicable"], changed: true });
    }
    counts[name] = { states: walk.states, edges: walk.edges };
  }
  assert.deepEqual(counts, SMALL_PLANS, "change detectors, not evidence");
  report(t, "scenario and small walks", started, Object.fromEntries(Object.entries(counts).map(([name, { states }]) => [name, states])));
});

test("the per-state checks give the same answer, and the same first counterexample, on one thread and across many", async () => {
  // Production, and a variant caught at many states, on a plan big enough to spread over many small ranges.
  const inline = walkMachine({ machine: productionMachine, plan: TWO_EACH });
  const across = await walkAcross({ plan: TWO_EACH }, 257);
  assert.deepEqual(across, inline);
  const edits = [{ find: 'return finish(state, index, "timed_out");', replace: 'return finish(state, index, "failed");' }];
  const caught = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof Counterexample) return JSON.stringify([error.property, error.input]);
      throw error;
    }
    throw new Error("the variant was not caught");
  };
  const one = await caught(() => walkMachine({ machine: loadVariant(require.resolve("../core/case-machine"), edits), plan: TWO_EACH }));
  const many = await caught(() => walkAcross({ plan: TWO_EACH, machineEdits: edits }, 257));
  assert.equal(many, one);
});

/**
 * The pool and the range checks against a fault planted in the real worker, on the plan B1 and I1
 * cut into four ranges across two workers, in a pool of their own. A worker fault goes through
 * walkAcross, as the six-slot walk does, so nothing on that path may swallow it; a cut to the ranges
 * asked for, or a range asked for and never sent, goes straight to checkRanges, which is where the
 * answers are tiled. Each answer is what failed, or "passed", and whatever fault the pool kept; a
 * minute without an answer says so.
 */
async function plantedRanges(plant: string | null, cut?: (ranges: Range[]) => Range[], unsent = false): Promise<Readonly<{ message: string; fault: string | null }>> {
  const planted = new Pool(2, plant === null ? WORKER : PLANT_WORKER, { plant });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const setup: MachineSetup = { plan: ONE_EACH };
    const run = async (): Promise<unknown> => {
      if (cut === undefined && !unsent) return walkAcross(setup, 4, planted);
      const explored = exploreMachine(prepareMachine(setup));
      const ranges = (cut ?? ((all: Range[]) => all))(rangesOf(explored.states, 4));
      return checkRanges(planted, setup, explored, ranges, unsent ? ranges.slice(0, -1) : ranges);
    };
    const checked = run().then(
      () => "passed",
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("no answer within 60 s"), 60_000);
    });
    return { message: await Promise.race([checked, late]), fault: planted.fault };
  } finally {
    clearTimeout(timer);
    await planted.close();
  }
}

test("the pool and the range checks fail on each fault planted in the real worker, with a message that names it, not by timeout", async () => {
  assert.deepEqual(await plantedRanges(null), { message: "passed", fault: null }, "nothing planted");
  // "empty" and "stray" fail with the same message, and are told apart by the fault the pool keeps.
  const planted: readonly (readonly [name: string, plant: string | null, cut: ((ranges: Range[]) => Range[]) | undefined, unsent: boolean, expected: RegExp])[] = [
    ["every answer emptied to its id", "empty", undefined, false, /^job \d+ came back with no value, failure or error$/],
    ["every answer under another job's id", "wrong-id", undefined, false, /^job \d+ was answered as job \d+$/],
    ["a stray empty answer before each real one", "stray", undefined, false, /^job \d+ came back with no value, failure or error$/],
    ["every range checked one state short", "short", undefined, false, /^the range \d+ to \d+ checked \d+ of its \d+ states$/],
    ["a worker that exits, with no error, on its first range", "exit", undefined, false, /^job \d+: the worker exited with code 0$/],
    ["every range after the first answered as checked, with nothing checked", "forge", undefined, false, /^the range \d+ to \d+ answered digest undefined, where the walk's own states there give \d+$/],
    ["every range after the first written over with state 0 in shared memory, then checked", "shared-write", undefined, false, /^the range \d+ to \d+ answered digest \d+, where the walk's own states there give \d+$/],
    ["the last range never asked for", null, (ranges) => ranges.slice(0, -1), false, /^the answered ranges do not tile the walk's 1165 states: they stop at \d+$/],
    ["the last range asked for and never sent", null, undefined, true, /^4 ranges were to be checked and 3 answered$/]
  ];
  for (const [name, plant, cut, unsent, expected] of planted) {
    const { message, fault } = await plantedRanges(plant, cut, unsent);
    assert.match(message, expected, name);
    // An answer under another id, or with no job out, also leaves the run with a fault every later job fails with.
    if (plant === "wrong-id" || plant === "stray") assert.match(fault ?? "", /was answered as job|with no job out/, `${name}: the pool keeps the fault`);
    else assert.equal(fault, null, `${name}: no answer came for a job that was not out`);
  }
});

test("the machine walk stops at its state bound, with a message that says so", () => {
  assert.equal(MACHINE_STATE_BOUND, 2 * SIX_SLOT.states, "twice the six-slot plan's pinned count");
  assert.throws(() => exploreMachine(prepareMachine({ plan: ONE_EACH }), 100), { message: /^the walk reached its bound of 100 states before it ended/ });
});

test("the caps this file states are production's", () => {
  assert.deepEqual([productionMachine.MAX_CONTROL_MISSES, productionMachine.MAX_START_RETRIES, productionMachine.MAX_CONFIGURATION_CHANGES], [CAP.controlMisses, CAP.startRetries, CAP.configurationChanges]);
});

test("the key refuses a state outside its domain, and rebuilds every state it accepts", async () => {
  const codec = machineCodec(contextOf(planOf("B1", "I1")));
  const planned = productionMachine.plannedState(planOf("B1", "I1"));
  assert.ok(planned.ok);
  assert.equal(JSON.stringify(codec.decode(codec.encode(planned.state))), JSON.stringify(planned.state));
  const outside = (change: Partial<MachineState>) => () => codec.encode({ ...planned.state, ...change });
  await assertCaughtBy("an extra field", M.domain, outside({ note: 1 } as unknown as Partial<MachineState>));
  await assertCaughtBy("a manifest the key does not hold", M.domain, outside({ purge: [] }));
  await assertCaughtBy("a plan digest the key does not hold", M.domain, outside({ planDigest: "ff".repeat(32) }));
  await assertCaughtBy("a third count of control misses", M.caps, outside({ controlMisses: 3 }));
  await assertCaughtBy("an attempt holding evidence", M.domain, outside({ attempts: [{ ...planned.state.attempts[0], evidence: ["row-0"] }, planned.state.attempts[1]] }));
});

/** The compiled lines the variants edit. loadVariant throws if one stops landing exactly once. */
const STARTED_GUARDS = 'if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");';
const CANCEL_HEAD = 'function caseCancelled(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");';
const DEADLINE_HEAD = 'function caseDeadline(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");';
const CLOSED_FLAG = "(0, purge_1.purgeStep)(state.closedBy !== null, state.purge, event)";
const CLEANUP_HEAD = 'function cleanupEvent(state, event) {\n    const index = indexOfSlot(state, event.slot);';
const CHANGE_RESET = "configurationChanges: state.configurationChanges + 1, controlMet: false, controlMisses: 0, exceptionFor: null";
const CLOSE_PLANNED = '{ phase: "not_started", configuration: state.configuration }';
const NOT_MET_CLOSE = 'return accept(closeWith(Object.assign(Object.assign({}, state), { baselineRule: "not_met" }), "failed", "baseline_not_met"));';
const RECONCILE_RUNNING = '{ phase: "failed", cleanup: "unconfirmed", startRetries: 0 }';
const STARTING_CHANGE = '{ phase: "starting", cleanup: "pending", configuration: state.configuration }';

const MACHINE_VARIANTS: readonly (readonly [name: string, property: string, plan: PlanInput, edits: readonly SourceEdit[], evidence?: readonly SourceEdit[]])[] = [
  ["planned slots closed as skipped", M.domain, ONE_EACH, [{ find: CLOSE_PLANNED, replace: '{ phase: "skipped", configuration: state.configuration }' }]],
  ["a capture that writes evidence", M.domain, ONE_EACH, [{ find: '{ phase: "capturing", startRetries: 0 }', replace: '{ phase: "capturing", startRetries: 0, evidence: ["row-0"] }' }]],
  ["a change to the configuration in force", M.guard, ONE_EACH, [{ find: 'if (event.configuration === state.configuration)\n        return refuse("configuration-unchanged");', replace: "" }]],
  ["a control while an attempt runs", M.guard, ONE_EACH, [{ find: 'return refuse("plan-not-frozen");\n    if (state.attempts.some(({ phase }) => isRunningPhase(phase)))\n        return refuse("another-attempt-running");\n    if (state.controlMet)', replace: 'return refuse("plan-not-frozen");\n    if (state.controlMet)' }]],
  ["a visit out of plan order", M.guard, TWO_BASELINES, [{ find: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");', replace: "" }]],
  ["usable reported from starting", M.guard, ONE_EACH, [{ find: 'starting: ["failed"],', replace: 'starting: ["failed", "usable"],' }]],
  ["unconfirmed cleanup made final", M.guard, ONE_EACH, [{ find: 'if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed")', replace: 'if (attempt.cleanup === "confirmed" || attempt.cleanup === "environment_destroyed" || attempt.cleanup === "unconfirmed")' }]],
  ["a change the remaining baseline cannot meet", M.guard, ONE_EACH, [{ find: 'if (baseline.filter(({ phase }) => phase === "planned").length < baselineFloor(baseline))\n            return refuse("configuration-floor-unreachable");', replace: "" }]],
  ["a deadline read as a failure", M.effect, ONE_EACH, [{ find: 'return finish(state, index, "timed_out");', replace: 'return finish(state, index, "failed");' }]],
  ["a case deadline cancelling the running attempt", M.effect, ONE_EACH, [{ find: 'closeWith(state, "timed_out", "deadline")', replace: 'closeWith(state, "cancelled", "deadline")' }]],
  ["a cancel recorded as a deadline", M.effect, ONE_EACH, [{ find: 'closeWith(state, "cancelled", "cancelled")', replace: 'closeWith(state, "cancelled", "deadline")' }]],
  ["a change keeping the misses", M.caps, ONE_EACH, [{ find: CHANGE_RESET, replace: "configurationChanges: state.configurationChanges + 1, controlMet: false, exceptionFor: null" }]],
  ["a retry in any phase", M.caps, ONE_EACH, [{ find: 'if (found.attempt.phase !== "starting")\n        return refuse("wrong-phase");\n    if (found.attempt.startRetries', replace: "if (found.attempt.startRetries" }]],
  ["a finish keeping the retries", M.caps, ONE_EACH, [{ find: "return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));", replace: "return accept(closeIfDone(withAttempt(state, index, { phase })));" }]],
  ["a control cap gone", M.caps, ONE_EACH, [{ find: 'if (state.controlMisses >= exports.MAX_CONTROL_MISSES)\n        return refuse("control-limit");', replace: "" }]],
  ["a start retry cap gone", M.caps, ONE_EACH, [{ find: 'if (found.attempt.startRetries >= exports.MAX_START_RETRIES)\n        return refuse("start-retry-limit");', replace: "" }]],
  ["a second configuration change", M.caps, ONE_EACH, [{ find: 'if (state.configurationChanges >= exports.MAX_CONFIGURATION_CHANGES)\n        return refuse("configuration-change-spent");', replace: "" }]],
  ["a close keeping the gate", M.gate, ONE_EACH, [{ find: "return Object.assign(Object.assign(Object.assign({}, state), GATE_AT_CLOSE), { closedBy, attempts:", replace: "return Object.assign(Object.assign({}, state), { closedBy, attempts:" }]],
  ["a change keeping a met control", M.gate, ONE_EACH, [{ find: CHANGE_RESET, replace: "configurationChanges: state.configurationChanges + 1, controlMisses: 0, exceptionFor: null" }]],
  ["not met leaving slots planned", M.closed, ONE_EACH, [{ find: NOT_MET_CLOSE, replace: 'return accept(Object.assign(Object.assign(Object.assign({}, state), GATE_AT_CLOSE), { baselineRule: "not_met", closedBy: "baseline_not_met" }));' }]],
  ["a slot closed unstarted with no configuration", M.closed, ONE_EACH, [{ find: CLOSE_PLANNED, replace: '{ phase: "not_started" }' }]],
  ["no close when the last attempt ends", M.closed, ONE_EACH, [{ find: "return accept(closeIfDone(withAttempt(state, index, { phase, startRetries: 0 })));", replace: "return accept(withAttempt(state, index, { phase, startRetries: 0 }));" }]],
  ["a close leaving the running attempt running", M.closed, ONE_EACH, [{ find: "if (isRunningPhase(attempt.phase))\n                return Object.assign(Object.assign({}, attempt), { phase: runningOutcome, startRetries: 0 });", replace: "" }]],
  ["a control on a closed case", M.closedStays, ONE_EACH, [{ find: 'return refuse("not-this-case");\n    if (state.closedBy !== null)\n        return refuse("case-closed");', replace: 'return refuse("not-this-case");' }]],
  ["a rule recorded on a closed case", M.closedStays, ONE_EACH, [{ find: 'function baselineRuleRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.closedBy !== null)\n        return refuse("case-closed");', replace: 'function baselineRuleRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");' }]],
  ["the rule recorded again with the other result", M.ruleFixed, ONE_EACH, [{ find: 'if (state.baselineRule !== "pending")\n        return refuse("baseline-rule-already-recorded");', replace: 'if (state.baselineRule !== "pending" && state.baselineRule === event.result)\n        return refuse("baseline-rule-already-recorded");' }]],
  ["reconcile confirming pending cleanup", M.cleanup, ONE_EACH, [{ find: '(attempt.cleanup === "pending" ? Object.assign(Object.assign({}, attempt), { cleanup: "unconfirmed" }) : attempt)', replace: '(attempt.cleanup === "pending" ? Object.assign(Object.assign({}, attempt), { cleanup: "confirmed" }) : attempt)' }]],
  ["reconcile leaving a running attempt's cleanup pending", M.cleanup, ONE_EACH, [{ find: RECONCILE_RUNNING, replace: '{ phase: "failed", startRetries: 0 }' }]],
  ["reconcile timing a running attempt out", M.cleanup, ONE_EACH, [{ find: RECONCILE_RUNNING, replace: '{ phase: "timed_out", cleanup: "unconfirmed", startRetries: 0 }' }]],
  ["cleanup confirmed while the attempt runs", M.cleanup, ONE_EACH, [{ find: 'if (isRunningPhase(attempt.phase))\n        return refuse("attempt-running");', replace: "" }]],
  ["a destroyed environment read as confirmed", M.cleanup, ONE_EACH, [{ find: 'cleanup: event.type === "cleanup-confirmed" ? "confirmed" : "environment_destroyed"', replace: 'cleanup: "confirmed"' }]],
  ["a change relabelling earlier attempts", M.ranUnder, INSTRUMENTED_PAIR, [{ find: CHANGE_RESET, replace: `${CHANGE_RESET}, attempts: state.attempts.map((attempt) => (attempt.configuration === null ? attempt : Object.assign(Object.assign({}, attempt), { configuration: event.configuration })))` }]],
  ["a start recording no configuration", M.ranUnder, ONE_EACH, [{ find: STARTING_CHANGE, replace: '{ phase: "starting", cleanup: "pending" }' }]],
  ["dropping not_started", M.agreeDenominator, ONE_EACH, [{ find: 'notStarted: count((phase) => phase === "planned" || phase === "not_started"),', replace: 'notStarted: count((phase) => phase === "planned"),' }]],
  ["terminal reading only the first attempt", M.agreeTerminal, ONE_EACH, [{ find: 'return state.closedBy !== null && !state.attempts.some((attempt) => attempt.cleanup === "pending");', replace: 'return state.closedBy !== null && state.attempts[0].cleanup !== "pending";' }]],
  ["continuation reading only pending cleanup", M.agreeContinuation, ONE_EACH, [{ find: "const slots = state.attempts.filter(({ cleanup }) => isCleanupUnresolved(cleanup)).map(({ slot }) => slot);", replace: 'const slots = state.attempts.filter(({ cleanup }) => cleanup === "pending").map(({ slot }) => slot);' }]],
  ["two attempts at once", M.oneRuns, TWO_BASELINES, [{ find: STARTED_GUARDS, replace: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("not-next-slot");' }]],
  ["an arm rewritten at the start of a visit", M.arm, ONE_EACH, [{ find: STARTING_CHANGE, replace: '{ phase: "starting", arm: "baseline", cleanup: "pending", configuration: state.configuration }' }]],
  ["the instrumented arm not waiting", M.waits, ONE_EACH, [{ find: 'if (attempt.arm === "instrumented" && state.baselineRule === "pending")\n        return refuse("baseline-rule-pending");', replace: "" }]],
  ["the rule recorded before the baseline ended", M.waits, ONE_EACH, [{ find: 'if (!baseline.every(({ phase }) => isSettledPhase(phase)))\n        return refuse("baseline-not-finished");', replace: "" }]],
  ["the floor gone", M.waits, ONE_EACH, [{ find: 'if (usable < baselineFloor(baseline))\n        return refuse("baseline-floor-unmet");', replace: "" }]],
  ["a change after the rule is met", M.waits, ONE_EACH, [{ find: 'if (state.baselineRule === "met")\n        return refuse("configuration-after-rule");', replace: "" }]],
  ["a terminal attempt finishing again", M.terminalStays, ONE_EACH, [{ find: 'if (!isRunningPhase(phase))\n        return refuse("wrong-phase");\n    if (!REPORTABLE[phase].includes(event.outcome))\n        return refuse("outcome-not-reachable");', replace: "" }]],
  ["a deadline reopening a slot that never started", M.terminalStays, ONE_EACH, [{ find: 'if (!isRunningPhase(state.attempts[index].phase))\n        return refuse("wrong-phase");\n    return finish(state, index, "timed_out");', replace: 'if (!isRunningPhase(state.attempts[index].phase) && state.attempts[index].phase !== "not_started")\n        return refuse("wrong-phase");\n    return finish(state, index, "timed_out");' }]],
  ["continuing past unresolved cleanup", M.blocks, TWO_BASELINES, [{ find: 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");', replace: "" }]],
  ["a visit past unconfirmed cleanup", M.blocks, TWO_BASELINES, [{ find: 'if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");\n    if (attempt.arm', replace: 'if (state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("cleanup-unresolved");\n    if (attempt.arm' }]],
  ["a cancel waiting on cleanup", M.acquisition, ONE_EACH, [{ find: CANCEL_HEAD, replace: `${CANCEL_HEAD}\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");` }]],
  ["a deadline waiting on cleanup", M.acquisition, ONE_EACH, [{ find: DEADLINE_HEAD, replace: `${DEADLINE_HEAD}\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");` }]],
  ["an unconfirmed cleanup capping an outcome", M.acquisition, ONE_EACH, [{ find: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed" }));', replace: 'return accept(withAttempt(state, index, { cleanup: "unconfirmed", phase: "incomplete" }));' }]],
  ["a change waiting on cleanup", M.acquisition, INSTRUMENTED_PAIR, [{ find: 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: 'function configurationChanged(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.attempts.some(({ cleanup }) => isCleanupUnresolved(cleanup)))\n        return refuse("cleanup-unresolved");' }]],
  ["an exception waiting on unconfirmed cleanup", M.acquisition, INSTRUMENTED_PAIR, [{ find: 'function exceptionRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: 'function exceptionRecorded(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.attempts.some(({ cleanup }) => cleanup === "unconfirmed"))\n        return refuse("cleanup-unresolved");' }]],
  ["a purge only of a cancelled case", M.purgeSlice, ONE_EACH, [{ find: CLOSED_FLAG, replace: '(0, purge_1.purgeStep)(state.closedBy === "cancelled", state.purge, event)' }]],
  ["a purge held by pending cleanup", M.purgeSlice, ONE_EACH, [{ find: CLOSED_FLAG, replace: "(0, purge_1.purgeStep)(isTerminal(state), state.purge, event)" }]],
  ["an empty manifest refused while cleanup is pending", M.purgeSlice, ONE_EACH, [{ find: CLOSED_FLAG, replace: '(0, purge_1.purgeStep)(state.closedBy !== null && !(event.type === "purge-manifest-recorded" && event.paths.length === 0 && state.attempts.some((attempt) => attempt.cleanup === "pending")), state.purge, event)' }]],
  ["a purge clearing the exploratory mark", M.purgeSlice, ONE_EACH, [{ find: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest }))", replace: "accept(Object.assign(Object.assign({}, state), { purge: result.manifest, exploratory: false }))" }]],
  ["a purge refusal reading the exploratory mark", M.purgeSlice, ONE_EACH, [{ find: "return result.ok ? accept(Object.assign(Object.assign({}, state), { purge: result.manifest })) : refuse(result.refusal);", replace: 'return result.ok ? accept(Object.assign(Object.assign({}, state), { purge: result.manifest })) : refuse(result.refusal !== "case-open" && state.exploratory ? "owner-only" : result.refusal);' }]],
  ["a cleanup refused once a manifest exists", M.purgeSlice, ONE_EACH, [{ find: CLEANUP_HEAD, replace: 'function cleanupEvent(state, event) {\n    if (state.purge !== null)\n        return refuse("case-closed");\n    const index = indexOfSlot(state, event.slot);' }]],
  ["cleanup refused once a listed path reads remaining", M.purgeSlice, ONE_EACH, [{ find: CLEANUP_HEAD, replace: 'function cleanupEvent(state, event) {\n    if (state.purge !== null && state.purge.some((entry) => entry.state === "remains"))\n        return refuse("case-closed");\n    const index = indexOfSlot(state, event.slot);' }]],
  ["a capture from another slot's runner", M.authority, ONE_EACH, [{ find: 'if (!isRunnerOf(by, state.attempts[index]))\n        return "not-this-attempt";', replace: 'if (by.kind !== "system:runner")\n        return "not-this-attempt";' }]],
  ["cleanup from another attempt's runner", M.authority, ONE_EACH, [{ find: "if (!isOwner(event.by) && !isRunnerOf(event.by, attempt))", replace: 'if (!isOwner(event.by) && event.by.kind !== "system:runner")' }]],
  ["a visit started by a runner", M.authority, ONE_EACH, [{ find: 'function attemptStarted(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function attemptStarted(state, event) {" }]],
  ["a control from the owner", M.authority, ONE_EACH, [{ find: 'if (event.by.kind !== "system:runner")\n        return refuse("runner-only");\n    if (event.by.attemptId !== state.controlRunId)', replace: 'if (event.by.kind === "system:runner" && event.by.attemptId !== state.controlRunId)' }]],
  ["a purge from a runner", M.authority, ONE_EACH, [{ find: 'function purgeEvent(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: "function purgeEvent(state, event) {" }]],
  ["a claim from the control run", M.authority, ONE_EACH, [], [{ find: 'if (by.kind !== "owner")\n        return refuse("owner-only");', replace: 'if (by.kind !== "owner" && by.attemptId !== machine.controlRunId)\n        return refuse("owner-only");' }]],
  ["a claim from a runner once rows exist", M.authority, ONE_EACH, [], [{ find: 'if (by.kind !== "owner")\n        return refuse("owner-only");', replace: 'if (by.kind !== "owner" && record.rows.length === 0)\n        return refuse("owner-only");' }]],
  ["cleanup refused from its own runner", M.interchangeable, ONE_EACH, [{ find: "if (!isOwner(event.by) && !isRunnerOf(event.by, attempt))", replace: "if (!isOwner(event.by))" }]],
  ["a failed control unlocking visits", M.control, ONE_EACH, [{ find: 'event.result === "met";', replace: '(event.result === "met" || event.result === "not_met");' }]],
  ["a merely recorded control", M.control, ONE_EACH, [{ find: 'event.result === "met";', replace: '(event.result === "met" || event.result === "not_evaluated");' }]],
  ["a control from another configuration", M.control, ONE_EACH, [{ find: 'const controlMet = event.configuration === state.configuration && event.result === "met";', replace: 'const controlMet = event.result === "met";' }]],
  [
    "an exception made after the visit",
    M.exceptionFirst,
    ONE_EACH,
    [
      { find: 'if (state.attempts[index].phase !== "planned")\n        return refuse("exception-after-visit");', replace: "" },
      { find: 'if (state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("exception-not-next");', replace: 'if (state.attempts[index].phase === "planned" && state.attempts.findIndex(({ phase }) => phase === "planned") !== index)\n        return refuse("exception-not-next");' }
    ]
  ],
  ["a later pass clearing the exploratory mark", M.mark, ONE_EACH, [{ find: "{ controlMet, controlMisses: 0 })", replace: "{ controlMet, controlMisses: 0, exploratory: false })" }]],
  ["an exception that does not mark the case", M.mark, ONE_EACH, [{ find: "{ exceptionFor: event.slot, exploratory: true }", replace: "{ exceptionFor: event.slot }" }]],
  ["a retry that does not count", M.acyclic, ONE_EACH, [{ find: "{ startRetries: found.attempt.startRetries + 1 }", replace: "{ startRetries: found.attempt.startRetries }" }]],
  ["a control miss that does not count", M.acyclic, ONE_EACH, [{ find: "Object.assign(Object.assign({}, state), { controlMisses: state.controlMisses + 1 })", replace: "state" }]],
  [
    "a closed case's cleanup that nothing can answer",
    M.sinks,
    ONE_EACH,
    [
      { find: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(state, "cancelled", "cancelled"));', replace: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(Object.assign(Object.assign({}, state), { attempts: state.attempts.map((attempt) => (isRunningPhase(attempt.phase) ? Object.assign(Object.assign({}, attempt), { cleanup: "pending" }) : attempt)) }), "cancelled", "cancelled"));' },
      { find: 'if (!state.attempts.some(({ cleanup }) => cleanup === "pending"))\n        return refuse("nothing-to-reconcile");', replace: 'return refuse("nothing-to-reconcile");' },
      { find: CLEANUP_HEAD, replace: 'function cleanupEvent(state, event) {\n    return refuse("cleanup-settled");\n    const index = indexOfSlot(state, event.slot);' }
    ]
  ],
  ["a case deadline that does not close", M.supervisor, ONE_EACH, [{ find: 'if (state.closedBy !== null)\n        return refuse("case-closed");\n    return accept(closeWith(state, "timed_out", "deadline"));', replace: 'return refuse("case-closed");' }]],
  ["reconcile refused once the case is closed", M.supervisor, ONE_EACH, [{ find: 'function reconcile(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");', replace: 'function reconcile(state, event) {\n    if (!isOwner(event.by))\n        return refuse("owner-only");\n    if (state.closedBy !== null)\n        return refuse("case-closed");' }]]
];

let machineJobs: Map<string, Promise<Answer>> | null = null;

/** Every machine variant is queued on the threads when the first of them is asked for, and each test waits on its own. */
function machineJob(name: string): Promise<Answer> {
  machineJobs ??= new Map(MACHINE_VARIANTS.map(([variant, property, plan, edits, evidenceEdits]) => [variant, pool().run({ kind: "machine-walk", setup: { plan, only: [property], manifests: "all", machineEdits: edits, evidenceEdits } })]));
  return machineJobs.get(name) as Promise<Answer>;
}

for (const [name, property] of MACHINE_VARIANTS) {
  test(`the machine walk catches ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, async () => settle(await machineJob(name)));
  });
}

test("every machine property has a variant it alone catches, the domain and the caps aside, which are always on", () => {
  const caught = new Set(MACHINE_VARIANTS.map(([, property]) => property));
  assert.deepEqual([...caught].sort(), Object.values(M).sort());
});


// ---------------------------------------------------------------------------------------------
// The purge slice, apart from the machine. purge.test.ts pins its signature to the closed flag, the
// manifest and the event, which is what lets it be walked alone: widening it invalidates this.
// ---------------------------------------------------------------------------------------------

test("the purge slice: every state purgeStep reaches from no manifest, open and closed, over three paths", () => {
  const walk = walkPurgeSlice(productionPurge);
  // Two with no manifest, and each status of each listed path of each of the eight manifests: 1 + 9 + 27 + 27.
  assert.deepEqual([walk.states, walk.summary], [2 + 64, 8]);
  assert.equal(walk.edges, PURGE_SLICE_EDGES);
  // A path read absent can read remaining and then absent again, so the slice's graph has a cycle. All this test
  // asserts of it is that a cycle exists; it is why acyclicity is claimed of the machine without the slice.
  assert.equal(walk.cyclic, true);
});

const PURGE_SLICE_EDGES = 200;

for (const [name, property, edits] of [
  ["a remaining path read as purged", S.summary, [{ find: 'entry.state === "absent"', replace: 'entry.state !== "present"' }]],
  ["a path dropped when it reads absent", S.answer, [{ find: "return { ok: true, manifest: manifest.map((candidate) => (candidate.path === path ? { path, state } : candidate)) };", replace: 'return { ok: true, manifest: manifest.filter((candidate) => candidate.path !== path || state !== "absent").map((candidate) => (candidate.path === path ? { path, state } : candidate)) };' }]],
  ["purging an open case", S.answer, [{ find: 'if (!closed)\n        return { ok: false, refusal: "case-open" };', replace: "" }]],
  ["remaining refused straight from present", S.answer, [{ find: 'if (entry.state === state)\n        return { ok: false, refusal: "path-status-unchanged" };', replace: 'if (entry.state === state || (entry.state === "present" && state === "remains"))\n        return { ok: false, refusal: "path-status-unchanged" };' }]],
  ["absent refused once a path reads remaining", S.answer, [{ find: 'if (entry.state === state)\n        return { ok: false, refusal: "path-status-unchanged" };', replace: 'if (entry.state === state || (entry.state === "remains" && state === "absent"))\n        return { ok: false, refusal: "path-status-unchanged" };' }]]
] as const) {
  test(`the purge slice catches ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, () => walkPurgeSlice(purgeVariant(...(edits as readonly SourceEdit[])), [property]));
  });
}


// ---------------------------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------------------------

const FOLD_TWO_COUNTS = { states: 202327, edges: 679588, summary: 12137 };
const FOLD_PAIR_COUNTS = { states: 240501, edges: 639764, summary: 14821 };
const FOLD_THREE_COUNTS = { states: 293776, edges: 810975, summary: 25149 };

let foldJobs: Map<string, Promise<Answer>> | null = null;

const instanceName = (instance: FoldInstance): FoldSetup["instance"] => (Object.entries(FOLD_INSTANCES).find(([, candidate]) => candidate === instance) as [FoldSetup["instance"], FoldInstance])[0];

/** The three fold walks and every fold variant are queued on the threads when the first of them is asked for, the walks ranked long. */
function foldJob(name: string): Promise<Answer> {
  if (foldJobs === null) {
    foldJobs = new Map();
    for (const instance of ["FOLD_TWO", "FOLD_PAIR", "FOLD_THREE"] as const) foldJobs.set(instance, pool().run({ kind: "fold-walk", setup: { instance } }, LONG));
    for (const [variant, property, edits, machineEdits, evidenceEdits, instance = FOLD_SMALL] of FOLD_VARIANTS) {
      foldJobs.set(variant, pool().run({ kind: "fold-walk", setup: { instance: instanceName(instance), only: [property], storeEdits: edits, machineEdits, evidenceEdits } }));
    }
  }
  return foldJobs.get(name) as Promise<Answer>;
}

for (const [label, name, instance, largest, counts] of [
  ["fold walk, two digests", "two digests and every identity over them", "FOLD_TWO", 1, FOLD_TWO_COUNTS],
  ["fold walk, fixture and criterion apart", "a plan whose fixture and criterion differ", "FOLD_PAIR", 1, FOLD_PAIR_COUNTS],
  ["fold walk, three digests", "three digests with two free", "FOLD_THREE", 2, FOLD_THREE_COUNTS]
] as const) {
  test(`the fold, ${name}: every state foldEntry reaches, under every fold property`, async (t) => {
    const started = performance.now();
    const walk = settle(await foldJob(instance)) as FoldWalk;
    assertFoldCovered(walk, largest);
    assert.deepEqual({ states: walk.states, edges: walk.edges, summary: walk.summary }, counts, "a change detector, not evidence");
    report(t, label, started, { states: walk.states, edges: walk.edges, summary: walk.summary });
  });
}

const WITH_KEPT_ROW = 'if (event.type === "evidence-recorded")\n        return { ok: true, state: after };';
const RAW_CHECK = 'if (named.some((digest) => raw.has(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));';
const LISTED_CHECK = 'if (named.some((digest) => listed.some(({ path }) => path === digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));';
const CONTROL_KEEPS = 'if (event.type === "control-recorded")\n        return {';
const KEEPS = "return { ok: true, state: Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };\n}";
const AFTER_MANIFEST = 'if (state.machine.purge !== null)\n                return refused("evidence-after-manifest", "row");';
const MANIFEST_CHECK = 'if (!isSameSet(event.paths, purgeSetOf(state)))\n                return refused("manifest-not-the-evidence", "paths");';
const LATE_LABEL = '(0, case_machine_1.isOutcome)(phaseBefore) ? Object.assign(Object.assign({}, row), { state: "late" }) : row';
const CLAIM_OWNER = 'if (by.kind !== "owner")\n        return refuse("owner-only");';

type FoldVariant = readonly [name: string, property: string, store: readonly SourceEdit[], machine?: readonly SourceEdit[], evidence?: readonly SourceEdit[], instance?: FoldInstance];

const FOLD_VARIANTS: readonly FoldVariant[] = [
  ["3fef1027: a control keeping nothing while a manifest omits its digests", F.summary, [{ find: "return new Set([...rowRawOf(state), ...state.controlObjects.filter((digest) => !state.keptObjects.includes(digest))]);", replace: "return rowRawOf(state);" }]],
  ["3fef1027: a listed path a control alone named kept by a later patch", F.apart, [{ find: LISTED_CHECK, replace: "" }]],
  ["a row after the manifest keeping a listed digest", F.apart, [{ find: AFTER_MANIFEST, replace: "" }, { find: WITH_KEPT_ROW, replace: 'if (event.type === "evidence-recorded")\n        return { ok: true, state: Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };' }]],
  ["the raw rule gone", F.rawStays, [{ find: RAW_CHECK, replace: "" }]],
  // Two that pin one half each of an oracle read two ways. The first keeps a row's digest in keptObjects while
  // the owner still cannot keep it, so the shadow never says kept and only the keptObjects half sees it; the
  // second keeps nothing in keptObjects, so a manifest lists what the owner kept and only the shadow half sees it.
  ["a row keeping its own digest, which stays raw to the owner", F.rawStays, [{ find: WITH_KEPT_ROW, replace: 'if (event.type === "evidence-recorded")\n        return { ok: true, state: Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) };' }, { find: "digest === null || keptObjects.includes(digest) ? [] : [digest]", replace: "digest === null ? [] : [digest]" }]],
  ["the owner's events keeping nothing, so a manifest lists what the owner kept", F.apart, [{ find: KEEPS, replace: "return { ok: true, state: after };\n}" }]],
  ["the raw rule gone, and nothing after the plan keeping anything", F.rawStays, [{ find: RAW_CHECK, replace: "" }, { find: KEEPS, replace: "return { ok: true, state: before === null ? Object.assign(Object.assign({}, after), { keptObjects: [...new Set([...after.keptObjects, ...named])] }) : after };\n}" }]],
  ["the kept objects not taken off the purge set", F.manifest, [{ find: "...state.controlObjects.filter((digest) => !state.keptObjects.includes(digest))]", replace: "...state.controlObjects]" }]],
  ["a part of the purge set taken as the whole", F.manifest, [{ find: "return paths.length === digests.size && paths.every((path) => digests.has(path));", replace: "return paths.every((path) => digests.has(path));" }]],
  ["the exact purge set refused when it lists a control's digest", F.manifest, [{ find: MANIFEST_CHECK, replace: 'if (!isSameSet(event.paths, purgeSetOf(state)) || event.paths.some((path) => state.controlObjects.includes(path)))\n                return refused("manifest-not-the-evidence", "paths");' }]],
  ["an empty manifest taken after a visit", F.empty, [{ find: 'return event.paths.length === 0 && begun ? refused("manifest-empty-after-a-visit", "paths") : result;', replace: "return result;" }]],
  ["a cancelled visit not counted as begun", F.empty, [{ find: 'const begun = state.machine.attempts.some(({ phase }) => phase !== "not_started");', replace: 'const begun = state.machine.attempts.some(({ phase }) => phase !== "not_started" && phase !== "cancelled");' }]],
  ["the raw rule heard ahead of the machine's", F.refusal, [{ find: "return applied.ok ? withKept(state, decoded.event, named, applied.state) : applied;", replace: "const early = withKept(state, decoded.event, named, applied.ok ? applied.state : state);\n    return !early.ok || applied.ok ? early : applied;" }]],
  ["keeping a digest only a control named refused once any row exists", F.refusal, [{ find: "const raw = rowRawOf(before);", replace: 'const raw = rowRawOf(before);\n        if (before.record.rows.length > 0 && named.some((digest) => before.controlObjects.includes(digest) && !before.keptObjects.includes(digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));' }]],
  ["a row naming a digest the case keeps refused, as an earlier version of the rule did", F.genuine, [{ find: WITH_KEPT_ROW, replace: 'if (event.type === "evidence-recorded")\n        return before !== null && named.some((digest) => before.keptObjects.includes(digest)) ? refused("object-both-raw-and-kept", "row.digest") : { ok: true, state: after };' }]],
  ["a control's objects counted raw", F.genuine, [{ find: "const raw = rowRawOf(before);", replace: "const raw = purgeSetOf(before);" }]],
  ["a control re-recorded for an identity already named refused", F.genuine, [{ find: CONTROL_KEEPS, replace: 'if (event.type === "control-recorded" && before !== null && named.every((digest) => before.controlObjects.includes(digest)))\n        return refused("raw-object-cannot-be-kept", "configuration");\n    if (event.type === "control-recorded")\n        return {' }]],
  ["a control after rows naming its fixture refused", F.genuine, [{ find: CONTROL_KEEPS, replace: 'if (event.type === "control-recorded" && before !== null && before.record.rows.some(({ digest }) => named.includes(digest)))\n        return refused("raw-object-cannot-be-kept", "configuration");\n    if (event.type === "control-recorded")\n        return {' }]],
  ["a change keeping a fixture the case already keeps refused once a row named it", F.genuine, [{ find: "const raw = rowRawOf(before);", replace: 'const raw = rowRawOf(before);\n        if (event.type === "configuration-changed" && named.some((digest) => before.keptObjects.includes(digest) && before.record.rows.some((row) => row.digest === digest)))\n            return refused("raw-object-cannot-be-kept", keptField(event));' }], undefined, undefined, FOLD_TWO],
  ["every actor read as the owner", F.authority, [{ find: 'return actor.kind === "owner" ? { kind: "owner" } : { kind: "system:runner", attemptId: actor.attemptId };', replace: 'return { kind: "owner" };' }]],
  ["a plan from a runner", F.authority, [{ find: 'if (by.kind !== "owner")\n            return refused("owner-only");', replace: "" }]],
  ["a claim from a runner once rows exist", F.authority, [], undefined, [{ find: CLAIM_OWNER, replace: 'if (by.kind !== "owner" && (record.rows.length === 0 || event.type === "source-reconstructed"))\n        return refuse("owner-only");' }]],
  ["an instrument record from any runner once rows exist", F.authority, [], undefined, [{ find: 'if (by.kind !== "system:runner" || by.attemptId !== attempt.attemptId)', replace: 'if (by.kind !== "system:runner" || (by.attemptId !== attempt.attemptId && record.rows.length === 0))' }]],
  ["a configuration stored with a field no identity has", F.domain, [{ find: "[...state.configurations, event.configuration]", replace: "[...state.configurations, Object.assign({}, event.configuration, { note: 1 })]" }]],
  ["a control under another identity taken as in force", F.control, [{ find: 'case "control-recorded":\n            return stepped(state, { type: event.type, configuration: (0, case_events_1.configurationKey)(event.configuration), result: event.result, by });', replace: 'case "control-recorded":\n            return stepped(state, { type: event.type, configuration: state.machine.configuration, result: event.result, by });' }]],
  ["a visit's basis recorded as control while an exception was pending", F.basis, [], [{ find: 'if (state.exceptionFor === slot)\n        return "exception";\n    return state.controlMet ? "control" : null;', replace: 'if (state.controlMet)\n        return "control";\n    return state.exceptionFor === slot ? "exception" : null;' }]],
  ["no late label", F.late, [], undefined, [{ find: LATE_LABEL, replace: "row" }]],
  ["a row late while its attempt is starting", F.late, [], undefined, [{ find: LATE_LABEL, replace: '((0, case_machine_1.isOutcome)(phaseBefore) || phaseBefore === "starting") ? Object.assign(Object.assign({}, row), { state: "late" }) : row' }]],
  ["a row taken after the manifest", F.rowTaken, [{ find: AFTER_MANIFEST, replace: "" }]],
  ["a second plan taken", F.planOnce, [{ find: 'if (state !== null)\n            return refused("already-planned");', replace: "" }]],
  ["a patch before the visit ends", F.patch, [], undefined, [{ find: 'return ended ? sourceReconstructed(record, event) : refuse("source-attempt-not-ended", "appliesTo");', replace: "return sourceReconstructed(record, event);" }]]
];

for (const [name, property] of FOLD_VARIANTS) {
  test(`the fold walk catches ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, async () => settle(await foldJob(name)));
  });
}

test("every fold property has a variant it alone catches", () => {
  const caught = new Set(FOLD_VARIANTS.map(([, property]) => property));
  assert.deepEqual([...caught].sort(), Object.values(F).sort());
});

test("the fold's key refuses what it could not rebuild", async () => {
  const codec = foldCodec(FOLD_SMALL);
  const planStep = planStepOf(FOLD_SMALL);
  const first = productionStore.foldEntry(null, { actor: FOLD_OWNER, events: [planStep.event], evidence: planStep.evidence, seq: 1 });
  assert.ok(first.ok);
  assert.equal(JSON.stringify(codec.decode(codec.encode(first.state))), JSON.stringify(first.state));
  await assertCaughtBy("an identity the instance does not name", F.domain, () => codec.encode({ ...first.state, configurations: [...first.state.configurations, identityOf("d3", DIGEST_ZERO, DIGEST_ZERO)] }));
  await assertCaughtBy("a string spelled like a token", F.domain, () => codec.encode({ ...first.state, keptObjects: ["#9"] }));
  // A token's text at the end of another string, after an escaped quote, is that string's and is not read as a token.
  const quoted = { ...first.state, keptObjects: ['x"#0', 'y\\"#1'] };
  assert.equal(JSON.stringify(codec.decode(codec.encode(quoted))), JSON.stringify(quoted));
});

test("the fold's pure entry gives the store path's state on the whole synthetic case", async () => {
  const owner = await verifiedOwnerActor();
  const stores = memoryStores();
  const actorOf = actorsFor(owner);
  const marks = await runScript({ stores, caseId: CASE_A, actorOf, now: risingClock(NOW_MS + 1000), commands: CASE_SCRIPT });
  let state: CaseState | null = null;
  let seq = 0;
  for (const { as, event } of CASE_SCRIPT) {
    seq += 1;
    const decoded = decodeEvent(event);
    assert.ok(decoded.ok, event.type);
    const folded: ReturnType<typeof productionStore.foldEntry> = productionStore.foldEntry(state, { actor: actorOf(as), events: [event], evidence: digestsNamed(decoded.event), seq });
    assert.ok(folded.ok, `${event.type}: ${JSON.stringify(folded)}`);
    state = folded.state;
  }
  assert.equal(seq, marks.last.seq);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), JSON.parse(JSON.stringify(marks.last.state)));
});

// ---------------------------------------------------------------------------------------------
// What the table found missing in the readings: no position test held a column that is not ASCII.
// ---------------------------------------------------------------------------------------------

const UTF16 = "a position read in UTF-16 code units on both sides falls in a range exactly where its offset does";

/** Every (start, end, offset) of one inline script that holds, and follows, a character outside the BMP: two UTF-16 units, one code point. */
const checkUtf16 = (readings: typeof productionReadings, measure: "units" | "points"): Readonly<{ tried: number; inside: number }> => {
  const astral = "\u{1D4D0}";
  const document = ["<html>", `<body>${astral}<script>let ${astral}a = 1;`, `let b = "${astral}";`, "  let c = 3;</script>"].join("\n");
  const scriptStart = document.indexOf("<script>") + "<script>".length;
  const script = document.slice(scriptStart, document.indexOf("</script>"));
  const at = (text: string, offset: number, how: "units" | "points"): Position => {
    const lines = text.slice(0, offset).split("\n");
    const last = lines[lines.length - 1];
    return { line: lines.length - 1, column: how === "units" ? last.length : [...last].length };
  };
  const resourceStart = at(document, scriptStart, "units");
  const identity: ScriptIdentity = { scriptId: "script-utf16", url: "https://orchard-lane.example/page.html", resourceStart, digest: "ab".repeat(32) };
  const place = { attempt: "attempt-0f3a", target: "target-t1", frame: "frame-f1", loader: "loader-l1", script: identity };
  let tried = 0;
  let inside = 0;
  for (let start = 0; start < script.length; start += 1) {
    for (let end = start + 1; end <= script.length; end += 1) {
      for (let offset = 0; offset < script.length; offset += 1) {
        const stack = at(document, scriptStart + offset, measure);
        const reading = readings.readExecutionJoin(
          { ...place, line: stack.line + 1, column: stack.column + 1, time: { clock: "page", ms: 1500 } },
          { ...place, start: at(script, start, "units"), end: at(script, end, "units"), window: { clock: "page", startMs: 1000, endMs: 2000, uncertaintyMs: null } },
          { attempt: place.attempt, scripts: [identity] }
        );
        const expected = offset >= start && offset < end;
        holds(UTF16, (reading.reading === "position_consistent") === expected, () => ({ start, end, offset, measure, reading }));
        tried += 1;
        if (expected) inside += 1;
      }
    }
  }
  return { tried, inside };
};

test("UTF-16 columns: positions read off a document holding a character outside the BMP, in code units on both sides", async () => {
  assert.deepEqual(checkUtf16(productionReadings, "units"), { tried: UTF16_TRIED, inside: UTF16_INSIDE });
  // The convention is load-bearing: the same stack read in code points lands outside the range somewhere. This changes
  // the test's input, not production, so it shows what an adapter must supply and is not a variant.
  await assertCaughtBy("a stack read in code points", UTF16, () => checkUtf16(productionReadings, "points"));
  // The variant: production's own conversion off by one on the inline script's first line.
  const variant = loadVariant<typeof productionReadings>(require.resolve("../core/readings"), [{ find: "column - 1 - resourceStart.column : column - 1;", replace: "column - resourceStart.column : column - 1;" }]);
  await assertCaughtBy("off-by-one columns on the first line", UTF16, () => checkUtf16(variant, "units"));
});

const UTF16_TRIED = 30420;
const UTF16_INSIDE = 10660;

test("the suite's threads saw no answer that no job out was waiting for", () => {
  assert.equal(shared?.fault ?? null, null);
});
