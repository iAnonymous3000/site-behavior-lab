/**
 * Small, dependency-free text helpers shared by the report headline, the
 * findings engine, and the report UI.
 *
 * Counts are pinned to the "en-US" locale so server-rendered and
 * client-rendered copy match (no hydration drift) and unit tests stay stable
 * regardless of the host's default locale.
 */

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Join a list into prose with an overflow tail:
 * `["a", "b", "c", "d"]` → `"a, b and c, plus 1 other"`.
 */
export function humanList(items: string[], limit = 3): string {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  if (visible.length === 0) return "";
  if (visible.length === 1) return remaining > 0 ? `${visible[0]} and ${plural(remaining, "other")}` : visible[0];
  const joined = `${visible.slice(0, -1).join(", ")} and ${visible.at(-1)}`;
  return remaining > 0 ? `${joined}, plus ${plural(remaining, "other")}` : joined;
}
