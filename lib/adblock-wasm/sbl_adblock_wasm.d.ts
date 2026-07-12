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
     * Returns true if a request to `url` of `request_type`, initiated by
     * `source_url`, would be blocked by the loaded lists. Kept for offline
     * callers whose historical contract has GET semantics.
     */
    check(url: string, source_url: string, request_type: string): boolean;
    /**
     * Method-aware network match for live routed requests. adblock-rust 0.13
     * added `$method=` filters, so the scanner must pass the browser's actual
     * method rather than silently treating POST/HEAD as GET.
     */
    checkWithMethod(url: string, source_url: string, request_type: string, method: string): boolean;
    /**
     * Build an engine from newline-separated filter list rules.
     */
    constructor(rules: string);
}
