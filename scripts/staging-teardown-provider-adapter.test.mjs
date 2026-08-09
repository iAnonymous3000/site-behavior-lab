import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  resolveStagingTeardownProviderAdapter,
  runStagingTeardown,
  validateStagingTeardownProviderAdapter
} from "./staging-teardown-provider-adapter.mjs";

const SESSION = {
  id: "6f1d9c2a-7b3e-4d5f-8a1b-2c3d4e5f6a7b",
  startedAt: "2026-08-01T14:00:00.000Z",
  inventoryBeforeAt: "2026-08-01T14:00:01.000Z",
  inventoryAfterAt: "2026-08-01T14:00:03.000Z",
  completedAt: "2026-08-01T14:00:04.000Z"
};
const COMMIT = "c".repeat(40);
const RESOURCES = [
  { kind: "worker", logicalName: "scanner-staging", removalDisposition: "deleted" },
  { kind: "dns", logicalName: "scan-staging.example.test", removalDisposition: "deleted" }
];

/** An adapter that behaves, driven entirely by a scripted state table. */
function fakeAdapter(states) {
  const calls = { observe: [], remove: [] };
  const remaining = new Map(Object.entries(states));
  return {
    calls,
    adapter: {
      kind: "fake",
      async observe(logicalName) {
        calls.observe.push(logicalName);
        const state = remaining.get(logicalName);
        return {
          state,
          externalIds: state === "present" ? [`id:${logicalName}`] : [],
          evidence: { kind: "provider-inventory-response", logicalName, state }
        };
      },
      async remove(logicalName) {
        calls.remove.push(logicalName);
        remaining.set(logicalName, "absent");
        return { evidence: { kind: "provider-removal-response", logicalName } };
      }
    }
  };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-08-01T14:00:02.000Z") + tick++).toISOString();
}

test("no provider adapter is registered, and that is deliberate", () => {
  for (const kind of ["cloudflare", "github", "", null, undefined]) {
    assert.throws(
      () => resolveStagingTeardownProviderAdapter(kind),
      /no reviewed staging teardown provider adapter is registered/
    );
  }
});

test("the executable capture still refuses unconditionally", () => {
  // The seam existing must not be mistaken for the capability existing.
  const capture = readFileSync(
    path.join(process.cwd(), "scripts", "staging-teardown-hosted-capture.mjs"),
    "utf8"
  );
  assert.match(capture, /no reviewed multi-provider staging teardown capture adapter is committed/);
  assert.match(capture, /function captureRefusal\(\)/);
  // The refusal must remain unconditional: no branch may reach a capture path.
  assert.doesNotMatch(capture, /resolveStagingTeardownProviderAdapter/);
  assert.doesNotMatch(capture, /runStagingTeardown/);
});

test("a teardown observes, removes only what was present, and re-observes", async () => {
  const { adapter, calls } = fakeAdapter({
    "scanner-staging": "present",
    "scan-staging.example.test": "present"
  });
  const transcript = await runStagingTeardown({
    adapter,
    resources: RESOURCES,
    session: SESSION,
    stagingSourceCommit: COMMIT,
    now: clock()
  });

  assert.equal(transcript.inventory.before.length, 2);
  assert.equal(transcript.inventory.actions.length, 2);
  assert.equal(transcript.inventory.after.length, 2);
  assert.deepEqual(
    transcript.inventory.actions.map((action) => action.disposition),
    ["deleted", "deleted"]
  );
  // Observed twice per resource, removed once each.
  assert.equal(calls.observe.length, 4);
  assert.deepEqual(calls.remove, ["scanner-staging", "scan-staging.example.test"]);
  assert.equal(transcript.stagingSourceCommit, COMMIT);
});

test("remove() is never called on a resource that was not observed present", async () => {
  // Most providers answer a delete of an absent resource with success, so
  // calling it anyway would let a transcript claim a teardown that never
  // happened.
  const { adapter, calls } = fakeAdapter({
    "scanner-staging": "absent",
    "scan-staging.example.test": "present"
  });
  const transcript = await runStagingTeardown({
    adapter,
    resources: RESOURCES,
    session: SESSION,
    stagingSourceCommit: COMMIT,
    now: clock()
  });

  assert.deepEqual(calls.remove, ["scan-staging.example.test"]);
  assert.deepEqual(
    transcript.inventory.actions.map((action) => action.disposition),
    ["already-absent", "deleted"]
  );
  assert.deepEqual(transcript.inventory.actions[0].externalIds, []);
});

