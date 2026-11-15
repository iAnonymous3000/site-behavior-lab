// @ts-nocheck

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { pathToFileURL } from "node:url";

// The durable-soak collector (scripts/durable-soak-ledger.mjs) validates each
// GitHub artifact it is about to download, and the ledger verifier
// (scripts/durable-soak-ledger-lib.mjs) validates the same artifact again from
// the stored pages before anything is written. The collector used to carry its
// own copy of that check, whose id test compared a value with itself, so it
// accepted ids the verifier refuses and failed only after the downloads were
// spent. These tests hold one validator: the collector selects with the
// verifier's artifactIdentity and positiveInteger, and agrees with it.

let ledger: any;
let collector: any;
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const script = (name: string) => pathToFileURL(path.join(process.cwd(), "scripts", name)).href;
before(async () => {
  ledger = await nativeImport(script("durable-soak-ledger-lib.mjs"));
  collector = await nativeImport(script("durable-soak-ledger.mjs"));
});

const HEAD = "a".repeat(40);
const RUN_ID = 88000001;
const ATTEMPT = 1;
const ARTIFACT_ID = 99000001;
const DEEP_NAME = `site-behavior-production-health-evidence-${RUN_ID}-${ATTEMPT}`;
const RESTART_NAME = `site-behavior-durable-soak-restart-evidence-${RUN_ID}-${ATTEMPT}`;

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: ARTIFACT_ID,
    name: DEEP_NAME,
    expired: false,
    size_in_bytes: 1234,
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: RUN_ID, head_sha: HEAD },
    ...overrides
  };
}

const outcome = (run: () => unknown) => {
  try {
    run();
    return "accepted";
  } catch {
    return "refused";
  }
};

// Each case changes one field of a valid listed artifact.
const CASES: Array<[string, Record<string, unknown>, "accepted" | "refused"]> = [
  ["a valid artifact", {}, "accepted"],
  ["a string id", { id: String(ARTIFACT_ID) }, "refused"],
  ["id zero", { id: 0 }, "refused"],
  ["a negative id", { id: -1 }, "refused"],
  ["a fractional id", { id: 1.5 }, "refused"],
  ["a missing id", { id: null }, "refused"],
  ["an unsafe id", { id: Number.MAX_SAFE_INTEGER + 1 }, "refused"],
  ["an expired artifact", { expired: true }, "refused"],
  ["an empty artifact", { size_in_bytes: 0 }, "refused"],
  ["another run", { workflow_run: { id: RUN_ID + 1, head_sha: HEAD } }, "refused"],
  ["another head", { workflow_run: { id: RUN_ID, head_sha: "c".repeat(40) } }, "refused"],
  ["a bad digest", { digest: "sha256:XYZ" }, "refused"]
];

test("the collector's deep-artifact selection agrees with the ledger verifier", () => {
  for (const [label, overrides, expected] of CASES) {
    const listed = artifact(overrides);
    const selected = outcome(() =>
      collector.selectDurableSoakDeepArtifact([listed], { runId: RUN_ID, attempt: ATTEMPT, headSha: HEAD })
    );
    const verified = outcome(() => ledger.artifactIdentity(listed, RUN_ID, HEAD, "fixture artifact"));
    assert.equal(selected, expected, `collector, ${label}`);
    assert.equal(verified, expected, `verifier, ${label}`);
  }
  const identity = collector.selectDurableSoakDeepArtifact([artifact(), artifact({ name: "other", id: 7 })], {
    runId: RUN_ID,
    attempt: ATTEMPT,
    headSha: HEAD
  });
  assert.deepEqual(identity, { id: ARTIFACT_ID, name: DEEP_NAME, sha256: "b".repeat(64), sizeBytes: 1234 });
  assert.throws(
    () => collector.selectDurableSoakDeepArtifact([artifact(), artifact()], { runId: RUN_ID, attempt: ATTEMPT, headSha: HEAD }),
    /has no exact evidence artifact/
  );
});

