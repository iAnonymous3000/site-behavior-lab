/**
 * The cluster-bootstrap interval: the repository's ONE cluster-aware
 * uncertainty method, extracted verbatim from
 * research/calibration-censoring/analyze-corpus-censoring.mjs so the
 * reliability sweep's loss bound and the committed censoring analysis cannot
 * drift apart. The research artifact's byte-exact reproduction
 * (test:calibration-censoring-artifact) is the proof the extraction changed
 * nothing.
 *
 * Method: resample CLUSTERS with replacement (never items), recompute the
 * rate per resample, report the 2.5% and 97.5% percentiles. Deterministic by
 * construction: a fixed-seed LCG, so two computations over the same input are
 * byte-identical. FEWER THAN THREE CLUSTERS IS A REFUSAL, not a wider
 * interval: with one or two clusters the resampling distribution collapses
 * onto the observed clusters and the percentiles describe nothing. Callers
 * with stricter preregistered minimums enforce them on top; nothing here may
 * fall back to an iid interval.
 */

export const CLUSTER_BOOTSTRAP_SEED = 20260816;
export const CLUSTER_BOOTSTRAP_ITERATIONS = 4000;
export const CLUSTER_BOOTSTRAP_MINIMUM_CLUSTERS = 3;

export function clusterInterval(items, predicate, keyOf, iterations = CLUSTER_BOOTSTRAP_ITERATIONS) {
  const clusters = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(item);
  }
  const pool = [...clusters.values()];
  if (pool.length < CLUSTER_BOOTSTRAP_MINIMUM_CLUSTERS) {
    return { lo: null, hi: null, clusters: pool.length };
  }
  let seed = CLUSTER_BOOTSTRAP_SEED;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rates = [];
  for (let i = 0; i < iterations; i++) {
    let k = 0, n = 0;
    for (let c = 0; c < pool.length; c++) {
      const picked = pool[Math.floor(rnd() * pool.length)];
      for (const item of picked) { n++; if (predicate(item)) k++; }
    }
    if (n > 0) rates.push(k / n);
  }
  rates.sort((a, b) => a - b);
  return { lo: rates[Math.floor(rates.length * 0.025)], hi: rates[Math.floor(rates.length * 0.975)], clusters: pool.length };
}

/**
 * The Wilson score interval, extracted verbatim from the censoring analysis
 * (same byte-exact-reproduction proof as clusterInterval). z defaults to the
 * analysis's 1.96; the TS analyzer's wilson95 keeps the higher-precision
 * constant on its own side, and neither may fork silently: the censoring
 * findings pin this one, the calibration tests pin that one.
 */
export const wilsonInterval = (k, n, z = 1.96) => {
  if (n === 0) return { lo: 0, hi: 1, half: 0.5 };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h), half: h };
};
