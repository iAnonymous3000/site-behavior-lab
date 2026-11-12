------------------------- MODULE CaseMachineExport -------------------------
(***************************************************************************)
(* Prints what the conformance suite compares the TypeScript with: the     *)
(* alphabet, and for each state TLC reaches its code, the views the rules  *)
(* define over it, and every event it accepts with the code of the state   *)
(* that event leaves; and each probe the authority table refuses.          *)
(* scripts/tla-case-machine-export.mjs runs TLC on this module and reads   *)
(* its lines. Nothing here is a property: StateLine is listed as an        *)
(* invariant only so that TLC evaluates it once on each distinct state,    *)
(* and it is true of every state.                                          *)
(*                                                                         *)
(* A code is the state as small numbers, by the orders below. The history  *)
(* field ruleMetUnder and the purge manifest, which the walk never moves,  *)
(* are left out of it.                                                     *)
(***************************************************************************)
EXTENDS CaseMachineMC, TLC

IndexIn(seq, value) == (CHOOSE i \in DOMAIN seq : seq[i] = value) - 1

SlotOrder == <<"none", "B1", "B2", "B3", "I1", "I2", "I3">>
ConfigurationOrder == <<"none", "alder", "birch">>
PhaseOrder == <<"planned", "starting", "capturing", "finalizing", "usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started">>
CleanupOrder == <<"none", "pending", "confirmed", "unconfirmed", "environment_destroyed">>
RuleOrder == <<"pending", "met", "not_met", "not_applicable">>
ClosureOrder == <<"none", "completed", "cancelled", "deadline", "baseline_not_met">>
ContinuationOrder == <<"allowed", "blocked", "not_applicable">>
Bit(b) == IF b THEN 1 ELSE 0

Code(S) ==
  << Bit(S.frozen), IndexIn(ConfigurationOrder, S.config), S.changes, Bit(S.met), S.misses,
     IndexIn(SlotOrder, S.exception), Bit(S.exploratory), IndexIn(RuleOrder, S.rule), IndexIn(ClosureOrder, S.closedBy) >>
  \o [n \in 1..(4 * Len(Plan)) |->
        LET a == S.att[Plan[((n - 1) \div 4) + 1]]
            field == (n - 1) % 4
        IN CASE field = 0 -> IndexIn(PhaseOrder, a.phase)
             [] field = 1 -> IndexIn(CleanupOrder, a.cleanup)
             [] field = 2 -> IndexIn(ConfigurationOrder, a.ranUnder)
             [] OTHER -> a.retries]

Views(S) ==
  LET d == Denominator(S)
  IN << d.planned, d.running, d.notStarted, d.waiting, d.usable, d.walled, d.failed, d.incomplete, d.timed_out, d.cancelled,
        Bit(Terminal(S)), IndexIn(ContinuationOrder, Continuation(S).kind) >>
     \o [n \in 1..Len(Plan) |-> Bit(Plan[n] \in Continuation(S).slots)]

StateLine ==
  PrintT(ToString(<< "S", Code(c), Views(c), {<<i, Code(After(c, Alphabet[i]))>> : i \in Out} >>))

ExportInit ==
  /\ Init
  /\ PrintT(ToString(<< "P", Plan, MaxControlMisses, MaxStartRetries, MaxConfigurationChanges >>))
  /\ \A i \in DOMAIN Alphabet : PrintT(ToString(<< "A", i, Alphabet[i] >>))
  /\ PrintT(ToString(<< "I", Code(Planned) >>))
  /\ \A probe \in Probes : Allowed(probe.type, SlotOf(probe), probe.by) \/ PrintT(ToString(<< "B", probe >>))

(* The purge reducer's answer on every pairing the slice reaches: open and *)
(* closed, no manifest and every manifest, every event of the slice. It    *)
(* takes a state it does not read, so that TLC evaluates it where          *)
(* PurgeInit names it and nowhere else.                                    *)
PurgeTable(S) ==
  \A closed \in BOOLEAN : \A m \in {NoManifest} \cup EveryManifest : \A p \in PurgeEvents :
    PrintT(ToString(<< "U", Bit(closed), m, [x \in DOMAIN p \ {"by"} |-> p[x]], PurgeRule(closed, m, p), RetentionTier(m) >>))

PurgeInit == Init /\ PurgeTable(c)
Stutter == UNCHANGED c

=============================================================================
