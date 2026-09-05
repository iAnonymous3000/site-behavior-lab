import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { adblockListMeta } from "./adblock-engine";
import {
  compareBraveSnapshotAdoption,
  formatBraveAdoptionConstant,
  formatBraveAdoptionSummary,
  readBraveSnapshotIdentity,
  type BraveSnapshotIdentity
} from "./brave-snapshot-adoption";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";
import { NODE_R2_CURRENT_ADBLOCK_IDENTITY } from "./scan-report-v2-r2-producer-contract";

const PINNED = NODE_R2_CURRENT_ADBLOCK_IDENTITY as BraveSnapshotIdentity;

/**
 * THE GUARD THAT WAS MISSING.
 *
 * Nothing asserted that the pinned producer identity describes the vendored
 * snapshot. The coupling was real but only observable three layers downstream:
 * a runtime-built report failed `assertNodeProducerContract` with `unknown Node
 * producer tuple`, the r2 redactor threw with it, the managed reader relabelled
 * the whole thing `redaction-not-idempotent`, and a durable test waited forever
 * for a publication that could never happen. Three suites went red and none of
 * them named the cause, so a stale pin read as a redaction bug.
 */
test("the pinned Node producer identity describes the vendored Brave snapshot", () => {
  const adoption = compareBraveSnapshotAdoption(readBraveSnapshotIdentity());
  assert.equal(
    adoption.adoptionRequired,
    false,
    `NODE_R2_CURRENT_ADBLOCK_IDENTITY does not describe lib/adblock-wasm/brave-default-filters.meta.json ` +
      `(${adoption.reason}). A refresh must carry the new snapshot AND the pinned constant in one commit. ` +
      `Run: npm run lists:adoption`
  );
});

/**
 * The mirror is deliberate (importing the engine module would drag the WASM
 * loader into every consumer of the check), so it needs a guard.
 *
 * Two halves, because either alone is weak. Comparing against a hand-written
 * `{...adblockListMeta(), engineVersion}` only proves the reader agrees with a
 * transcription of the builder's expression, and a transcription goes stale
 * silently. So the builder's SOURCE is also read, and the expression this test
 * transcribes must still appear in it.
 */
test("the adoption reader mirrors exactly what the builder stamps on a report", () => {
  const meta = adblockListMeta();
  assert.notEqual(meta, null, "the vendored snapshot must be readable through the engine module");
  assert.deepEqual(readBraveSnapshotIdentity(), {
    ...meta!,
    engineVersion: NODE_ADBLOCK_ENGINE_VERSION
  });

  const builder = readFileSync(path.join(process.cwd(), "lib", "scan-result-v2-r2-builder.ts"), "utf8");
  assert.match(
    builder,
    /adblock: \{ \.\.\.meta, engineVersion: NODE_ADBLOCK_ENGINE_VERSION \}/,
    "the builder no longer stamps the shape this reader mirrors; re-derive readBraveSnapshotIdentity"
  );
});

test("a moved fetch timestamp alone is not an adoption", () => {
  const refetched: BraveSnapshotIdentity = { ...PINNED, fetchedAt: "2099-01-01T00:00:00.000Z" };
  const adoption = compareBraveSnapshotAdoption(refetched, PINNED);
  assert.equal(adoption.adoptionRequired, false);
  assert.equal(adoption.reason, "identical");
});

test("moved rule bytes are an adoption", () => {
  const moved: BraveSnapshotIdentity = { ...PINNED, manifestDigest: "a".repeat(64) };
  const adoption = compareBraveSnapshotAdoption(moved, PINNED);
  assert.equal(adoption.adoptionRequired, true);
  assert.equal(adoption.reason, "rules-moved");
});

test("a moved engine version is an adoption", () => {
  const moved: BraveSnapshotIdentity = { ...PINNED, engineVersion: "adblock-rust-9.9.9" };
  assert.equal(compareBraveSnapshotAdoption(moved, PINNED).adoptionRequired, true);
});

test("a different list count is an adoption", () => {
  const moved: BraveSnapshotIdentity = { ...PINNED, lists: PINNED.lists + 1 };
  assert.equal(compareBraveSnapshotAdoption(moved, PINNED).adoptionRequired, true);
});

test("an unreadable snapshot is reported as needing adoption, never as a match", () => {
  const adoption = compareBraveSnapshotAdoption(null, PINNED);
  assert.equal(adoption.adoptionRequired, true);
  assert.equal(adoption.reason, "snapshot-unreadable");
});

test("the emitted constant is the exact source literal, not a description of one", () => {
  const identity: BraveSnapshotIdentity = {
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: "2026-08-14T23:10:31.506Z",
    manifestDigest: "b".repeat(64),
    engineVersion: NODE_ADBLOCK_ENGINE_VERSION
  };
  const literal = formatBraveAdoptionConstant(identity);
  assert.match(literal, /^export const NODE_R2_CURRENT_ADBLOCK_IDENTITY = Object\.freeze\(\{$/m);
  assert.match(literal, /^ {2}manifestDigest: "b{64}",$/m);
  assert.match(literal, /^ {2}engineVersion: NODE_ADBLOCK_ENGINE_VERSION$/m);
  assert.match(literal, /satisfies NonNullable<Toolchain\["adblock"\]>\);$/);
  // The pinned constant is written exactly this way, so an emitted literal that
  // did not match its shape would be a paste that does not compile.
  assert.ok(!literal.includes("undefined"));
});

test("the summary tells a maintainer whether the outgoing identity must be frozen", () => {
  const moved: BraveSnapshotIdentity = { ...PINNED, manifestDigest: "c".repeat(64) };
  const adoption = compareBraveSnapshotAdoption(moved, PINNED);

  const withPublications = formatBraveAdoptionSummary(adoption, 60);
  assert.match(withPublications, /must ALSO be frozen/);
  assert.match(withPublications, /\*\*60\*\*/);

  const withoutPublications = formatBraveAdoptionSummary(adoption, 0);
  assert.match(withoutPublications, /must ALSO be frozen/);
  assert.match(withoutPublications, /zero committed reports is not evidence/);
});

test("a matching snapshot produces no adoption instructions", () => {
  const summary = formatBraveAdoptionSummary(compareBraveSnapshotAdoption(PINNED, PINNED), 0);
  assert.match(summary, /no identity declaration is needed/);
  assert.doesNotMatch(summary, /NODE_R2_CURRENT_ADBLOCK_IDENTITY = Object\.freeze/);
});
