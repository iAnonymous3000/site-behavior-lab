/**
 * The environment a Chromium child process is allowed to inherit.
 *
 * Chromium needs a small set of host-runtime variables for executable lookup,
 * locale, temporary files, fonts, and sandbox/runtime directories. It does not
 * need the Next process's application secrets. Supplying an explicit child env
 * prevents R2 credentials, Turnstile secrets, scan tokens, and unrelated cloud
 * credentials from being inherited by a renderer process.
 *
 * This lives in its own module because two callers need it and neither should
 * import the other: the scanner (lib/scanner.ts), whose renderer opens
 * attacker-controlled pages, and the PDF renderer (lib/report-pdf.ts), whose
 * renderer opens our own page but paints attacker-influenced strings from the
 * scanned site into it. A second hand-written allowlist is the one failure this
 * file exists to prevent.
 */

const BROWSER_PROCESS_ENV_ALLOWLIST = [
  "CHROME_DEVEL_SANDBOX",
  "FONTCONFIG_FILE",
  "FONTCONFIG_PATH",
  "FONTCONFIG_SYSROOT",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR"
] as const;

export function browserProcessEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    BROWSER_PROCESS_ENV_ALLOWLIST.flatMap((name) => {
      const value = env[name];
      return typeof value === "string" ? [[name, value] as const] : [];
    })
  );
}
