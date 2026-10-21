/**
 * What becomes of a live rescan, stated one way wherever the site states it:
 * the site history page (app/sites/[domain]/page.tsx) and the scan form's
 * note for a site that already has evidence (app/_components/scan-controls.tsx)
 * both render this clause. Import-free, so the static site page and the
 * homepage bundle can both read it without pulling anything else in.
 */
export const LIVE_RESCAN_HISTORY_CLAUSE =
  "a live rescan remains a standalone share report until a later corpus publication includes it";
