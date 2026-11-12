-------------------------- MODULE WorkerHoldTable --------------------------
(***************************************************************************)
(* The axiom table in one search. Each switch only removes transitions, so *)
(* a path is open under a set of switches exactly when it takes no         *)
(* transition a switch of the set forbids. This module walks every move,   *)
(* with nothing assumed, and carries along the switches the path so far    *)
(* has broken (used). A row then fails under a set of switches exactly     *)
(* when some state breaks it with no switch of the set among those used.   *)
(* TLC reaches every pair of a state and the switches a path to it broke,  *)
(* and TableLines prints each broken row with them;                        *)
(* scripts/tla-worker-hold-export.mjs keeps the smallest.                  *)
(*                                                                         *)
(* It also carries the named trace of register row F4-BEYOND: a worker     *)
(* that ran with no observer before the freeze, which the mirror does not  *)
(* yet call late, by how the freeze found it and where the word that would *)
(* say so is, on the step that ends the readout and excludes it.           *)
(***************************************************************************)
EXTENDS WorkerHold, TLC

VARIABLES used, named

Rows == {"excluded-implies-no-page-code-before-the-freeze",
         "excluded-implies-no-unobserved-page-code-before-the-freeze",
         "read-implies-the-observer-preceded-every-statement",
         "a-read-state-is-no-older-than-the-freeze",
         "every-worker-the-readout-heard-of-lands-in-one-term",
         "a-worker-that-ran-before-the-freeze-lands-in-a-term"}

Holds(row) ==
  CASE row = "excluded-implies-no-page-code-before-the-freeze" -> ExcludedRanNothing
    [] row = "excluded-implies-no-unobserved-page-code-before-the-freeze" -> ExcludedRanNothingUnobserved
    [] row = "read-implies-the-observer-preceded-every-statement" -> ReadHadItsObserver
    [] row = "a-read-state-is-no-older-than-the-freeze" -> ReadNoOlderThanTheFreeze
    [] row = "every-worker-the-readout-heard-of-lands-in-one-term" -> HeardLandsInOneTerm
    [] row = "a-worker-that-ran-before-the-freeze-lands-in-a-term" -> RanLandsInATerm

(* How the freeze found the first worker, when it is the named trace's:    *)
(* held, reaching, or not yet heard of, which the drain's second pass      *)
(* reads. The empty string when it is not.                                 *)
NamedForm(S) ==
  LET k == S.wk[0]
  IN IF S.gphase \notin {"draining", "waiting-trees"} \/ ~k.ranuF \/ k.det \/ S.glost \/ k.mhold = "late" THEN ""
     ELSE CASE k.form.st = "held" -> "held" [] k.form.st = "reaching" -> "reaching" [] k.form.st = "none" -> "second-pass" [] OTHER -> ""

(* Where the word that would call it late is. *)
NamedCause(S) ==
  LET k == S.wk[0]
      lates == {i \in DOMAIN S.port : S.port[i].item = "late"}
  IN IF lates # {}
     THEN (IF S.port[CHOOSE i \in lates : \A j \in lates : i <= j].before THEN "late-posted-before-the-freeze" ELSE "late-posted-after-the-freeze")
     ELSE IF \E i \in DOMAIN k.events : k.events[i].e = "resumed" THEN "resume-still-on-the-socket"
     ELSE IF \E i \in DOMAIN S.port : S.port[i].item = "lost" THEN "connection-lost-on-the-port"
     ELSE IF k.conc THEN "thread-concluded-first"
     ELSE "no-word-on-its-way"

TableInit == Init /\ used = {} /\ named = <<>>

TableNext ==
  \E move \in EveryMove(st) :
    /\ st' = move.next
    /\ used' = used \cup move.blocked
    /\ named' = IF move.next.gphase = "done" /\ NamedForm(st) # "" /\ move.next.landed[0].term = "pausedAtReadout"
                THEN <<NamedForm(st), NamedCause(st)>> ELSE <<>>

(* True of every state. Listed as an invariant so that TLC evaluates it    *)
(* once on each pair it reaches.                                           *)
TableLines ==
  st.gphase = "done" =>
    /\ \A row \in Rows : Holds(row) \/ PrintT(ToString(<<"V", row, used>>))
    /\ named = <<>> \/ PrintT(ToString(<<"T", named[1], named[2], used>>))

=============================================================================
