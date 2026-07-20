import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION
} from "./legacy-methodology";
import type { ScanConditions } from "./types";

export type ScanConditionsProfile = "node-playwright" | "cloudflare-browser-run" | "brave-pagegraph";

export function scannerDisclosure(
  profile: ScanConditionsProfile,
  input: {
    chromiumVersion: string;
    locale: string;
    scannerEgress: string;
    shieldsMode?: ScanConditions["shieldsMode"];
    timezone: string;
  }
): string {
  if (profile === "node-playwright") {
    const shieldsDescription = input.shieldsMode === "block-simulation" ? "block simulation" : "classification only";
    return `Automated Chromium scan using Playwright ${NODE_PLAYWRIGHT_VERSION} from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, the listed viewport, and Brave Shields ${shieldsDescription}. Brave-list matching uses each route-evaluated request's initiating document (the parent document for a subframe navigation), under methodology ${NODE_SCANNER_METHODOLOGY_VERSION}; main-frame navigations are not blocked or counted as matches, and redirect follow-up URLs that Playwright does not re-route are not independently evaluated. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
  }

  if (profile === "cloudflare-browser-run") {
    return `Cloudflare Browser Run headless Chromium from ${input.scannerEgress} with browser ${input.chromiumVersion}, timezone ${input.timezone}, locale ${input.locale}, and the listed viewport. This Worker verifies public URL shape and DNS answers before navigation and resource loading, but Browser Run performs connection-time DNS resolution and this Worker cannot currently pin the browser connection to the verified IP. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.`;
  }

  return `Brave PageGraph-derived scan from ${input.scannerEgress} with browser ${input.chromiumVersion} and the listed viewport. Treat results as reproducible evidence for this crawl configuration, not a universal claim about all visitors.`;
}
