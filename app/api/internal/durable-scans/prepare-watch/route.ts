import { NextResponse } from "next/server";
import {
  DURABLE_SCAN_JOB_PREPARED_HEADER,
  assertDurableScanJobInternalRequest,
  encodeDurableScanJobPreparation
} from "@/lib/durable-scan-job-node";
import { readRequestBodyWithinLimit } from "@/lib/edge-scan-gate";
import { PublicScanError, toPublicError } from "@/lib/public-errors";
import { MAX_BODY_BYTES } from "@/lib/scan-limits";
import { prepareEncryptedWatchRun } from "@/lib/scan-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Private edge-to-container boundary for one decrypted scheduled rescan. The
 * endpoint inherits the durable coordinator's internal bearer credential and
 * performs fresh Node DNS validation before it returns an admission envelope.
 * It never stores watch plaintext or exposes a public creation surface.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertDurableScanJobInternalRequest(request);
    const body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
    if (body === null) throw new PublicScanError("Request body is too large.", 413);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new PublicScanError("Request body must be valid JSON.");
    }
    const preparation = await prepareEncryptedWatchRun(payload);
    return NextResponse.json(preparation.submission, {
      status: 202,
      headers: {
        "cache-control": "no-store",
        [DURABLE_SCAN_JOB_PREPARED_HEADER]: encodeDurableScanJobPreparation(preparation)
      }
    });
  } catch (error) {
    // DELIBERATELY not the instanceof DurableScanJobCoordinatorError branch the
    // [id] routes use, and here the difference is load-bearing: the Worker
    // echoes a 4xx body from this route verbatim to the public watch creator
    // and maps 5xx to encryptedWatchUnavailableResponse. Mirroring the branch
    // would publish "Unauthorized durable scan-job control request." to a
    // visitor and turn a correct retry-later into a bogus 401. toPublicError
    // keeps the public answer honest and still console.errors the original
    // error with its message for the operator.
    const publicError = toPublicError(error);
    return NextResponse.json(
      { ok: false, error: publicError.message },
      { status: publicError.status, headers: { "cache-control": "no-store" } }
    );
  }
}
