/**
 * The published coverage boundary: what this instrument does NOT measure.
 *
 * The validation matrix already says how well each detector is exercised. It
 * cannot answer the question a reader actually has, which is what a clean
 * report fails to rule out. Coverage claims are only falsifiable if the
 * negative space is enumerated too, so this is that enumeration, published
 * next to the matrix rather than left implicit.
 *
 * SELF-MAINTAINING WHERE IT CAN BE. An API-shaped entry names the identifiers
 * whose ABSENCE from the scanner source is what makes its claim true, and
 * detector-coverage-boundary.test.ts greps the real sources for them. So
 * instrumenting one of these surfaces fails the suite until the boundary is
 * updated: claiming to miss something already measured is as much a defect
 * here as claiming to measure something that is missed.
 *
 * Not every gap is API-shaped. "We do not compare script bytes between
 * visits" has no missing identifier to point at, and a token invented to
 * satisfy the check would be a guard that proves nothing. Those entries carry
 * no identifiers, and the published count distinguishes claims a test
 * enforces from claims that rest on review.
 *
 * WHY THREE REASONS AND NOT ONE. "We do not detect X" collapses three
 * different facts that a reader should be able to tell apart: a surface we
 * could instrument and have not, a capability we refuse on principle, and
 * something no single instrumented page visit can see. Only the first is a
 * backlog item. Flattening them would let a deliberate non-goal read as an
 * oversight, and an impossibility read as a promise.
 */

export type CoverageBoundaryReason = "not-instrumented" | "declined" | "unobservable";

export type CoverageBoundaryEntry = {
  /** Stable id; safe to deep-link and to reference from an issue. */
  readonly id: string;
  readonly label: string;
  readonly reason: CoverageBoundaryReason;
  readonly explanation: string;
  /**
   * Identifiers that must NOT appear in the scanner sources for this claim to
   * hold, checked by the accompanying test.
   *
   * Only API-shaped claims can be proven this way. "We do not compare script
   * bytes between visits" is a real gap with no missing identifier to point
   * at, and inventing a token that is trivially absent would be a guard that
   * proves nothing. Such entries carry no identifiers and are counted
   * separately, so the page can say how many claims are mechanically enforced
   * rather than implying all of them are.
   */
  readonly absentIdentifiers?: readonly string[];
};

/**
 * The source text every claim below is checked against, because the guard is
 * only as complete as the surface it reads. Two files used to be listed here
 * while more modules could reach the page, so a hook landing in any of the
 * others would not have tripped a single claim.
 *
 * A DELIBERATE SUPERSET, and worth stating plainly rather than implying the
 * list is exactly the injecting set. Six of these either call Playwright's
 * injection API or have a function handed to it. `keystroke-exfiltration` and
 * `scan-runtime` do neither: they are scanner-adjacent modules read anyway,
 * because scanning extra text can only make an absence claim stricter, never
 * weaker. Nothing is lost by over-including and a real hook is caught sooner.
 *
 * The rule for adding: if a surface could plausibly be instrumented from the
 * module, read it. The two derivations below then check that nothing which
 * DOES reach the page is missing from this list.
 */
export const COVERAGE_BOUNDARY_SOURCES: readonly string[] = [
  "lib/bounded-page-collector.ts",
  "lib/consent-interaction.ts",
  "lib/consent-verification.ts",
  "lib/fingerprint-observer.ts",
  "lib/gpc-injection.ts",
  "lib/keystroke-exfiltration.ts",
  "lib/scan-runtime.ts",
  "lib/scanner.ts"
];

/**
 * Modules that call Playwright's injection API themselves.
 *
 * SAYS LESS THAN IT LOOKS. This is a host-side call-text match, and it is
 * blind to the dominant idiom in this scanner: a module exports a plain
 * page-context function and `lib/scanner.ts` hands it to `addInitScript`. A
 * module of that shape contains none of these tokens. Three of the eight
 * sources declared above (`gpc-injection`, `keystroke-exfiltration`,
 * `scan-runtime`) match this pattern zero times, which is the proof.
 *
 * So this is one of two signals, not the mechanism. `injectedModuleSpecifiers`
 * below covers the shape this misses, by following what is actually handed to
 * the injection call. Neither alone keeps the list complete.
 */
