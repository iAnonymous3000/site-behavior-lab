/**
 * One source of truth for the Chromium sandbox launch switch and the health
 * assertion that reports it. Only the exact value "1" enables the sandbox so
 * an accidental non-empty value cannot silently change browser launch policy.
 */
export const CHROMIUM_SANDBOX_ENV = "SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX";

export function chromiumSandboxEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[CHROMIUM_SANDBOX_ENV] === "1";
}
