export type NormalizeHttpUrlResult =
  | {
      ok: true;
      url: URL;
    }
  | {
      ok: false;
      message: string;
    };

export function normalizeHttpUrlInput(input: string): NormalizeHttpUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: "Enter a public URL to scan." };
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, message: "Only HTTP and HTTPS URLs can be scanned." };
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, message: "Enter a valid public URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "Only HTTP and HTTPS URLs can be scanned." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, message: "Credentials in URLs are not supported." };
  }

  parsed.hash = "";
  return { ok: true, url: parsed };
}
