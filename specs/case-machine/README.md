# The case machine in TLA+

`CaseMachine.tla` states the case and attempt machine of
`investigation/core/case-machine.ts` from its rules: the header of that file,
the docblock of `investigation/core/purge.ts`, and the rule text the
exploration suite quotes. It is not a line by line copy of the TypeScript: it
is two operators, `Accepts(S, e)` and `After(S, e)`, written from those rules
by an author who had read the code, and the next-state relation takes each
event of the alphabet the state accepts.

Its domain is that of register rows F5-M, F5-S and F5-P in
`docs/formal-verification.md`: the full promised plan (slots B1 to B3 and I1 to
I3) and the four smaller plans, over the same event alphabet (92 events on the
six-slot plan), under the same caps (2 control misses, 2 start retries, 1
configuration change), and the purge slice over three paths.

## Files

| File | What it is |
|---|---|
| `CaseMachine.tla` | The machine, its views, and its properties. |
| `CaseMachineMC.tla` | The five plans the configurations name. |
| `six-slots.cfg` | Row F5-M: the six-slot plan, every property. The purge pairing holds no manifest, every path present, and every path absent. |
| `instrumented.cfg`, `baseline.cfg`, `one-each.cfg`, `two-each.cfg` | Row F5-S: the smaller plans, every property, with every manifest the slice reaches. |
| `PurgeSlice.tla`, `purge-slice.cfg` | Row F5-P: the purge events alone, from no manifest, open and closed. |
| `CaseMachineExport.tla` | Prints what the conformance suite compares the code with. Not a property. |
| `conformance.json` | What TLC exported. Written by `scripts/tla-case-machine-export.mjs`. |

## Where it differs from the TypeScript on purpose

- The plan's digest is a flag, and a configuration is one of two names. One
  digest and two keys are walked, as in the suite.
- Evidence ids are not modeled. `evidence-recorded` appears only as a body the
  authority probes send.
- Refusal reasons are not modeled, the purge reducer's aside. The exploration
  suite compares refusals between two calls of production in two properties
  (the actors a rule allows; unresolved cleanup): that half is not stated here.
- The record events of `evidence-model.ts` (`applyRecordEvent`) are not in the
  specification, so the half of the authority sentence that reads them is not
  stated here.
- Three guards are written as the rule text words them, where the code words
  them otherwise: a configuration change is refused once the rule is recorded
  (the code refuses once it is met; a rule not met has closed the case); an
  instrumented visit needs the rule met where both arms are planned (the code
  refuses while it is pending); a visit spends the exception recorded for it
  (the code clears whichever is pending). On the five plans the two wordings
  give the same transitions: the conformance suite holds that.
- `ruleMetUnder` is a history field: the configuration in force when the rule
  was recorded as met. No guard reads it, and it splits no state: TLC finds
  the same count of distinct states as the suite's walk.

## The properties of row F5-M

Each sentence of the row, the name it has in `CaseMachine.tla`, and how it is
held. "TLC" means an invariant TLC checks on every state it reaches. A property
of transitions is written as an invariant of the state it leaves from, over
every event that state accepts and the state that event leaves, so TLC holds
it on every transition and the event is in hand. "Conformance" means the
sentence is about the code, and `scripts/tla-case-machine-conformance.test.mjs`
holds the code to the specification.

