# TLA+ specifications

Two designs are stated here in TLA+ and model-checked with TLC, a checker this
project did not write:

- `case-machine/`: the investigation workspace's case and attempt machine.
- `worker-hold/`: the shared-worker hold, from the browser to the readout.

Each already has a hand-written exploration in TypeScript, and a row in
`docs/formal-verification.md`. These specifications are a second statement of
the same rules, in a language with published semantics.

## What this is, and what it is not

TLC model checking is exhaustive over a bounded model. A property here holds
over every state TLC reaches from the first state a configuration names, over
that configuration's alphabet and bounds, under the assumptions it sets.
Nothing is said of an input, a plan, a world or a bound outside a
configuration. It is not an argument for unbounded inputs, and no file here
claims one.

The specification is what TLC checks. The code is held to the specification by
trace conformance: a suite replays what TLC computed through the real code and
compares each step. That holds the code to the specification, and neither to a
browser. The assumptions of `worker-hold/` (A1 to A5) are assumptions about
Chromium. They are switches in the specification, and no run here measures
them.

## Tools

`tla-tools.json` pins one release of the TLA+ tools by its URL and SHA-256,
and the digest of each file TLC exported. The export scripts refuse any other
jar. TLC needs Java 11 or later; nothing here installs it.

CI has no Java. So each specification has two halves:

- An export script runs TLC and writes `conformance.json` beside the
  specification: counts, digests, traces and tables. With `--check` it writes
  nothing and fails on any byte that differs from the committed file.
- A conformance suite reads `conformance.json` and never starts Java. It fails
  if a specification file changed since the export, by its SHA-256.

```sh
# The conformance suites, as CI runs them (no Java):
npm run test:tla-case-machine
npm run test:tla-worker-hold

# Regenerate what TLC computes, or check it (Java and the pinned jar):
npx tsc -p tsconfig.investigation-test.json
node scripts/tla-case-machine-export.mjs --jar tla2tools.jar [--check]
npx tsc -p tsconfig.test.json
node scripts/tla-worker-hold-export.mjs --jar tla2tools.jar [--check]

# One TLC run by hand, on a configuration beside a specification:
cd specs/case-machine
java -cp tla2tools.jar tlc2.TLC -workers 2 -deadlock -config six-slots.cfg CaseMachineMC

# Seeded faults in a specification, each caught by the invariant named for it:
node scripts/tla-case-machine-mutations.mjs --jar tla2tools.jar
node scripts/tla-worker-hold-mutations.mjs --jar tla2tools.jar
```

`-deadlock` turns off TLC's deadlock check. Both specifications end in states
with no successor on purpose (a terminal case, a finished readout), and each
states what such a state must be as an invariant of its own.

## Reading a result

A count TLC reports (states generated, distinct states, depth) is a change
detector, as in the register. What a run establishes is that each invariant
its configuration lists held on every state it reached.
