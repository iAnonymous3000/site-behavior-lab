import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  resolveStagingTeardownProviderAdapter,
  runStagingTeardown,
  validateStagingTeardownProviderAdapter
} from "./staging-teardown-provider-adapter.mjs";
import {
  buildStagingTeardownEvidence,
  STAGING_RESOURCE_CONTRACT
} from "./staging-teardown-evidence-lib.mjs";
import { serializeCanonicalEvidence } from "./operator-evidence-common.mjs";

const SESSION_ID = "6f1d9c2a-7b3e-4d5f-8a1b-2c3d4e5f6a7b";
const COMMIT = "c".repeat(40);
const TARGET_MANIFEST_SHA256 = "f".repeat(64);

function artifact(kind, logicalName, state = "accepted") {
  return {
    kind,
    sessionId: SESSION_ID,
    bytes: serializeCanonicalEvidence({ logicalName, state })
  };
}

function fakeAdapter({ present = [STAGING_RESOURCE_CONTRACT[0].logicalName], stubborn = null } = {}) {
  const remaining = new Set(present);
  const calls = { observe: [], remove: [] };
  return {
    calls,
    adapter: {
      kind: "fake-exact",
      removalOrder: [...STAGING_RESOURCE_CONTRACT].reverse().map((resource) => resource.logicalName),
      async observe(logicalName, { phase }) {
        calls.observe.push(`${phase}:${logicalName}`);
        const state = remaining.has(logicalName) ? "present" : "absent";
        return {
          state,
          externalIds: state === "present" ? [`id:${logicalName}`] : [],
          evidence: artifact("provider-inventory-response", logicalName, state)
        };
      },
      async remove(logicalName) {
        calls.remove.push(logicalName);
        if (logicalName !== stubborn) remaining.delete(logicalName);
        return { evidence: artifact("provider-removal-response", logicalName) };
      }
    }
  };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-08-01T14:00:00.000Z") + tick++).toISOString();
}

test("the exact twelve-resource ceremony inventories before mutation and proves absence after", async () => {
  const participating = [
    STAGING_RESOURCE_CONTRACT[0].logicalName,
    STAGING_RESOURCE_CONTRACT.at(-1).logicalName
  ];
  const { adapter, calls } = fakeAdapter({ present: participating });
  const transcript = await runStagingTeardown({
    adapter,
    resources: STAGING_RESOURCE_CONTRACT,
    session: { id: SESSION_ID },
    stagingSourceCommit: COMMIT,
    now: clock()
  });

  assert.equal(transcript.inventory.before.length, 12);
  assert.equal(transcript.inventory.actions.length, 12);
  assert.equal(transcript.inventory.after.length, 12);
  assert.deepEqual(
    transcript.inventory.actions.map((action) => action.logicalName),
    STAGING_RESOURCE_CONTRACT.map((resource) => resource.logicalName),
    "receipt action order remains canonical even though deletion order is dependency-driven"
  );
  assert.deepEqual(
    calls.remove,
    [...participating].reverse(),
    "only observed-present resources are removed, in the adapter's declared order"
  );
  const firstRemoveCall = calls.observe.length / 2;
  assert.deepEqual(
    calls.observe.slice(0, firstRemoveCall),
    STAGING_RESOURCE_CONTRACT.map((resource) => `before:${resource.logicalName}`),
    "every before observation completes before remove is entered"
  );

  const receipt = buildStagingTeardownEvidence({
    sourceBytes: Buffer.from(serializeCanonicalEvidence({
      ...transcript,
      targetManifestSha256: TARGET_MANIFEST_SHA256
    }), "utf8")
  });
  assert.equal(receipt.stagingSourceCommit, COMMIT);
  assert.equal(receipt.session.id, SESSION_ID);
  assert.equal(receipt.targetManifestSha256, TARGET_MANIFEST_SHA256);

  for (const invalid of [undefined, "0".repeat(63), "G".repeat(64)]) {
    const candidate = { ...transcript };
    if (invalid !== undefined) candidate.targetManifestSha256 = invalid;
    assert.throws(
      () => buildStagingTeardownEvidence({
        sourceBytes: Buffer.from(serializeCanonicalEvidence(candidate), "utf8")
      }),
      /targetManifestSha256/
    );
  }
});

