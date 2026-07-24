import { NextResponse } from "next/server";
import {
  DurableScanJobCoordinatorError,
  assertDurableScanJobInternalRequest,
  readDurableScanJobInternalRequestJson
} from "@/lib/durable-scan-job-node";
import {
  isDurableScanJobPublicationReconciliationRequest,
  reconcileDurableScanJobPublication
} from "@/lib/scan-jobs";
import { toPublicError } from "@/lib/public-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Content-free R2 reconciliation for one expired publishing generation. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertDurableScanJobInternalRequest(request);
    const body = await readDurableScanJobInternalRequestJson(request);
    const { id } = await context.params;
    if (!isDurableScanJobPublicationReconciliationRequest(body) || body.jobId !== id) {
      return controlError("Invalid durable scan-job reconciliation request.", 400);
    }
    return NextResponse.json(
      await reconcileDurableScanJobPublication(body, undefined, { signal: request.signal })
    );
  } catch (error) {
    if (error instanceof DurableScanJobCoordinatorError && error.status) {
      return controlError(error.message, error.status);
    }
    const publicError = toPublicError(error);
    return controlError(publicError.message, publicError.status);
  }
}

function controlError(error: string, status: number): Response {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "cache-control": "no-store" } }
  );
}
