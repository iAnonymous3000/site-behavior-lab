"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/app/v3/v3.module.css";
import {
  createTurnstileScriptLoader,
  type TurnstileScriptDocument
} from "@/lib/turnstile-script-loader";
import { selectTurnstileWidgetSize, type TurnstileWidgetSize } from "@/lib/turnstile-widget-size";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileRenderOptions = {
  sitekey: string;
  size?: TurnstileWidgetSize;
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

function getWindowTurnstile(): TurnstileApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

const loadTurnstileScript = createTurnstileScriptLoader(TURNSTILE_SCRIPT_SRC, () =>
  typeof window === "undefined"
    ? null
    : {
        document: document as unknown as TurnstileScriptDocument,
        loaded: () => Boolean(getWindowTurnstile())
      }
);

export function TurnstileCheckV3({
  siteKey,
  resetNonce,
  onToken,
  onError
}: {
  siteKey: string;
  resetNonce: number;
  onToken: (token: string) => void;
  onError: (message: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [widgetSize, setWidgetSize] = useState<TurnstileWidgetSize>("compact");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = (width: number) => setWidgetSize(selectTurnstileWidgetSize(width));
    updateSize(container.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === container);
      updateSize(entry?.contentRect.width ?? container.getBoundingClientRect().width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        const api = getWindowTurnstile();
        if (cancelled || widgetIdRef.current || !containerRef.current || !api) return;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          size: widgetSize,
          callback: (token) => {
            onErrorRef.current(null);
            onTokenRef.current(token);
          },
          "error-callback": () => {
            onTokenRef.current("");
            const currentApi = getWindowTurnstile();
            if (widgetIdRef.current && currentApi) {
              try {
                currentApi.reset(widgetIdRef.current);
              } catch {}
            }
            onErrorRef.current("Browser verification could not be completed. Retry the check below.");
          },
          "expired-callback": () => onTokenRef.current(""),
          "timeout-callback": () => onTokenRef.current("")
        });
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        onErrorRef.current("Cloudflare Turnstile could not load. Check your connection and retry.");
      });

    return () => {
      cancelled = true;
      const api = getWindowTurnstile();
      if (widgetIdRef.current && api) {
        try {
          api.remove(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = null;
        onTokenRef.current("");
      }
    };
  }, [siteKey, attempt, widgetSize]);

  useEffect(() => {
    if (resetNonce === 0) return;
    onTokenRef.current("");
    const api = getWindowTurnstile();
    if (widgetIdRef.current && api) {
      try {
        api.reset(widgetIdRef.current);
      } catch {}
    }
  }, [resetNonce]);

  return (
    <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <div ref={containerRef} />
      {loadFailed && (
        <button
          type="button"
          className={styles.btn}
          onClick={() => {
            setLoadFailed(false);
            onError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry browser check
        </button>
      )}
    </div>
  );
}
