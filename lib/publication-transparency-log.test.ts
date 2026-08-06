import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTransparencyLogEntries,
  assertTransparencyLogHistory,
  buildTransparencyLog,
  parseTransparencyLog,
  transparencyLogEntryDigest,
  verifyTransparencyLogChain,
  TRANSPARENCY_LOG_CHAIN_ALGORITHM,
  TRANSPARENCY_LOG_SCHEMA,
  type TransparencyLogAddition,
  type TransparencyLogAnchor
} from "./publication-transparency-log";

const ID_A = `20260601-${"a".repeat(32)}`;
const ID_B = `20260602-${"b".repeat(32)}`;
const ID_C = `20260603-${"c".repeat(32)}`;

function addition(reportId: string, seed: string): TransparencyLogAddition {
  return {
    reportId,
    reportWireSha256: seed.repeat(64).slice(0, 64),
    publicDigest: seed.repeat(64).slice(0, 63) + "f"
  };
}

const A = addition(ID_A, "1");
const B = addition(ID_B, "2");
const C = addition(ID_C, "3");

function logOf(...additions: TransparencyLogAddition[]) {
  return buildTransparencyLog(appendTransparencyLogEntries([], additions));
}

function wireOf(...additions: TransparencyLogAddition[]): unknown {
  return JSON.parse(JSON.stringify(logOf(...additions))) as unknown;
}

test("the chain commits to order, and the head commits to the whole history", () => {
  const log = logOf(A, B, C);
  assert.equal(log.entryCount, 3);
  assert.equal(log.head, log.entries[2].entryDigest);
  assert.equal(log.entries[0].sequence, 0);

  verifyTransparencyLogChain(log);

  // Every entry after the first depends on its predecessor, so the same
  // publication at a different position is a different digest.
  const reordered = logOf(B, A, C);
  assert.notEqual(reordered.head, log.head);
  assert.notEqual(reordered.entries[0].entryDigest, log.entries[1].entryDigest);
});

test("an empty log has a null head rather than a digest of nothing", () => {
  const empty = buildTransparencyLog([]);
  assert.equal(empty.head, null);
  assert.equal(empty.entryCount, 0);
  verifyTransparencyLogChain(empty);
  assert.deepEqual(parseTransparencyLog(JSON.parse(JSON.stringify(empty))).entries, []);
});

test("the algorithm identity is inside the preimage, so redefining it cannot reuse old digests", () => {
  const digest = transparencyLogEntryDigest({
    previousEntryDigest: null,
    sequence: 0,
    reportId: ID_A,
    reportWireSha256: A.reportWireSha256,
    publicDigest: A.publicDigest
  });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(logOf(A).entries[0].entryDigest, digest);
  assert.equal(TRANSPARENCY_LOG_CHAIN_ALGORITHM, "sha256-canon-v1");
});

test("appending preserves the existing prefix byte for byte and skips already-logged reports", () => {
  const first = appendTransparencyLogEntries([], [A, B]);
  const second = appendTransparencyLogEntries(first, [A, B, C]);
  assert.equal(second.length, 3);
  assert.deepEqual(second.slice(0, 2), first);
  assert.equal(second[2].reportId, ID_C);

  // Re-running with no new publications is a no-op, not a rewrite.
  assert.deepEqual(appendTransparencyLogEntries(second, [A, B, C]), second);
});

test("a back-filled older publication appends rather than rewriting history", () => {
  const older = addition(`20260101-${"d".repeat(32)}`, "4");
  const existing = appendTransparencyLogEntries([], [B, C]);
  const withBackfill = appendTransparencyLogEntries(existing, [older]);
  assert.deepEqual(withBackfill.slice(0, 2), existing);
  assert.equal(withBackfill[2].reportId, older.reportId);
  verifyTransparencyLogChain(buildTransparencyLog(withBackfill));
});

test("editing any published digest breaks the chain at that entry", () => {
  const log = logOf(A, B, C);
  for (const field of ["reportWireSha256", "publicDigest"] as const) {
    const tampered = {
      ...log,
      entries: log.entries.map((entry, index) =>
        index === 1 ? { ...entry, [field]: "0".repeat(64) } : entry
      )
    };
    assert.throws(() => verifyTransparencyLogChain(tampered), /entry 1 .* but the chain computes/);
  }
});

