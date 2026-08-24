import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CLUSTER_BOOTSTRAP_ITERATIONS,
  CLUSTER_BOOTSTRAP_MINIMUM_CLUSTERS,
  CLUSTER_BOOTSTRAP_SEED,
  clusterInterval
} from "./cluster-interval-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

test("fewer than three clusters is a refusal, never a wider interval", () => {
  const twoClusters = [
    { cluster: "a", ok: true },
    { cluster: "a", ok: false },
    { cluster: "b", ok: true }
  ];
  assert.deepEqual(
    clusterInterval(twoClusters, (item) => item.ok, (item) => item.cluster),
    { lo: null, hi: null, clusters: 2 }
  );
  assert.equal(CLUSTER_BOOTSTRAP_MINIMUM_CLUSTERS, 3);
});

test("the bootstrap is deterministic and clusters, not items, are the resampling unit", () => {
  const items = [];
  for (const [cluster, rate] of [["a", 0.9], ["b", 0.5], ["c", 0.7], ["d", 0.8]]) {
    for (let index = 0; index < 20; index += 1) {
      items.push({ cluster, ok: index / 20 < rate });
    }
  }
  const first = clusterInterval(items, (item) => item.ok, (item) => item.cluster);
  const second = clusterInterval(items, (item) => item.ok, (item) => item.cluster);
  assert.deepEqual(first, second, "a fixed seed makes two computations byte-identical");
  assert.equal(first.clusters, 4);
  assert.ok(first.lo !== null && first.lo < first.hi);
  // The interval must reflect BETWEEN-cluster spread: shuffling items across
  // clusters (same overall rate, homogeneous clusters) must narrow it.
  const homogenized = items.map((item, index) => ({
    cluster: ["a", "b", "c", "d"][index % 4],
    ok: item.ok
  }));
  const homogeneous = clusterInterval(homogenized, (item) => item.ok, (item) => item.cluster);
  assert.ok(
    homogeneous.hi - homogeneous.lo < first.hi - first.lo,
    "homogeneous clusters must produce a narrower interval than heterogeneous ones"
  );
  assert.equal(CLUSTER_BOOTSTRAP_SEED, 20260816);
  assert.equal(CLUSTER_BOOTSTRAP_ITERATIONS, 4000);
});

test("the research analysis imports this implementation rather than restating it", () => {
  // One algorithm, one home. The censoring analysis's committed findings
  // reproduce byte-exactly (test:calibration-censoring-artifact), which is
  // the proof the extraction changed nothing; this guard keeps a second
  // implementation from quietly returning.
  const research = readFileSync(
    path.join(moduleDir, "..", "research", "calibration-censoring", "analyze-corpus-censoring.mjs"),
    "utf8"
  );
  assert.match(
    research,
    /import \{ clusterInterval, wilsonInterval \} from "\.\.\/\.\.\/scripts\/cluster-interval-lib\.mjs"/
  );
  assert.doesNotMatch(research, /function clusterInterval/);
  // Wilson moved to the same home; the research script keeps only an alias.
  assert.doesNotMatch(research, /function wilson(Interval)?\s*\(/);
});
