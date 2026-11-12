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
| the exclusion rows | `ExcludedRanNothing`, `ExcludedRanNothingUnobserved` | A worker the readout excludes as held ran no page code (the second: none with no observer in) before the freeze. |
| the no-term row | `RanLandsInATerm` | A worker that ran before the freeze, with the attacher alive, lands in a term. |
| F4-TABLE | `WorkerHoldTable.tla` | Each row under every set of switches, from one search that carries the switches a path broke. That a larger set keeps what a smaller one kept is how the switches are built, not a check. |
| F4-BEYOND | `NamedForm`, `NamedCause` in `WorkerHoldTable.tla` | The named trace: a worker that ran unobserved before the freeze, which the mirror does not yet call late, on the step that ends the readout and excludes it. |

## Where a row can be judged, and where it cannot

A row of the form "a worker that lands so had this fact" passes in a world
where no worker lands so, and in a world where no worker has the fact that
would break it. It passes there whatever the protocol does, so its passing is
no evidence about the protocol.

That is the case for four rows in the stream world. Its one worker starts
released, with its observer in, having run, and known to the mirror. So in
that world:

- No worker is ever excluded. The two exclusion rows have no worker to judge.
- No worker ever lands nowhere, because the mirror knows the worker from the
  first state. The no-term row cannot fail.
- No worker ever runs with no observer in. F4-READ cannot fail.

These four rows are therefore not listed for the stream world: not in
`stream-plan.cfg`, not in the export script's table of cells, and not in the
suite's copy of the register's table. The register's table gives each of them
"holds under no axiom" in the stream world. TLC's table agrees, and the
sentence is true, but it carries no information. The rows that the stream
world does judge are F4-AGE and the first half of F4-TERM. The four rows are
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
for each cell of its copy of the register's table. It also holds that the four
rows above in the stream world, and F4-AGE in the three worlds with no stream,
are the only rows with nothing to judge.

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
| `ExcludedRanNothing` | A worker that lands in an excluded term ran no page code before the freeze. | behavioural, in the hold, two-worker and small worlds. It fails under the plan's axioms, and holds with Z (with A5's order half as well in the hold and two-worker worlds). | One in the protocol: a worker the mirror calls late at the freeze is excluded as held. The second exclusion row catches the same fault, and each catches it without the other. |
| `ExcludedRanNothingUnobserved` | A worker that lands in an excluded term ran no page code with no observer in before the freeze. | behavioural, in the same worlds. | The same fault. No seeded fault separates this row from the first. |
| `ReadHadItsObserver` | A worker that lands in a read term never ran with no observer in. | behavioural, in the hold, two-worker and small worlds. | One in the protocol: the thread makes nothing of a resume while it holds a worker. |
| `ReadNoOlderThanTheFreeze` | A worker that lands in a read term is read at a snapshot no older than the realm's at the freeze, and at the close of a task that was open then. | behavioural, in the stream world only. | Three in the protocol. |
| `HeardLandsInOneTerm` | A worker the mirror heard of lands in one of the named terms, and a worker it never heard of lands as unattached or nowhere. | definitional. `Landing` returns one of a fixed set of strings and "heard" is the mirror's own flag, so it fails only if `Landing` is given a term name that is in no set. The register says the same of the hand-written model. | One, of that kind: a term renamed in `Landing`. |
| `RanLandsInATerm` | No worker lands nowhere having run before the freeze with the attacher alive. | behavioural, in the hold world under D1, and in the hold and two-worker worlds under Z. | Two. One weakens what D1 forbids, which is an assumption and not the protocol. One is in the protocol: the mirror makes nothing of a worker's attach. |

The reachability companions (`NoWorkerExcluded` and the others) are not in this
table. They are not claims: each must be violated, and says so where it is
defined.

`scripts/tla-worker-hold-mutations.mjs` seeds these ten faults, each run with
only the row named for it, under a set of switches where the committed
specification keeps the row. A caught fault shows that the row can fail there.
No committed artifact records the result, and no CI stage runs the script: it
needs TLC.

Two terms are named in the term sets and never produced: `diedPaused` and
`ownerUnscoped`. No operator of the specification returns either, so no
exclusion row is ever judged on the first and no read row on the second.
`WorkerHold.tla` says so where the sets are defined.

## Files

| File | What it is |
|---|---|
| `WorkerHold.tla` | The protocol, the classification and the rows. |
| `WorkerHoldTable.tla` | The axiom table in one search, and the named trace. |
| `WorkerHoldExport.tla` | Prints the whole graph of a world. Not a property. |
| `hold-plan.cfg`, `stream-plan.cfg`, `two-plan.cfg`, `small-plan.cfg` | Each world under the plan's axioms, with the rows that hold there and have something to judge there. The export script writes the other configurations it runs. |
| `conformance.json` | What TLC exported. Written by `scripts/tla-worker-hold-export.mjs`. |

## What the conformance suite holds

`scripts/tla-worker-hold-conformance.test.mjs`, with no Java:

- The hand-written model and the specification take the same steps. Each
  world's whole graph, with nothing assumed, is folded into a digest over its
  labels (a move's steps with what the thread posted and sent, then the
  switches that forbid it) and over what each worker landed as. The model's
  digest must be the one TLC's printed graph gave, so the two are bisimilar
  over those labels: every trace of the model is a trace of the specification
  and the other way, under every set of switches.
- The table TLC found is the register's, row by row and world by world, and
  under each of the 512 sets of switches the rows the model's own verdicts
  break are the rows TLC found broken.
- No row is listed as holding where it has nothing to judge, as the section
  above says.
- TLC's traces replay through the real thread, its in-process transport, the
  real mirror and the real readout, by `lib/fv-worker-model-replay.ts`: every
  label each world takes under the plan's axioms with C1 and D1, a trace that
  breaks each row the register says fails, and each form of the named trace.

That replay is thin on purpose: one trace to a label, not every sequence. The
suite pins two faults of the real thread that it cannot tell from the real one
(one acts on a word the model drops, which is no step of any trace; one needs
a session's words out of order at one point). The hand-written suite's own
replay of the model catches both, and reaches this specification only through
the comparison of graphs.

## Not claimed

Anything about a browser: every switch is an assumption. Any world, alphabet
or bound outside the four configurations. The dedicated world, and A4's own
row in it. The direction row. A command's own timeout, which the hand-written
model leaves out and this specification leaves out with it. What the real
code does on a sequence the specification has no move for.
