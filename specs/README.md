# TLA+ specifications

One design is stated here in TLA+ and model-checked with TLC, a checker this
project did not write:

- `case-machine/`: the investigation workspace's case and attempt machine.

It already has a hand-written exploration in TypeScript, and rows in
`docs/formal-verification.md`. The specification is a second statement of the
same rules, in a language with published semantics.

## What this is, and what it is not

TLC model checking is exhaustive over a bounded model. A property here holds
over every state TLC reaches from the first state a configuration names, over
that configuration's alphabet and bounds, under the assumptions it sets.
Nothing is said of an input, a plan, a world or a bound outside a
configuration. It is not an argument for unbounded inputs, and no file here
claims one.

The specification is what TLC checks. The code is held to the specification by
trace conformance: a suite replays what TLC computed through the real code and
compares each step. That holds the code to the specification, and neither to
anything else.

## Tools

`tla-tools.json` pins one release of the TLA+ tools by its URL and SHA-256,
and the digest of each file TLC exported. The export scripts refuse any other
jar. TLC needs Java 11 or later; nothing here installs it.

CI has no Java. So a specification has two halves:

- An export script runs TLC and writes `conformance.json` beside the
  specification: counts, digests, traces and tables. With `--check` it writes
  nothing and fails on any byte that differs from the committed file.
- A conformance suite reads `conformance.json` and never starts Java. It fails
  if a specification file changed since the export, by its SHA-256.

```sh
# The conformance suite, as CI runs it (no Java):
npm run test:tla-case-machine

# Regenerate what TLC computes, or check it (Java and the pinned jar):
npx tsc -p tsconfig.investigation-test.json
node scripts/tla-case-machine-export.mjs --jar tla2tools.jar [--check]

# One TLC run by hand, on a configuration beside a specification:
cd specs/case-machine
java -cp tla2tools.jar tlc2.TLC -workers 2 -deadlock -config six-slots.cfg CaseMachineMC

# Seeded faults in a specification, each caught by the invariant named for it:
node scripts/tla-case-machine-mutations.mjs --jar tla2tools.jar
```

`-deadlock` turns off TLC's deadlock check. The specification ends in states
with no successor on purpose (a terminal case), and states what such a state
must be as an invariant of its own.

## Reading a result

A count TLC reports (states generated, distinct states, depth) is a change
detector, as in the register. What a run establishes is that each invariant
its configuration lists held on every state it reached.
