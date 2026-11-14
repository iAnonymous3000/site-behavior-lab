# TLA+ specifications

Two designs are stated here in TLA+ and model-checked with TLC, a checker this
project did not write:

- `case-machine/`: the investigation workspace's case and attempt machine.
- `worker-hold/`: the shared-worker hold, from the browser to the readout.

Each already has a hand-written exploration in TypeScript, with rows in
`docs/formal-verification.md` (F4 for the hold, F5 for the case machine).
These specifications are a second statement of the same rules, in a language
with published semantics. They have rows of their own there: TLA-HOLD,
TLA-HOLD-L, TLA-HOLD-N and TLA-HOLD-R for the hold, TLA-CASE for the case
machine, and TLA-EXPORT for the committed exports.

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
jar. TLC needs Java 11 or later; nothing in the unit tests installs it.

The unit tests have no Java. So each specification has two halves:

- An export script runs TLC and writes `conformance.json` beside the
  specification: counts, digests, traces and tables. With `--check` it writes
  nothing and fails on any byte that differs from the committed file.
- A conformance suite reads `conformance.json` and never starts Java.

### Where TLC runs

In the unit tests, and so in the required CI run, TLC's side of every
comparison is the committed export. A workflow of its own,
`.github/workflows/tla-checks.yml`, runs TLC on a hosted runner:

- On every push to `main`: the hold export with `--check`, and the hold
  specification's seeded faults.
- By schedule (weekly) and by hand: the same, and the case machine export
  with `--check` and its seeded faults. The case machine takes hours on a
  hosted runner, which is why it is not run on every push. It is to be
  dispatched at each release candidate.

That workflow downloads the jar pinned in `tla-tools.json` and the Java
runtime pinned in `tla-ci-runtime.json`, each refused unless its size and
SHA-256 are the pinned ones. It writes a receipt (the commit, the tools, each
check with its exit status and the digest of the export it compared), holds
the receipt to the commit, and a second job, which runs none of the commit's
code, signs it.

What that does and does not give:

- A check that passed shows that TLC, on that runner, from the files of that
  commit, wrote the committed export byte for byte, or caught each seeded
  fault. The exports were first written on another machine with another Java
  runtime, so a pass also shows the two agree.
- Nothing reads the workflow's conclusion. It is not a required check, no
  release gate reads the receipt, and a commit can be promoted while its run
  is red or still going. A push to `main` does not check the case machine at
  all.
- The signature shows which workflow run wrote the receipt. It does not show
  that TLC is right.
- The receipt records the fault runs only as a count in the script's last
  line and an exit status.

Between runs, what the unit tests can see is drift. Each export records the
SHA-256 of what it was produced by and from:

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
