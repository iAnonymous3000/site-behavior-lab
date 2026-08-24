/**
 * The preregistered pilot-to-frame sizing rule
 * (docs/reliability-sweep-cluster-design.md, "Prevalence and sizing").
 *
 * The pilot replaces the withdrawn 0.50 base-rate assumption with a
 * measurement: reviewers label the pilot slice under the independent
 * reference protocol, and the frame size derives from the pilot's Wilson
 * interval through the EXACT rule below, never from a point estimate and
 * never from an assumed rate.
 *
 * THE RULE, fixed before any pilot is labeled:
 *   N = the smallest integer such that
 *     P( Binomial(N, pLower)   >= minimumPerClass ) >= assurance   AND
 *     P( Binomial(N, 1-pUpper) >= minimumPerClass ) >= assurance
 * where [pLower, pUpper] is the pilot's Wilson 95% interval, minimumPerClass
 * is the publication profile's claimed-class floor, and assurance is 0.99.
 * Both reference classes are guarded at their own conservative endpoint, so
 * a pilot that cannot support both classes yields a large N honestly rather
 * than a narrow claim. Under the v4 side-separated model the reference
 * margins do not depend on scan-side completeness (labels are per case), so
 * this rule converts prevalence uncertainty alone; the prediction-side
 * margins remain the study preregistration's detector-specific power
 * calculation.
 */

import { wilsonInterval } from "./cluster-interval-lib.mjs";

/**
 * Pilot floor: Wilson 95% half-width at the worst case (p = 0.5) is 0.096 at
 * n = 100, inside the programme's 0.10 half-width convention. Smaller pilots
 * cannot state their prevalence to the precision the sizing rule consumes.
 */
export const PREREGISTERED_PILOT_MINIMUM = 100;
export const PREREGISTERED_SIZING_ASSURANCE = 0.99;
export const SIZING_SEARCH_CEILING = 100000;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

/** P(Binomial(n, p) >= k), computed in log space; exact, no approximation. */
export function binomialTailAtLeast(n, p, k) {
  require(Number.isSafeInteger(n) && n >= 0, "binomial n must be a non-negative integer");
  require(Number.isSafeInteger(k) && k >= 0, "binomial k must be a non-negative integer");
  require(typeof p === "number" && p >= 0 && p <= 1, "binomial p must be a probability");
  if (k === 0) return 1;
  if (k > n) return 0;
  if (p === 0) return 0;
  if (p === 1) return 1;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  // Iterate the pmf from x = 0 upward via the recurrence, accumulating the
  // lower tail, then return its complement.
  let logPmf = n * logQ; // x = 0
  let lowerTail = 0;
  for (let x = 0; x < k; x += 1) {
    if (x > 0) {
      logPmf += Math.log((n - x + 1) / x) + logP - logQ;
    }
    lowerTail += Math.exp(logPmf);
  }
  return Math.max(0, Math.min(1, 1 - lowerTail));
}

/**
 * The exact rule. Returns the derived N with the interval and the per-class
 * assurances at that N, so the derivation is auditable, not just a number.
 */
export function deriveFrameSizeFromPilot({
  pilotPresent,
  pilotTotal,
  minimumPerClass,
  assurance = PREREGISTERED_SIZING_ASSURANCE
}) {
  require(
    Number.isSafeInteger(pilotTotal) && pilotTotal >= PREREGISTERED_PILOT_MINIMUM,
    `pilot total must be at least the preregistered minimum of ${PREREGISTERED_PILOT_MINIMUM}`
  );
  require(
    Number.isSafeInteger(pilotPresent) && pilotPresent >= 0 && pilotPresent <= pilotTotal,
    "pilot present-count must be an integer within the pilot"
  );
  const interval = wilsonInterval(pilotPresent, pilotTotal, 1.96);
  return deriveFromInterval({
    lower: interval.lo,
    upper: interval.hi,
    minimumPerClass,
    assurance,
    pilot: { present: pilotPresent, total: pilotTotal },
    pilotLabel: `${pilotPresent}/${pilotTotal}`
  });
}

