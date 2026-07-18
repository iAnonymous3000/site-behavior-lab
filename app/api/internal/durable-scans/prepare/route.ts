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
    const publicError = toPublicError(error);
    return NextResponse.json(
      { ok: false, error: publicError.message },
      { status: publicError.status, headers: { "cache-control": "no-store" } }
    );
  }
}
