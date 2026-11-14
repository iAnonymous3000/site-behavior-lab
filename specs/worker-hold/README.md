# The shared-worker hold in TLA+

`WorkerHold.tla` states the protocol of register rows F4-READ to F4-BEYOND in
`docs/formal-verification.md`: the browser and the worker, the attacher's
thread, the mirror over its port, and the drain and the readout. Each
assumption about the environment is a switch that only removes transitions,
and a configuration names the world it walks and the switches it assumes.

## How independent it is

Less than the case machine's specification, and this file says how.

- It was written with `lib/fv-worker-model.ts` open, and it takes that model's
  worlds as its own: which steps each world walks, that a worker pauses again
  at most once, that a word the thread would make nothing of is dropped, and
  which steps a reduced world runs together. The register states those worlds
  only by name, so there was no other statement of them to write from.
- Its step names are the model's, so that its traces can be replayed through
  the real code by the model's own replay harness.
- The thread, the mirror, the drain and the world's facts are restated here
  as TLA+ operators. The readout's classification is restated from the
  docblocks of `lib/worker-fingerprint-realm.ts`, where the hand-written model
  calls the real kernels.

So what it adds is a second statement in a language with published semantics,
checked by a tool this project did not write, with its own statement of each
row and of the classification. It does not add a second, independent reading
of what the worlds should be.

## The switches

As the register words them. A1 to A5 are the plan's axioms; C1, D1 and Z are
not axioms of the plan, and none of the nine is a fact of Chromium.

| Switch | Assumption | Where it removes transitions |
|---|---|---|
| A1 | a session's commands and a worker's own words on it arrive in order | a command landing, or a word heard, out of its turn (`:@n`) |
| A2 | another client's release of a held worker is heard by the attacher's session | `other-release-unheard`, and a run command landing unheard |
| notA3 | A3's negation: a detach never overtakes a session's events still on their way | the thread hearing a detach with words still on the session |
| A4 | a worker the debugger holds at its start runs nothing until it is released | `starts-unreleased` |
| A5fifo | the port between the thread and the main thread delivers in order | the mirror hearing a report out of its turn |
| A5bound | a message posted before the freeze is processed before the settle bound | the settle bound with such a report on the port |
| C1 | what the browser emitted before the freeze, and what the thread posted on hearing it, is processed before the settle bound | the settle bound, and the connection closing, with such news on its way |
| D1 | all of that is processed before the page's frame tree answers | the frame tree answering with such news on its way |
| Z | at the freeze the mirror has heard of every worker born, and has its next word for every worker that has run | the freeze, when the mirror is not current |

A script's parse is not under A1: it may be heard ahead of the arming's answer,
behind it or never, with no switch's leave.

## The worlds

The hand-written model's, by the same names: `hold` (one worker, every step),
`stream` (one worker from its release on, with its stream and the barrier's
hops), `two` (`TWO_WORKER_WORLD`, under its stated bound) and `small`
(`SMALL_WORLD`). The dedicated world is not specified here.

## The rows

Read at the end of a readout, from the world's own facts about each worker,
which nothing that classifies reads.

| Register row | In TLA+ | Sentence |
|---|---|---|
| F4-READ | `ReadHadItsObserver` | A shared worker the readout reads had its observer in before every statement of page code it ran. |
| F4-AGE | `ReadNoOlderThanTheFreeze` | A shared worker the readout reads is read at a state no older than the freeze. Judged in the stream world only. |
| F4-TERM, first half | `HeardLandsInOneTerm` | Every shared worker the readout heard of lands in exactly one term. A landing is one term by construction; TLC holds that it is one of the named terms. |
| F4-TERM, second half | not stated | Where @12 lands a worker apart from @11: the row rests on a restated old rule, and a third copy of it here would be bound to nothing. |
| the exclusion rows | `ExcludedRanNothing`, `ExcludedRanNothingUnobserved` | A worker the readout excludes as held ran no page code (the second: none with no observer in) before the freeze. From fingerprint-observer@14 the readout excludes no shared worker, so neither row has a worker to judge in any world. Both are kept: they fail as soon as a worker that ran is excluded again. |
| the no-term row | `RanLandsInATerm` | A worker that ran before the freeze, with the attacher alive, lands in a term. |
| F4-TABLE | `WorkerHoldTable.tla` | Each row under every set of switches, from one search that carries the switches a path broke. That a larger set keeps what a smaller one kept is how the switches are built, not a check. |
| F4-BEYOND | `NamedForm`, `NamedCause`, `NamedTerms` in `WorkerHoldTable.tla` | The named trace: a worker that ran unobserved before the freeze, which the mirror does not yet call late, on the step that ends the readout. That step lands it unread, as a hold the freeze cannot place (`holdUnplaced`). Through fingerprint-observer@13 the same step excluded it (`pausedAtReadout`). |

