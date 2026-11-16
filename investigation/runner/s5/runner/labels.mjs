// Script ownership (R-c as refined, answers 6 and 7), computed in the runner. Never taken at the
// recorder's word: inside the scanner's browser the recorder counts every main-world script as the
// main document's, the scanner's own injected scripts among them (S5a rerun).
//
// - A script with an HTTP(S) URL is a script the page loaded. It keeps its URL and is marked inside or
//   outside the visit's origin scope: the site of the plan's URL as the scanner computes first party
//   (partyKey of lib/domain-utils.ts), never the recorder's selected scope.
// - A script with an empty URL is "scanner" when it is identified against the reference set (by
//   sha256 where the text is the same, by containment where Playwright wraps a function with
//   per-visit arguments), and otherwise "origin not identified". It is never the page's own.
//   Containment counts only when the text holds at most CONTAINMENT_MAX_EXCESS characters beyond the
//   reference (the rulings of 2026-11-16T01:36:59Z and 01:48:17Z, about three times the largest excess
//   measured on the reference visits): that is room for Playwright's wrapper and its
//   arguments, and a page that wraps a copy of a reference in its own code (eval, new Function) gets
//   no scanner label for it. The row records the excess.
// - A script with any other URL is "origin not identified", with its scheme only.
// Every source the recorder lists takes exactly one label, so the counts sum to the source count.
// No script text is in anything this returns.
import { createHash } from "node:crypto";

export const LABELS = Object.freeze(["page-loaded", "scanner", "origin-not-identified"]);
export const CONTAINMENT_MAX_EXCESS = 1024;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function schemeOf(url) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

export function identify(text, references) {
  const digest = sha256(text);
  const equal = references.references.find((r) => r.sha256 === digest);
  if (equal) return { method: "sha256", reference: equal.name, excess: 0 };
  const contained = references.references.find((r) => r.length >= references.minChars && text.length - r.length <= CONTAINMENT_MAX_EXCESS && text.includes(r.text));
  if (contained) return { method: "containment", reference: contained.name, excess: text.length - contained.length };
  return null;
}

/** One script's row: its id, URL or scheme, length, sha256, label, method, reference, excess and scope. No text. */
function rowFor({ id, url, text, state }, { references, siteKey, partyKey }) {
  const row = {
    scriptId: String(id ?? "").slice(0, 80),
    url: null,
    scheme: null,
    sourceState: typeof state === "string" ? state.slice(0, 20) : null,
    length: text === null ? null : text.length,
    sha256: text === null ? null : sha256(text),
    label: "origin-not-identified",
    method: null,
    reference: null,
    excess: null,
    scope: null
  };
  const scheme = schemeOf(url);
  if (url !== "" && (scheme === "http" || scheme === "https")) {
    row.url = url.slice(0, 2048);
    row.label = "page-loaded";
    let host = null;
    try { host = new URL(url).hostname; } catch {}
    row.scope = host !== null && partyKey(host) === siteKey ? "inside" : "outside";
    return row;
  }
  if (url !== "") { row.scheme = scheme; return row; }
  if (text !== null) {
    const found = identify(text, references);
    if (found) Object.assign(row, { label: "scanner", ...found });
  }
  return row;
}

function tableOf(rows) {
  const counts = Object.fromEntries(LABELS.map((label) => [label, rows.filter((r) => r.label === label).length]));
  return { sources: rows.length, counts, rows };
}

const textOf = (value) => (typeof value === "string" ? value : null);

/** One row per source of a raw observe output's normalized_result.sources. */
export function labelScripts(observe, context) {
  const sources = Array.isArray(observe?.normalized_result?.sources) ? observe.normalized_result.sources : [];
  return tableOf(sources.map((source) => rowFor({ id: source?.script_id, url: typeof source?.url === "string" ? source.url : "", text: textOf(source?.source?.text), state: source?.source?.state }, context)));
}

/** One row per script of a raw inspect output's normalized_result.scripts.items, its text wherever the item holds it. */
export function labelInspectScripts(inspect, context) {
  const items = Array.isArray(inspect?.normalized_result?.scripts?.items) ? inspect.normalized_result.scripts.items : [];
  return tableOf(items.map((item) => rowFor({ id: item?.script_key, url: typeof item?.url === "string" ? item.url : "", text: textOf(item?.source?.text) ?? textOf(item?.text), state: item?.source?.state ?? null }, context)));
}
