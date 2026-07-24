"use client";

import { useEffect, useRef, useState } from "react";

export type ResolvedTheme = "light" | "dark";

/** Keep the control state synchronized with CSS until the visitor chooses an override. */
export function useThemePreference(): {
  theme: ResolvedTheme | null;
  toggleTheme: () => void;
} {
  const [theme, setTheme] = useState<ResolvedTheme | null>(null);
  const removeSystemListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const explicitTheme = readExplicitTheme();
    if (explicitTheme) {
      setTheme(explicitTheme);
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setTheme(media.matches ? "dark" : "light");
    const removeListener = () => media.removeEventListener("change", syncSystemTheme);
    syncSystemTheme();
    media.addEventListener("change", syncSystemTheme);
    removeSystemListenerRef.current = removeListener;

    return () => {
      removeListener();
      if (removeSystemListenerRef.current === removeListener) {
        removeSystemListenerRef.current = null;
      }
    };
  }, []);

  function toggleTheme(): void {
    const current = theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    removeSystemListenerRef.current?.();
    removeSystemListenerRef.current = null;
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("sbl-theme", next);
    } catch {
      /* localStorage unavailable */
    }
    setTheme(next);
  }

  return { theme, toggleTheme };
}

function readExplicitTheme(): ResolvedTheme | null {
  const documentTheme = document.documentElement.dataset.theme;
  if (documentTheme === "light" || documentTheme === "dark") return documentTheme;
  try {
    const storedTheme = localStorage.getItem("sbl-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      document.documentElement.dataset.theme = storedTheme;
      return storedTheme;
    }
  } catch {
    /* localStorage unavailable */
  }
  return null;
}