## What the readout does with a hold, from fingerprint-observer@14

Through fingerprint-observer@13 the readout excluded a shared worker on three
paths, each as `pausedAtReadout` ("ran nothing before the freeze"):

- attached after the freeze, as the mirror heard it, and released (the second
  pass, `AtFreeze`);
- reaching at the freeze, and released by the drain's end (`ReachingBy`);
- seen held, and then released, or still held at the bound (`HeldBy`).

From @14 each of the three lands the worker unread, in the term
`holdUnplaced`: a release can be in flight at the freeze, with the worker
already running and the mirror one hop behind, and nothing the readout holds
tells that worker from one released after the freeze. The specification
states the same three lines. So no operator of it returns an excluded form,
and no shared worker lands in an excluded term in any world.

The trace that the register names (F4-BEYOND) is as reachable as it was, in
each form and with each cause. What changed is the term its worker lands in.
`WorkerHoldTable.tla` prints that term on each line of the trace, and the
export script refuses a line, or a move of the printed graph, that lands the
named trace in an excluded term.

## Where a row can be judged, and where it cannot

A row of the form "a worker that lands so had this fact" passes in a world
where no worker lands so, and in a world where no worker has the fact that
would break it. It passes there whatever the protocol does, so its passing is
no evidence about the protocol.

That is the case for the two exclusion rows in every world. No shared worker
is excluded (the section above), so neither row has a worker to judge, under
any set of switches. They are listed nowhere: in no committed configuration,
in no cell of the export script's table, and in no cell of the suite's copy
of the register's table. TLC's table has no set of switches that breaks
either, which reads as "holds under no axiom" and carries no information.
Through @13 both rows could be judged in the hold, two-worker and small
worlds, where they failed under the plan's axioms (with C1 and D1 on top as
well) and held with Z, in the hold world with A5's order half as well.

That nothing is excluded is itself held, in three ways:

- For each world the export script runs TLC on `NoWorkerExcluded` with
  nothing assumed, so over every path of the world, and refuses to write the
  export unless TLC holds it. The export records the row and the companion.
- The conformance suite walks the hand-written model's graph, which calls the
  real classification, and fails if any landing is in an excluded term.
- The seeded faults put each of the three @13 exclusions back, one at a time,
  and TLC must report each exclusion row violated (the table of invariants
  below). That is the evidence that the two rows can still fail.

It is also the case for two more rows in the stream world. Its one worker
starts released, with its observer in, having run, and known to the mirror.
So in that world:

- No worker ever lands nowhere, because the mirror knows the worker from the
  first state. The no-term row cannot fail.
- No worker ever runs with no observer in. F4-READ cannot fail.

These two rows are therefore not listed for the stream world: not in
`stream-plan.cfg`, not in the export script's table of cells, and not in the
suite's copy of the register's table. The register's table gives each of them
"holds under no axiom" in the stream world. TLC's table agrees, and the
sentence is true, but it carries no information. The rows that the stream
world does judge are F4-AGE and the first half of F4-TERM. The two rows are
judged in the hold, two-worker and small worlds.

