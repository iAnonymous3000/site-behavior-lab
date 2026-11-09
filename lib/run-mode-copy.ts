export type RunMode = "single" | "gpc" | "shields" | "consent";

/**
 * Copy for the scan form's run-mode control, kept out of the component so unit
 * tests can pin the plain-language rule: labels lead with the function, and the
 * tooltip plus hint define the jargon ("Brave Shields", "GPC") on first use.
 */
export const RUN_MODE_LABELS: Record<RunMode, string> = {
  single: "Single",
  gpc: "GPC diff",
  shields: "Blocker",
  consent: "Consent · experimental"
};

export type ComparisonRunMode = Exclude<RunMode, "single">;

/**
 * The run mode a published report came from, so a surface can name a report's
 * kind in the Run control's own labels rather than a vocabulary of its own.
 * Null for a kind the form cannot run (a temporal or custom comparison).
 */
export function reportRunMode(report: {
  reportType: "single" | "comparison";
  comparisonType?: string | null;
}): RunMode | null {
  if (report.reportType === "single") return "single";
  const type = report.comparisonType;
  return type === "gpc" || type === "shields" || type === "consent" ? type : null;
}

/**
 * Whether a comparison mode may be offered. Until the scanner's health check
 * answers, nothing is claimed either way: the static build rendered all three
 * comparisons as unavailable on first paint ("GPC comparison is not available
 * from this scanner") and the dynamic build as available, and both flipped
 * once health arrived (journey audit gap 18).
 */
export type RunModeAvailability = "checking" | "available" | "unavailable";

export function runModeAvailability(enabled: boolean, awaitingScannerHealth: boolean): RunModeAvailability {
  if (awaitingScannerHealth) return "checking";
  return enabled ? "available" : "unavailable";
}

/** Shown once, in place of any availability claim, while health is pending. */
export const RUN_MODE_CHECKING_NOTE = "Checking which comparisons this scanner offers.";

/**
 * Why a comparison is off, once health has answered without it. Every note
 * says only that this scanner does not offer the mode: there is one scanner,
 * so a note that names another one to use sends the visitor nowhere.
 */
const unavailableNote = (name: string): string => `${name} comparison is not available from this scanner.`;
export const RUN_MODE_UNAVAILABLE_NOTES: Readonly<Record<ComparisonRunMode, string>> = {
  gpc: unavailableNote("GPC"),
  shields: unavailableNote("Blocker"),
  consent: unavailableNote("Consent")
};

/** A comparison button's description: what the mode does, or, once known, why it is off. */
export function runModeDescription(
  mode: ComparisonRunMode,
  availability: RunModeAvailability
): { text: string; shown: boolean } {
  return availability === "unavailable"
    ? { text: RUN_MODE_UNAVAILABLE_NOTES[mode], shown: true }
    : { text: RUN_MODE_TITLES[mode], shown: false };
}

export const RUN_MODE_TITLES: Record<RunMode, string> = {
  single: "One controlled visit.",
  gpc: "Two visits: with and without the Global Privacy Control opt-out signal.",
  shields: "Two visits: one normal, one with Brave's ad-block engine and default Shields lists actively blocking (a simulation, not a live Brave-browser visit).",
  consent: 'Experimental. Two visits: one asked to click "Accept all" on the cookie banner, one "Reject all".'
};

/**
 * The line under the Run control. A comparison's two visits run in an order
 * drawn at random for each pair (lib/scan-api.ts), which the report names, so
 * a hint never says which visit comes first.
 */
export function runModeHint(mode: RunMode): string {
  if (mode === "shields") {
    return "Visits the page twice, in a random order the report names: once normally and once with Brave's ad-block engine and Shields' default filter lists actively blocking, a simulation of Brave Shields inside this scanner's browser (not a live Brave visit). It also applies the lists to the site's own requests, which Brave's default setting mostly exempts. The report shows the difference between this one pair of visits; it does not treat that difference as a causal blocking rate.";
  }
  if (mode === "gpc") {
    return 'Visits the page twice, in a random order the report names: once normally and once sending Global Privacy Control (GPC), a legal "do not sell or share my data" signal. The report shows the difference between this one pair of visits; request counts cannot prove that the site received or honored the signal.';
  }
  if (mode === "consent") {
    return 'Experimental: coverage varies across consent banners. Visits the page twice, attempting "Accept all" and "Reject all". A comparison requires recorded choices and adequate measurement; if no banner control is found, that visit stays pre-consent. Results describe this pair of visits.';
  }
  return "One controlled visit that records the requests, cookies, and scripts the page loads, up to a recording cap that is flagged when hit.";
}