test("an incomplete or reordered contract is refused before provider interaction", async () => {
  const { adapter, calls } = fakeAdapter();
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT.slice(1),
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /exactly 12 canonical resources/
  );
  assert.deepEqual(calls.observe, []);

  const reordered = [...STAGING_RESOURCE_CONTRACT];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: reordered,
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /teardown resource 0 must be exactly/
  );
  assert.deepEqual(calls.observe, []);
});

test("an all-absent inventory is refused before any removal", async () => {
  const { adapter, calls } = fakeAdapter({ present: [] });
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT,
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /already absent; refusing to claim or perform a teardown/
  );
  assert.deepEqual(calls.remove, []);
});

test("a provider acceptance is not treated as absence", async () => {
  const stubborn = STAGING_RESOURCE_CONTRACT[0].logicalName;
  const { adapter } = fakeAdapter({ present: [stubborn], stubborn });
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT,
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /is still present after teardown/
  );
});

test("action timestamps must remain monotonic across dependency order", async () => {
  const { adapter } = fakeAdapter();
  const values = [
    "2026-08-01T14:00:00.000Z",
    "2026-08-01T14:00:01.000Z",
    "2026-08-01T14:00:02.000Z",
    "2026-08-01T14:00:01.500Z"
  ];
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT,
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: () => values.shift() ?? "2026-08-01T14:00:03.000Z"
    }),
    /action clock moved backwards/
  );
});

test("malformed adapter evidence is rejected before mutation", async () => {
  let removeCalled = false;
  const adapter = {
    kind: "bad-evidence",
    async observe(logicalName) {
      return {
        state: "present",
        externalIds: [`id:${logicalName}`],
        evidence: { kind: "provider-inventory-response", sessionId: "wrong", bytes: "{}\n" }
      };
    },
    async remove() {
      removeCalled = true;
      return { evidence: {} };
    }
  };
  await assert.rejects(
    runStagingTeardown({
      adapter,
      resources: STAGING_RESOURCE_CONTRACT,
      session: { id: SESSION_ID },
      stagingSourceCommit: COMMIT,
      now: clock()
    }),
    /exact provider-inventory-response evidence for this session/
  );
  assert.equal(removeCalled, false);
});

test("adapter shape and exact provider kind fail closed", () => {
  assert.throws(() => validateStagingTeardownProviderAdapter(null), /must be an object/);
  assert.throws(() => validateStagingTeardownProviderAdapter({}), /bounded kind/);
  assert.throws(
    () => validateStagingTeardownProviderAdapter({ kind: "x", observe() {} }),
    /must implement remove\(\)/
  );
  assert.throws(
    () => resolveStagingTeardownProviderAdapter("cloudflare", {}),
    /unsupported staging teardown provider adapter kind/
  );
});

test("every executed staging producer module is in both source-closure copies", () => {
  const modules = [
    "scripts/staging-teardown-provider-adapter.mjs",
    "scripts/staging-teardown-provider-adapters.mjs",
    "scripts/staging-teardown-provider-http.mjs",
    "scripts/staging-teardown-target-projections.mjs",
    "scripts/staging-teardown-github-app-token.mjs"
  ];
  const listSources = [
    "scripts/staging-teardown-hosted-capture-lib.mjs",
    "lib/measurement-candidate-binding.ts"
  ];
  for (const source of listSources) {
    const text = readFileSync(path.join(process.cwd(), source), "utf8");
    for (const module of modules) {
      assert.ok(text.includes(`\"${module}\"`), `${source} must bind ${module}`);
    }
  }
});
