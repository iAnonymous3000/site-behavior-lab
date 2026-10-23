import { displayPublicUrl } from "./text-format";

/**
 * Reader copy for "Inspect this connection" (owner's approval, 2026-10-22,
 * the brief's section 4, plus the sentences the rulings added). React-free so
 * unit tests reach every sentence; the evidence explorer's lazy chunk renders
 * it. Never "caused", "proves", "honors", "ignores" or "complies", and each
 * sentence is at most 30 words.
 */

/**
 * The link each third-party row of a fresh result's request log offers. Its
 * accessible name adds the address, as the row shows it, so a list of links
 * read out of context still says which connection each one inspects.
 */
export const INSPECT_CONNECTION_LINK = {
  label: "Inspect this connection",
  name: (address: string) => `Inspect this connection to ${displayPublicUrl(address)}`
} as const;
