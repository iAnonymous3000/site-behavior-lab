/**
 * The homepage loads the scheduled-rescan panel, and with it the watch client,
 * only when this says so. It imports nothing, so the first load pays for these
 * few lines and not for the client. The prefix is the one the client parses
 * management links with.
 */
export const WATCH_FRAGMENT_PREFIX = "#watch=";

/**
 * True when the scanner advertises scheduled rescans, or when the address holds
 * a management link: a held link stays manageable while creation is off.
 */
export function scheduledRescansWanted(enabled: boolean, hash: string): boolean {
  return enabled || hash.startsWith(WATCH_FRAGMENT_PREFIX);
}
