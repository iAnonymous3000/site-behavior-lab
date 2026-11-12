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
| F4-AGE | `ReadNoOlderThanTheFreeze` | A shared worker the readout reads is read at a state no older than the freeze. |
| F4-TERM, first half | `HeardLandsInOneTerm` | Every shared worker the readout heard of lands in exactly one term. A landing is one term by construction; TLC holds that it is one of the named terms. |
| F4-TERM, second half | not stated | Where @12 lands a worker apart from @11: the row rests on a restated old rule, and a third copy of it here would be bound to nothing. |
| the exclusion rows | `ExcludedRanNothing`, `ExcludedRanNothingUnobserved` | A worker the readout excludes as held ran no page code (the second: none with no observer in) before the freeze. |
| the no-term row | `RanLandsInATerm` | A worker that ran before the freeze, with the attacher alive, lands in a term. |
| F4-TABLE | `WorkerHoldTable.tla` | Each row under every set of switches, from one search that carries the switches a path broke. That a larger set keeps what a smaller one kept is how the switches are built, not a check. |
| F4-BEYOND | `NamedForm`, `NamedCause` in `WorkerHoldTable.tla` | The named trace: a worker that ran unobserved before the freeze, which the mirror does not yet call late, on the step that ends the readout and excludes it. |

## Files

| File | What it is |
|---|---|
| `WorkerHold.tla` | The protocol, the classification and the rows. |
| `WorkerHoldTable.tla` | The axiom table in one search, and the named trace. |
| `WorkerHoldExport.tla` | Prints the whole graph of a world. Not a property. |
| `hold-plan.cfg`, `stream-plan.cfg`, `two-plan.cfg`, `small-plan.cfg` | Each world under the plan's axioms, with the rows the register says hold there. The export script writes the other configurations it runs. |
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