test("recomputing a tampered entry's own digest still fails, because successors commit to it", () => {
  const log = logOf(A, B, C);
  const forgedEntry = {
    ...log.entries[1],
    publicDigest: "0".repeat(64),
    entryDigest: transparencyLogEntryDigest({
      previousEntryDigest: log.entries[0].entryDigest,
      sequence: 1,
      reportId: ID_B,
      reportWireSha256: log.entries[1].reportWireSha256,
      publicDigest: "0".repeat(64)
    })
  };
  const tampered = {
    ...log,
    entries: [log.entries[0], forgedEntry, log.entries[2]]
  };
  assert.throws(() => verifyTransparencyLogChain(tampered), /entry 2 /);
});

test("parse rejects unknown keys, bad shapes, and a head or count that contradicts the entries", () => {
  const valid = wireOf(A, B) as Record<string, unknown>;
  assert.doesNotThrow(() => parseTransparencyLog(valid));

  assert.throws(() => parseTransparencyLog({ ...valid, surprise: 1 }), /log\.surprise is not allowed/);
  assert.throws(() => parseTransparencyLog({ ...valid, $schema: "https://example.test/x" }), /canonical transparency-log schema/);
  assert.throws(() => parseTransparencyLog({ ...valid, schemaVersion: 2 }), /schemaVersion must be 1/);
  assert.throws(() => parseTransparencyLog({ ...valid, chainAlgorithm: "sha256" }), /chainAlgorithm must be/);
  assert.throws(() => parseTransparencyLog({ ...valid, entryCount: 5 }), /entryCount must equal/);
  assert.throws(() => parseTransparencyLog({ ...valid, head: "0".repeat(64) }), /head must be the last entry digest/);

  const entries = valid.entries as Record<string, unknown>[];
  assert.throws(
    () => parseTransparencyLog({ ...valid, entries: [entries[0], { ...entries[1], sequence: 7 }] }),
    /sequence must equal its position 1/
  );
  assert.throws(
    () => parseTransparencyLog({ ...valid, entries: [entries[0], { ...entries[1], reportId: ID_A }] }),
    /duplicates/
  );
  assert.throws(
    () => parseTransparencyLog({ ...valid, entries: [entries[0], { ...entries[1], reportId: "not-a-report-id" }] }),
    /reportId has an invalid format/
  );
  assert.throws(
    () => parseTransparencyLog({ ...valid, entries: [entries[0], { ...entries[1], publicDigest: "ABC" }] }),
    /publicDigest has an invalid format/
  );
  assert.throws(
    () => parseTransparencyLog({ ...valid, entries: [entries[0], { ...entries[1], extra: true }] }),
    /entries\[1\]\.extra is not allowed/
  );
});

test("an anchor must match the chain head at its own entry count", () => {
  const log = logOf(A, B, C);
  const honest: TransparencyLogAnchor = {
    entryCount: 2,
    head: log.entries[1].entryDigest,
    proofType: "opentimestamps",
    proof: "AAEC"
  };
  const anchored = buildTransparencyLog(log.entries, [honest]);
  assert.doesNotThrow(() => verifyTransparencyLogChain(anchored));
  assert.doesNotThrow(() => parseTransparencyLog(JSON.parse(JSON.stringify(anchored))));

  const wrongHead = buildTransparencyLog(log.entries, [{ ...honest, head: "0".repeat(64) }]);
  assert.throws(() => verifyTransparencyLogChain(wrongHead), /attests to head .* but the chain head/);

  const beyondLog = buildTransparencyLog(log.entries, [{ ...honest, entryCount: 9 }]);
  assert.throws(() => verifyTransparencyLogChain(beyondLog), /attests to 9 entries but the log holds 3/);
});

