export const MEASUREMENT_FREEZE_ENV =
  "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE";

/**
 * One exact policy for every featured-corpus writer and the retention pruner.
 * Empty/unset and literal 0 retain the ordinary seven-day policy. Literal 1
 * starts the governed evidence epoch and forbids report deletion. Every other
 * value is an operator error, never permission to prune.
 */
export function measurementFreezeRetentionPolicy(environment = process.env) {
  const raw = environment[MEASUREMENT_FREEZE_ENV];
  if (raw === undefined || raw === "" || raw === "0") {
    return {
      measurementFreeze: false,
      pruningAllowed: true,
      mode: "ordinary-retention"
    };
  }
  if (raw === "1") {
    return {
      measurementFreeze: true,
      pruningAllowed: false,
      mode: "governed-evidence-freeze"
    };
  }
  throw new Error(
    `${MEASUREMENT_FREEZE_ENV} must be exactly 0, 1, empty, or unset; refusing an ambiguous retention policy`
  );
}

export function requireStaticReportPruningAllowed(
  environment = process.env
) {
  const policy = measurementFreezeRetentionPolicy(environment);
  if (!policy.pruningAllowed) {
    throw new Error(
      `${MEASUREMENT_FREEZE_ENV}=1 forbids static report pruning during the governed evidence epoch`
    );
  }
  return policy;
}
