/**
 * The line a v1 report carries when the scan finished but its shareable copy
 * could not be saved (lib/scan-api.ts). Such a result has no share, and the
 * browser's job poller accepts it on this line alone (lib/scan-job-polling.ts),
 * so both read one constant. The same sentence is admitted public v1
 * vocabulary in lib/redact-scan-report-v1.ts; a test pins that copy to this
 * one, since changing the wording is an identity decision, not a copy edit.
 */
export const SHARE_SAVE_WARNING = "Shareable report could not be saved on this host; JSON export is still available.";
