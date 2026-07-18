import { NextResponse } from "next/server";
import {
  DurableScanJobCoordinatorError,
  assertDurableScanJobInternalRequest,
  isDurableScanJobActivation,
  isScanJobId,
  type DurableScanJobActivation
} from "@/lib/durable-scan-job-node";
import {
  activateDurableScanJob,
  cancelDurableScanJobGeneration
} from "@/lib/scan-jobs";
import { toPublicError } from "@/lib/public-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Private Worker-to-container activation. The public Worker blocks this path. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertDurableScanJobInternalRequest(request);
    const body: unknown = await request.json();
    const { id } = await context.params;
    if (!isDurableScanJobActivation(body) || body.jobId !== id) {
      return controlError("Invalid durable scan-job activation.", 400);
    }
    return NextResponse.json(await activateDurableScanJob(body as DurableScanJobActivation));
  } catch (error) {
    return controlException(error);
  }
}

/** Best-effort abort delivery after the Durable Object has won cancellation. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertDurableScanJobInternalRequest(request);
    const body: unknown = await request.json();
    const { id } = await context.params;
    if (!isGenerationControl(body) || body.jobId !== id) {
      return controlError("Invalid durable scan-job cancellation owner.", 400);
    }
    const result = cancelDurableScanJobGeneration(body);
    return result ? NextResponse.json(result) : controlError("Durable scan-job execution not found.", 404);
  } catch (error) {
    return controlException(error);
  }
}

function isGenerationControl(value: unknown): value is { jobId: string; generation: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === "generation" &&
    keys[1] === "jobId" &&
    isScanJobId(record.jobId) &&
    Number.isSafeInteger(record.generation) &&
    (record.generation as number) >= 1
  );
}

function controlException(error: unknown): Response {
  if (error instanceof DurableScanJobCoordinatorError && error.status) {
    return controlError(error.message, error.status);
  }
  const publicError = toPublicError(error);
  return controlError(publicError.message, publicError.status);
}

function controlError(error: string, status: number): Response {
  return NextResponse.json(
    { ok: false, error },
    { status, headers: { "cache-control": "no-store" } }
  );
}
