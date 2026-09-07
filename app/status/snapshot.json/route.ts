import { loadStatusSnapshot } from "@/lib/status-snapshot-server";

export const dynamic = "force-static";

export async function GET() {
  return Response.json(await loadStatusSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
