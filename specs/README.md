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

The specification is what TLC checks. How far the code is held to the
specification differs between the two, and each README says so in full.

- `case-machine/`: on each of the five plans, the real machine's whole
  reachable transition relation is compared with the specification's, by
  counts and a digest of SHA-256 values. That is every reachable state of
  those plans and every event of the alphabet, and nothing outside them.
- `worker-hold/`: the hand-written model's whole graph is compared with the
  specification's, in each of the four worlds, by a digest. The real code
  (the attacher's thread, the mirror and the readout) is held to the
  specification only on kept traces, which a suite replays through it. They
  are 40, 13, 23 and 19 covering traces in the hold, stream, two-worker and
  small worlds, 14 traces that each break a row, and 21 traces that each
  reach a form of the named trace. The covering traces take each label a world has under the plan's
  axioms with C1 and D1 once: 84, 31, 57 and 43 labels, where the worlds
  have 232, 78, 59 and 45 with nothing assumed. Two seeded faults of the
  real thread are pinned in the suite as not detected by that replay.

Where two graphs are called bisimilar here, the equality was established by
comparing digests cut to 128 bits, and not edge by edge. Equal digests show
it unless two different digests collide.

None of this holds the code or the specification to a browser. The
assumptions of `worker-hold/` (A1 to A5) are assumptions about Chromium. They
are switches in the specification, and no run here measures them.

## Tools

`tla-tools.json` pins one release of the TLA+ tools by its URL and SHA-256,
and the digest of each file TLC exported. The export scripts refuse any other
jar. TLC needs Java 11 or later; nothing here installs it.

CI has no Java. So each specification has two halves:

- An export script runs TLC and writes `conformance.json` beside the
  specification: counts, digests, traces and tables. With `--check` it writes
  nothing and fails on any byte that differs from the committed file.
- A conformance suite reads `conformance.json` and never starts Java.

### In CI, TLC's side is a committed file

No CI job runs TLC, and no CI job regenerates or checks `conformance.json`.
In CI, TLC's side of every comparison is the committed export, and a person
with Java and the jar regenerates it by hand. That TLC produced the file, and
what it reports TLC held, is the file's own word. CI cannot see it.

What CI can see is drift. Each export records the SHA-256 of what it was
produced by and from:

- `producedBy`: the export script, and each module it imports.
- `specification`: each `.tla` file.
- `configurations`: each committed `.cfg` file TLC ran.
- `tla2tools`: the jar.

The conformance suite computes the same digests from the files as they stand
and fails if one differs, so an export script, a specification or a
configuration that was edited after the export no longer passes with it. The
suite has no jar, so it holds the jar's recorded digest to the pin in
`tla-tools.json`. That pin and the digests of the two exports are stored
beside the files they describe: they stop an accidental edit, and nothing
more.

The two mutation scripts are in the same position, and weaker: they need TLC,
no CI stage runs them, and no committed file records their result.

### Regenerating and checking locally

Use the jar that `tla-tools.json` pins. Regenerate an export after any change
to a file it records, and commit the export with that change. To check that a
committed export is what TLC produces now, run the same command with
`--check`: it writes nothing, and fails on any byte that differs.

```sh
# The conformance suites, as CI runs them (no Java):
npm run test:tla-case-machine
npm run test:tla-worker-hold

# Regenerate what TLC computes, or check it (Java and the pinned jar).
# The case machine takes about an hour, nearly all of it the six-slot plan;
# the hold takes about ten minutes.
npx tsc -p tsconfig.investigation-test.json
node scripts/tla-case-machine-export.mjs --jar tla2tools.jar [--java /path/to/java] [--workers 2] [--check]
npx tsc -p tsconfig.test.json
node scripts/tla-worker-hold-export.mjs --jar tla2tools.jar [--java /path/to/java] [--workers 2] [--check]

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
