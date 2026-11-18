import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// What scripts/trust-kernel-verus-receipt.mjs accepts as a receipt that shows
// a Verus run over the trust kernel passed at a commit, and the shape of the
// workflow that writes and signs it. Verus itself runs only in
// .github/workflows/trust-kernel.yml; nothing here starts it.

type Pins = { verus: { version: string; commit: string; assets: Record<string, { sha256: string }> } };
type Results = {
  verifiedItems: number;
  pinnedItems: number;
  errors: number;
  rlimitFloor: number;
  statementsNamed: number;
  guardMutationsRefused: number;
  cargoTestsPassed: number;
  verusMutationsRefused: number;
  treeCleanBefore: boolean;
  treeCleanAfter: boolean;
};
type Receipt = {
  schemaVersion: number;
  kind: string;
  source: { commit: string; tree: string };
  runner: { platform: string; node: string };
  verus: { version: string; commit: string; assetSha256: string | null };
  checkedFiles: { path: string; sha256: string }[];
  specifications: { path: string; sha256: string }[];
  results: Results;
};
type Helpers = {
  PINS_PATH: string;
  RECEIPT_KIND: string;
  RECEIPT_KEYS: string[];
  receiptProblems(receipt: unknown, expected: { commit: string; pins: Pins }): string[];
  buildReceipt(input: {
    source: { commit: string; tree: string };
    workspace: string;
    pins: Pins;
    checkedFiles: string[];
    specifications: Record<string, { sha256: string }>;
    run: Results;
  }): Receipt;
};

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(root, "scripts", "trust-kernel-verus-receipt.mjs")).href);
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");

const COMMIT = "a".repeat(40);
const PLATFORM = "linux-x64";

async function goodReceipt(): Promise<{ receipt: Receipt; pins: Pins }> {
  const { PINS_PATH, RECEIPT_KIND } = await helpers;
  const pins = JSON.parse(source(PINS_PATH)) as Pins;
  const receipt: Receipt = {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    source: { commit: COMMIT, tree: "b".repeat(40) },
    runner: { platform: PLATFORM, node: "v24.14.1" },
    verus: { version: pins.verus.version, commit: pins.verus.commit, assetSha256: pins.verus.assets[PLATFORM].sha256 },
    checkedFiles: [
      { path: "kernel/src/encode.rs", sha256: "c".repeat(64) },
      { path: "kernel/src/address.rs", sha256: "d".repeat(64) }
    ],
    specifications: [{ path: "kernel/src/encode.rs", sha256: "e".repeat(64) }],
    results: {
      verifiedItems: 103,
      pinnedItems: 103,
      errors: 0,
      rlimitFloor: 2,
      statementsNamed: 9,
      guardMutationsRefused: 40,
      cargoTestsPassed: 30,
      verusMutationsRefused: 8,
      treeCleanBefore: true,
      treeCleanAfter: true
    }
  };
  return { receipt, pins };
}

test("a receipt of a passing run at the commit shows the run passed", async () => {
  const { receiptProblems, RECEIPT_KEYS } = await helpers;
  const { receipt, pins } = await goodReceipt();
  assert.deepEqual(Object.keys(receipt), RECEIPT_KEYS);
  assert.deepEqual(receiptProblems(receipt, { commit: COMMIT, pins }), []);
});

test("the receipt the Verus step builds from these files is one the rule accepts, with the digests of the files it names", async () => {
  const { buildReceipt, receiptProblems, PINS_PATH } = await helpers;
  const pins = JSON.parse(source(PINS_PATH)) as Pins;
  const workspace = path.join(root, "tools/trust-kernel");
  const files = ["kernel/src/encode.rs", "kernel/src/address.rs"];
  const { receipt: good } = await goodReceipt();
  const built = buildReceipt({ source: good.source, workspace, pins, checkedFiles: files, specifications: { [files[0]]: { sha256: "e".repeat(64) } }, run: good.results });
  const head = COMMIT;
  assert.deepEqual(built.source, good.source);
  assert.deepEqual(built.checkedFiles.map((entry) => entry.path), files);
  for (const entry of built.checkedFiles) {
    assert.equal(entry.sha256, createHash("sha256").update(readFileSync(path.join(workspace, entry.path))).digest("hex"));
  }
  const platform = `${process.platform}-${process.arch}`;
  if (pins.verus.assets[platform] === undefined) {
    assert.ok(receiptProblems(built, { commit: head, pins }).some((problem) => /pinned for its platform/.test(problem)));
  } else {
    assert.deepEqual(receiptProblems(built, { commit: head, pins }), []);
  }
});