F4-AGE is the other way round: it has force only in the stream world. In the
hold, two-worker and small worlds `Stream` is `FALSE`, so the realm never goes
past its first snapshot. A worker that is read there is always read at that
one snapshot, and there is no older state it could have been read at. The row
passes there whatever the readout does, so it is not listed in `hold-plan.cfg`,
`two-plan.cfg` or `small-plan.cfg`, nor in a cell of those worlds. The
register's table gives it "holds under no axiom" in the hold and two-worker
worlds, and its row says that the stream world decides it. Only the stream
world lists it, under the three axioms it needs there (A1, A3's negation and
A5's order half).

So that a row is not listed again where it has nothing to judge, each row has
reachability companions in `WorkerHold.tla`. A companion says that something
never happens, and TLC must report it violated:

| Row | Its subject is reached when TLC violates | What would break it is reached when TLC violates |
|---|---|---|
| `ExcludedRanNothing` | `NoWorkerExcluded` | `NoWorkerRanBeforeTheFreeze` |
| `ExcludedRanNothingUnobserved` | `NoWorkerExcluded` | `NoWorkerRanUnobservedBeforeTheFreeze` |
| `ReadHadItsObserver` | `NoWorkerRead` | `NoWorkerRanUnobserved` |
| `ReadNoOlderThanTheFreeze` | `NoWorkerRead` | `NoReadPastTheFirstSnapshot`: a read of a realm that was past its first snapshot at the freeze, which is where an older state exists to be read by mistake |
| `HeardLandsInOneTerm` | `NoWorkerInANamedTerm` | (the row is a definition, see the table of invariants) |
| `RanLandsInATerm` | `NoWorkerRanWithTheAttacherAlive` | `NoWorkerNowhere` |

Wherever a row is listed as holding, the export script runs TLC on each of
its companions in the same world under the same switches, and refuses to
write the export if TLC holds one. It records the companions TLC reported
violated. The conformance suite, with no Java, walks the hand-written model's
own graph and fails if a companion of a listed row is not reached there: for
each cell of the export script's table, for each committed configuration, and
for each cell of its copy of the register's table. It also holds that the two
exclusion rows in every world, the two rows above in the stream world, and
F4-AGE in the three worlds with no stream, are the only rows with nothing to
judge. For each of those the export script runs TLC on the companion that is
never reached, with nothing assumed, and TLC must hold it. The export records
those companions, and the suite holds them to the model's graph.

What a violated companion shows is limited. It shows that the row's subject,
and the fact that would break the row, each occur in that world under those
switches. It does not show that a fault would be caught: the seeded faults
(`scripts/tla-worker-hold-mutations.mjs`) are the evidence for that, and they
cover the sets named there.

## What each invariant asserts, and of what kind

The classes are those of `../case-machine/README.md`. **Behavioural**: a fault
of the protocol violates it. The protocol is the thread, the mirror, the drain
and the readout's classification; the switches are assumptions, and a fault
that weakens a switch is not a fault of the protocol. **Definitional**: it
restates a definition of the specification, and is held for the record.

| Invariant | What it asserts | Class | Seeded faults |
|---|---|---|---|
| `TypeOK` | The readout's phase is one of four named phases, two flags are booleans, and each session's two queues and the port stay within stated lengths. It does not type the worker record. | behavioural, and weak. No register row rests on it. | One, in the specification's world and not in the thread or the mirror: a command that reaches the worker stays on its session, and the session's words pile up past the bound. No fault of the thread or the mirror is seeded for it. |
| `ExcludedRanNothing` | A worker that lands in an excluded term ran no page code before the freeze. | behavioural, and with nothing to judge in the committed specification: no worker lands in an excluded term, in any world, so it holds there under every set of switches. It is a guard on the classification: a fault that excludes a worker that ran violates it. | Four in the protocol, all in the readout's classification. One: a worker the mirror calls late at the freeze is excluded as held (under A5's order half and Z). Three put back the exclusions of fingerprint-observer@13, one at a time, under the plan's axioms with C1 and D1: in the second pass, for a worker reaching at the freeze, and for a worker seen held. The second exclusion row catches the same four, and each row catches each without the other. |
| `ExcludedRanNothingUnobserved` | A worker that lands in an excluded term ran no page code with no observer in before the freeze. | behavioural, in the same way. | The same four faults. No seeded fault separates this row from the first. |
| `ReadHadItsObserver` | A worker that lands in a read term never ran with no observer in. | behavioural, in the hold, two-worker and small worlds. | One in the protocol: the thread makes nothing of a resume while it holds a worker. |
| `ReadNoOlderThanTheFreeze` | A worker that lands in a read term is read at a snapshot no older than the realm's at the freeze, and at the close of a task that was open then. | behavioural, in the stream world only. | Three in the protocol. |
| `HeardLandsInOneTerm` | A worker the mirror heard of lands in one of the named terms, and a worker it never heard of lands as unattached or nowhere. | definitional. `Landing` returns one of a fixed set of strings and "heard" is the mirror's own flag, so it fails only if `Landing` is given a term name that is in no set. The register says the same of the hand-written model. | One, of that kind: a term renamed in `Landing`. |
| `RanLandsInATerm` | No worker lands nowhere having run before the freeze with the attacher alive. | behavioural, in the hold world under D1, and in the hold and two-worker worlds under Z. | Two. One weakens what D1 forbids, which is an assumption and not the protocol. One is in the protocol: the mirror makes nothing of a worker's attach. |

The reachability companions (`NoWorkerExcluded` and the others) are not in this
table. They are not claims: each must be violated, and says so where it is
defined.

`scripts/tla-worker-hold-mutations.mjs` seeds these twelve faults in sixteen
runs (each of the four exclusion faults is run once for each exclusion row),
each run with only the row named for it, under a set of switches where the
committed specification keeps the row. A caught fault shows that the row can
fail there. For the two exclusion rows "keeps the row" is true under every
set, because they have nothing to judge, so their faults are all the evidence
there is that they can fail.
No committed artifact records the result. The unit tests do not run the
script: it needs TLC. The workflow `tla-checks.yml` runs it on every push to
`main`, and its receipt keeps the script's exit status and last line.

Three terms are named in the term sets and never produced: `pausedAtReadout`,
`diedPaused` and `ownerUnscoped`. No operator of the specification returns
any of them, so no exclusion row is ever judged on the first two and no read
row on the third. The first was produced through fingerprint-observer@13.
`WorkerHold.tla` says so where the sets are defined.