| # | Sentence of F5-M | In TLA+ | Held by |
|---|---|---|---|
| 1 | every state the walk reaches lies inside the domain its key encodes | `Domain` | TLC |
| 2 | each event is accepted exactly when the rule W2 states for it holds | `Accepts` | Not an invariant: in the specification the rule is the definition. Conformance holds the code to it, on every reachable state and every event of the alphabet. |
| 3 | an accepted event changes exactly the fields W2's rule for it names, to the values it names | `After` | As 2: conformance compares the state every accepted event leaves. |
| 4 | retry counters are what the accepted events count, and stay within their caps | `CapsState`, `CapsStep` | TLC |
| 5 | the gate and the rule hold what the accepted events made them, and a closed case keeps no gate | `GateState`, `GateStep` | TLC |
| 6 | a case is closed exactly when no slot is planned or running, and a slot closed unstarted carries the configuration in force | `ClosedExactly` | TLC |
| 7 | a closed case never reopens: its closure never changes, and nothing but cleanup changes after it | `ClosedStays` | TLC |
| 8 | the baseline rule, once recorded, never changes | `RuleFixed` | TLC |
| 9 | cleanup changes only by the events that name it, and reconcile reads what it states | `CleanupState`, `CleanupStep` | TLC |
| 10 | a begun attempt ran under the configuration in force when it began, and that never changes | `RanUnder` | TLC |
| 11 | denominatorOf agrees with the phases | `Denominator`, `DenominatorAdds` | The view is defined from the rule; TLC holds the rule's equation. That the code's `denominatorOf` gives this view on every reachable state: conformance. |
| 12 | isTerminal agrees with closed and no cleanup pending | `Terminal`, `TerminalIsQuiet` | The view is the rule's words; TLC holds that a terminal state accepts nothing but a cleanup event. Agreement of the code's `isTerminal`: conformance. |
| 13 | continuationOf agrees with an open case and its unresolved cleanup | `Continuation`, `ContinuationReads` | The view is the rule's words; TLC holds that a blocked continuation starts no visit. Agreement of the code's `continuationOf`: conformance. |
| 14 | at most one attempt runs | `OneRuns` | TLC |
| 15 | an arm never changes | `ArmState`, `ArmStep` | TLC |
| 16 | instrumented waits on baseline's rule, and begins under the configuration it was met under | `Waits` | TLC |
| 17 | a terminal attempt never reopens | `TerminalStays` | TLC |
| 18 | continuation blocks on unresolved cleanup | `Blocks` | TLC |
| 19 | unresolved cleanup changes no acquisition | `Acquisition` | TLC, the equality of refusal reasons aside |
| 20 | a purge answers as the restated reducer does on the closed flag and the manifest, and changes nothing else, and nothing else reads the manifest | `PurgeSlice` | TLC, with the reducer's rule restated apart from `PurgeRule`. The code's refusals and manifests: conformance. |
| 21 | an event from an actor the rule does not allow is refused | `Authority` | TLC, for the machine's events. Record events are not stated. |
| 22 | the actors a rule allows get the same answer | `Interchangeable` | TLC, the equality of refusal reasons aside |
| 23 | a visit begins only on a met control for the configuration in force, or on the owner's exception for it | `ControlGate` | TLC |
| 24 | an exception is recorded only for a visit that has not begun | `ExceptionFirst` | TLC |
| 25 | the exploratory mark is on exactly when an exception was recorded | `Mark` | TLC |
| 26 | without the purge slice, no event returns to a state | `Acyclic` | TLC, in a stronger form: a measure every accepted event raises |
| 27 | every sink is terminal | `Sinks` | TLC |
| 28 | a supervisor's event is accepted from every non-terminal state | `Supervisor` | TLC |

Row F5-P's two sentences are `SliceAnswers` and `SummaryOnlyExactly` in
`PurgeSlice.tla`. Row F5-S is the same invariants under the four smaller
configurations.

## What the conformance suite holds

- For each of the five plans, the real machine's reachable transitions over
  the suite's own alphabet are the specification's: the same states, the same
  accepted events from each, the same state each leaves, and the same views.
  It is a comparison of counts and an order-free digest of SHA-256 values; the
  export script compares line by line whenever it runs.
- TLC's traces, one transition of every class the specification's relation
  holds, replay through the real `step` state by state, on the six-slot plan
  and the two smallest.
- Every probe the specification's authority table refuses is refused by the
  real `step`: on every reachable state of the two smallest plans, and on
  every node of the six-slot traces.
- The real `purgeStep` and `retentionTier` answer as the specification's
  reducer on every pairing of the slice, and through the real `step` on every
  reachable state of the two smallest plans with every manifest.
- Each of its variants of the real machine fails the relation check.

## Not claimed

Any plan, alphabet or cap outside the configurations. Any wall-clock bound.
Evidence ids, digests and identities. That alarms arrive and that a store
accepts a write. Anything about the fold (`case-store.ts`), the log or the
readings: rows F5-F to F5-R5 are not specified here.