/**
 * The uncertainty-aware variant, preregistered alongside the point rule:
 * an UNCERTAIN resolved label can be either class, so the interval is the
 * assignment envelope in the policy-C spirit: the lower endpoint treats
 * every uncertain as absent (Wilson lower of present/total) and the upper
 * endpoint treats every uncertain as present (Wilson upper of
 * (present+uncertain)/total). With zero uncertain labels this reduces
 * EXACTLY to deriveFrameSizeFromPilot. The derived N is monotonically at
 * or above the point rule's, never below: uncertainty can only demand
 * more, and the 18..82 present-count band is therefore a NECESSARY
 * condition at any pool ceiling, not a sufficient one.
 */
export function deriveFrameSizeFromPilotEnvelope({
  present,
  absent,
  uncertain,
  minimumPerClass,
  assurance = PREREGISTERED_SIZING_ASSURANCE
}) {
  for (const [name, value] of [
    ["present", present],
    ["absent", absent],
    ["uncertain", uncertain]
  ]) {
    require(
      Number.isSafeInteger(value) && value >= 0,
      `pilot ${name} count must be a non-negative integer`
    );
  }
  const total = present + absent + uncertain;
  require(
    total >= PREREGISTERED_PILOT_MINIMUM,
    `pilot total must be at least the preregistered minimum of ${PREREGISTERED_PILOT_MINIMUM}`
  );
  return deriveFromInterval({
    lower: wilsonInterval(present, total, 1.96).lo,
    upper: wilsonInterval(present + uncertain, total, 1.96).hi,
    minimumPerClass,
    assurance,
    pilot: { present, absent, uncertain, total },
    pilotLabel: `${present} present, ${absent} absent, ${uncertain} uncertain of ${total}`
  });
}

/** The one search: smallest N with both class floors at the assurance. */
function deriveFromInterval({ lower, upper, minimumPerClass, assurance, pilot, pilotLabel }) {
  require(
    Number.isSafeInteger(minimumPerClass) && minimumPerClass >= 1,
    "the claimed-class minimum must be a positive integer"
  );
  require(
    typeof assurance === "number" && assurance > 0 && assurance < 1,
    "assurance must be a probability strictly between 0 and 1"
  );
  const presentRate = lower;
  const absentRate = 1 - upper;
  for (let n = minimumPerClass; n <= SIZING_SEARCH_CEILING; n += 1) {
    const presentAssurance = binomialTailAtLeast(n, presentRate, minimumPerClass);
    const absentAssurance = binomialTailAtLeast(n, absentRate, minimumPerClass);
    if (presentAssurance >= assurance && absentAssurance >= assurance) {
      return {
        derivedN: n,
        pilot,
        interval95: { lower, upper },
        minimumPerClass,
        assurance,
        perClass: {
          referencePresent: { rate: presentRate, assuranceAtN: presentAssurance },
          referenceAbsent: { rate: absentRate, assuranceAtN: absentAssurance }
        }
      };
    }
  }
  throw new Error(
    `no frame size at or below ${SIZING_SEARCH_CEILING} satisfies both reference classes at assurance ${assurance} from a pilot of ${pilotLabel}; the population cannot support this study's claimed classes`
  );
}

/**
 * The fail condition, as code: a derived N larger than the swept eligible
 * pool is infeasibility. The remedy is a larger universe and fresh sweep
 * rounds over the enlarged set; it is never a relaxed exclusion, a reused
 * pilot site, or a narrowed population, and this function offers no
 * parameter through which any of those could be expressed.
 */
export function assertFrameFeasible({ derivedN, sweptEligiblePool }) {
  require(
    Number.isSafeInteger(derivedN) && derivedN >= 1,
    "feasibility needs the derived frame size"
  );
  require(
    Number.isSafeInteger(sweptEligiblePool) && sweptEligiblePool >= 0,
    "feasibility needs the swept eligible pool count"
  );
  require(
    derivedN <= sweptEligiblePool,
    `derived N of ${derivedN} exceeds the swept eligible pool of ${sweptEligiblePool}: the study is INFEASIBLE at this pool; the remedy is a larger universe and fresh sweep rounds, never a relaxed exclusion, a reused pilot site, or a narrowed population`
  );
  return { derivedN, sweptEligiblePool };
}