## Files

| File | What it is |
|---|---|
| `WorkerHold.tla` | The protocol, the classification and the rows. |
| `WorkerHoldTable.tla` | The axiom table in one search, and the named trace. |
| `WorkerHoldExport.tla` | Prints the whole graph of a world. Not a property. |
| `hold-plan.cfg`, `stream-plan.cfg`, `two-plan.cfg`, `small-plan.cfg` | Each world under the plan's axioms, with the rows that hold there and have something to judge there. The export script writes the other configurations it runs. |
| `conformance.json` | What TLC exported. Written by `scripts/tla-worker-hold-export.mjs`, by hand. The workflow `tla-checks.yml` checks it against TLC on every push to `main`. It records the SHA-256 of that script, of the modules it imports, of each `.tla` and `.cfg` file here and of the jar, and the suite fails when one of those files no longer matches. `../README.md` says how to regenerate and check it. |

## What the conformance suite holds

`scripts/tla-worker-hold-conformance.test.mjs`, with no Java:

- The hand-written model and the specification take the same steps. Each
  world's whole graph, with nothing assumed, is folded into a digest over its
  labels (a move's steps with what the thread posted and sent, then the
  switches that forbid it) and over what each worker landed as. The model's
  digest must be the one TLC's printed graph gave. A state's digest is SHA-256
  over its moves and the digests of the states they lead to, cut to 128 bits.
  Equal digests at the first states therefore show that the two graphs are
  bisimilar over those labels (every trace of the model is a trace of the
  specification and the other way, under every set of switches), unless two
  different digests collide. The equality is established by that truncated
  digest, and not by comparing the graphs edge by edge.
- The table TLC found is the register's, row by row and world by world, and
  under each of the 512 sets of switches the rows the model's own verdicts
  break are the rows TLC found broken.
- No row is listed as holding where it has nothing to judge, as the section
  above says. For each world it holds that no shared worker is excluded and
  that neither exclusion row is listed anywhere.
- TLC's traces replay through the real thread, its in-process transport, the
  real mirror and the real readout, by `lib/fv-worker-model-replay.ts`: every
  label each world takes under the plan's axioms with C1 and D1, a trace that
  breaks each row the register says fails, and each form of the named trace,
  both released by the drain's end and still held at the bound.
  On each form of the named trace the real readout must land the worker
  unread, as `holdUnplaced`, and both exclusion rows are required of the term
  it counted.
- Three variants of the real readout, each with one exclusion of
  fingerprint-observer@13 put back in its compiled text, are each caught by
  an exclusion row on the named traces that go through the changed line, and
  on no other named trace.

### How far the real code is held

The first two points above hold the hand-written model to the specification
over each world's whole graph. The third is the only one that touches the real
code, and it holds the real code to the specification on the kept traces and
on nothing else. In the committed export those are:

| World | Covering traces | Labels they take, of the labels the world has with nothing assumed | Traces that break a row | Traces to a form of the named trace |
|---|---|---|---|---|
| hold | 40 | 84 of 232 | 3 | 33 |
| stream | 13 | 31 of 78 | 4 | 0 |
| two | 23 | 57 of 59 | 2 | 0 |
| small | 19 | 43 of 45 | 0 | 0 |

The traces that break a row are fewer than they were through
fingerprint-observer@13 (9, from 14): the five that broke an exclusion row are
gone, because nothing breaks one now. The named trace has 33 kept traces, from
21: one for each form and cause, under each of the two sets of switches the
export keeps them for, and for each way the hold stood when the readout ended
(the mirror had heard the release, 12 traces, or still showed the worker held
at the bound, 21 traces). The two ends go through different lines of the
readout's classification. A worker read by the second pass, or frozen as
reaching, goes through its own line only when it is released by the end;
still held at the bound, it is seen held first and goes through the line for
a worker seen held. The three variants of the real readout are held to that:
each is caught on exactly the named traces that go through the line it
changes (4, 4 and 25 of the 33), and by the first exclusion row.

The labels taken are all the labels a world has under the plan's axioms with
C1 and D1, each taken once. A label the world has only with an axiom off is on
no covering trace. That replay is thin on purpose: one trace to a label, not
every sequence.

Two seeded faults of the real thread are pinned in the suite as not detected
by this replay: one acts on a word the model drops, which is no step of any
trace; one needs a session's words out of order at one point. The suite fails
if the kept traces start to tell either apart, so the limit stays on record.
The hand-written suite's own replay of the model catches both, and reaches
this specification only through the comparison of graphs.

## Not claimed

Anything about a browser: every switch is an assumption. Any world, alphabet
or bound outside the four configurations. The dedicated world, and A4's own
row in it. The direction row. A command's own timeout, which the hand-written
model leaves out and this specification leaves out with it. What the real
code does on a sequence the specification has no move for.
