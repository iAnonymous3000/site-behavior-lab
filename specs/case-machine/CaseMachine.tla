---------------------------- MODULE CaseMachine ----------------------------
(***************************************************************************)
(* The case and attempt machine of the investigation workspace, stated     *)
(* from its rules: the header of investigation/core/case-machine.ts, the   *)
(* docblock of investigation/core/purge.ts, and the rule text the          *)
(* exploration suite quotes (investigation/test/case-exploration.test.ts). *)
(* It is a second statement of those rules, in another shape than the      *)
(* TypeScript and not copied from it line by line, so that the two can be  *)
(* compared: the comparison is the conformance suite,                      *)
(* scripts/tla-case-machine-conformance.test.mjs.                          *)
(*                                                                         *)
(* What TLC establishes here is bounded: each property below holds on      *)
(* every state this module reaches from the plan a configuration names,    *)
(* over the event alphabet below, under the caps a configuration sets.     *)
(* Nothing is said of a plan, an event or a cap outside a configuration.   *)
(*                                                                         *)
(* Where this statement differs from the TypeScript on purpose:            *)
(*  - The plan's digest is a flag (frozen or not). One digest is walked.   *)
(*  - A configuration is one of two names. Two keys are walked.            *)
(*  - Evidence ids are not modeled. evidence-recorded appears only as a    *)
(*    body the authority probes send; this module has no effect for it.    *)
(*  - Refusal reasons are not modeled, the purge reducer's aside.          *)
(*  - Three guards are written as the rule text words them, where the      *)
(*    code words them otherwise: a configuration change is refused once    *)
(*    the rule is recorded (the code refuses once it is met, and a rule    *)
(*    not met has closed the case); an instrumented visit needs the rule   *)
(*    met where both arms are planned (the code refuses while it is        *)
(*    pending); a visit spends the exception recorded for it (the code     *)
(*    clears whichever is pending). The conformance suite holds the two    *)
(*    wordings to the same transitions on the walked plans.                *)
(*  - ruleMetUnder is a history field. No guard reads it.                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Plan,                     \* the planned slots, a sequence in plan order
  MaxControlMisses,         \* a run and one retry
  MaxStartRetries,
  MaxConfigurationChanges,
  HeldManifests             \* "two" or "all": which manifests the purge pairing holds beside none

----------------------------------------------------------------------------
(* Names. *)

SlotNames == {"B1", "B2", "B3", "I1", "I2", "I3"}
BaselineNames == {"B1", "B2", "B3"}
Configurations == {"alder", "birch"}
FirstConfiguration == "alder"
NoSlot == "none"
NoConfiguration == "none"

RunningPhases == {"starting", "capturing", "finalizing"}
Outcomes == {"usable", "walled", "failed", "incomplete", "timed_out", "cancelled"}
SettledPhases == Outcomes \cup {"not_started"}
Phases == {"planned"} \cup RunningPhases \cup SettledPhases
Cleanups == {"none", "pending", "confirmed", "unconfirmed", "environment_destroyed"}
UnresolvedCleanups == {"pending", "unconfirmed"}
Rules == {"pending", "met", "not_met", "not_applicable"}
Closures == {"none", "completed", "cancelled", "deadline", "baseline_not_met"}

Slots == {Plan[i] : i \in DOMAIN Plan}
Position(s) == CHOOSE i \in DOMAIN Plan : Plan[i] = s
ArmOf(s) == IF s \in BaselineNames THEN "baseline" ELSE "instrumented"
BaselineSlots == {s \in Slots : ArmOf(s) = "baseline"}
InstrumentedSlots == {s \in Slots : ArmOf(s) = "instrumented"}
BothArms == BaselineSlots # {} /\ InstrumentedSlots # {}

(* Usable baseline attempts the rule's met needs: two, or all of the       *)
(* baseline when fewer than two were planned.                              *)
Floor == IF Cardinality(BaselineSlots) < 2 THEN Cardinality(BaselineSlots) ELSE 2

ASSUME PlanIsWellFormed ==
  /\ Len(Plan) > 0
  /\ \A i \in DOMAIN Plan : Plan[i] \in SlotNames
  /\ \A i, j \in DOMAIN Plan : i # j => Plan[i] # Plan[j]

----------------------------------------------------------------------------
(* Actors. A runner is known by the attempt it runs; the control run and   *)
(* a runner of some other case are runners too, and hold no slot.          *)

Owner == [kind |-> "owner", of |-> "none"]
Runner(id) == [kind |-> "runner", of |-> id]
ControlRun == Runner("control")
ForeignRun == Runner("foreign")
Actors == {Owner, ControlRun, ForeignRun} \cup {Runner(s) : s \in SlotNames}

----------------------------------------------------------------------------
(* The purge manifest and its reducer, from purge.ts's docblock: only a    *)
(* closed case has a manifest; one is recorded once, of distinct paths,    *)
(* each read present; a path's status moves only on a listed path, and     *)
(* only to a status it does not hold. No manifest differs from an empty    *)
(* one, so "recorded" is its own flag.                                     *)

PurgePaths == <<"p1", "p2", "p3">>
UnlistedPath == "p0"
PathStatuses == {"present", "absent", "remains"}
NoManifest == [recorded |-> FALSE, entries |-> <<>>]
ManifestOf(paths) == [recorded |-> TRUE, entries |-> [k \in DOMAIN paths |-> [path |-> paths[k], status |-> "present"]]]

IsDistinct(seq) == \A i, j \in DOMAIN seq : i # j => seq[i] # seq[j]
StatusNamed(type) == IF type = "purge-path-absent" THEN "absent" ELSE "remains"
Listed(m, path) == {k \in DOMAIN m.entries : m.entries[k].path = path}

PurgeTypes == {"purge-manifest-recorded", "purge-path-absent", "purge-path-remains"}

(* The reducer's answer: the manifest it leaves, or the reason it refuses. *)
PurgeRule(closed, m, p) ==
  IF ~closed THEN [ok |-> FALSE, refusal |-> "case-open"]
  ELSE IF p.type = "purge-manifest-recorded" THEN
    IF m.recorded THEN [ok |-> FALSE, refusal |-> "manifest-already-recorded"]
    ELSE IF ~IsDistinct(p.paths) THEN [ok |-> FALSE, refusal |-> "manifest-malformed"]
    ELSE [ok |-> TRUE, manifest |-> ManifestOf(p.paths)]
  ELSE IF ~m.recorded \/ Listed(m, p.path) = {} THEN [ok |-> FALSE, refusal |-> "no-such-path"]
  ELSE LET k == CHOOSE k \in Listed(m, p.path) : TRUE
           status == StatusNamed(p.type)
       IN IF m.entries[k].status = status THEN [ok |-> FALSE, refusal |-> "path-status-unchanged"]
          ELSE [ok |-> TRUE, manifest |-> [m EXCEPT !.entries[k].status = status]]

(* SUMMARY_ONLY only when a manifest exists and every path on it is        *)
(* confirmed absent.                                                       *)
RetentionTier(m) ==
  IF m.recorded /\ \A k \in DOMAIN m.entries : m.entries[k].status = "absent" THEN "SUMMARY_ONLY" ELSE "RAW_HELD"

----------------------------------------------------------------------------
(* The state. *)

VARIABLE c

AttemptStates == [phase : Phases, cleanup : Cleanups, ranUnder : Configurations \cup {NoConfiguration},
                  retries : 0..MaxStartRetries, arm : {"baseline", "instrumented"}]

Closed(S) == S.closedBy # "none"
Running(S) == {s \in Slots : S.att[s].phase \in RunningPhases}
Waiting(S) == {s \in Slots : S.att[s].phase = "planned"}
IsNext(S, s) == s \in Waiting(S) /\ \A t \in Waiting(S) : Position(s) <= Position(t)
Unresolved(S) == {s \in Slots : S.att[s].cleanup \in UnresolvedCleanups}
PendingCleanup(S) == {s \in Slots : S.att[s].cleanup = "pending"}
AllSettled(S) == \A s \in Slots : S.att[s].phase \in SettledPhases
BaselineSettled(S) == \A s \in BaselineSlots : S.att[s].phase \in SettledPhases
UsableBaseline(S) == {s \in BaselineSlots : S.att[s].phase = "usable" /\ S.att[s].ranUnder = S.config}
RuleRecorded(S) == S.rule \in {"met", "not_met"}

Planned ==
  [frozen |-> FALSE, config |-> FirstConfiguration, changes |-> 0, met |-> FALSE, misses |-> 0,
   exception |-> NoSlot, exploratory |-> FALSE,
   rule |-> IF BothArms THEN "pending" ELSE "not_applicable",
   closedBy |-> "none",
   att |-> [s \in Slots |-> [phase |-> "planned", cleanup |-> "none", ranUnder |-> NoConfiguration, retries |-> 0, arm |-> ArmOf(s)]],
   purge |-> NoManifest,
   ruleMetUnder |-> NoConfiguration]

----------------------------------------------------------------------------
(* Events. Each is a record with its type, who sent it, and what it names. *)

Reportable(phase) ==
  CASE phase = "starting" -> {"failed"}
    [] phase = "capturing" -> {"failed", "walled"}
    [] phase = "finalizing" -> {"usable", "incomplete", "walled", "failed"}
    [] OTHER -> {}

CleanupTypes == {"cleanup-confirmed", "cleanup-unconfirmed", "environment-destroyed"}
OwnRunnerTypes == {"attempt-start-retried", "capture-began", "capture-finished", "attempt-finished", "evidence-recorded"}
OwnerOnlyTypes == {"plan-frozen", "configuration-changed", "exception-recorded", "baseline-rule-recorded", "attempt-started",
                   "attempt-deadline", "case-deadline", "case-cancelled", "reconcile"} \cup PurgeTypes

SlotOf(e) == IF "slot" \in DOMAIN e THEN e.slot ELSE NoSlot

(* Whether the rules take this event in this state. *)
Accepts(S, e) ==
  CASE e.type = "plan-frozen" ->
         \* The plan is frozen once, before any control, exception or visit.
         e.by = Owner /\ ~Closed(S) /\ ~S.frozen
    [] e.type = "control-recorded" ->
         \* From the one control run the plan declares. Once the configuration in force has a
         \* met control no further control is taken for it; a miss is counted, up to the cap.
         /\ e.by = ControlRun
         /\ ~Closed(S) /\ S.frozen /\ Running(S) = {}
         /\ ~S.met /\ S.misses < MaxControlMisses
    [] e.type = "configuration-changed" ->
         \* Once the rule is recorded the configuration cannot change. While it is pending, a
         \* change is refused when the baseline slots not yet started could not reach the floor.
         /\ e.by = Owner
         /\ ~Closed(S) /\ S.frozen /\ Running(S) = {}
         /\ ~RuleRecorded(S)
         /\ S.changes < MaxConfigurationChanges
         /\ e.configuration # S.config
         /\ (S.rule = "pending" => Cardinality(Waiting(S) \cap BaselineSlots) >= Floor)
    [] e.type = "exception-recorded" ->
         \* The owner's, for the next visit, before it began; one waits at a time.
         /\ e.by = Owner /\ e.slot \in Slots
         /\ ~Closed(S) /\ S.frozen
         /\ S.exception = NoSlot
         /\ IsNext(S, e.slot)
    [] e.type = "baseline-rule-recorded" ->
         \* Every baseline attempt ended, then the owner records met or not_met. Met needs the
         \* floor of usable baseline attempts under the configuration in force.
         /\ e.by = Owner
         /\ ~Closed(S) /\ S.rule = "pending" /\ BaselineSettled(S)
         /\ (e.result = "met" => Cardinality(UsableBaseline(S)) >= Floor)
    [] e.type = "attempt-started" ->
         \* Plan order, one at a time. Unresolved cleanup blocks the next attempt. Instrumented
         \* waits on baseline's rule. A visit needs a met control for the configuration in
         \* force, or the exception the owner recorded for it.
         /\ e.by = Owner /\ e.slot \in Slots
         /\ ~Closed(S) /\ S.frozen
         /\ Running(S) = {}
         /\ IsNext(S, e.slot)
         /\ Unresolved(S) = {}
         /\ (ArmOf(e.slot) = "instrumented" /\ BothArms => S.rule = "met")
         /\ (S.met \/ S.exception = e.slot)
    [] e.type = "attempt-start-retried" ->
         /\ e.slot \in Slots /\ e.by = Runner(e.slot)
         /\ S.att[e.slot].phase = "starting" /\ S.att[e.slot].retries < MaxStartRetries
    [] e.type = "capture-began" ->
         e.slot \in Slots /\ e.by = Runner(e.slot) /\ S.att[e.slot].phase = "starting"
    [] e.type = "capture-finished" ->
         e.slot \in Slots /\ e.by = Runner(e.slot) /\ S.att[e.slot].phase = "capturing"
    [] e.type = "attempt-finished" ->
         e.slot \in Slots /\ e.by = Runner(e.slot) /\ e.outcome \in Reportable(S.att[e.slot].phase)
    [] e.type = "evidence-recorded" ->
         \* Only its refusal is used here, by the authority probes: no evidence id is modeled.
         e.slot \in Slots /\ e.by = Runner(e.slot) /\ S.att[e.slot].phase \notin {"planned", "not_started"}
    [] e.type = "attempt-deadline" ->
         e.by = Owner /\ e.slot \in Slots /\ S.att[e.slot].phase \in RunningPhases
    [] e.type \in {"case-deadline", "case-cancelled"} ->
         \* A supervisor's event closes an open case, whatever cleanup is doing.
         e.by = Owner /\ ~Closed(S)
    [] e.type = "reconcile" ->
         \* A running attempt has no runner left; with none running, pending cleanup has gone
         \* unanswered.
         e.by = Owner /\ (Running(S) # {} \/ PendingCleanup(S) # {})
    [] e.type \in CleanupTypes ->
         \* The owner's, or that attempt's own runner's, once the attempt began and stopped
         \* running. Confirmed and destroyed are settled; unconfirmed can still be resolved.
         /\ e.slot \in Slots /\ e.by \in {Owner, Runner(e.slot)}
         /\ S.att[e.slot].phase \notin RunningPhases
         /\ \/ S.att[e.slot].cleanup = "pending"
            \/ S.att[e.slot].cleanup = "unconfirmed" /\ e.type # "cleanup-unconfirmed"
    [] e.type \in PurgeTypes ->
         e.by = Owner /\ PurgeRule(Closed(S), S.purge, e).ok
    [] OTHER -> FALSE

(* What only steers the next visit is cleared when the case closes. *)
ClearGate(S) == [S EXCEPT !.met = FALSE, !.misses = 0, !.exception = NoSlot]

(* Close now, whatever cleanup is doing: the running attempt takes this    *)
(* outcome, and every slot still waiting never begins, and carries the     *)
(* configuration in force.                                                 *)
CloseNow(S, outcome, why) ==
  [ClearGate(S) EXCEPT
     !.closedBy = why,
     !.att = [s \in Slots |->
                IF S.att[s].phase \in RunningPhases THEN [S.att[s] EXCEPT !.phase = outcome, !.retries = 0]
                ELSE IF S.att[s].phase = "planned" THEN [S.att[s] EXCEPT !.phase = "not_started", !.ranUnder = S.config]
                ELSE S.att[s]]]

(* Ending the last attempt still planned or running closes the case, as    *)
(* completed.                                                              *)
CloseIfDone(S) == IF ~Closed(S) /\ AllSettled(S) THEN [ClearGate(S) EXCEPT !.closedBy = "completed"] ELSE S

Ended(S, s, outcome) == CloseIfDone([S EXCEPT !.att[s].phase = outcome, !.att[s].retries = 0])

(* The state an accepted event leaves. *)
After(S, e) ==
  CASE e.type = "plan-frozen" -> [S EXCEPT !.frozen = TRUE]
    [] e.type = "control-recorded" ->
         IF e.configuration = S.config /\ e.result = "met"
         THEN [S EXCEPT !.met = TRUE, !.misses = 0]
         ELSE [S EXCEPT !.misses = @ + 1]
    [] e.type = "configuration-changed" ->
         \* A new configuration needs its own control and its own exception.
         [ClearGate(S) EXCEPT !.config = e.configuration, !.changes = @ + 1]
    [] e.type = "exception-recorded" -> [S EXCEPT !.exception = e.slot, !.exploratory = TRUE]
    [] e.type = "baseline-rule-recorded" ->
         IF e.result = "met" THEN [S EXCEPT !.rule = "met", !.ruleMetUnder = S.config]
         ELSE CloseNow([S EXCEPT !.rule = "not_met"], "failed", "baseline_not_met")
    [] e.type = "attempt-started" ->
         [S EXCEPT !.att[e.slot].phase = "starting", !.att[e.slot].cleanup = "pending", !.att[e.slot].ranUnder = S.config,
                   !.exception = IF @ = e.slot THEN NoSlot ELSE @]
    [] e.type = "attempt-start-retried" -> [S EXCEPT !.att[e.slot].retries = @ + 1]
    [] e.type = "capture-began" -> [S EXCEPT !.att[e.slot].phase = "capturing", !.att[e.slot].retries = 0]
    [] e.type = "capture-finished" -> [S EXCEPT !.att[e.slot].phase = "finalizing"]
    [] e.type = "attempt-finished" -> Ended(S, e.slot, e.outcome)
    [] e.type = "attempt-deadline" -> Ended(S, e.slot, "timed_out")
    [] e.type = "case-deadline" -> CloseNow(S, "timed_out", "deadline")
    [] e.type = "case-cancelled" -> CloseNow(S, "cancelled", "cancelled")
    [] e.type = "reconcile" ->
         IF Running(S) # {}
         THEN LET r == CHOOSE r \in Running(S) : TRUE
              IN CloseIfDone([S EXCEPT !.att[r].phase = "failed", !.att[r].cleanup = "unconfirmed", !.att[r].retries = 0])
         ELSE [S EXCEPT !.att = [s \in Slots |-> IF S.att[s].cleanup = "pending" THEN [S.att[s] EXCEPT !.cleanup = "unconfirmed"] ELSE S.att[s]]]
    [] e.type = "cleanup-confirmed" -> [S EXCEPT !.att[e.slot].cleanup = "confirmed"]
    [] e.type = "cleanup-unconfirmed" -> [S EXCEPT !.att[e.slot].cleanup = "unconfirmed"]
    [] e.type = "environment-destroyed" -> [S EXCEPT !.att[e.slot].cleanup = "environment_destroyed"]
    [] e.type \in PurgeTypes -> [S EXCEPT !.purge = PurgeRule(Closed(S), S.purge, e).manifest]
    [] OTHER -> S

----------------------------------------------------------------------------
(* The alphabet: each event the rules name, from the actor its rule names. *)
(* Evidence records and purge events are left out of the walk.             *)

Ev(type, by) == [type |-> type, by |-> by]
SlotEv(type, slot, by) == [type |-> type, slot |-> slot, by |-> by]
Control(configuration, result) == [type |-> "control-recorded", configuration |-> configuration, result |-> result, by |-> ControlRun]
Finished(slot, outcome) == [type |-> "attempt-finished", slot |-> slot, outcome |-> outcome, by |-> Runner(slot)]

CaseDeadline == Ev("case-deadline", Owner)
Reconcile == Ev("reconcile", Owner)

GlobalEvents ==
  << Ev("plan-frozen", Owner),
     [type |-> "configuration-changed", configuration |-> "alder", by |-> Owner],
     [type |-> "configuration-changed", configuration |-> "birch", by |-> Owner],
     [type |-> "baseline-rule-recorded", result |-> "met", by |-> Owner],
     [type |-> "baseline-rule-recorded", result |-> "not_met", by |-> Owner],
     CaseDeadline,
     Ev("case-cancelled", Owner),
     Reconcile,
     Control("alder", "met"), Control("alder", "not_met"), Control("alder", "not_evaluated"),
     Control("birch", "met"), Control("birch", "not_met"), Control("birch", "not_evaluated") >>

SlotEvents(s) ==
  << SlotEv("exception-recorded", s, Owner),
     SlotEv("attempt-started", s, Owner),
     SlotEv("attempt-start-retried", s, Runner(s)),
     SlotEv("capture-began", s, Runner(s)),
     SlotEv("capture-finished", s, Runner(s)),
     SlotEv("attempt-deadline", s, Owner),
     SlotEv("cleanup-confirmed", s, Owner),
     SlotEv("cleanup-unconfirmed", s, Owner),
     SlotEv("environment-destroyed", s, Owner),
     Finished(s, "usable"), Finished(s, "walled"), Finished(s, "failed"), Finished(s, "incomplete") >>

Alphabet ==
  LET upTo[n \in 0..Len(Plan)] == IF n = 0 THEN GlobalEvents ELSE upTo[n - 1] \o SlotEvents(Plan[n])
  IN upTo[Len(Plan)]

(* The events the state accepts, by their place in the alphabet. Next reads *)
(* this set, so TLC generates one successor for each accepted event, and    *)
(* the count of states it generates is the count of accepted events plus    *)
(* the first state.                                                         *)
Out == {i \in DOMAIN Alphabet : Accepts(c, Alphabet[i])}

Init == c = Planned
Next == \E i \in Out : c' = After(c, Alphabet[i])
Spec == Init /\ [][Next]_c

----------------------------------------------------------------------------
(* Views the rules define over a state. *)

CountIn(S, phases) == Cardinality({s \in Slots : S.att[s].phase \in phases})

(* Planned equals running plus every outcome plus not started. notStarted  *)
(* counts every slot where no visit began; waiting is the part that could. *)
Denominator(S) ==
  [planned |-> Cardinality(Slots), running |-> CountIn(S, RunningPhases),
   notStarted |-> CountIn(S, {"planned", "not_started"}), waiting |-> CountIn(S, {"planned"}),
   usable |-> CountIn(S, {"usable"}), walled |-> CountIn(S, {"walled"}), failed |-> CountIn(S, {"failed"}),
   incomplete |-> CountIn(S, {"incomplete"}), timed_out |-> CountIn(S, {"timed_out"}), cancelled |-> CountIn(S, {"cancelled"})]

(* Closed, with no cleanup still waiting on anyone. *)
Terminal(S) == Closed(S) /\ PendingCleanup(S) = {}

(* May another attempt begin, as far as cleanup goes. *)
Continuation(S) ==
  IF Closed(S) THEN [kind |-> "not_applicable", slots |-> {}]
  ELSE IF Unresolved(S) # {} THEN [kind |-> "blocked", slots |-> Unresolved(S)]
  ELSE [kind |-> "allowed", slots |-> {}]

----------------------------------------------------------------------------
(* Properties. Each is named for the sentence of register row F5-M it      *)
(* states; specs/case-machine/README.md holds the table. A property over   *)
(* transitions is written as an invariant over the state the transition    *)
(* leaves from: it reads every event the state accepts and the state that  *)
(* event leaves, so TLC holds it on every transition out of every state    *)
(* it reaches, and the event is in hand.                                   *)

EachStep(P(_, _, _)) == \A i \in Out : P(c, Alphabet[i], After(c, Alphabet[i]))
Begins(S, T, s) == S.att[s].phase = "planned" /\ T.att[s].phase \notin {"planned", "not_started"}
Closes(S, T) == ~Closed(S) /\ Closed(T)

\* "every state the walk reaches lies inside the domain its key encodes"
Domain ==
  /\ c.frozen \in BOOLEAN /\ c.config \in Configurations /\ c.changes \in 0..MaxConfigurationChanges
  /\ c.met \in BOOLEAN /\ c.misses \in 0..MaxControlMisses
  /\ c.exception \in Slots \cup {NoSlot} /\ c.exploratory \in BOOLEAN
  /\ c.rule \in Rules /\ c.closedBy \in Closures
  /\ c.att \in [Slots -> AttemptStates]
  /\ c.purge = NoManifest
  /\ c.ruleMetUnder \in Configurations \cup {NoConfiguration}
  /\ DOMAIN c = {"frozen", "config", "changes", "met", "misses", "exception", "exploratory", "rule", "closedBy", "att", "purge", "ruleMetUnder"}

\* "retry counters are what the accepted events count, and stay within their caps"
CapsState ==
  /\ c.misses <= MaxControlMisses /\ c.changes <= MaxConfigurationChanges
  /\ \A s \in Slots : c.att[s].retries <= MaxStartRetries /\ (c.att[s].retries > 0 => c.att[s].phase = "starting")
CapsStepOf(S, e, T) ==
  /\ T.changes = S.changes + (IF e.type = "configuration-changed" THEN 1 ELSE 0)
  /\ IF e.type = "control-recorded"
     THEN T.misses = (IF e.configuration = S.config /\ e.result = "met" THEN 0 ELSE S.misses + 1)
     ELSE T.misses = (IF e.type = "configuration-changed" \/ Closes(S, T) THEN 0 ELSE S.misses)
  /\ \A s \in Slots :
       IF e.type = "attempt-start-retried" /\ e.slot = s THEN T.att[s].retries = S.att[s].retries + 1
       ELSE T.att[s].retries = (IF T.att[s].phase = "starting" THEN S.att[s].retries ELSE 0)
CapsStep == EachStep(CapsStepOf)

\* "the gate and the rule hold what the accepted events made them, and a closed case keeps no gate"
GateState == Closed(c) => ~c.met /\ c.misses = 0 /\ c.exception = NoSlot
GateStepOf(S, e, T) ==
  /\ T.config = (IF e.type = "configuration-changed" THEN e.configuration ELSE S.config)
  /\ T.met = (IF e.type = "control-recorded" THEN e.configuration = S.config /\ e.result = "met"
              ELSE S.met /\ e.type # "configuration-changed" /\ ~Closes(S, T))
  /\ T.exception = (IF e.type = "exception-recorded" THEN e.slot
                    ELSE IF e.type = "configuration-changed" \/ Closes(S, T) \/ (e.type = "attempt-started" /\ S.exception = e.slot) THEN NoSlot
                    ELSE S.exception)
  /\ T.rule = (IF e.type = "baseline-rule-recorded" THEN e.result ELSE S.rule)
  /\ T.frozen = (S.frozen \/ e.type = "plan-frozen")
GateStep == EachStep(GateStepOf)

\* "a case is closed exactly when no slot is planned or running, and a slot closed unstarted carries the configuration in force"
ClosedExactly ==
  /\ Closed(c) <=> AllSettled(c)
  /\ \A s \in Slots : c.att[s].phase = "not_started" => c.att[s].ranUnder = c.config

\* "a closed case never reopens: its closure never changes, and nothing but cleanup changes after it"
SameButCleanup(S, T) == [T EXCEPT !.att = [s \in Slots |-> [T.att[s] EXCEPT !.cleanup = S.att[s].cleanup]]] = S
ClosedStaysOf(S, e, T) == Closed(S) => T.closedBy = S.closedBy /\ SameButCleanup(S, T)
ClosedStays == EachStep(ClosedStaysOf)

\* "the baseline rule, once recorded, never changes"
RuleFixedOf(S, e, T) == RuleRecorded(S) => T.rule = S.rule
RuleFixed == EachStep(RuleFixedOf)

\* "cleanup changes only by the events that name it, and reconcile reads what it states"
CleanupState ==
  \A s \in Slots : (c.att[s].phase \in RunningPhases => c.att[s].cleanup = "pending")
                /\ (c.att[s].phase = "planned" => c.att[s].cleanup = "none")
CleanupStepOf(S, e, T) ==
  /\ \A s \in Slots :
       T.att[s].cleanup # S.att[s].cleanup =>
         \/ T.att[s].cleanup = "pending" /\ S.att[s].cleanup = "none" /\ e.type = "attempt-started" /\ e.slot = s
         \/ T.att[s].cleanup = "confirmed" /\ e.type = "cleanup-confirmed" /\ e.slot = s
         \/ T.att[s].cleanup = "environment_destroyed" /\ e.type = "environment-destroyed" /\ e.slot = s
         \/ T.att[s].cleanup = "unconfirmed" /\ (e.type = "reconcile" \/ (e.type = "cleanup-unconfirmed" /\ e.slot = s))
  /\ e.type = "reconcile" =>
       IF Running(S) # {}
       THEN \A r \in Running(S) : T.att[r].phase = "failed" /\ T.att[r].cleanup = "unconfirmed"
       ELSE \A s \in Slots : S.att[s].cleanup = "pending" => T.att[s].cleanup = "unconfirmed"
CleanupStep == EachStep(CleanupStepOf)

\* "a begun attempt ran under the configuration in force when it began, and that never changes"
RanUnderOf(S, e, T) ==
  \A s \in Slots : /\ S.att[s].phase # "planned" => T.att[s].ranUnder = S.att[s].ranUnder
                   /\ Begins(S, T, s) => T.att[s].ranUnder = S.config
RanUnder == EachStep(RanUnderOf)

\* "denominatorOf agrees with the phases": the view is defined above from the rule; what TLC holds
\* is the rule's equation. That the code's denominatorOf gives this view is held by conformance.
DenominatorAdds ==
  LET d == Denominator(c)
  IN /\ d.planned = d.running + d.notStarted + d.usable + d.walled + d.failed + d.incomplete + d.timed_out + d.cancelled
     /\ d.planned = Len(Plan) /\ d.waiting <= d.notStarted

\* "isTerminal agrees with closed and no cleanup pending": the view is the rule's own words, so
\* TLC holds only what it implies here: a terminal state accepts nothing but a cleanup event.
TerminalIsQuiet == Terminal(c) => \A i \in Out : Alphabet[i].type \in CleanupTypes

\* "continuationOf agrees with an open case and its unresolved cleanup": the view is the rule's own
\* words; TLC holds that a blocked continuation starts no visit and an allowed one hides no cleanup.
ContinuationReads ==
  /\ Continuation(c).kind = "blocked" => \A i \in Out : Alphabet[i].type # "attempt-started"
  /\ Continuation(c).kind = "allowed" => ~Closed(c) /\ Unresolved(c) = {}
  /\ Continuation(c).kind = "not_applicable" <=> Closed(c)

\* "at most one attempt runs"
OneRuns == Cardinality(Running(c)) <= 1

\* "an arm never changes"
ArmState == \A s \in Slots : c.att[s].arm = ArmOf(s)
ArmStepOf(S, e, T) == \A s \in Slots : T.att[s].arm = S.att[s].arm
ArmStep == EachStep(ArmStepOf)

\* "instrumented waits on baseline's rule, and begins under the configuration it was met under"
WaitsOf(S, e, T) ==
  /\ \A s \in InstrumentedSlots : Begins(S, T, s) /\ BothArms => S.rule = "met" /\ T.att[s].ranUnder = S.ruleMetUnder
  /\ e.type = "baseline-rule-recorded" =>
       /\ BaselineSettled(S)
       /\ e.result = "met" => Cardinality({s \in BaselineSlots : S.att[s].phase = "usable" /\ S.att[s].ranUnder = S.config}) >= Floor
Waits == EachStep(WaitsOf)

\* "a terminal attempt never reopens"
TerminalStaysOf(S, e, T) == \A s \in Slots : S.att[s].phase \in SettledPhases => T.att[s].phase = S.att[s].phase
TerminalStays == EachStep(TerminalStaysOf)

\* "continuation blocks on unresolved cleanup"
BlocksOf(S, e, T) == \A s \in Slots : Begins(S, T, s) => Unresolved(S) = {}
Blocks == EachStep(BlocksOf)

\* "unresolved cleanup changes no acquisition": a cleanup event moves no phase and no closure, and
\* the same state with every unresolved cleanup resolved answers every other event the same way,
\* cleanup aside. A start and a reconcile are the two events cleanup may steer.
AcquisitionStepOf(S, e, T) ==
  e.type \in CleanupTypes => T.closedBy = S.closedBy /\ \A s \in Slots : T.att[s].phase = S.att[s].phase
MaskCleanup(S) == [S EXCEPT !.att = [s \in Slots |-> [S.att[s] EXCEPT !.cleanup = "none"]]]
Resolved(S) == [S EXCEPT !.att = [s \in Slots |-> IF S.att[s].cleanup \in UnresolvedCleanups THEN [S.att[s] EXCEPT !.cleanup = "confirmed"] ELSE S.att[s]]]
Acquisition ==
  /\ EachStep(AcquisitionStepOf)
  /\ Unresolved(c) # {} =>
       \A i \in DOMAIN Alphabet :
         Alphabet[i].type \notin CleanupTypes \cup {"attempt-started", "reconcile"} =>
           /\ Accepts(c, Alphabet[i]) = Accepts(Resolved(c), Alphabet[i])
           /\ Accepts(c, Alphabet[i]) => MaskCleanup(After(c, Alphabet[i])) = MaskCleanup(After(Resolved(c), Alphabet[i]))

\* "a purge answers as the restated reducer does on the closed flag and the manifest, and changes
\* nothing else, and nothing else reads the manifest". The reducer's rule is restated here by what
\* it must leave, apart from PurgeRule above.
SubSeqs(seq) == LET rec[n \in 0..Len(seq)] == IF n = 0 THEN {<<>>} ELSE rec[n - 1] \cup {Append(sub, seq[n]) : sub \in rec[n - 1]} IN rec[Len(seq)]
StatusAssignments(paths) == {[k \in DOMAIN paths |-> [path |-> paths[k], status |-> pick[k]]] : pick \in [DOMAIN paths -> PathStatuses]}
EveryManifest == UNION {{[recorded |-> TRUE, entries |-> entries] : entries \in StatusAssignments(paths)} : paths \in SubSeqs(PurgePaths)}
AllWith(status) == [recorded |-> TRUE, entries |-> [k \in DOMAIN PurgePaths |-> [path |-> PurgePaths[k], status |-> status]]]
Held == IF HeldManifests = "all" THEN EveryManifest ELSE {AllWith("present"), AllWith("absent")}
PurgeEvents ==
  {[type |-> "purge-manifest-recorded", paths |-> paths, by |-> Owner] : paths \in SubSeqs(PurgePaths) \cup {<<PurgePaths[1], PurgePaths[1]>>}}
  \cup {[type |-> type, path |-> path, by |-> Owner] : type \in {"purge-path-absent", "purge-path-remains"}, path \in {PurgePaths[k] : k \in DOMAIN PurgePaths} \cup {UnlistedPath}}
PurgeLeaves(closed, m, p, accepted, left) ==
  /\ accepted => closed
  /\ p.type = "purge-manifest-recorded" =>
       /\ accepted <=> closed /\ ~m.recorded /\ IsDistinct(p.paths)
       /\ accepted => left.recorded /\ Len(left.entries) = Len(p.paths)
                      /\ \A k \in DOMAIN p.paths : left.entries[k] = [path |-> p.paths[k], status |-> "present"]
  /\ p.type # "purge-manifest-recorded" =>
       /\ accepted <=> closed /\ m.recorded /\ \E k \in DOMAIN m.entries : m.entries[k].path = p.path /\ m.entries[k].status # StatusNamed(p.type)
       /\ accepted => left.recorded /\ Len(left.entries) = Len(m.entries)
                      /\ \A k \in DOMAIN m.entries :
                           /\ left.entries[k].path = m.entries[k].path
                           /\ left.entries[k].status = (IF m.entries[k].path = p.path THEN StatusNamed(p.type) ELSE m.entries[k].status)
PurgeSliceOn(m) ==
  LET H == [c EXCEPT !.purge = m]
  IN /\ \A p \in PurgeEvents :
          /\ PurgeLeaves(Closed(c), m, p, Accepts(H, p), IF Accepts(H, p) THEN After(H, p).purge ELSE m)
          /\ Accepts(H, p) => [After(H, p) EXCEPT !.purge = m] = H
     /\ \A i \in DOMAIN Alphabet :
          /\ Accepts(H, Alphabet[i]) = Accepts(c, Alphabet[i])
          /\ Accepts(c, Alphabet[i]) => After(H, Alphabet[i]) = [After(c, Alphabet[i]) EXCEPT !.purge = m]
PurgeSlice == PurgeSliceOn(NoManifest) /\ (Closed(c) => \A m \in Held : PurgeSliceOn(m))

\* "an event from an actor the rule does not allow is refused". Who may send each kind of event is
\* written here as a table, apart from the guards above, and every body is sent from every actor
\* the table does not allow.
Allowed(type, slot, by) ==
  CASE type = "control-recorded" -> by = ControlRun
    [] type \in OwnerOnlyTypes -> by = Owner
    [] type \in OwnRunnerTypes -> by = Runner(slot)
    [] type \in CleanupTypes -> by \in {Owner, Runner(slot)}
    [] OTHER -> FALSE
ProbeBodies ==
  {Alphabet[i] : i \in DOMAIN Alphabet}
  \cup {[type |-> "evidence-recorded", slot |-> s, by |-> Runner(s)] : s \in Slots}
  \cup {[type |-> "purge-manifest-recorded", paths |-> <<PurgePaths[1]>>, by |-> Owner],
        [type |-> "purge-path-absent", path |-> PurgePaths[1], by |-> Owner],
        [type |-> "purge-path-remains", path |-> PurgePaths[1], by |-> Owner]}
Probes == {[body EXCEPT !.by = actor] : body \in ProbeBodies, actor \in Actors}
Authority == \A probe \in Probes : ~Allowed(probe.type, SlotOf(probe), probe.by) => ~Accepts(c, probe)

\* "the actors a rule allows get the same answer": a cleanup event from the owner and from the
\* attempt's own runner. Refusal reasons are not modeled, so their equality is not stated here.
Interchangeable ==
  \A i \in DOMAIN Alphabet :
    Alphabet[i].type \in CleanupTypes =>
      LET fromRunner == [Alphabet[i] EXCEPT !.by = Runner(Alphabet[i].slot)]
      IN /\ Accepts(c, fromRunner) = Accepts(c, Alphabet[i])
         /\ Accepts(c, fromRunner) => After(c, fromRunner) = After(c, Alphabet[i])

\* "a visit begins only on a met control for the configuration in force, or on the owner's exception for it"
ControlOf(S, e, T) == \A s \in Slots : Begins(S, T, s) => S.met \/ S.exception = s
ControlGate == EachStep(ControlOf)

\* "an exception is recorded only for a visit that has not begun"
ExceptionFirstOf(S, e, T) == e.type = "exception-recorded" => S.att[e.slot].phase = "planned"
ExceptionFirst == EachStep(ExceptionFirstOf)

\* "the exploratory mark is on exactly when an exception was recorded": it starts off, an exception
\* turns it on, and nothing else moves it.
MarkOf(S, e, T) == T.exploratory = (S.exploratory \/ e.type = "exception-recorded")
Mark == EachStep(MarkOf)

\* "without the purge slice, no event returns to a state": every accepted event raises this
\* measure, so no sequence of them returns to a state.
PhaseRank(phase) == CASE phase = "planned" -> 0 [] phase = "starting" -> 1 [] phase = "capturing" -> 2 [] phase = "finalizing" -> 3 [] OTHER -> 4
CleanupRank(cleanup) == CASE cleanup = "none" -> 0 [] cleanup = "pending" -> 1 [] cleanup = "unconfirmed" -> 2 [] OTHER -> 3
SumOver(S, f(_)) == LET rec[n \in 0..Len(Plan)] == IF n = 0 THEN 0 ELSE rec[n - 1] + f(S.att[Plan[n]]) IN rec[Len(Plan)]
AttemptMeasure(a) == 10 * PhaseRank(a.phase) + a.retries + CleanupRank(a.cleanup)
Measure(S) ==
  5 * S.changes + (IF S.frozen THEN 1 ELSE 0) + (IF RuleRecorded(S) THEN 1 ELSE 0)
  + (IF S.met THEN 3 ELSE 0) + S.misses + (IF S.exception # NoSlot THEN 1 ELSE 0)
  + SumOver(S, AttemptMeasure)
AcyclicOf(S, e, T) == Measure(T) > Measure(S)
Acyclic == EachStep(AcyclicOf)

\* "every sink is terminal"
Sinks == Out = {} => Terminal(c)

\* "a supervisor's event is accepted from every non-terminal state"
Supervisor == ~Terminal(c) => Accepts(c, CaseDeadline) \/ Accepts(c, Reconcile)

=============================================================================