test("a resource still present after removal fails the ceremony", async () => {
  // A removal call that returned success proves an API accepted a request, not
  // that the resource is gone. The second inventory is the only thing that can
  // say so, and it must be believed over the removal response.
  const adapter = {
    kind: "stubborn",
    async observe(logicalName) {
      return {
        state: "present",
        externalIds: [`id:${logicalName}`],
        evidence: { kind: "provider-inventory-response", logicalName }
      };
    },
    async remove(logicalName) {
      return { evidence: { kind: "provider-removal-response", logicalName } };
    }
  };
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: RESOURCES,
      session: SESSION,
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /is still present after teardown; the ceremony did not complete/
  );
});

test("a malformed adapter is refused before any resource is touched", async () => {
  assert.throws(() => validateStagingTeardownProviderAdapter(null), /must be an object/);
  assert.throws(() => validateStagingTeardownProviderAdapter({}), /bounded kind/);
  assert.throws(
    () => validateStagingTeardownProviderAdapter({ kind: "x", observe() {} }),
    /must implement remove\(\)/
  );

  let touched = false;
  await assert.rejects(
    runStagingTeardown({
      adapter: {
        kind: "x",
        observe() {
          touched = true;
          return {};
        }
      },
      resources: RESOURCES,
      session: SESSION,
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /must implement remove\(\)/
  );
  assert.equal(touched, false, "validation must precede any provider interaction");
});

test("malformed adapter observations are refused rather than recorded", async () => {
  const cases = [
    [{ state: "maybe", externalIds: [], evidence: {} }, /must report present or absent/],
    [{ state: "present", externalIds: "no", evidence: {} }, /string external ids/],
    [{ state: "present", externalIds: [], evidence: null }, /must carry provider evidence/],
    [{ state: "absent", externalIds: ["id:leftover"], evidence: {} }, /reported absent with external ids/]
  ];
  for (const [observation, expected] of cases) {
    await assert.rejects(
      runStagingTeardown({
        adapter: {
          kind: "bad",
          async observe() {
            return observation;
          },
          async remove() {
            return { evidence: {} };
          }
        },
        resources: RESOURCES,
        session: SESSION,
        stagingSourceCommit: COMMIT,
        now: clock()
      }),
      expected
    );
  }
});

test("the ceremony must declare a scope, and an injected clock", async () => {
  const { adapter } = fakeAdapter({});
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: [],
      session: SESSION,
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /must declare at least one resource in scope/
  );
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: RESOURCES,
      session: SESSION,
      stagingSourceCommit: COMMIT
    }),
    /requires an injected clock/
  );
});

test("the closure lists must be extended at the moment the capture imports this seam", () => {
  // Three hand-maintained lists must agree on the producer's source closure:
  // STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS, the hosted collection
  // contract's trustedSourcePaths, and the measurement binding's copy.
  //
  // This module is deliberately NOT in them yet, because the capture does not
  // import it: the refusal is retained, so the seam is not part of any closure
  // the producer executes, and pinning its digest would claim otherwise. The
  // moment a reviewed adapter lands and the capture imports this file, it
  // becomes closure and all three lists must move together. This fails then,
  // rather than leaving an unpinned file inside an attested producer.
  const seam = "scripts/staging-teardown-provider-adapter.mjs";
  const importers = ["scripts/staging-teardown-hosted-capture.mjs", "scripts/staging-teardown-hosted-capture-lib.mjs"];
  const importsSeam = importers.some((file) =>
    /staging-teardown-provider-adapter\.mjs/.test(
      readFileSync(path.join(process.cwd(), file), "utf8")
    )
  );

  // Only files that hold the path as a LITERAL. hosted-evidence-provenance-lib
  // derives its list from the capture lib's constant, so demanding a literal
  // there would be unsatisfiable and the future branch would be unreachable.
  const listSources = [
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "lib/measurement-candidate-binding.ts"
  ];
  const listed = listSources.filter((file) =>
    readFileSync(path.join(process.cwd(), file), "utf8").includes(`"${seam}"`)
  );

  if (importsSeam) {
    assert.deepEqual(
      listed,
      listSources,
      "the capture now imports the adapter seam, so every producer-closure list must name it"
    );
  } else {
    assert.deepEqual(
      listed,
      [],
      "the seam is not imported by the capture, so it must not claim closure membership"
    );
  }
});

test("this module performs no network call and holds no credential", () => {
  const source = readFileSync(
    path.join(process.cwd(), "scripts", "staging-teardown-provider-adapter.mjs"),
    "utf8"
  );
  for (const forbidden of [/\bfetch\(/, /node:https/, /process\.env\./, /API_TOKEN/]) {
    assert.doesNotMatch(source, forbidden, `the seam must stay free of ${forbidden}`);
  }
});
