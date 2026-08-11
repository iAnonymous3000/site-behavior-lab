/** Cloudflare documents 300px as the minimum width of its flexible widget. */
export const TURNSTILE_FLEXIBLE_MIN_WIDTH_PX = 300;

export type TurnstileWidgetSize = "compact" | "flexible";

/**
 * Choose from Cloudflare's responsive modes using the widget's real container,
 * not the viewport. A non-finite or not-yet-laid-out width fails to compact.
 */
export function selectTurnstileWidgetSize(containerWidth: number): TurnstileWidgetSize {
  return Number.isFinite(containerWidth) && containerWidth >= TURNSTILE_FLEXIBLE_MIN_WIDTH_PX
    ? "flexible"
    : "compact";
}
