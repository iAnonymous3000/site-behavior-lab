const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const URL_PATTERN = /https?:\/\/\S+/gi;
const MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Preserve the child scanner's final public-safe error without copying an
 * unbounded stderr stream into the workflow summary or diagnostics artifact.
 * URLs are redacted defensively: scan targets must never leak through a future
 * child error message even though the current CI scanner already avoids them.
 */
export function failureDiagnosticFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.trim() === "") return null;

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHARACTER_PATTERN, " ").trim())
    .filter(Boolean);
  const finalLine = lines.at(-1);
  if (!finalLine) return null;

  const redacted = finalLine.replace(URL_PATTERN, "[redacted URL]");
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}
