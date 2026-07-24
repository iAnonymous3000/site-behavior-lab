/** Pure client-form decisions kept outside React so privacy and readiness are regression-tested. */

export { normalizeScanUrl } from "../lib/scan-prefill";

export function scannerHealthPending(input: {
  liveScanEnabled: boolean;
  reportPage: boolean;
  healthResolved: boolean;
  healthError: string | null;
}): boolean {
  return input.liveScanEnabled && !input.reportPage && !input.healthResolved && input.healthError === null;
}
