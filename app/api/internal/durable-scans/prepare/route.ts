import { NextResponse } from "next/server";
import {
  DURABLE_SCAN_JOB_PREPARED_HEADER,
  assertDurableScanJobInternalRequest,
  encodeDurableScanJobPreparation
} from "@/lib/durable-scan-job-node";
import { prepareDurableScanJobRequest } from "@/lib/scan-jobs";
import { toPublicError } from "@/lib/public-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rollout-safe private preparation endpoint. It can never enqueue Phase-1
 * work: an older container version returns 404 here, so the edge may refuse
 * without causing a ghost target visit during gradual Container rollouts.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertDurableScanJobInternalRequest(request);
    const preparation = await prepareDurableScanJobRequest(request);
    return NextResponse.json(preparation.submission, {
      status: 202,
      headers: {
        "cache-control": "no-store",
        [DURABLE_SCAN_JOB_PREPARED_HEADER]: encodeDurableScanJobPreparation(preparation)
      }
    });
  } catch (error) {
    // DELIBERATELY not the instanceof DurableScanJobCoordinatorError branch the
    // [id] routes use. The Worker echoes any non-202/non-404 status and body
    // from this route straight to the public caller, so surfacing the internal
    // 401 would hand a visitor an unactionable authorization error for what is,
    // from their side, an operator token misconfiguration. toPublicError maps
    // it to an honest "unavailable, try later" and still console.errors the
    // original DurableScanJobCoordinatorError with its message, which is the
    // signal the operator actually needs. The edge blocks this whole prefix
    // (cloudflare/container-worker.ts privateRouteNotFound), so the only
    // requests that reach here are the Worker's own.
    const publicError = toPublicError(error);
    return NextResponse.json(
      { ok: false, error: publicError.message },
      { status: publicError.status, headers: { "cache-control": "no-store" } }
    );
  }
}
