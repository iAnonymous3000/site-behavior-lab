// The fragment that carries a scheduled-rescan management link. The homepage
// reads it to decide when to load the panel, and the watch client parses links
// with it. This module holds the constant and nothing else, and imports
// nothing, so the homepage's first load carries only this line.
export const WATCH_FRAGMENT_PREFIX = "#watch=";
