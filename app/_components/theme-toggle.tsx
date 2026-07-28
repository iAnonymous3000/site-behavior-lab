"use client";

import { Moon, Sun, SunMoon } from "lucide-react";
import { useThemePreference } from "../_hooks/use-theme-preference";

/**
 * The one theme control, shared by the app shell and report permalinks.
 *
 * The server cannot know the visitor's OS colour preference, so the resolved theme
 * is null until the hook's effect runs. During that window the control must not
 * claim a direction: an OS-dark visitor previously saw a moon and "Switch to dark"
 * on an already-dark page. Naming the unresolved state keeps the button honest
 * without diverging from the server-rendered HTML.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useThemePreference();

  return (
    <button
      className="icon-button"
      type="button"
      onClick={toggleTheme}
      aria-label={
        theme === "dark"
          ? "Switch to light colour theme"
          : theme === "light"
            ? "Switch to dark colour theme"
            : "Switch colour theme"
      }
    >
      {theme === "dark" ? (
        <Sun size={18} aria-hidden="true" />
      ) : theme === "light" ? (
        <Moon size={18} aria-hidden="true" />
      ) : (
        <SunMoon size={18} aria-hidden="true" />
      )}
    </button>
  );
}
