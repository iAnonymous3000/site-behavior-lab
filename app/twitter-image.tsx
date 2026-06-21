import { OG_CONTENT_TYPE, OG_SIZE, renderHomeCard } from "@/lib/og-report-card";

export const alt = "Site Behavior Lab: see what a site does, not just what it says.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Required for the static GitHub Pages export (`output: export`).
export const dynamic = "force-static";

export default function Image() {
  return renderHomeCard();
}
