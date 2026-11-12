-------------------------- MODULE WorkerHoldExport --------------------------
(***************************************************************************)
(* Prints the module's whole graph for a world, with nothing assumed: each *)
(* state TLC reaches, and each move from it with its label, the switches   *)
(* that forbid it and the state it leaves; and, at the end of a readout,   *)
(* what each worker landed as. scripts/tla-worker-hold-export.mjs runs TLC *)
(* on this module with one worker, so that a state's lines come together,  *)
(* and folds them into the digest the conformance suite compares with the  *)
(* hand-written model's. Nothing here is a property: StateLines is listed  *)
(* as an invariant only so that TLC evaluates it once on each state.       *)
(***************************************************************************)
EXTENDS WorkerHold, TLC

Bit(b) == IF b THEN 1 ELSE 0

(* A state as one value TLC always prints the same way. A record prints its  *)
(* fields in the order it was built in, so the same state can print two     *)
(* ways; a tuple of its fields in a stated order cannot.                    *)
Listed(seq, Item(_)) == [i \in 1..Len(seq) |-> Item(seq[i])]
Same(x) == x
EventCode(ev) == <<ev.e, ev.before>>
ReportCode(report) == <<report.item, report.w, report.before, report.earlier>>
WorkerCode(k) ==
  << k.phase, k.waiting, k.dbg, k.bp, k.obs, k.ran, k.ranu, k.other, k.eval, k.attach, k.detach, k.seq, k.pausedAgain,
     k.ranF, k.ranuF, k.seqF,
     k.hold, k.gone, k.ack, k.early, k.probe, k.conc, k.scripts, k.awaitOff,
     k.known, k.mhold, k.det, k.dwp, k.unreached, k.quick, k.install, k.lost, k.mseq, k.mword, k.mclosed, k.broken, k.disc,
     k.form.st, k.form.why, k.answered, k.freezeSeq, k.snapshot, k.barrier,
     Listed(k.commands, Same), Listed(k.events, EventCode) >>
LandedCode(l) == <<l.heard, l.term, l.readSeq, l.ranAtFreeze, l.ranUnobservedAtFreeze, l.ranUnobserved, l.attacherLives, l.realmAtFreeze>>
Code(S) ==
  << S.gphase, S.ended, S.glost, Listed(S.port, ReportCode),
     [i \in 1..WorkerCount |-> WorkerCode(S.wk[i - 1])],
     IF S.gphase = "done" THEN [i \in 1..WorkerCount |-> LandedCode(S.landed[i - 1])] ELSE <<>> >>

StateLines ==
  /\ PrintT(ToString(<<"S", Code(st)>>))
  /\ \A move \in EveryMove(st) :
       /\ PrintT(ToString(<<"L", move.label, move.blocked>>))
       /\ PrintT(ToString(<<"N", Code(move.next)>>))
  /\ st.gphase = "done" =>
       \A w \in W :
         LET l == st.landed[w]
         IN PrintT(ToString(<<"D", w, l.term, l.readSeq, Bit(l.ranAtFreeze), Bit(l.ranUnobservedAtFreeze), Bit(l.ranUnobserved), Bit(l.attacherLives), l.realmAtFreeze>>))

=============================================================================
