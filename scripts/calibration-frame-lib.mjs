import { createHash } from "node:crypto";
import { canonicalPrettyJson, sha256Hex } from "./calibration-study-lib.mjs";

/**
 * Deterministic frame draw for a calibration study.
 *
 * `docs/calibration-prereg-drafts/frame-construction.md` names this as a build
 * item that did not exist: "a small `calibration:frame` producer that takes the
 * screened pool, the committed preregistration digest as seed, and emits the
 * drawn cases with their canonical selection and condition files".
 *
 * THE DRAW IS A SORT, NOT A SHUFFLE. Every candidate is keyed by
 * `sha256(seed || "\n" || url)` and the lowest N keys win. This is an
 * equal-probability draw with no replacement, and unlike a seeded Fisher-Yates
 * it needs no agreement about a PRNG: a reviewer can recompute one SHA-256 per
 * pool entry in any language, sort, and see the same frame. Reproducibility by
 * a stranger is the whole point of seeding the draw with the preregistration
 * digest, so the draw must not depend on an implementation detail of this file.
 *
 * The seed is the SHA-256 of the committed preregistration bytes. It therefore
 * cannot be known until the preregistration is final, and it cannot be changed
 * afterwards without changing the frame, which is what stops anyone from
 * redrawing until they like the sample.
 */

export const CALIBRATION_FRAME_DRAW_VERSION = "sha256-key-sort@1";

/** Case ids are opaque and non-identifying: nothing about the site leaks in. */
export function caseIdForIndex(index) {
  return `case-${String(index + 1).padStart(4, "0")}`;
}

export function drawKey(seed, url) {
  return createHash("sha256").update(`${seed}\n${url}`).digest("hex");
}

/**
 * Draw exactly `count` candidates from `pool`.
 *
 * Refuses a pool with duplicate URLs. A duplicate would carry two draw keys for
 * one site, giving it two chances and quietly breaking both the
 * equal-probability claim and the study's `independentUnits` declaration.
 */
export function drawFrame(pool, seed, count) {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error("pool must be a non-empty array");
  }
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error("seed must be 64 lowercase hex characters");
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("count must be a positive integer");
  }
  if (count > pool.length) {
    throw new Error(`cannot draw ${count} cases from a pool of ${pool.length}`);
  }
  const urls = new Set();
  const keyed = pool.map((entry) => {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`pool entry is not an https url: ${JSON.stringify(entry)}`);
    }
    if (urls.has(url)) throw new Error(`pool contains ${url} more than once`);
    urls.add(url);
    return { url, key: drawKey(seed, url) };
  });
  // Ties on a 256-bit key do not occur in practice; the url tiebreak keeps the
  // ordering total anyway, so the draw stays deterministic by construction
  // rather than by luck.
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.url < b.url ? -1 : 1));
  return keyed.slice(0, count).map((entry, index) => ({
    caseId: caseIdForIndex(index),
    url: entry.url,
    drawKey: entry.key
  }));
}

export function selectionArtifact({ studyId, detector, caseId, url }) {
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-selection",
    studyId,
    detector,
    caseId,
    url
  };
}

export function conditionArtifact({ studyId, detector, caseId, measurementCondition }) {
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-condition",
    studyId,
    detector,
    caseId,
    // Only the three request axes; `interpretation` belongs to the plan's
    // measurement condition and is not part of what the runner is handed.
    request: {
      device: measurementCondition.device,
      gpcEnabled: measurementCondition.gpcEnabled,
      consentMode: measurementCondition.consentMode
    }
  };
}

/**
 * Build every case's exact frozen bytes and the plan rows that digest them.
 *
 * Serialization is `canonicalPrettyJson`, matching what the acquisition-side
 * validator recomputes; a different indent would produce a different SHA-256
 * and fail closed at acquisition, after the ceremony had already started.
 */
export function buildFrameArtifacts({ drawn, studyId, detector, measurementCondition }) {
  return drawn.map((entry) => {
    const selection = selectionArtifact({ studyId, detector, caseId: entry.caseId, url: entry.url });
    const condition = conditionArtifact({
      studyId,
      detector,
      caseId: entry.caseId,
      measurementCondition
    });
    const selectionText = canonicalPrettyJson(selection);
    const conditionText = canonicalPrettyJson(condition);
    return {
      caseId: entry.caseId,
      url: entry.url,
      drawKey: entry.drawKey,
      selectionText,
      conditionText,
      selectionDigest: sha256Hex(selectionText),
      conditionDigest: sha256Hex(conditionText)
    };
  });
}

export { sha256Hex };
