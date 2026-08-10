import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * One reviewed digest per action, everywhere it is written down.
 *
 * Every third-party action in this repository is pinned to a full commit
 * digest, and several tests and `docs/supply-chain-assurance.md` restate the
 * digest they expect. That restatement is deliberate: `lib/release-evidence.ts`
 * spells out why a shape-only pin is not good enough, since it would bless a
 * swapped, unreviewed action that kept the version comment. The cost is that a
 * single version bump has to land in more than a dozen places at once.
 *
 * Dependabot can only edit the workflows. When it bumped `actions/attest` to
 * v4.2.2 it left six restatements behind, and the result was two obscure
 * regex-mismatch failures that named neither the action nor the files that
 * disagreed. Worse is the case nobody sees: a bump that misses one WORKFLOW
 * rather than one test. No existing assertion reads every workflow, so a
 * release job left on an older digest would attest happily and no gate would
 * mention it.
 *
 * This is the sweep that closes both. It derives the expected pin from the
 * workflows themselves and requires everything else to agree, so a partial bump
 * fails once, loudly, listing exactly what disagreed.
 */

const root = process.cwd();
const workflowDir = path.join(root, ".github", "workflows");

/**
 * Files that restate an action pin and must agree with the workflows.
 *
 * Fourteen of them, for seven actions. `actions/attest` alone is written down
 * thirteen times. The list is not maintained by hand: the last test in this
 * file re-derives it from the tree and fails if it is wrong, which is how eight
 * of these entries were found in the first place.
 */
const RESTATING_FILES = [
  "docs/supply-chain-assurance.md",
  "lib/docker-ci-gate.test.ts",
  "lib/durable-soak-ledger.test.ts",
  "lib/hosted-evidence-provenance.test.ts",
  "lib/measurement-freeze-activation.test.ts",
  "lib/production-health-workflow.test.ts",
  "lib/publication-gates.test.ts",
  "lib/release-evidence.test.ts",
  "lib/report-publication-workflow.test.ts",
  "lib/scanner-fidelity-study.test.ts",
  "lib/supply-chain-ci.test.ts",
  "lib/waf-hosted-capture.test.ts",
  "scripts/aa-study-producer-lib.test.mjs",
  "scripts/calibration-study-lib.test.mjs"
];

type Pin = { action: string; digest: string; version: string | null; file: string; line: number };

function workflowFiles(): string[] {
  return readdirSync(workflowDir)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort();
}

function pinsIn(file: string): Pin[] {
  const contents = readFileSync(path.join(workflowDir, file), "utf8");
  const found: Pin[] = [];
  contents.split("\n").forEach((text, index) => {
    const match = /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([0-9a-f]{40})(?:\s*#\s*(\S+))?/.exec(text);
    if (match) {
      found.push({ action: match[1], digest: match[2], version: match[3] ?? null, file, line: index + 1 });
    }
  });
  return found;
}

function allPins(): Pin[] {
  return workflowFiles().flatMap((file) => pinsIn(file));
}

test("every workflow step is pinned to a commit digest, never a moving tag", () => {
  // The premise the rest of this file rests on. A single `@v4` would make the
  // reviewed-digest assertions meaningless for that step.
  const floating: string[] = [];
  for (const file of workflowFiles()) {
    readFileSync(path.join(workflowDir, file), "utf8")
      .split("\n")
      .forEach((text, index) => {
        const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(text);
        if (!uses) return;
        const reference = uses[1];
        // Local composite actions and reusable workflows in this repository are
        // governed by this repository, so they need no digest.
        if (reference.startsWith("./") || reference.startsWith(".github/")) return;
        if (!/@[0-9a-f]{40}$/.test(reference)) floating.push(`${file}:${index + 1} ${reference}`);
      });
  }
  assert.deepEqual(floating, [], `these steps are not digest-pinned:\n${floating.join("\n")}`);
});

test("an action resolves to exactly one digest and one version across every workflow", () => {
  const byAction = new Map<string, Pin[]>();
  for (const pin of allPins()) {
    const existing = byAction.get(pin.action);
    if (existing) existing.push(pin);
    else byAction.set(pin.action, [pin]);
  }
  assert.ok(byAction.size > 0, "no pinned actions were parsed; the sweep would be vacuous");

  const disagreements: string[] = [];
  for (const [action, pins] of byAction) {
    const distinct = new Set(pins.map((pin) => `${pin.digest} # ${pin.version ?? "(no version comment)"}`));
    if (distinct.size > 1) {
      disagreements.push(
        `${action} is pinned ${distinct.size} different ways:\n` +
          pins.map((pin) => `    ${pin.file}:${pin.line} -> ${pin.digest} # ${pin.version ?? "?"}`).join("\n")
      );
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    `a version bump reached some workflows and not others:\n${disagreements.join("\n")}`
  );
});

test("every pin carries the version comment that makes review possible", () => {
  // A bare digest is unreviewable in a diff: nobody can tell v4.2.1 from a
  // stranger's fork by looking at 40 hex characters.
  const bare = allPins()
    .filter((pin) => !pin.version || !/^v\d+(\.\d+)*$/.test(pin.version))
    .map((pin) => `${pin.file}:${pin.line} ${pin.action}@${pin.digest} # ${pin.version ?? "(none)"}`);
  assert.deepEqual(bare, [], `these pins have no reviewable version comment:\n${bare.join("\n")}`);
});

test("tests and docs restate the same digest the workflows actually use", () => {
  // The failure this exists for. Dependabot edits workflows only, so a bump
  // that is not carried into every restatement leaves the repository asserting
  // one digest and running another.
  const workflowDigests = new Map<string, string>();
  for (const pin of allPins()) workflowDigests.set(pin.digest, pin.action);

  const stale: string[] = [];
  for (const relative of RESTATING_FILES) {
    const contents = readFileSync(path.join(root, relative), "utf8");
    // Only digests written next to an action name are action pins. The rest of
    // the 40-hex strings in these files are report ids, git commits and sha256
    // vectors, and sweeping those in would make this test meaningless noise.
    for (const match of contents.matchAll(
      /([A-Za-z0-9._-]+\\?\/[A-Za-z0-9._/-]+)@\\?([0-9a-f]{40})/g
    )) {
      const action = match[1].replace(/\\/g, "");
      const digest = match[2];
      if (workflowDigests.get(digest) === action) continue;
      const line = contents.slice(0, match.index).split("\n").length;
      stale.push(`${relative}:${line} restates ${action}@${digest}, which no workflow uses`);
    }
  }
  assert.deepEqual(stale, [], `restated action pins have drifted from the workflows:\n${stale.join("\n")}`);
});

test("the restating files are the ones that actually restate a pin", () => {
  // A list like RESTATING_FILES rots silently in the direction that matters: a
  // new file starts restating a digest, nobody adds it here, and the sweep
  // above quietly stops covering it. So the list is checked against the tree
  // rather than trusted.
  const digests = new Set(allPins().map((pin) => pin.digest));
  const searched = [
    ...readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`),
    ...readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => `scripts/${f}`),
    ...readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)
  ];

  const restating = searched.filter((relative) => {
    if (relative === "lib/pinned-action-consistency.test.ts") return false;
    const contents = readFileSync(path.join(root, relative), "utf8");
    return [...digests].some((digest) => contents.includes(digest));
  });

  assert.deepEqual(
    restating.sort(),
    [...RESTATING_FILES].sort(),
    "RESTATING_FILES must name every file that hardcodes a pinned action digest"
  );
});
