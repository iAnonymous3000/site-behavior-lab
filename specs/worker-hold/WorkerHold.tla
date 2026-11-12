----------------------------- MODULE WorkerHold -----------------------------
(***************************************************************************)
(* The shared-worker hold and the readout over it: the browser and the     *)
(* worker, the attacher's thread, the mirror over its port, and the drain  *)
(* and the readout, with each assumption about the environment a switch    *)
(* that only removes transitions.                                          *)
(*                                                                         *)
(* It is a second statement of what lib/fv-worker-model.ts states by hand, *)
(* in another language and checked by another tool. It is not independent  *)
(* of that model in three ways, and says so here:                          *)
(*  - The worlds are the model's. Which steps a world walks, how often a   *)
(*    worker may pause again, which words are dropped once the thread      *)
(*    would make nothing of them, and which steps a reduced world runs     *)
(*    together are bounds of the hand-written model, and this module       *)
(*    takes them as its own so that the two can be compared step for step. *)
(*  - The step names are the model's, so that a trace of this module can   *)
(*    be replayed through the real code by the model's own replay.         *)
(*  - The readout's classification is restated here from the docblocks of  *)
(*    lib/worker-fingerprint-realm.ts. The hand-written model calls the    *)
(*    real kernels instead.                                                *)
(* What it leaves out: the direction row (where @12 lands a worker apart   *)
(* from @11), which rests on a restated old rule; and the dedicated world. *)
(*                                                                         *)
(* What TLC establishes is bounded: each property holds, or fails, over    *)
(* every state this module reaches in the world a configuration names,     *)
(* under the switches that configuration assumes. No switch is a fact of   *)
(* a browser.                                                              *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  WorkerCount,       \* 1 or 2
  CollapseSessions,  \* a session's own steps run together, where their order is not the question
  Stream,            \* the realm's stream past its first snapshot, and the barrier's every hop
  StartReleased,     \* the world starts with its worker released, its observer in, and the mirror current
  Reduced,           \* no overtaking, no worker running at its attach, no failed install, no thread bound or death
  Assumed            \* the switches assumed, a subset of Switches

(* A1 to A5 of the plan, with A5 in halves and A3 as its negation; then    *)
(* the three that are not axioms of the plan.                              *)
PlanAxioms == {"A1", "A2", "notA3", "A4", "A5fifo", "A5bound"}
Switches == PlanAxioms \cup {"C1", "D1", "Z"}
ASSUME Assumed \subseteq Switches /\ WorkerCount \in {1, 2}

W == 0..(WorkerCount - 1)
Id(w) == IF w = 0 THEN "0" ELSE "1"
Remove(seq, i) == [j \in 1..(Len(seq) - 1) |-> IF j < i THEN seq[j] ELSE seq[j + 1]]

----------------------------------------------------------------------------
(* The state. One record for each worker: the world's facts, what the      *)
(* attacher's thread holds, what the mirror and the installer's record     *)
(* hold, what the readout holds, and the session's two directions.         *)

NoForm == [st |-> "none", why |-> ""]
Blank ==
  [ \* The world. ran and ranu move only when the worker runs.
    phase |-> "not-born", waiting |-> FALSE, dbg |-> FALSE, bp |-> FALSE, obs |-> FALSE, ran |-> FALSE, ranu |-> FALSE,
    other |-> FALSE, eval |-> FALSE, attach |-> "none", detach |-> "none", seq |-> 0, pausedAgain |-> FALSE,
    \* The world at the freeze.
    ranF |-> FALSE, ranuF |-> FALSE, seqF |-> 0,
    \* The attacher's thread.
    hold |-> "none", gone |-> FALSE, ack |-> FALSE, early |-> FALSE, probe |-> FALSE, conc |-> FALSE, scripts |-> FALSE, awaitOff |-> FALSE,
    \* The mirror and the installer's record.
    known |-> FALSE, mhold |-> "none", det |-> FALSE, dwp |-> FALSE, unreached |-> FALSE, quick |-> FALSE, install |-> "none",
    lost |-> FALSE, mseq |-> 0, mword |-> "none", mclosed |-> 0, broken |-> FALSE, disc |-> FALSE,
    \* The readout: the form the freeze gave, and its slot. freezeSeq is one past the sequence, and 0 for none.
    form |-> NoForm, answered |-> FALSE, freezeSeq |-> 0, snapshot |-> 0, barrier |-> "none",
    \* The session: commands on their way to the worker, and its words on their way to the thread.
    commands |-> <<>>, events |-> <<>> ]

Released ==
  [Blank EXCEPT !.phase = "running", !.obs = TRUE, !.ran = TRUE, !.seq = 1, !.hold = "released", !.conc = TRUE, !.pausedAgain = TRUE,
                !.known = TRUE, !.mhold = "released", !.install = "installed", !.mseq = 1, !.mword = "closed", !.mclosed = 1]

First ==
  [gphase |-> "before", ended |-> FALSE, glost |-> FALSE, port |-> <<>>,
   wk |-> [w \in W |-> IF StartReleased /\ w = 0 THEN Released ELSE Blank],
   landed |-> <<>>]

PausedPhases == {"at-main", "paused"}
CompiledPhases == {"compiled", "running", "paused"}

----------------------------------------------------------------------------
(* What the thread posts and sends as it handles a word. X carries the     *)
(* state with what this step has posted to the port and sent so far.       *)

Emit(S, w, e) == [S EXCEPT !.wk[w].events = Append(@, [e |-> e, before |-> FALSE])]

Send(X, w, word) == IF X.s.ended THEN X ELSE [X EXCEPT !.sends = Append(@, <<Id(w), word>>)]

(* A command to a target that has gone reaches nothing. *)
Command(X, w, c) ==
  IF X.s.ended THEN X
  ELSE LET k == X.s.wk[w]
           sent == [X EXCEPT !.sends = Append(@, <<Id(w), IF c = "off" /\ k.ack THEN "off+remove" ELSE c>>)]
       IN IF k.phase = "gone" THEN sent ELSE [sent EXCEPT !.s.wk[w].commands = Append(@, c)]

Post(X, w, item, detail, earlier) ==
  IF X.s.ended THEN X
  ELSE [X EXCEPT !.posts = Append(@, <<Id(w), detail>>),
                 !.s.port = Append(@, [item |-> item, w |-> w, before |-> FALSE, earlier |-> earlier])]

(* The worker's page code runs from here on. *)
Run(k, gphase) == [k EXCEPT !.phase = "running", !.ran = IF gphase = "before" THEN TRUE ELSE @, !.ranu = IF k.obs THEN @ ELSE TRUE]

(* A release of any client: a start-up hold ends, or a pause ends, and the *)
(* session hears unless told not to.                                       *)
Release(S, w, heard) ==
  LET k == S.wk[w]
  IN IF k.phase = "start-held"
     THEN LET S1 == [S EXCEPT !.wk[w].phase = "compiled"] IN IF k.dbg THEN Emit(S1, w, "parsed") ELSE S1
     ELSE IF k.phase \in PausedPhases
     THEN LET S1 == [S EXCEPT !.wk[w] = Run(k, S.gphase)] IN IF heard THEN Emit(S1, w, "resumed") ELSE S1
     ELSE S

----------------------------------------------------------------------------
(* The attacher's thread. *)

MarkLate(X, w, detail, debuggerOn, earlier) ==
  IF X.s.wk[w].hold # "pending" THEN X
  ELSE LET posted == Post([X EXCEPT !.s.wk[w].hold = "late"], w, "late", detail, earlier)
       IN IF debuggerOn THEN Command(posted, w, "off") ELSE posted

(* An early parse is a script from before the breakpoint: once the         *)
(* breakpoint's answer is in, a probe asks whether the worker ran past it. *)
ProbeIfParsed(X, w) ==
  LET k == X.s.wk[w]
  IN IF k.hold # "pending" \/ ~k.early \/ ~k.ack \/ k.probe THEN X
     ELSE Command([X EXCEPT !.s.wk[w].probe = TRUE], w, "probe")

(* A hold broken before its install answered: the worker is late. *)
BreakHold(X, w, earlier) ==
  LET k == X.s.wk[w]
  IN IF k.hold # "held" \/ k.conc THEN X
     ELSE Command(Post([X EXCEPT !.s.wk[w].hold = "late"], w, "late", "late:resumed-while-held", earlier), w, "off")

(* The install concluded, by its answer or by the hold's bound: the thread *)
(* says how, and turns the debugger off, which lets the worker run.        *)
Conclude(X, w, outcome, earlier) ==
  LET k == X.s.wk[w]
  IN IF k.conc \/ k.hold # "held" THEN X
     ELSE Command(Post([X EXCEPT !.s.wk[w].conc = TRUE, !.s.wk[w].awaitOff = TRUE], w,
                       CASE outcome = "ok" -> "installed-ok" [] outcome = "bad" -> "installed-bad" [] OTHER -> "installed-none",
                       CASE outcome = "ok" -> "installed:ok" [] outcome = "bad" -> "installed:bad" [] OTHER -> "installed:none",
                       earlier), w, "off")

ThreadHears(X, w, e, earlier) ==
  LET k == X.s.wk[w]
      inMap == ~k.gone
  IN CASE e = "parsed" ->
            IF ~inMap THEN X
            ELSE LET X1 == [X EXCEPT !.s.wk[w].scripts = TRUE]
                 IN IF k.hold = "pending" /\ ~k.ack THEN ProbeIfParsed([X1 EXCEPT !.s.wk[w].early = TRUE], w) ELSE X1
       [] e \in {"ack", "ack-listed"} ->
            \* The breakpoint's answer, and behind it the question's: which scripts existed. A script it lists is
            \* one from before the breakpoint, whichever way that script's parse comes.
            LET X1 == ProbeIfParsed([X EXCEPT !.s.wk[w].ack = TRUE], w)
            IN IF inMap /\ k.hold = "pending"
               THEN LET X2 == Send(X1, w, "unask")
                    IN IF e = "ack-listed" THEN ProbeIfParsed([X2 EXCEPT !.s.wk[w].early = TRUE], w) ELSE X2
               ELSE X1
       [] e = "pause-main" ->
            IF ~inMap \/ k.hold # "pending" THEN X
            ELSE Command(Post([X EXCEPT !.s.wk[w].hold = "held"], w, "held", "held", earlier), w, "install")
       [] e = "pause-script" -> IF inMap THEN MarkLate(X, w, "late:other-script", TRUE, earlier) ELSE X
       [] e = "pause-statement" ->
            IF ~inMap THEN X
            ELSE IF k.hold = "held" THEN BreakHold(X, w, earlier) ELSE MarkLate(X, w, "late:other-pause", TRUE, earlier)
       [] e = "resumed" -> IF inMap THEN BreakHold(X, w, earlier) ELSE X
       [] e = "first" -> IF inMap THEN Post(X, w, "event-first", "event:first", earlier) ELSE X
       [] e = "open" -> IF inMap THEN Post(X, w, "event-open", "event:open", earlier) ELSE X
       [] e = "closed" -> IF inMap THEN Post(X, w, "event-closed", "event:closed", earlier) ELSE X
       [] e = "install-ok" -> Conclude(X, w, "ok", earlier)
       [] e = "install-bad" -> Conclude(X, w, "bad", earlier)
       [] e = "off-answer" ->
            IF k.awaitOff THEN Post([X EXCEPT !.s.wk[w].awaitOff = FALSE, !.s.wk[w].hold = "released"], w, "released", "released:on", earlier) ELSE X
       [] e = "probe-answer" -> MarkLate(X, w, "late:ran-before-breakpoint", TRUE, earlier)
       [] e = "barrier-answer" ->
            \* Past its bound the command is no longer waited for.
            IF k.barrier = "sent" THEN Post([X EXCEPT !.s.wk[w].barrier = "replied"], w, "reply-ok", "reply:ok", earlier) ELSE X

(* A worker running at its attach is late at once. One waiting is armed:   *)
(* the debugger, the breakpoint at its main script and the question behind *)
(* it, and then it is let run to that breakpoint.                          *)
ThreadHearsAttach(X, w, earlier) ==
  LET k == X.s.wk[w]
      X1 == Post([X EXCEPT !.s.wk[w].attach = "none", !.s.wk[w].hold = "pending"], w, "attached",
                 IF k.waiting THEN "attached:waiting" ELSE "attached:running", earlier)
  IN IF ~k.waiting THEN MarkLate(X1, w, "late:running-at-attach", FALSE, earlier)
     ELSE Command(Command(X1, w, "arm"), w, "run")

ThreadHearsDetach(X, w, lifetime, earlier) ==
  LET k == X.s.wk[w]
      X1 == [X EXCEPT !.s.wk[w].detach = "none", !.s.wk[w].gone = TRUE]
  IN IF k.hold = "held" /\ ~k.conc THEN Post(X1, w, "gone-held", "detached:held", earlier)
     ELSE IF k.hold = "held" THEN Post(X1, w, "gone-after-install", "detached:after-install", earlier)
     ELSE IF k.hold = "pending" /\ ~k.scripts /\ ~k.early
          THEN IF lifetime = "quick" THEN Post(X1, w, "gone-unreached-quick", "detached:unreached-quick", earlier)
               ELSE Post(X1, w, "gone-unreached-long", "detached:unreached-long", earlier)
     ELSE Post(X1, w, "gone-other", "detached:other", earlier)

----------------------------------------------------------------------------
(* The mirror and the installer's record, on the main thread. *)

(* A barrier's answer fixes the point the readout reads the stream at: the *)
(* last closed snapshot if the last word is closed, else the next one.     *)
AnswerBarrier(S, w) ==
  LET k == S.wk[w]
  IN IF k.form.st # "waiting" \/ k.answered THEN S
     ELSE IF k.mword = "closed" /\ k.mclosed # 0
          THEN [S EXCEPT !.wk[w].answered = TRUE, !.wk[w].snapshot = k.mclosed]
          ELSE [S EXCEPT !.wk[w].answered = TRUE, !.wk[w].freezeSeq = k.mseq + 1]

(* A word of the realm's stream. One out of sequence breaks the stream. *)
Receive(S, w, sequence, closed) ==
  LET k == S.wk[w]
  IN IF k.broken \/ k.lost THEN S
     ELSE IF sequence # k.mseq + 1 THEN [S EXCEPT !.wk[w].broken = TRUE]
     ELSE LET S1 == [S EXCEPT !.wk[w].mseq = sequence, !.wk[w].mword = IF closed THEN "closed" ELSE "open"]
          IN IF ~closed THEN S1
             ELSE LET S2 == [S1 EXCEPT !.wk[w].mclosed = sequence]
                  \* The drain's end takes each slot off its record, so an emission past it fills none.
                  IN IF S.gphase # "waiting-trees" /\ k.form.st = "waiting" /\ k.snapshot = 0 /\ k.freezeSeq # 0 /\ sequence > k.freezeSeq - 1
                     THEN [S2 EXCEPT !.wk[w].snapshot = sequence] ELSE S2

LoseChannel(S) ==
  LET marked == [S EXCEPT !.glost = TRUE, !.wk = [w \in W |-> IF S.wk[w].known /\ ~S.wk[w].det THEN [S.wk[w] EXCEPT !.lost = TRUE] ELSE S.wk[w]]]
      \* A barrier still waiting is refused with the channel, which answers it for a worker already gone.
      answer0 == IF marked.wk[0].det THEN AnswerBarrier(marked, 0) ELSE marked
  IN IF WorkerCount = 2 /\ answer0.wk[WorkerCount - 1].det THEN AnswerBarrier(answer0, WorkerCount - 1) ELSE answer0

GoneItems == {"gone-held", "gone-after-install", "gone-unreached-quick", "gone-unreached-long", "gone-other"}

MirrorHears(S, report) ==
  LET w == report.w
      k == S.wk[w]
      item == report.item
      late == k.mhold = "late"
  IN IF item = "lost" THEN (IF S.glost THEN S ELSE LoseChannel(S))
     ELSE IF S.glost THEN S
     ELSE IF item = "attached" THEN (IF k.known THEN S ELSE [S EXCEPT !.wk[w].known = TRUE, !.wk[w].mhold = "pending"])
     \* A report ahead of its worker's attach reaches nothing: the mirror has no such worker.
     ELSE IF ~k.known THEN S
     ELSE CASE item = "held" -> IF late THEN S ELSE [S EXCEPT !.wk[w].mhold = "held"]
            [] item = "installed-ok" ->
                 \* Installed only with the realm's first snapshot already in.
                 IF late \/ k.install # "none" THEN S
                 ELSE [S EXCEPT !.wk[w].install = IF k.mseq >= 1 /\ ~k.broken THEN "installed" ELSE "failed"]
            [] item \in {"installed-bad", "installed-none"} ->
                 IF late \/ k.install # "none" THEN S ELSE [S EXCEPT !.wk[w].install = "failed"]
            [] item = "late" ->
                 IF late THEN S
                 ELSE [S EXCEPT !.wk[w].mhold = "late", !.wk[w].install = IF k.install = "none" THEN "attached-late" ELSE @]
            [] item = "released" -> IF late THEN S ELSE [S EXCEPT !.wk[w].mhold = "released"]
            [] item \in GoneItems ->
                 LET S1 == [S EXCEPT !.wk[w].det = TRUE, !.wk[w].dwp = (item = "gone-held"),
                                     !.wk[w].unreached = (item \in {"gone-unreached-quick", "gone-unreached-long"}),
                                     !.wk[w].quick = (item = "gone-unreached-quick"),
                                     \* Gone after its install answered, it was let go: no longer held.
                                     !.wk[w].mhold = IF item = "gone-after-install" /\ @ = "held" THEN "released" ELSE @]
                 IN IF S.gphase # "waiting-trees" THEN AnswerBarrier(S1, w) ELSE S1
            [] item = "event-first" -> Receive(S, w, 1, TRUE)
            [] item = "event-open" -> Receive(S, w, 2, FALSE)
            [] item = "event-closed" -> Receive(S, w, 3, TRUE)
            [] item = "reply-ok" -> AnswerBarrier(S, w)
            [] item = "reply-error" -> IF k.det THEN AnswerBarrier(S, w) ELSE S

----------------------------------------------------------------------------
(* The readout's classification, restated from the docblocks of            *)
(* lib/worker-fingerprint-realm.ts.                                        *)

F(st, why) == [st |-> st, why |-> why]

(* Gone with no pause: it ended at once only when the attacher never saw   *)
(* it run and its life fits the bound.                                     *)
GoneUnpaused(k) == IF k.unreached /\ k.quick THEN F("ended-at-once", "") ELSE F("unread", "unreached")

(* A shared worker at the freeze, short of its stream. It is held by its   *)
(* main-script pause, not from its start: one with no pause yet is         *)
(* reaching. One attached after the call was not yet paused at it, so only *)
(* its hold at the main script can show it ran nothing then.               *)
AtFreeze(k, attachedAfterFreeze) ==
  IF k.lost THEN F("unread", "channelLostAlive")
  ELSE IF k.dwp THEN F("unread", "diedHeld")
  ELSE IF k.mhold = "held" THEN F("held", "")
  ELSE IF k.mhold = "late" THEN F("unread", "attachedLate")
  ELSE IF k.mhold = "pending" THEN (IF k.det THEN GoneUnpaused(k) ELSE F("reaching", ""))
  ELSE IF attachedAfterFreeze THEN F("excluded", "pausedAtReadout")
  ELSE IF k.install # "installed" THEN F("unread", "installFailed")
  ELSE F("stream", "")

(* An installed worker's state at the freeze, from its stream. Gone, a     *)
(* closed last word is its state and an open one waits for that task's     *)
(* closed snapshot. Running, its state waits for the readout's barrier.    *)
StreamAtFreeze(k) ==
  IF k.broken \/ k.mword = "none" THEN F("unread", "streamBroken")
  ELSE IF ~k.det THEN F("waiting", "running")
  ELSE IF k.mword = "closed" /\ k.mclosed # 0 THEN F("closed", "")
  ELSE F("waiting", "gone-open")

(* A worker reaching at the freeze, by its first move by the drain's end. *)
ReachingBy(k) ==
  IF k.lost THEN F("unread", "channelLostAlive")
  ELSE IF k.mhold = "held" THEN F("held", "")
  ELSE IF k.mhold = "released" THEN F("excluded", "pausedAtReadout")
  ELSE IF k.mhold = "late" THEN F("unread", "attachedLate")
  ELSE IF k.det THEN GoneUnpaused(k)
  ELSE F("reaching", "")

(* A worker seen held, by its next move by the drain's end. A late behind  *)
(* held means the hold broke; still held when the channel closed, or gone  *)
(* held with its install unanswered, it may have run, and is unread.       *)
HeldBy(k) ==
  IF k.mhold = "late" THEN F("unread", "attachedLate")
  ELSE IF k.mhold = "held" /\ k.lost THEN F("unread", "channelLostAlive")
  ELSE IF k.dwp THEN F("unread", "diedHeld")
  ELSE F("excluded", "pausedAtReadout")

Resolved(k, form) ==
  LET reached == IF form.st = "reaching" THEN ReachingBy(k) ELSE form
  IN IF reached.st = "held" THEN HeldBy(k) ELSE reached

ExcludedTerms == {"pausedAtReadout", "diedPaused"}
ReadTerms == {"readable", "ownerUnscoped"}
UnreadTerms == {"installFailed", "attachedLate", "unreached", "cutOff", "streamBroken", "channelLostAlive", "diedHeld"}
WorkerTerms == ExcludedTerms \cup UnreadTerms \cup ReadTerms \cup {"endedAtOnce"}

(* The term a worker lands in, and the snapshot it is read at, 0 for none. *)
(* A worker the mirror never heard of is unattached if discovery found it, *)
(* and otherwise lands nowhere.                                            *)
Landing(k) ==
  IF ~k.known THEN [term |-> IF k.disc THEN "unattached" ELSE "nowhere", readSeq |-> 0]
  ELSE LET frozen == IF k.form.st = "none" THEN AtFreeze(k, TRUE) ELSE k.form
           r == Resolved(k, frozen)
       IN CASE r.st \in {"excluded", "unread"} -> [term |-> r.why, readSeq |-> 0]
            [] r.st = "ended-at-once" -> [term |-> "endedAtOnce", readSeq |-> 0]
            [] r.st = "reaching" -> [term |-> "unreached", readSeq |-> 0]
            [] OTHER ->
                 \* Read from its stream. With no whole state for the freeze when the drain ended, it is unread.
                 IF k.snapshot = 0
                 THEN [term |-> IF k.lost THEN "channelLostAlive" ELSE IF k.broken THEN "streamBroken" ELSE "cutOff", readSeq |-> 0]
                 ELSE [term |-> "readable", readSeq |-> k.snapshot]

(* The form the freeze gives a worker the mirror knows. *)
FreezeWorker(S, w) ==
  LET k == S.wk[w]
      frozen == AtFreeze(k, FALSE)
      form == IF frozen.st = "stream" THEN StreamAtFreeze(k) ELSE frozen
  IN IF form.st = "closed" THEN [S EXCEPT !.wk[w].form = F("closed", ""), !.wk[w].snapshot = k.mclosed]
     ELSE IF form = F("waiting", "gone-open")
     THEN [S EXCEPT !.wk[w].form = F("waiting", ""), !.wk[w].answered = TRUE, !.wk[w].freezeSeq = k.mseq + 1]
     ELSE IF form.st = "waiting"
     THEN [S EXCEPT !.wk[w].form = F("waiting", ""), !.wk[w].barrier = IF S.glost THEN @ ELSE "to-thread"]
     ELSE [S EXCEPT !.wk[w].form = form]

HoldSettled(k) == k.mhold # "held" \/ k.det

(* The drain's own test: the visit lost, or every discovered worker        *)
(* reported and every frozen one settled.                                  *)
Drained(S) ==
  \/ S.glost
  \/ \A w \in W :
       LET k == S.wk[w]
       IN /\ ~(k.disc /\ ~k.known)
          /\ k.known =>
               CASE k.form.st \in {"none", "held"} -> HoldSettled(k)
                 [] k.form.st = "reaching" -> k.lost \/ (IF k.mhold = "held" THEN HoldSettled(k) ELSE ~(k.mhold = "pending" /\ ~k.det))
                 [] k.form.st = "waiting" -> k.snapshot # 0 \/ k.broken \/ k.lost
                 [] OTHER -> TRUE

(* The end of a readout: each worker's term, and the world's own facts     *)
(* about it, which nothing that classifies reads.                          *)
Finish(S) ==
  [gphase |-> "done", ended |-> FALSE, glost |-> FALSE, port |-> <<>>, wk |-> [w \in W |-> Blank],
   landed |-> [w \in W |->
     LET k == S.wk[w] l == Landing(k)
     IN [heard |-> k.known, term |-> l.term, readSeq |-> l.readSeq, ranAtFreeze |-> k.ranF, ranUnobservedAtFreeze |-> k.ranuF,
         ranUnobserved |-> k.ranu, attacherLives |-> ~S.ended, realmAtFreeze |-> k.seqF]]]

----------------------------------------------------------------------------
(* What the model drops. A word the thread would make nothing of, from     *)
(* this state on whatever comes, is not kept on the session.               *)

OwnWords == {"parsed", "ack", "ack-listed", "pause-main", "pause-script", "pause-statement", "resumed"}

Ignored(k, e) ==
  \* An answer is heard by the promise that asked, whatever became of the worker: a breakpoint's answer behind an
  \* early parse still sends its probe.
  IF k.gone /\ e \in {"ack", "ack-listed"} /\ k.hold = "pending" /\ k.early /\ ~k.probe THEN FALSE
  ELSE \/ k.hold = "late" /\ e # "barrier-answer"
       \/ k.conc /\ (e \in OwnWords \/ e \in {"install-ok", "install-bad", "probe-answer"})
       \/ k.conc /\ e = "off-answer" /\ ~k.awaitOff
       \/ k.gone /\ (e \in OwnWords \/ e \in {"first", "open", "closed"})

NormalWorker(S, k0) ==
  LET k1 == [k0 EXCEPT !.disc = IF k0.known THEN FALSE ELSE @,
                       !.waiting = IF k0.hold # "none" THEN FALSE ELSE @,
                       !.ran = IF S.gphase # "before" THEN FALSE ELSE @]
      k2 == IF k1.hold \notin {"pending", "none"} THEN [k1 EXCEPT !.early = FALSE, !.probe = FALSE, !.scripts = FALSE] ELSE k1
      k3 == IF k2.hold = "late" \/ k2.conc THEN [k2 EXCEPT !.eval = FALSE, !.ack = FALSE, !.pausedAgain = TRUE] ELSE k2
      k4 == IF k3.gone THEN [k3 EXCEPT !.pausedAgain = TRUE] ELSE k3
      k5 == [k4 EXCEPT !.events = SelectSeq(@, LAMBDA ev : ~Ignored(k4, ev.e))]
      k6 == IF k5.phase = "gone" THEN [k5 EXCEPT !.dbg = FALSE, !.bp = FALSE, !.obs = FALSE, !.other = FALSE, !.pausedAgain = FALSE] ELSE k5
  IN IF S.gphase = "waiting-trees"
     \* Past the drain the worker itself does nothing more, and only a barrier still lands.
     THEN [k6 EXCEPT !.phase = IF @ = "not-born" THEN @ ELSE "running", !.dbg = FALSE, !.bp = FALSE, !.obs = FALSE, !.other = FALSE,
                     !.eval = FALSE, !.pausedAgain = FALSE, !.seq = 0, !.commands = SelectSeq(@, LAMBDA c : c = "barrier")]
     ELSE IF k6.phase = "running" /\ k6.pausedAgain
     THEN [k6 EXCEPT !.obs = IF Stream THEN @ ELSE FALSE, !.dbg = FALSE, !.bp = FALSE, !.other = FALSE]
     ELSE k6

Normal(S) == IF S.gphase = "done" THEN S ELSE [S EXCEPT !.wk = [w \in W |-> NormalWorker(S, S.wk[w])]]

----------------------------------------------------------------------------
(* Steps. A move is its label (one step, or several a reduced world runs   *)
(* together), the switches that forbid it, and the state it leaves.        *)

StepOf(name, X, ended) == [name |-> name, posts |-> X.posts, sends |-> X.sends, ended |-> ended]
Quiet(S) == [s |-> S, posts |-> <<>>, sends |-> <<>>]
Raw(name, blocked, X) == [label |-> <<StepOf(name, X, "")>>, blocked |-> blocked, next |-> X.s, none |-> FALSE]
NoMove == [label |-> <<>>, blocked |-> {}, next |-> First, none |-> TRUE]
(* How far out of its turn an item was taken, as the model's labels word   *)
(* it: nothing for the first in a queue, and @n for the one n behind it.   *)
Behind == <<"@1", "@2", "@3", "@4", "@5", "@6", "@7", "@8", "@9", "@10", "@11", "@12", "@13", "@14", "@15", "@16", "@17", "@18",
            "@19", "@20", "@21", "@22", "@23", "@24", "@25">>
At(index) == IF index = 1 THEN <<>> ELSE <<Behind[index - 1]>>

(* A command reaches the worker. Out of its turn, A1 forbids it. *)
CommandLands(S, w, index, variant) ==
  LET k == S.wk[w]
      command == k.commands[index]
      S0 == [S EXCEPT !.wk[w].commands = Remove(@, index)]
      paused == k.phase \in PausedPhases
      listed == k.phase \in CompiledPhases
      next ==
        CASE command = "arm" ->
               \* A script already compiled is listed by the question behind the breakpoint, whatever becomes of its
               \* parse: ahead of the answer, behind it, or never. No switch chooses.
               LET armed == [S0 EXCEPT !.wk[w].dbg = TRUE, !.wk[w].bp = TRUE]
                   ahead == IF listed /\ variant = "" THEN Emit(armed, w, "parsed") ELSE armed
                   answered == Emit(ahead, w, IF listed THEN "ack-listed" ELSE "ack")
               IN IF listed /\ variant = "parse-behind" THEN Emit(answered, w, "parsed") ELSE answered
          [] command = "run" -> Release(S0, w, variant # "unheard")
          [] command = "install" ->
               IF paused
               THEN IF variant = "ok"
                    THEN Emit(Emit([S0 EXCEPT !.wk[w].obs = TRUE, !.wk[w].seq = 1], w, "first"), w, "install-ok")
                    ELSE Emit(S0, w, "install-bad")
               ELSE [S0 EXCEPT !.wk[w].eval = TRUE]
          [] command = "off" ->
               \* Turning the debugger off is the moment a paused worker runs.
               LET off == [S0 EXCEPT !.wk[w].dbg = FALSE, !.wk[w].bp = FALSE]
                   ran == IF paused THEN Emit([off EXCEPT !.wk[w] = Run(off.wk[w], S.gphase)], w, "resumed") ELSE off
               IN Emit(ran, w, "off-answer")
          [] command = "probe" -> Emit(S0, w, "probe-answer")
          [] command = "barrier" -> Emit(S0, w, "barrier-answer")
  IN Raw(<<"lands", Id(w), command>> \o (IF variant = "" THEN <<>> ELSE <<variant>>) \o At(index),
         (IF index > 1 THEN {"A1"} ELSE {}) \cup (IF variant = "unheard" THEN {"A2"} ELSE {}),
         Quiet(next))

(* The thread hears a word of the session. Out of its turn, A1 forbids it. *)
EventHeard(S, w, index) ==
  LET ev == S.wk[w].events[index]
      X == ThreadHears(Quiet([S EXCEPT !.wk[w].events = Remove(@, index)]), w, ev.e, ev.before)
  IN Raw(<<"hears", Id(w), ev.e>> \o At(index), IF index > 1 THEN {"A1"} ELSE {}, X)

EagerWords == {"parsed", "ack", "ack-listed", "first", "probe-answer"}

(* The first step that needs no interleaving in a world that runs a        *)
(* session's own steps together. The second worker of the two-worker world *)
(* runs a plain hold.                                                      *)
EagerFor(S, w) ==
  LET k == S.wk[w]
      plain == w = 1
      paused == k.phase \in PausedPhases
      hearable == k.attach = "none" /\ k.events # <<>> /\ k.events[1].e \in EagerWords
  IN IF S.gphase = "waiting-trees" THEN (IF hearable THEN EventHeard(S, w, 1) ELSE NoMove)
     ELSE IF plain /\ k.phase = "compiled" /\ k.bp
     THEN Raw(<<"reaches-main", Id(w), "paused">>, {}, Quiet(Emit([S EXCEPT !.wk[w].phase = "at-main"], w, "pause-main")))
     ELSE IF k.commands # <<>> /\ k.phase # "gone" /\ plain
     THEN CommandLands(S, w, 1, IF k.commands[1] = "install" /\ paused THEN "ok" ELSE "")
     ELSE IF k.commands # <<>> /\ k.phase # "gone" /\ k.commands[1] # "off" /\ ~(k.commands[1] = "install" /\ paused)
     THEN CommandLands(S, w, 1, "")
     ELSE IF hearable THEN EventHeard(S, w, 1)
     ELSE NoMove

EagerStep(S) ==
  IF S.ended THEN NoMove
  ELSE LET first == EagerFor(S, 0)
       IN IF ~first.none \/ WorkerCount = 1 THEN first ELSE EagerFor(S, 1)

RECURSIVE Eagerly(_)
Eagerly(move) ==
  IF ~CollapseSessions \/ move.next.gphase = "done" THEN move
  ELSE LET again == EagerStep(move.next)
       IN IF again.none THEN move
          ELSE Eagerly([label |-> move.label \o again.label, blocked |-> move.blocked \cup again.blocked, next |-> Normal(again.next), none |-> FALSE])

(* One move with what follows it. *)
Moved(raw) == Eagerly([raw EXCEPT !.next = Normal(@)])
Settled(name, blocked, X, ended) == Moved([label |-> <<StepOf(name, X, ended)>>, blocked |-> blocked, next |-> X.s, none |-> FALSE])

SomeBefore(k) == \E i \in DOMAIN k.events : k.events[i].before
InFlightAtFreeze(k) == k.attach = "flight-at-freeze" \/ k.detach = "flight-at-freeze"
NewsFromBeforeTheFreeze(S) == \E w \in W : InFlightAtFreeze(S.wk[w]) \/ SomeBefore(S.wk[w])

(* D1: the frame tree answers only behind what the browser emitted before  *)
(* the freeze, and what the thread posted on hearing it.                   *)
TreesBlockedBy(S) ==
  IF (\E i \in DOMAIN S.port : S.port[i].before \/ S.port[i].earlier) \/ NewsFromBeforeTheFreeze(S) THEN {"D1"} ELSE {}

(* The settle bound. A5's second half: a message posted before the freeze  *)
(* is processed before it. C1: so is what the browser emitted before the   *)
(* freeze, and what the thread posted on hearing it.                       *)
BoundBlockedBy(S) ==
  (IF \E i \in DOMAIN S.port : S.port[i].before THEN {"A5bound"} ELSE {})
  \cup (IF (\E i \in DOMAIN S.port : S.port[i].earlier) \/ NewsFromBeforeTheFreeze(S) THEN {"C1"} ELSE {})

(* The drain has ended, by what it waited for or by its bound. The readout *)
(* then awaits the frame trees it asked for at the call, and classifies    *)
(* only after that. The trees may have answered already, or not.           *)
DrainEnded(S, name, blocked, X, how) ==
  IF Reduced THEN {Settled(name, blocked, [X EXCEPT !.s = Finish(S)], how)}
  ELSE {Settled(name, blocked \cup TreesBlockedBy(S), [X EXCEPT !.s = Finish(S)], how)}
       \cup (IF TreesBlockedBy(S) = {} THEN {}
             ELSE LET waits == Settled(name, blocked, [X EXCEPT !.s = [S EXCEPT !.gphase = "waiting-trees"]], IF how = "drain" THEN "drain-waits" ELSE "bound-waits")
                  IN {[waits EXCEPT !.label = <<StepOf(<<"documents-late">>, Quiet(S), "")>> \o @]})

(* A step the main thread hears: the drain may end on it. *)
MainMoved(name, blocked, X) ==
  IF X.s.gphase = "draining" /\ Drained(X.s) THEN DrainEnded(X.s, name, blocked, X, "drain") ELSE {Settled(name, blocked, X, "")}

(* The connection closes or the thread dies: nothing on a session arrives, *)
(* and Chromium resumes a worker held for a client that went away.         *)
EndThread(S) ==
  [S EXCEPT !.ended = TRUE,
            !.wk = [w \in W |->
              LET k == [S.wk[w] EXCEPT !.commands = <<>>, !.events = <<>>, !.attach = "none", !.detach = "none", !.dbg = FALSE, !.bp = FALSE, !.eval = FALSE]
              IN IF k.phase \in {"start-held", "compiled", "at-main", "paused"} THEN Run(k, S.gphase) ELSE k]]

(* Z: at the freeze the mirror has heard of every worker born, and has its *)
(* next word for every worker that has run.                                *)
Current(S) ==
  \/ S.glost
  \/ \A w \in W : LET k == S.wk[w] IN k.phase = "not-born" \/ (k.known /\ ~(k.ran /\ k.mhold \notin {"late", "released"} /\ ~k.det))

FreezeAll(S) ==
  LET marked == [S EXCEPT !.gphase = "draining",
                          !.port = [i \in DOMAIN S.port |-> [S.port[i] EXCEPT !.before = TRUE]],
                          !.wk = [w \in W |-> LET k == S.wk[w]
                                              IN [k EXCEPT !.ranF = k.ran, !.ranuF = k.ranu, !.seqF = k.seq,
                                                           !.attach = IF @ = "flight" THEN "flight-at-freeze" ELSE @,
                                                           !.detach = IF @ = "flight" THEN "flight-at-freeze" ELSE @,
                                                           !.events = [i \in DOMAIN k.events |-> [k.events[i] EXCEPT !.before = TRUE]]]]]
      first == IF marked.wk[0].known THEN FreezeWorker(marked, 0) ELSE marked
  IN IF WorkerCount = 2 /\ first.wk[WorkerCount - 1].known THEN FreezeWorker(first, WorkerCount - 1) ELSE first

WorkerMoves(S, w) ==
  LET k == S.wk[w]
      phase == k.phase
      past == S.gphase = "waiting-trees"
      plain == w = 1
      alive == phase # "not-born" /\ ~S.ended
      Put(kk) == [S EXCEPT !.wk[w] = kk]
      born(waiting) ==
        Settled(<<"born", Id(w), IF waiting THEN "waiting" ELSE "running">>, {},
                Quiet(Put([k EXCEPT !.phase = IF waiting THEN "start-held" ELSE "running", !.waiting = waiting, !.attach = "flight",
                                    !.pausedAgain = ~waiting,
                                    !.ran = IF ~waiting /\ S.gphase = "before" THEN TRUE ELSE @,
                                    !.ranu = IF ~waiting THEN TRUE ELSE @])), "")
      otherReleased(heard) == Release(Put([k EXCEPT !.other = TRUE]), w, heard)
      pausedAt(event) == Emit(Put([k EXCEPT !.pausedAgain = TRUE, !.phase = "paused"]), w, event)
      commandIndexes == IF Reduced \/ past THEN (IF k.commands = <<>> THEN {} ELSE {1}) ELSE DOMAIN k.commands
      variantsOf(command) ==
        LET paused == phase \in PausedPhases
        IN IF command = "install" /\ paused THEN (IF Reduced THEN {"ok"} ELSE {"ok", "bad"})
           ELSE IF command = "run" /\ paused THEN (IF Reduced THEN {""} ELSE {"", "unheard"})
           ELSE IF command = "arm" /\ phase \in CompiledPhases /\ ~Reduced THEN {"", "parse-behind", "parse-held"}
           ELSE {""}
      eventIndexes == IF Reduced \/ past THEN (IF k.events = <<>> THEN {} ELSE {1}) ELSE DOMAIN k.events
      unreached == k.hold = "pending" /\ ~k.scripts /\ ~k.early
  IN \* A worker is born, held at its start or already running. One born after the connection closed is left out.
     (IF phase = "not-born" /\ ~S.ended /\ ~past THEN {born(TRUE)} \cup (IF Reduced THEN {} ELSE {born(FALSE)}) ELSE {})
     \* A start-up hold that does not hold, which A4 says never happens.
     \cup (IF alive /\ ~past /\ ~Reduced /\ ~k.other /\ phase = "start-held"
           THEN {Settled(<<"starts-unreleased", Id(w)>>, {"A4"}, Quiet(otherReleased(TRUE)), "")} ELSE {})
     \* Another client's release, once. A2: the attacher's session hears it.
     \cup (IF alive /\ ~past /\ ~plain /\ ~k.other /\ ((phase = "start-held" /\ ~Reduced) \/ phase \in PausedPhases)
           THEN {Settled(<<"other-release", Id(w)>>, {}, Quiet(otherReleased(TRUE)), "")}
                \cup (IF phase # "start-held" /\ ~Reduced THEN {Settled(<<"other-release-unheard", Id(w)>>, {"A2"}, Quiet(otherReleased(FALSE)), "")} ELSE {})
           ELSE {})
     \* The worker reaches its main script: paused there with the breakpoint in, or at a dependency first, or it runs.
     \cup (IF alive /\ ~past /\ phase = "compiled"
           THEN IF k.bp
                THEN {Settled(<<"reaches-main", Id(w), "paused">>, {}, Quiet(Emit(Put([k EXCEPT !.phase = "at-main"]), w, "pause-main")), "")}
                     \cup (IF Reduced THEN {} ELSE {Settled(<<"reaches-dependency", Id(w)>>, {}, Quiet(Emit(Put([k EXCEPT !.phase = "paused"]), w, "pause-script")), "")})
                ELSE {Settled(<<"reaches-main", Id(w), "ran">>, {}, Quiet(Put(Run(k, S.gphase))), "")}
           ELSE {})
     \* A running worker with the debugger on can stop at a statement, or at a later script with the breakpoint set, once.
     \cup (IF alive /\ ~past /\ ~Reduced /\ phase = "running" /\ k.dbg /\ ~k.pausedAgain
           THEN {Settled(<<"stops-at-statement", Id(w)>>, {}, Quiet(pausedAt("pause-statement")), "")}
                \cup (IF k.bp THEN {Settled(<<"stops-at-script", Id(w)>>, {}, Quiet(pausedAt("pause-script")), "")} ELSE {})
           ELSE {})
     \* An install that reached a running worker evaluates at its next task or pause.
     \cup (IF alive /\ ~past /\ k.eval /\ phase \in {"running", "paused"}
           THEN {Settled(<<"evaluates-late", Id(w), "ok">>, {}, Quiet(Emit(Emit(Put([k EXCEPT !.eval = FALSE, !.obs = TRUE, !.seq = 1]), w, "first"), w, "install-ok")), ""),
                 Settled(<<"evaluates-late", Id(w), "bad">>, {}, Quiet(Emit(Put([k EXCEPT !.eval = FALSE]), w, "install-bad")), "")}
           ELSE {})
     \* The realm's own stream, a task and its close, once the observer is in.
     \cup (IF alive /\ ~past /\ Stream /\ phase = "running" /\ k.obs /\ k.seq \in {1, 2} /\ k.hold # "late"
           THEN {Settled(<<"emits", Id(w), IF k.seq = 1 THEN "open" ELSE "closed">>, {},
                         Quiet(Emit(Put([k EXCEPT !.seq = @ + 1]), w, IF k.seq = 1 THEN "open" ELSE "closed")), "")}
           ELSE {})
     \* The worker ends. What was on its way to it reaches nothing.
     \cup (IF alive /\ ~past /\ ~plain /\ phase # "gone"
           THEN {Settled(<<"ends", Id(w)>>, {}, Quiet(Put([k EXCEPT !.phase = "gone", !.eval = FALSE, !.commands = <<>>, !.detach = "flight"])), "")}
           ELSE {})
     \* The browser takes a session's commands.
     \cup (IF alive /\ phase # "gone"
           THEN UNION {IF (past /\ k.commands[index] # "barrier")
                          \/ (CollapseSessions /\ k.commands[index] # "off" /\ ~(k.commands[index] = "install" /\ phase \in PausedPhases))
                       THEN {}
                       ELSE {Moved(CommandLands(S, w, index, variant)) : variant \in variantsOf(k.commands[index])}
                       : index \in commandIndexes}
           ELSE {})
     \* The thread hears its socket. The attach comes first. A3's negation: a detach never overtakes a session's words.
     \cup (IF alive /\ k.attach # "none"
           THEN {Settled(<<"hears", Id(w), "attach", IF k.waiting THEN "waiting" ELSE "running">>, {},
                         ThreadHearsAttach(Quiet(S), w, k.attach = "flight-at-freeze"), "")}
           ELSE IF alive
           THEN {Moved(EventHeard(S, w, index)) : index \in {i \in eventIndexes : ~(CollapseSessions /\ k.events[i].e \in EagerWords)}}
                \cup (IF k.detach = "none" THEN {}
                      ELSE {Settled(<<"hears", Id(w), "detach", lifetime>>, IF k.events # <<>> THEN {"notA3"} ELSE {},
                                    ThreadHearsDetach(Quiet(S), w, lifetime, k.detach = "flight-at-freeze"), "")
                            : lifetime \in IF unreached /\ ~Reduced THEN {"quick", "long"} ELSE {"long"}})
           ELSE {})
     \* The thread's own bounds: on a hold with its install unanswered, and on the debugger's turning off.
     \cup (IF alive /\ ~past /\ ~Reduced /\ k.hold = "held" /\ ~k.conc /\ ~k.gone
           THEN {Settled(<<"hold-bound", Id(w)>>, {}, Conclude(Quiet(S), w, "none", FALSE), "")} ELSE {})
     \cup (IF alive /\ ~past /\ ~Reduced /\ k.awaitOff
           THEN {Settled(<<"off-bound", Id(w)>>, {}, Post(Quiet(Put([k EXCEPT !.awaitOff = FALSE, !.hold = "released"])), w, "released", "released:off", FALSE), "")}
           ELSE {})
     \* The barrier's way to the thread and, unanswered, its bound.
     \cup (IF alive /\ Stream /\ k.barrier = "to-thread"
           THEN {Settled(<<"thread-gets-barrier", Id(w)>>, {},
                         IF k.gone THEN Post(Quiet(Put([k EXCEPT !.barrier = "replied"])), w, "reply-error", "reply:error", FALSE)
                         ELSE Command(Quiet(Put([k EXCEPT !.barrier = "sent"])), w, "barrier"), "")}
           ELSE {})
     \cup (IF alive /\ ~past /\ Stream /\ k.barrier = "sent"
           THEN {Settled(<<"barrier-bound", Id(w)>>, {}, Post(Quiet(Put([k EXCEPT !.barrier = "replied"])), w, "reply-error", "reply:error", FALSE), "")}
           ELSE {})
     \* With no stream to read past, the barrier is one round trip, behind everything the port holds.
     \cup (IF alive /\ ~Stream /\ k.barrier = "to-thread" /\ ~k.gone /\ phase # "gone" /\ S.port = <<>>
           THEN MainMoved(<<"barrier-round-trip", Id(w)>>, {}, Quiet(AnswerBarrier(Put([k EXCEPT !.barrier = "replied"]), w)))
           ELSE {})
     \* Discovery on the page's own connection, which is not the attacher's.
     \cup (IF ~Reduced /\ phase # "not-born" /\ ~k.disc /\ ~k.known
           THEN MainMoved(<<"discovered", Id(w)>>, {}, Quiet(Put([k EXCEPT !.disc = TRUE])))
           ELSE {})

GlobalMoves(S) ==
  LET past == S.gphase = "waiting-trees"
      portIndexes == IF Reduced \/ past \/ (~Stream /\ S.gphase # "before") THEN (IF S.port = <<>> THEN {} ELSE {1}) ELSE DOMAIN S.port
  IN \* The port. A5's first half: it delivers in order.
     UNION {MainMoved(<<"mirror-hears", Id(IF S.port[index].item = "lost" THEN 0 ELSE S.port[index].w), S.port[index].item>> \o At(index),
                      IF index > 1 THEN {"A5fifo"} ELSE {},
                      Quiet(MirrorHears([S EXCEPT !.port = Remove(@, index)], S.port[index])))
            : index \in portIndexes}
     \* The connection closes, and the thread reports it last. Or the thread dies, and nothing queued arrives.
     \cup (IF ~S.ended /\ ~past
           THEN {Settled(<<"connection-closes">>, IF NewsFromBeforeTheFreeze(S) THEN {"C1", "D1"} ELSE {},
                         LET X == Post(Quiet(S), 0, "lost", "lost", FALSE) IN [X EXCEPT !.s = EndThread(@)], "")}
                \cup (IF Reduced THEN {}
                      ELSE LET dead == [EndThread(S) EXCEPT !.port = <<>>]
                           IN MainMoved(<<"thread-dies">>, {}, Quiet(IF dead.glost THEN dead ELSE LoseChannel(dead))))
           ELSE {})
     \* The readout is called.
     \cup (IF S.gphase = "before" THEN MainMoved(<<"freeze">>, IF Current(S) THEN {} ELSE {"Z"}, Quiet(FreezeAll(S))) ELSE {})
     \cup (IF S.gphase = "draining" THEN DrainEnded(S, <<"settle-bound">>, BoundBlockedBy(S), Quiet(S), "bound") ELSE {})
     \cup (IF past THEN {Settled(<<"documents-answered">>, TreesBlockedBy(S), Quiet(Finish(S)), "documents")} ELSE {})

(* Every move of a state, whatever is assumed. *)
EveryMove(S) ==
  IF S.gphase = "done" THEN {}
  ELSE IF S.gphase = "waiting-trees" /\ TreesBlockedBy(S) = {}
  THEN {Settled(<<"documents-answered">>, {}, Quiet(Finish(S)), "documents")}
  ELSE LET all == UNION {WorkerMoves(S, w) : w \in W} \cup GlobalMoves(S)
       \* A reduced world's bound: no more than four reports wait on the port.
       IN IF Reduced THEN {move \in all : move.next.gphase = "done" \/ Len(move.next.port) <= 4} ELSE all

(* The moves the assumed switches leave. *)
Moves(S) == {move \in EveryMove(S) : move.blocked \cap Assumed = {}}

----------------------------------------------------------------------------
VARIABLE st

Init == st = First
Next == \E move \in Moves(st) : st' = move.next
Spec == Init /\ [][Next]_st

----------------------------------------------------------------------------
(* Properties, read at the end of a readout from the world's own facts.    *)
(* Each is named for the register row it states; README.md has the table.  *)

Landed == IF st.gphase = "done" THEN {st.landed[w] : w \in W} ELSE {}

\* The first exclusion row: a worker the readout excludes as held ran no page code before the freeze.
ExcludedRanNothing == \A l \in Landed : l.term \in ExcludedTerms => ~l.ranAtFreeze
\* The second: it ran no page code with no observer in before the freeze.
ExcludedRanNothingUnobserved == \A l \in Landed : l.term \in ExcludedTerms => ~l.ranUnobservedAtFreeze
\* F4-READ: "A shared worker the readout reads had its observer in before every statement of page code it ran."
ReadHadItsObserver == \A l \in Landed : l.term \in ReadTerms => ~l.ranUnobserved
\* F4-AGE: "A shared worker the readout reads is read at a state no older than the freeze." A task open at the
\* freeze is read at its close.
ReadNoOlderThanTheFreeze == \A l \in Landed : l.term \in ReadTerms => l.readSeq >= (IF l.realmAtFreeze = 2 THEN 3 ELSE l.realmAtFreeze)
\* F4-TERM, its first half: "Every shared worker the readout heard of lands in exactly one term." A landing is
\* one term by construction; what TLC holds is that a worker the mirror heard of lands in one of the named
\* terms, and that only a worker it never heard of is unattached or nowhere.
HeardLandsInOneTerm == \A l \in Landed : IF l.heard THEN l.term \in WorkerTerms ELSE l.term \in {"unattached", "nowhere"}
\* The no-term row: a worker that ran before the freeze, with the attacher alive, lands in a term.
RanLandsInATerm == \A l \in Landed : ~(l.term = "nowhere" /\ l.ranAtFreeze /\ l.attacherLives)

----------------------------------------------------------------------------
(* Reachability companions. A row of the form "a worker that lands so had  *)
(* this fact" holds of every state when no worker ever lands so, and when  *)
(* no worker ever has the fact that would break it. Each companion below   *)
(* says that one such thing never happens, so TLC must report it VIOLATED  *)
(* wherever a row that needs it is listed as holding: the violation is the *)
(* evidence that the row had something to judge there. A companion that    *)
(* holds is a row with nothing to judge, and the row is not listed there.  *)
(* scripts/tla-worker-hold-export.mjs names the companions of each row and *)
(* runs them; README.md says where each row cannot be judged.              *)

\* The exclusion rows judge only a worker the readout excludes.
NoWorkerExcluded == \A l \in Landed : l.term \notin ExcludedTerms
\* The first exclusion row can fail only where some worker ran before the freeze.
NoWorkerRanBeforeTheFreeze == \A l \in Landed : ~l.ranAtFreeze
\* The second, only where some worker ran with no observer in before the freeze.
NoWorkerRanUnobservedBeforeTheFreeze == \A l \in Landed : ~l.ranUnobservedAtFreeze
\* F4-READ and F4-AGE judge only a worker the readout reads.
NoWorkerRead == \A l \in Landed : l.term \notin ReadTerms
\* F4-READ can fail only where some worker ran with no observer in.
NoWorkerRanUnobserved == \A l \in Landed : ~l.ranUnobserved
\* F4-TERM, its first half, speaks of a worker that lands in a named term.
NoWorkerInANamedTerm == \A l \in Landed : l.term \notin WorkerTerms
\* The no-term row judges only a worker that ran before the freeze with the attacher alive,
NoWorkerRanWithTheAttacherAlive == \A l \in Landed : ~(l.ranAtFreeze /\ l.attacherLives)
\* and can fail only where some worker lands nowhere.
NoWorkerNowhere == \A l \in Landed : l.term # "nowhere"

TypeOK ==
  /\ st.gphase \in {"before", "draining", "waiting-trees", "done"}
  /\ st.ended \in BOOLEAN /\ st.glost \in BOOLEAN
  /\ \A w \in W : Len(st.wk[w].commands) <= 8 /\ Len(st.wk[w].events) <= 12
  /\ Len(st.port) <= 13 * WorkerCount

=============================================================================
