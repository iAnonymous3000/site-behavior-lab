/* tslint:disable */
/* eslint-disable */

/**
 * A compiled adblock engine, built once from newline-separated filter rules
 * (Brave / EasyList syntax) and then queried per network request.
 */
export class AdblockEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Full `BlockerResult` query returning JSON with rule/list attribution,
     * exceptions, `$redirect` surrogate, `$removeparam` rewritten URL, and
     * both Brave Standard and Aggressive verdicts.
     */
    checkDetailed(url: string, source_url: string, request_type: string, method: string): string;
    /**
     * Method-aware network match for live routed requests. adblock-rust 0.13
     * added `$method=` filters, so the scanner must pass the browser's actual
     * method rather than silently treating POST/HEAD as GET.
     */
    checkWithMethod(url: string, source_url: string, request_type: string, method: string): boolean;
    /**
     * Returns true if a request to `url` of `request_type`, initiated by
     * `source_url`, would be blocked by the loaded lists. Kept for offline
     * callers whose historical contract has GET semantics.
     */
    check(url: string, source_url: string, request_type: string): boolean;
    /**
     * Build a full-telemetry engine with `FilterSet::new(true)` so every
     * `checkDetailed` query reports the matched filter rule, originating list
     * URL, line number, exception rule, `$redirect` surrogate, `$removeparam`
     * rewritten URL, and Brave Standard vs. Aggressive blocking verdicts.
     */
    static newWithDebug(rules: string): AdblockEngine;
    /**
     * Build a compact engine from newline-separated filter list rules
     * (debug metadata off; kept for low-memory / legacy boolean callers).
     */
    constructor(rules: string);
    /**
     * Number of distinct source lists indexed when constructed with `newWithDebug`.
     */
    sourceCount(): number;
}