export const PAGE_INJECTION_PATTERN = /addInitScript|page\.evaluate|frame\.evaluate|\.evaluate\(/;

/** Injection call whose first argument is a bare identifier, not an inline function. */
const INJECTION_CALL = /(?:addInitScript|evaluateHandle|evaluate)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
/** Named import block, possibly spanning lines, with optional `type` and `as`. */
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;

/**
 * Repo-relative modules whose exported function this source injects into the
 * page, resolved through the source's own imports.
 *
 * This is the signal that catches the shape PAGE_INJECTION_PATTERN cannot see:
 * whatever reaches the page must be passed to an injection call somewhere in a
 * file the boundary already reads, so following that argument back to its
 * defining module finds the injecting module even though that module contains
 * no Playwright call of its own.
 *
 * Arguments that are inline functions or locally defined resolve to nothing
 * and are skipped, so an unresolvable call neither throws nor false-flags.
 * Separated from the test, like the other checks here, so the check itself can
 * be shown to fail.
 */
export function injectedModuleSpecifiers(source: string): string[] {
  const imported = new Map<string, string>();
  for (const block of source.matchAll(NAMED_IMPORT)) {
    for (const raw of block[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliased = part.match(/^(\S+)\s+as\s+(\S+)$/);
      imported.set(aliased ? aliased[2] : part, block[2]);
    }
  }

  const found = new Set<string>();
  for (const call of source.matchAll(INJECTION_CALL)) {
    const specifier = imported.get(call[1]);
    if (!specifier) continue;
    if (specifier.startsWith("./")) found.add(`lib/${specifier.slice(2)}.ts`);
    else if (specifier.startsWith("@/lib/")) found.add(`${specifier.slice(2)}.ts`);
  }
  return [...found].sort();
}

export const COVERAGE_BOUNDARY_ENTRIES: readonly CoverageBoundaryEntry[] = [
  {
    id: "device-sensors",
    label: "Device motion, orientation, and ambient sensors",
    reason: "not-instrumented",
    explanation:
      "Accelerometer, gyroscope, magnetometer, and ambient-light readings can carry device entropy. The scanner does not hook these APIs, so a report is silent about them whether or not a page used them.",
    absentIdentifiers: [
      "DeviceOrientation",
      "DeviceMotion",
      "Accelerometer",
      "Gyroscope",
      "Magnetometer",
      "AmbientLight"
    ]
  },
  {
    id: "battery-status",
    label: "Battery status",
    reason: "not-instrumented",
    explanation:
      "Battery level and charging state were a documented fingerprinting vector. The scanner does not observe the Battery Status API.",
    absentIdentifiers: ["getBattery"]
  },
  {
    id: "media-device-enumeration",
    label: "Media device enumeration",
    reason: "not-instrumented",
    explanation:
      "The list and ordering of cameras and microphones is high-entropy. The scanner does not observe device enumeration.",
    absentIdentifiers: ["enumerateDevices"]
  },
  {
    id: "speech-voice-list",
    label: "Installed speech-synthesis voices",
    reason: "not-instrumented",
    explanation:
      "Installed voice lists vary by platform and installed software. The scanner does not observe them.",
    absentIdentifiers: ["getVoices"]
  },
  {
    id: "storage-quota",
    label: "Storage quota estimation",
    reason: "not-instrumented",
    explanation:
      "Quota estimates can expose device and profile characteristics. The scanner does not observe quota queries.",
    absentIdentifiers: ["storage.estimate"]
  },
  {
    id: "client-hints",
    label: "High-entropy client hints",
    reason: "not-instrumented",
    explanation:
      "Sites can request detailed platform and architecture hints, over request headers or the in-page hint API. No report field holds client-hint headers, and the in-page API is not instrumented, so neither route is visible in a report. The claim is scoped to client hints on purpose: a report does carry one request-header observation, the scanner's own GPC signal readback.",
    absentIdentifiers: ["userAgentData"]
  },
  {
    id: "network-information",
    label: "Network information",
    reason: "not-instrumented",
    explanation:
      "Effective connection type and downlink estimates are observable entropy. The scanner does not hook the Network Information API.",
    absentIdentifiers: ["navigator.connection"]
  },
  {
    id: "timing-side-channels",
    label: "Timing side channels",
    reason: "not-instrumented",
    explanation:
      "High-resolution timers can be used to infer cached resources, hardware characteristics, and cross-site state without any request the scanner would log. The scanner does not observe timer construction or clock probing, so a report saying nothing about timing means the surface was never watched, not that it was unused. The enforced part of this claim is the distinctive high-resolution constructs; a page reading the ordinary coarse clock is not distinguishable from any other script.",
    absentIdentifiers: ["SharedArrayBuffer", "Atomics", "timeOrigin"]
  },
  {
    id: "geolocation",
    label: "Geolocation requests",
    reason: "not-instrumented",
    explanation:
      "A page can ask for precise location through the Geolocation API. The scanner neither hooks that API nor grants the permission, so a report does not record that a site asked, and its silence is not evidence that no request was made.",
    absentIdentifiers: ["geolocation", "getCurrentPosition", "watchPosition"]
  },
  {
    id: "permissions-api",
    label: "Permission state queries",
    reason: "not-instrumented",
    explanation:
      "Querying the state of camera, microphone, notification, or location permissions is itself an entropy source, and it happens without any user prompt. The scanner does not instrument the Permissions API, so these silent queries are absent from every report.",
    absentIdentifiers: ["navigator.permissions", "permissions.query"]
  },
  {
    id: "script-integrity-drift",
    label: "Third-party script integrity over time",
    reason: "not-instrumented",
    explanation:
      "A third-party script can change after review. The scanner records which scripts were requested on a visit, but does not compare script bytes between visits, so a silent post-deployment change is not currently detected. This gap is architectural rather than a missing API hook, so no identifier check can stand in for it."
  },
  {
    id: "authenticated-sessions",
    label: "Anything behind a login",
    reason: "declined",
    explanation:
      "Scans are unauthenticated. Behavior that only appears to signed-in users is outside every report, by choice: holding credentials for sites we scan would create a risk we are not willing to carry on readers' behalf."
  },
  {
    id: "bot-wall-evasion",
    label: "Behavior hidden behind bot walls",
    reason: "declined",
    explanation:
      "The scanner identifies itself honestly and does not spoof a user agent or solve challenges. When a site refuses an automated browser, the refusal is reported as the finding rather than worked around, so what that site would have done for a human is unmeasured."
  },
  {
    id: "real-user-panels",
    label: "Real-user measurement",
    reason: "declined",
    explanation:
      "Every measurement comes from a controlled browser we operate. No panel, extension, or user traffic feeds this project, so findings describe what a site did for this instrument, not a population of real visitors."
  },
  {
    id: "server-side-data-flows",
    label: "What happens after a request arrives",
    reason: "unobservable",
    explanation:
      "A browser sees that a request was sent and what it carried. It cannot see retention, onward sale, server-to-server sharing, or joins performed after receipt. No report should be read as evidence about any of those."
  },
  {
    id: "native-app-behavior",
    label: "Native apps and embedded SDKs",
    reason: "unobservable",
    explanation:
      "This instrument drives a web browser. Mobile applications and the SDKs inside them are a different surface and are never covered by a site's report."
  },
  {
    id: "cross-device-identity",
    label: "Cross-device and offline identity joins",
    reason: "unobservable",
    explanation:
      "Linking a visit to other devices, logged-in profiles, or offline records happens outside the page. A single visit cannot observe it, so its absence from a report means nothing about whether it occurs."
  }
];

export const coverageBoundaryMetadata = {
  version: "coverage-boundary-v1",
  entries: COVERAGE_BOUNDARY_ENTRIES.length,
  /** Claims a test enforces against the scanner source, not merely asserted. */
  checkedClaims: COVERAGE_BOUNDARY_ENTRIES.filter(
    (entry) => entry.absentIdentifiers !== undefined && entry.absentIdentifiers.length > 0
  ).length
};

/**
 * Where the full boundary is published. A report artifact summarizes; this is
 * the link that makes the summary checkable.
 */
export const COVERAGE_BOUNDARY_PATH = "/catalog/#coverage-boundary";

/**
 * Absolute form, for print and PDF. Paper has no base path to resolve against
 * and no link to follow, so it needs the whole address. On screen use
 * COVERAGE_BOUNDARY_PATH through next/link instead, so a deployment under a
 * base path does not ship a broken anchor.
 */
export const COVERAGE_BOUNDARY_URL = `https://sitebehavior.org${COVERAGE_BOUNDARY_PATH}`;

/**
 * The boundary reduced to what a report artifact can carry.
 *
 * A forwarded report used to carry none of this: the enumeration lived only on
 * the catalog page, so the one artifact a reader sends to a third party was
 * silent about what the instrument never looked at. A reader cannot be
 * expected to know that silence means "unwatched" rather than "absent".
 *
 * Derived from the entries rather than written out, because a hand-written
 * summary is exactly the second copy that drifts from the list it summarizes.
 */
export function coverageBoundarySummary(
  entries: readonly CoverageBoundaryEntry[] = COVERAGE_BOUNDARY_ENTRIES
): Readonly<Record<CoverageBoundaryReason, readonly string[]>> {
  const group = (reason: CoverageBoundaryReason) =>
    entries.filter((entry) => entry.reason === reason).map((entry) => entry.label);
  return {
    "not-instrumented": group("not-instrumented"),
    declined: group("declined"),
    unobservable: group("unobservable")
  };
}

/**
 * One sentence naming what a clean report does NOT rule out, for surfaces with
 * no room to list all of it. Says "not measured" and never "not present",
 * which is the distinction the whole boundary exists to protect.
 */
export function coverageBoundarySentence(
  entries: readonly CoverageBoundaryEntry[] = COVERAGE_BOUNDARY_ENTRIES
): string {
  const summary = coverageBoundarySummary(entries);
  const surfaces = summary["not-instrumented"];
  const declined = summary.declined.length;
  const unobservable = summary.unobservable.length;
  // Entry labels contain their own commas ("Device motion, orientation, and
  // ambient sensors"), so a comma-joined list reads as one run-on enumeration
  // and a reader cannot tell where one surface ends and the next begins.
  const listed = surfaces.slice(0, 3).join("; ");
  const rest = surfaces.length - 3;
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return (
    `This report covers what the scanner measures, not everything a site can do. ` +
    `${plural(surfaces.length, "browser surface is", "browser surfaces are")} not instrumented at all ` +
    `(${listed}${rest > 0 ? `; and ${plural(rest, "other", "others")}` : ""}), ` +
    `${plural(declined, "capability is", "capabilities are")} declined by policy, and ` +
    `${plural(unobservable, "is", "are")} outside what any single visit can see. ` +
    `Their absence from this report is not evidence that they did not occur.`
  );
}

export const COVERAGE_BOUNDARY_REASON_COPY: Readonly<
  Record<CoverageBoundaryReason, { readonly label: string; readonly meaning: string }>
> = {
  "not-instrumented": {
    label: "Not instrumented",
    meaning:
      "A browser surface this scanner could observe and currently does not. These are the entries that could become coverage; each one is held to its claim by a test that reads the scanner source."
  },
  declined: {
    label: "Declined",
    meaning:
      "A capability deliberately not built. These are not backlog items, and building them would change what this project is."
  },
  unobservable: {
    label: "Outside the instrument",
    meaning:
      "Not visible to any single instrumented page visit. No amount of engineering on this scanner would reveal it."
  }
};

/**
 * Check the published no-coverage claims against real scanner source text.
 *
 * Separated from the test so the check itself is testable: a guard that has
 * never been shown to fail is not evidence of anything.
 */
export function coverageBoundaryViolations(
  entries: readonly CoverageBoundaryEntry[],
  sourceText: string
): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    for (const identifier of entry.absentIdentifiers ?? []) {
      if (sourceText.includes(identifier)) {
        violations.push(
          `${entry.id}: the boundary claims "${entry.label}" is not instrumented, but ${identifier} appears in the scanner source`
        );
      }
    }
  }
  return violations;
}

/** Structural validation, mirroring the validation-matrix manifest check. */
export function validateCoverageBoundary(entries: readonly CoverageBoundaryEntry[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const label = `entry ${index + 1}`;
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id)) issues.push(`${label}: id must be a lowercase slug`);
    if (ids.has(entry.id)) issues.push(`${label}: duplicate id ${entry.id}`);
    ids.add(entry.id);
    if (!entry.label.trim()) issues.push(`${label}: label is required`);
    if (entry.explanation.trim().length < 40) {
      issues.push(`${label}: explanation must say what a reader cannot conclude`);
    }
    if (entry.reason === "not-instrumented") {
      if (entry.absentIdentifiers && entry.absentIdentifiers.length === 0) {
        issues.push(`${label}: absentIdentifiers must be omitted or non-empty, never an empty promise`);
      }
    } else if (entry.absentIdentifiers !== undefined) {
      issues.push(`${label}: only a not-instrumented claim may name absent identifiers`);
    }
  }

  for (const reason of ["not-instrumented", "declined", "unobservable"] as const) {
    if (!entries.some((entry) => entry.reason === reason)) {
      issues.push(`the boundary must distinguish ${reason} from the other reasons`);
    }
  }

  return issues;
}
