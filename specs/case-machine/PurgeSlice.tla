----------------------------- MODULE PurgeSlice -----------------------------
(***************************************************************************)
(* The purge slice of register row F5-P, walked on its own: the machine's  *)
(* purge events from no manifest, on an open case and on a closed one.     *)
(* The open case is the planned state and the closed one is that state     *)
(* cancelled; the reducer reads only the closed flag and the manifest, so  *)
(* which closed case carries the manifest does not matter to it, and       *)
(* PurgeSlice in CaseMachine.tla holds that on every state of each plan.   *)
(***************************************************************************)
EXTENDS CaseMachineMC

SliceInit == c \in {Planned, After(Planned, Ev("case-cancelled", Owner))}
SliceNext == \E p \in {q \in PurgeEvents : Accepts(c, q)} : c' = After(c, p)

\* "purgeStep answers as the restated reducer does, accepting exactly when it does, with its
\* refusal and its manifest": the reducer's rule, restated by what it must leave, on every event of
\* the slice from the manifest held. Its refusals are compared with the code's by conformance.
SliceAnswers ==
  \A p \in PurgeEvents :
    /\ PurgeLeaves(Closed(c), c.purge, p, Accepts(c, p), IF Accepts(c, p) THEN After(c, p).purge ELSE c.purge)
    /\ Accepts(c, p) => [After(c, p) EXCEPT !.purge = c.purge] = c
    /\ ~Accepts(c, p) => PurgeRule(Closed(c), c.purge, p).refusal \in
         {"case-open", "manifest-already-recorded", "manifest-malformed", "no-such-path", "path-status-unchanged"}

\* "SUMMARY_ONLY holds exactly when a manifest exists and every path on it reads absent"
SummaryOnlyExactly ==
  RetentionTier(c.purge) = "SUMMARY_ONLY" <=>
    c.purge.recorded /\ ~\E k \in DOMAIN c.purge.entries : c.purge.entries[k].status \in {"present", "remains"}

\* Only a closed case holds a manifest, and a manifest lists distinct paths of the slice.
SliceDomain ==
  /\ c.purge.recorded => Closed(c)
  /\ c.purge = NoManifest \/ c.purge \in EveryManifest
  /\ [c EXCEPT !.purge = NoManifest] \in {Planned, After(Planned, Ev("case-cancelled", Owner))}

=============================================================================
