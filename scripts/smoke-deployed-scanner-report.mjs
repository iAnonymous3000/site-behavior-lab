/**
 * Runtime-light adapters for the deployed-scanner smoke and historical
 * archive checks. Live scans produce ScanReport v3; historical reports in
 * public/reports/ and older receipts remain v1 or v2/r2.
 */

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function generation(value) {
  if (!isRecord(value)) return null;
  if (value.schemaVersion === 3 && nonemptyString(value.reportId) && isRecord(value.leadArm)) return "v3";
  if (value.reportType !== "single" && value.reportType !== "comparison") return null;
  if (value.schemaVersion === 1 && value.ok === true) return "v1";
  if (value.schemaVersion === 2 && value.schemaRevision === 2) return "r2";
  return null;
}

export function isSupportedDeployedReport(value) {
  return generation(value) !== null;
}

export function singleReportTotalRequests(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v3") {
    return numberOrNull(value.leadArm?.summary?.totalRequests);
  }
  if (reportGeneration === "v1" && value.reportType === "single") {
    return numberOrNull(value.summary?.totalRequests);
  }
  if (reportGeneration === "r2" && value.reportType === "single") {
    return numberOrNull(value.run?.summary?.counts?.totalRequests);
  }
  return null;
}

function v3ShieldsComparisonParts(value) {
  if (generation(value) !== "v3") return null;
  if (!Array.isArray(value.comparisonArms) || !Array.isArray(value.comparisons)) return null;
  const delta = value.comparisons.find(
    (entry) => isRecord(entry) && (entry.axis === "shields-standard" || entry.axis === "shields-aggressive")
  );
  if (!delta) return null;
  const arm = value.comparisonArms.find(
    (entry) =>
      isRecord(entry) &&
      entry.armId === delta.variantArmId &&
      (entry.conditions?.shieldsMode === "standard" || entry.conditions?.shieldsMode === "aggressive")
  );
  if (!arm) return null;
  return { delta, arm };
}

export function isShieldsComparisonReport(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v3") {
    return v3ShieldsComparisonParts(value) !== null;
  }
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
  if (value.schemaVersion === 3) {
    const parts = v3ShieldsComparisonParts(value);
    if (!parts) return false;
    return (
      nonemptyString(value.provenance?.egressRegion) !== null &&
      numberOrNull(parts.delta.requestsDelta) !== null &&
      numberOrNull(parts.delta.thirdPartyRequestsDelta) !== null &&
      numberOrNull(parts.delta.shieldsBlockedCount) !== null
    );
  }
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
  return /private network|public address|verified as public|not be resolved|loopback|link-local|reserved|local and private/i.test(
    reason
  )
    ? reason
    : null;
}

export function shieldsEngineActive(value) {
  if (!isShieldsComparisonReport(value)) return false;
  if (value.schemaVersion === 3) {
    const parts = v3ShieldsComparisonParts(value);
    if (!parts) return false;
    const versions = value.provenance?.engineVersions;
    const expectedMode = parts.delta.axis === "shields-aggressive" ? "aggressive" : "standard";
    return (
      nonemptyString(versions?.adblockRust) !== null &&
      nonemptyString(versions?.filterListsDigest) !== null &&
      value.leadArm?.conditions?.shieldsMode === "off" &&
      parts.arm.conditions?.shieldsMode === expectedMode &&
      parts.arm.loadOutcome === "ok"
    );
  }
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
  if (value.schemaVersion === 3) {
    const parts = v3ShieldsComparisonParts(value);
    if (!parts) return { baseline: null, variant: null };
    const baseline =
      parts.delta.axis === "shields-aggressive"
        ? numberOrNull(value.leadArm?.summary?.shieldsBlockedAggressive)
        : numberOrNull(value.leadArm?.summary?.shieldsBlockedStandard);
    return {
      baseline,
      variant: numberOrNull(parts.delta.shieldsBlockedCount)
    };
  }
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

/** Saved v1 may retain explicit null screenshot slots; r2 and v3 may never
 * retain screenshots or ephemeral shells. */
export function savedReportRetainsScreenshot(value) {
  const reportGeneration = generation(value);
  if (reportGeneration === "v3") {
    if (
      Object.prototype.hasOwnProperty.call(value, "screenshot") ||
      Object.prototype.hasOwnProperty.call(value, "ephemeral") ||
      Object.prototype.hasOwnProperty.call(value.leadArm ?? {}, "screenshot")
    ) {
      return true;
    }
    if (Array.isArray(value.comparisonArms)) {
      return value.comparisonArms.some(
        (arm) => isRecord(arm) && Object.prototype.hasOwnProperty.call(arm, "screenshot")
      );
    }
    return false;
  }
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