test("anchor parsing is strict about proof type, encoding, and size", () => {
  const log = logOf(A);
  const base: TransparencyLogAnchor = {
    entryCount: 1,
    head: log.entries[0].entryDigest,
    proofType: "opentimestamps",
    proof: "AAEC"
  };
  const wire = (anchor: unknown) =>
    JSON.parse(JSON.stringify({ ...buildTransparencyLog(log.entries), anchors: [anchor] })) as unknown;

  assert.doesNotThrow(() => parseTransparencyLog(wire(base)));
  assert.throws(() => parseTransparencyLog(wire({ ...base, proofType: "notary" })), /not a supported proof type/);
  assert.throws(() => parseTransparencyLog(wire({ ...base, proof: "not base64!" })), /must be base64/);
  assert.throws(() => parseTransparencyLog(wire({ ...base, proof: "A".repeat(70_000) })), /exceeds the proof size ceiling/);
  assert.throws(() => parseTransparencyLog(wire({ ...base, entryCount: 0 })), /entryCount must be a positive safe integer/);
  assert.throws(() => parseTransparencyLog(wire({ ...base, when: "now" })), /anchors\[0\]\.when is not allowed/);
});

test("history refuses removal, reordering, and edits, and accepts honest appends", () => {
  const previous = wireOf(A, B);
  assert.doesNotThrow(() => assertTransparencyLogHistory(previous, wireOf(A, B, C)));
  assert.doesNotThrow(() => assertTransparencyLogHistory(previous, previous));

  assert.throws(() => assertTransparencyLogHistory(previous, wireOf(A)), /entries were removed/);
  assert.throws(() => assertTransparencyLogHistory(previous, wireOf(B, A)), /entries\[0\] changed/);
  assert.throws(() => assertTransparencyLogHistory(previous, wireOf(A, C, B)), /entries\[1\] changed/);

  // A rewritten publication that is internally re-chained is still refused,
  // which is the whole point: consistency is not the same as immutability.
  const rewritten = wireOf(A, addition(ID_B, "9"));
  assert.throws(() => assertTransparencyLogHistory(previous, rewritten), /entries\[1\] changed/);
});

test("history refuses a current log whose own chain is broken", () => {
  const previous = wireOf(A);
  const current = wireOf(A, B) as Record<string, unknown>;
  const entries = (current.entries as Record<string, unknown>[]).slice();
  entries[1] = { ...entries[1], publicDigest: "0".repeat(64) };
  assert.throws(() => assertTransparencyLogHistory(previous, { ...current, entries }), /the chain computes/);
});

test("published anchors cannot be withdrawn or edited", () => {
  const log = logOf(A, B);
  const anchor: TransparencyLogAnchor = {
    entryCount: 2,
    head: log.entries[1].entryDigest,
    proofType: "opentimestamps",
    proof: "AAEC"
  };
  const anchored = JSON.parse(JSON.stringify(buildTransparencyLog(log.entries, [anchor]))) as unknown;
  const unanchored = JSON.parse(JSON.stringify(buildTransparencyLog(log.entries))) as unknown;

  assert.throws(() => assertTransparencyLogHistory(anchored, unanchored), /anchors were removed/);
  const edited = JSON.parse(
    JSON.stringify(buildTransparencyLog(log.entries, [{ ...anchor, proof: "BBEC" }]))
  ) as unknown;
  assert.throws(() => assertTransparencyLogHistory(anchored, edited), /anchors\[0\] changed/);
  assert.doesNotThrow(() => assertTransparencyLogHistory(unanchored, anchored));
});

test("the published wire is exactly what the parser accepts, with no extra fields", () => {
  const log = buildTransparencyLog(appendTransparencyLogEntries([], [A]));
  const wire = JSON.parse(JSON.stringify(log)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire).sort(), [
    "$schema",
    "anchors",
    "chainAlgorithm",
    "entries",
    "entryCount",
    "head",
    "schemaVersion"
  ]);
  assert.deepEqual(Object.keys((wire.entries as Record<string, unknown>[])[0]).sort(), [
    "entryDigest",
    "publicDigest",
    "reportId",
    "reportWireSha256",
    "sequence"
  ]);
  assert.equal(wire.$schema, TRANSPARENCY_LOG_SCHEMA);
  assert.deepEqual(parseTransparencyLog(wire), log);
});
