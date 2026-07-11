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
  consent: "Consent"
};

export const RUN_MODE_TITLES: Record<RunMode, string> = {
  single: "One controlled visit.",
  gpc: "Two visits: with and without the Global Privacy Control opt-out signal.",
  shields: "Two visits: one normal, one with Brave's ad-block engine and default Shields lists actively blocking (a simulation, not a live Brave-browser visit).",
  consent: 'Two visits: one asked to click "Accept all" on the cookie banner, one "Reject all".'
};

export function runModeHint(mode: RunMode): string {
  if (mode === "shields") {
    return "Visits the page twice: once normally, then once with Brave's ad-block engine and Shields' default filter lists actively blocking, a simulation of Brave Shields inside this scanner's browser (not a live Brave visit), to show what changes with blocking on.";
  }
  if (mode === "gpc") {
    return 'Visits the page twice: once normally, then once sending Global Privacy Control (GPC), a legal "do not sell or share my data" signal, to show whether the site reacts.';
  }
  if (mode === "consent") {
    return 'Visits the page twice: once clicking "Accept all" on the cookie/consent banner and once clicking "Reject all", to show what differed between the two visits. If no banner control is found, that visit stays pre-consent and the report says so.';
  }
  return "One controlled visit that records every request, cookie, and script the page loads.";
}