test("a receipt is refused for each way it falls short of a pass at the commit", async () => {
  const { receiptProblems } = await helpers;
  const cases: [string, (receipt: Receipt) => void, RegExp][] = [
    ["another commit", (r) => { r.source.commit = "f".repeat(40); }, /is of commit f+, not a+/],
    ["a short commit", (r) => { r.source.commit = "a".repeat(8); }, /names no full commit and tree/],
    ["another kind", (r) => { r.kind = "site-behavior-lab-tla-checks-receipt"; }, /another kind or version/],
    ["another Verus", (r) => { r.verus.version = "0.0.0"; }, /a Verus other than the pinned one/],
    ["another archive", (r) => { r.verus.assetSha256 = "0".repeat(64); }, /archive other than the one pinned for its platform/],
    ["a platform with no pin", (r) => { r.runner.platform = "freebsd-x64"; }, /archive other than the one pinned for its platform/],
    ["fewer items than pinned", (r) => { r.results.verifiedItems = 102; }, /verified 102 items, and 103 are pinned/],
    ["no items", (r) => { r.results.verifiedItems = 0; r.results.pinnedItems = 0; }, /verified 0 items/],
    ["an error", (r) => { r.results.errors = 1; }, /reported 1 errors/],
    ["no guard mutation refused", (r) => { r.results.guardMutationsRefused = 0; }, /guardMutationsRefused is not a count above zero/],
    ["no broken copy refused", (r) => { r.results.verusMutationsRefused = 0; }, /verusMutationsRefused is not a count above zero/],
    ["no cargo test", (r) => { r.results.cargoTestsPassed = 0; }, /cargoTestsPassed is not a count above zero/],
    ["a changed tree", (r) => { r.results.treeCleanAfter = false; }, /clean tree, or left it changed/],
    ["no checked file", (r) => { r.checkedFiles = []; }, /checked file list is empty or malformed/],
    ["a malformed digest", (r) => { r.specifications[0].sha256 = "x"; }, /specification list is empty or malformed/],
    ["an added field", (r) => { (r as Record<string, unknown>).note = "passed"; }, /exactly its fields, in order/],
    ["a dropped result", (r) => { delete (r.results as Partial<Results>).treeCleanBefore; }, /results do not hold exactly their fields/]
  ];
  for (const [what, edit, message] of cases) {
    const { receipt, pins } = await goodReceipt();
    edit(receipt);
    const problems = receiptProblems(receipt, { commit: COMMIT, pins });
    assert.ok(problems.some((problem) => message.test(problem)), `${what}: ${JSON.stringify(problems)}`);
  }
});

test("the kernel workflow writes the receipt only from the Verus step, holds it to its commit, and signs it in a job that runs none of the commit's code", () => {
  const workflow = source(".github/workflows/trust-kernel.yml");
  const [checkJob, rest] = workflow.split(/^  attest:\n/m);
  assert.ok(rest !== undefined, "no attest job");
  const [attestJob] = rest.split(/^  trust-kernel-audit:\n/m);

  // The job that runs the commit's code can sign nothing, and the job that
  // signs runs none of the commit's code.
  assert.doesNotMatch(checkJob, /id-token|attestations/);
  assert.doesNotMatch(attestJob, /actions\/checkout|npm ci|scripts\//);
  assert.match(attestJob, /needs:\n      - trust-kernel\n    if: github\.ref == 'refs\/heads\/main'\n/);
  assert.match(attestJob, /permissions:\n      contents: read\n      id-token: write\n      attestations: write\n      artifact-metadata: write\n/);
  assert.match(attestJob, /uses: actions\/attest@[0-9a-f]{40} # v/);
  assert.match(attestJob, /receipt\?\.source\?\.commit !== process\.env\.GITHUB_SHA/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);

  // The Verus step writes the receipt, the check holds it to the commit, and
  // only then is it kept; the attest job signs the kept file and no other.
  const order = [
    'node scripts/trust-kernel-verus.mjs verify --verus "$RUNNER_TEMP/verus/verus-x86-linux"\n          --receipt "$RUNNER_TEMP/site-behavior-lab-trust-kernel-verus-receipt.json"',
    'node scripts/trust-kernel-verus-receipt.mjs check\n          --receipt "$RUNNER_TEMP/site-behavior-lab-trust-kernel-verus-receipt.json" --commit "$GITHUB_SHA"',
    "      - name: Preserve the Verus receipt\n        if: always()\n"
  ].map((text) => checkJob.indexOf(text));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const kept = /name: (trust-kernel-verus-receipt-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\})\n {10}path: \$\{\{ runner\.temp \}\}\/(site-behavior-lab-trust-kernel-verus-receipt\.json)\n/.exec(checkJob);
  assert.ok(kept, "the receipt is not kept under its commit and run");
  assert.ok(attestJob.includes(`name: ${kept[1]}\n`), "the attest job downloads another artifact");
  assert.ok(attestJob.includes(`subject-path: \${{ runner.temp }}/trust-kernel-verus-receipt/${kept[2]}\n`), "the attest job signs another file");

  // Still no gate reads it: it is no required CI job, and no other workflow
  // waits on it or is started by it.
  const jobNames = [...workflow.matchAll(/^    name: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(jobNames, ["Trust Kernel Checks", "Attest the Verus receipt", "Trust Kernel Dependency Audit"]);
  const required = JSON.parse(source(".github/required-ci-jobs.json")) as { jobs: string[] };
  for (const job of jobNames) assert.equal(required.jobs.includes(job), false, `${job} is a required job`);
  // A comment may name the workflow (adblock-wasm.yml gives its reason by
  // pointing here); a trigger on it, an API path to its runs or a run lookup
  // by its name may not.
  const readsIt = /workflows:\s*\[?\s*["']?Trust Kernel|workflows\/trust-kernel\.yml|--workflow[= ]+["']?(?:trust-kernel\.yml|Trust Kernel)/;
  for (const file of readdirSync(path.join(root, ".github/workflows")).filter((entry) => entry !== "trust-kernel.yml")) {
    assert.doesNotMatch(source(`.github/workflows/${file}`), readsIt, `${file} reads or waits on the Trust Kernel workflow`);
  }
});
