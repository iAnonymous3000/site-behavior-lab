/**
 * Runtime-light adapters for the deployed-scanner smoke. The live producer can
 * return frozen v1 or current v2/r2; these helpers keep the smoke assertions on
 * facts both wires actually record without mistaking r2's missing root `ok`
 * for an API failure.
 */

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function generation(value) {
  if (!isRecord(value) || (value.reportType !== "single" && value.reportType !== "comparison")) return null;
  if (value.schemaVersion === 1 && value.ok === true) return "v1";
  if (value.schemaVersion === 2 && value.schemaRevision === 2) return "r2";
  return null;
}

export function isSupportedDeployedReport(value) {
  return generation(value) !== null;
}

export function singleReportTotalRequests(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v1" && value.reportType === "single") {
    return numberOrNull(value.summary?.totalRequests);
  }
  if (reportGeneration === "r2" && value.reportType === "single") {
    return numberOrNull(value.run?.summary?.counts?.totalRequests);
  }
  return null;
}

export function isShieldsComparisonReport(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v1") {
    return value.reportType === "comparison" && value.comparisonType === "shields";
  }
  if (reportGeneration === "r2") {
    return (
      value.reportType === "comparison" &&
      value.experiment?.kind === "intervention" &&
      value.experiment?.axis === "shields"
    );
  }
  return false;
}

export function hasShieldsComparisonDiff(value) {
  if (!isShieldsComparisonReport(value)) return false;
  if (value.schemaVersion === 1) return isRecord(value.diff?.thirdPartyRequests);
  const family = value.diff?.families?.["raw-counts"];
  const metricGate = value.comparability?.perMetric?.["raw-counts"];
  const baselineRegion = nonemptyString(value.baseline?.conditions?.egress?.region);
  const variantRegion = nonemptyString(value.variant?.conditions?.egress?.region);
  return (
    family?.eligible === true &&
    metricGate?.eligible === true &&
    isRecord(family.metrics) &&
    Object.keys(family.metrics).length > 0 &&
    isRecord(family.metrics.thirdPartyRequests) &&
    baselineRegion !== null &&
    baselineRegion === variantRegion
  );
}

/** The deployed smoke defaults to R2, but self-hosts can explicitly expect a
 * filesystem store. R2 additionally needs a constructible configured path. */
export function healthMatchesExpectedReportStore(value, expectedKind) {
  if (!isRecord(value) || (expectedKind !== "r2" && expectedKind !== "filesystem")) return false;
  const reportStore = value.checks?.reportStore;
  if (value.storage !== expectedKind || reportStore?.kind !== expectedKind) return false;
  return expectedKind !== "r2" || reportStore.configuredPath === true;
}

/** Return the concrete URL-safety refusal reason, never a generic job error. */
export function ssrfGuardRefusalReason(value) {
  if (!isRecord(value) || value.status !== "failed") return null;
  const reason = nonemptyString(value.error);
  if (!reason) return null;
  return /private network|public address|verified as public|not be resolved|loopback|link-local|reserved/i.test(reason)
    ? reason
    : null;
}

export function shieldsEngineActive(value) {
  if (!isShieldsComparisonReport(value)) return false;
  if (value.schemaVersion === 1) {
    return (
      value.baseline?.conditions?.adblock?.active === true &&
      value.variant?.conditions?.adblock?.active === true &&
      value.baseline?.conditions?.shieldsMode === "classification" &&
      value.variant?.conditions?.shieldsMode === "block-simulation"
    );
  }
  return (
    value.baseline?.verificationFacts?.shields?.engineLoaded === true &&
    value.variant?.verificationFacts?.shields?.engineLoaded === true &&
    value.baseline?.verificationFacts?.shields?.applied === false &&
    value.variant?.verificationFacts?.shields?.applied === true &&
    value.baseline?.conditions?.shields === "classification" &&
    value.variant?.conditions?.shields === "block-simulation" &&
    value.experiment?.verification?.baseline?.outcome === "passed" &&
    value.experiment?.verification?.variant?.outcome === "passed"
  );
}

export function shieldsBlockedCounts(value) {
  if (!isShieldsComparisonReport(value)) return { baseline: null, variant: null };
  if (value.schemaVersion === 1) {
    return {
      baseline: numberOrNull(value.baseline?.summary?.shieldsBlockedRequests),
      variant: numberOrNull(value.variant?.summary?.shieldsBlockedRequests)
    };
  }
  return {
    baseline: numberOrNull(value.baseline?.summary?.counts?.shieldsBlockedRequests),
    variant: numberOrNull(value.variant?.summary?.counts?.shieldsBlockedRequests)
  };
}

/** Saved v1 may retain explicit null screenshot slots; r2 may not retain its
 * ephemeral shell at all. Return true only for actual v1 data or any r2 shell. */
export function savedReportRetainsScreenshot(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v1") {
    if (value.screenshot !== null && value.screenshot !== undefined) return true;
    if (value.reportType === "comparison") {
      return (
        (value.baseline?.screenshot !== null && value.baseline?.screenshot !== undefined) ||
        (value.variant?.screenshot !== null && value.variant?.screenshot !== undefined)
      );
    }
    return false;
  }
  if (reportGeneration === "r2") {
    return (
      Object.prototype.hasOwnProperty.call(value, "ephemeral") ||
      Object.prototype.hasOwnProperty.call(value.run ?? {}, "screenshot") ||
      Object.prototype.hasOwnProperty.call(value.baseline ?? {}, "screenshot") ||
      Object.prototype.hasOwnProperty.call(value.variant ?? {}, "screenshot")
    );
  }
  return false;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
