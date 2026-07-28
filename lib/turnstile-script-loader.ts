/**
 * Load the Turnstile script exactly once, and stay retryable when it fails.
 *
 * The previous inline loader looked for an existing <script> tag and, finding
 * one, attached `load`/`error` listeners to it. After a failed load that tag is
 * still in the document and both of its events have already fired, so `{once:
 * true}` listeners registered afterwards never run: the promise never settles.
 * A widget remount — a health retry, a reset nonce — therefore hung forever
 * with no widget and no error, which is worse than the failure it replaced,
 * because only a full page reload recovered.
 *
 * The fix is to stop inferring load state from the DOM. One shared promise
 * answers concurrent callers, a rejection clears it so a later attempt can try
 * again, and each fresh attempt removes any tag left by a previous one rather
 * than listening to a corpse.
 *
 * Extracted from the component so it can be tested against a stub document
 * without a browser.
 */
export type TurnstileScriptDocument = {
  querySelectorAll(selector: string): Iterable<{ remove(): void }>;
  createElement(tagName: "script"): TurnstileScriptElement;
  head: { appendChild(element: TurnstileScriptElement): void };
};

export type TurnstileScriptElement = {
  src: string;
  async: boolean;
  defer: boolean;
  addEventListener(type: "load" | "error", listener: () => void, options: { once: true }): void;
};

export type TurnstileScriptHost = {
  document: TurnstileScriptDocument;
  /** Present once the script has evaluated successfully. */
  loaded: () => boolean;
};

export function createTurnstileScriptLoader(src: string, host: () => TurnstileScriptHost | null) {
  let pending: Promise<void> | null = null;

  return function loadTurnstileScript(): Promise<void> {
    const active = host();
    if (!active) return Promise.reject(new Error("Turnstile is only available in the browser."));
    if (active.loaded()) return Promise.resolve();
    if (pending) return pending;

    const attempt = new Promise<void>((resolve, reject) => {
      // A tag from a previous attempt has already fired both of its events, so
      // listening to it would wait forever. Drop it and start clean.
      for (const stale of active.document.querySelectorAll(`script[src="${src}"]`)) stale.remove();

      const script = active.document.createElement("script");
      script.src = src;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Turnstile failed to load.")), { once: true });
      active.document.head.appendChild(script);
    });

    // Clear the shared promise on failure so the next mount retries instead of
    // being handed the old rejection forever. The extra handler also keeps the
    // rejection from being unhandled when no caller is waiting yet.
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };
}
