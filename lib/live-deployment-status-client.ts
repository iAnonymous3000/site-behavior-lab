import {
  LatestClientOperation,
  fetchJsonWithPolicy,
  type LatestClientOperationHandlers,
  type LatestClientOperationOutcome
} from "./client-fetch-policy";
import { evaluateLiveDeployment, type LiveDeploymentEvaluation } from "./public-status";

/** The receipt is a tiny fixed-shape object; anything larger is not credible status evidence. */
export const PAGES_DEPLOYMENT_RECEIPT_MAX_BYTES = 16 * 1024;
/** Health includes readiness checks and warnings, but should still remain compact. */
export const SCANNER_HEALTH_RESPONSE_MAX_BYTES = 64 * 1024;

export type LiveDeploymentEvidence = Readonly<{
  pages: unknown;
  scanner: unknown;
}>;

export type LiveDeploymentStatusCheck = Readonly<{
  evidence: LiveDeploymentEvidence;
  evaluation: LiveDeploymentEvaluation;
}>;

export type LiveDeploymentStatusCheckOptions = Readonly<{
  pagesReceiptUrl: string;
  scannerHealthUrl: string;
  /** Test seam; browser callers use the global fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test seam for freshness evaluation. */
  nowMs?: number;
}>;

/**
 * Fetch both public status receipts under one latest-operation epoch. The
 * operation owner fences success, error, and settled callbacks even if an
 * underlying fetch implementation ignores cancellation.
 */
export function runLiveDeploymentStatusCheck(
  operation: LatestClientOperation,
  options: LiveDeploymentStatusCheckOptions,
  handlers: LatestClientOperationHandlers<LiveDeploymentStatusCheck>
): Promise<LatestClientOperationOutcome> {
  return operation.run(async (signal) => {
    const sharedPolicy = options.fetchImpl ? { signal, fetchImpl: options.fetchImpl } : { signal };
    const [pages, scanner] = await Promise.all([
      fetchJsonWithPolicy(options.pagesReceiptUrl, { cache: "no-store" }, {
        ...sharedPolicy,
        label: "Public deployment receipt",
        maxBytes: PAGES_DEPLOYMENT_RECEIPT_MAX_BYTES
      }),
      fetchJsonWithPolicy(options.scannerHealthUrl, { cache: "no-store" }, {
        ...sharedPolicy,
        label: "Public scanner health",
        maxBytes: SCANNER_HEALTH_RESPONSE_MAX_BYTES
      })
    ]);
    const evidence = Object.freeze({ pages, scanner });
    return Object.freeze({
      evidence,
      evaluation: evaluateLiveDeployment(pages, scanner, options.nowMs ?? Date.now())
    });
  }, handlers);
}
