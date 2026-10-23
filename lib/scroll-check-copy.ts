/**
 * Reader copy for "Check after scrolling" (owner's approval, 2026-10-23, the
 * build brief's section 4). React-free so unit tests reach every sentence.
 * Never "caused", "proves", "safe", "honors", "ignores" or "complies", and
 * each sentence is at most 30 words.
 */

/**
 * The entry a fresh result offers in "What this visit could not see", in its
 * "Anything that loads only after interaction or consent" item.
 */
export const SCROLL_CHECK_ENTRY = {
  label: "Check after scrolling",
  sentence:
    "Opens the scan form ready for a new visit that lets this page settle and then scrolls it, checking scrolling only; nothing runs until you press Check."
} as const;