test("the restart artifact is the exact id the operator selected", () => {
  const select = (artifacts: unknown[], artifactId = ARTIFACT_ID) =>
    collector.selectDurableSoakRestartArtifact(artifacts, { runId: RUN_ID, runAttempt: ATTEMPT, headSha: HEAD, artifactId });
  for (const [label, overrides, expected] of CASES) {
    // Selection is by id, so an id change makes the artifact absent.
    assert.equal(outcome(() => select([artifact({ name: RESTART_NAME, ...overrides })])), expected, `restart, ${label}`);
  }
  assert.equal(select([artifact({ name: RESTART_NAME })]).id, ARTIFACT_ID);
  // The right name under another id is not the selected artifact.
  assert.throws(() => select([artifact({ name: RESTART_NAME, id: ARTIFACT_ID + 1 })]), /not unique in its source run/);
  assert.throws(() => select([artifact({ name: DEEP_NAME })]), /must be named/);
  assert.throws(() => select([artifact({ name: RESTART_NAME }), artifact({ name: RESTART_NAME })]), /not unique/);
});

test("only command-line values are converted from text", () => {
  // The verifier refuses a GitHub id delivered as text; the collector must not
  // convert one on the way in.
  assert.throws(() => ledger.positiveInteger("123", "fixture id"), /positive safe integer/);
  const options = collector.parseOptions([
    "--start-at", "2026-11-01T00:00:00.000Z",
    "--end-at", "2026-11-02T00:00:00.000Z",
    "--restart-run-id", String(RUN_ID),
    "--restart-run-attempt", "2",
    "--restart-artifact-id", String(ARTIFACT_ID),
    "--output", path.join(process.cwd(), "durable-soak-fixture-output")
  ]);
  assert.equal(options.restartRunId, RUN_ID);
  assert.equal(options.restartRunAttempt, 2);
  assert.equal(options.restartArtifactId, ARTIFACT_ID);
  for (const [flag, value] of [["--restart-run-id", "0"], ["--restart-run-attempt", "21"], ["--restart-artifact-id", "01"]]) {
    const args = [
      "--start-at", "2026-11-01T00:00:00.000Z",
      "--end-at", "2026-11-02T00:00:00.000Z",
      "--restart-run-id", String(RUN_ID),
      "--restart-run-attempt", "2",
      "--restart-artifact-id", String(ARTIFACT_ID),
      "--output", path.join(process.cwd(), "durable-soak-fixture-output")
    ];
    args[args.indexOf(flag) + 1] = value;
    assert.throws(() => collector.parseOptions(args), /positive safe integer/, `${flag} ${value}`);
  }

  const source = readFileSync(path.join(process.cwd(), "scripts", "durable-soak-ledger.mjs"), "utf8");
  const parseStart = source.indexOf("\nfunction parseOptions(args) {");
  const parseEnd = source.indexOf("\n}\n", parseStart);
  assert.ok(parseStart > 0 && parseEnd > parseStart, "parseOptions could not be located");
  const calls = [...source.matchAll(/positiveIntegerArgument\(/g)].map((match) => match.index ?? -1);
  const definition = source.indexOf("function positiveIntegerArgument(");
  const uses = calls.filter((index) => index !== definition + "function ".length);
  assert.equal(uses.length, 3, "the three restart flags are the only text-converted integers");
  for (const index of uses) {
    assert.ok(index > parseStart && index < parseEnd, "positiveIntegerArgument may be used only for command-line values");
  }
});

test("the collector keeps no validator copy of its own", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts", "durable-soak-ledger.mjs"), "utf8");
  for (const name of ["artifactIdentity", "positiveInteger", "digest"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`),
      `scripts/durable-soak-ledger.mjs defines its own ${name}`
    );
  }
  const imports = source.match(/^import \{([^}]*)\} from "\.\/durable-soak-ledger-lib\.mjs";$/m);
  assert.ok(imports, "the collector must import from the ledger lib");
  const names = imports[1].split(",").map((name) => name.trim());
  assert.ok(names.includes("artifactIdentity") && names.includes("positiveInteger"), "the collector must import both validators");
});
