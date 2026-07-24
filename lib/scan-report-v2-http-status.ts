/**
 * HTTP status compatibility at the frozen ScanReport v2/r2 wire boundary.
 *
 * RFC 9110 defines a status-code as three decimal digits, so an upstream can
 * truthfully produce 600-999 even though the already-published v2/r1 and
 * v2/r2 schemas only admit 100-599. Frozen reports must never coerce those
 * values to 599 or emit a schema-invalid number. Producers instead emit null
 * in the affected status field and attach one of the reserved capture-loss
 * details below. A later schema revision is required for a first-class exact
 * 600-999 value.
 */

export const HTTP_STATUS_CODE_MIN = 100;
export const HTTP_STATUS_CODE_MAX = 999;
export const SCAN_REPORT_V2_R2_HTTP_STATUS_MAX = 599;

export const R2_NAVIGATION_STATUS_UNREPRESENTABLE = "r2-navigation-status-unrepresentable" as const;
export const R2_REQUEST_STATUS_UNREPRESENTABLE = "r2-request-status-unrepresentable" as const;

export type R2HttpStatusLimitationDetail =
  | typeof R2_NAVIGATION_STATUS_UNREPRESENTABLE
  | typeof R2_REQUEST_STATUS_UNREPRESENTABLE;

export type R2HttpStatusNormalization = {
  status: number | null;
  /** True only for a valid three-digit code that the frozen r2 schema cannot carry. */
  unrepresentable: boolean;
};

export function isHttpStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HTTP_STATUS_CODE_MIN &&
    value <= HTTP_STATUS_CODE_MAX
  );
}

export function isScanReportV2R2HttpStatus(value: unknown): value is number {
  return isHttpStatusCode(value) && value <= SCAN_REPORT_V2_R2_HTTP_STATUS_MAX;
}

export function isR2HttpStatusLimitationDetail(value: unknown): value is R2HttpStatusLimitationDetail {
  return value === R2_NAVIGATION_STATUS_UNREPRESENTABLE || value === R2_REQUEST_STATUS_UNREPRESENTABLE;
}

/**
 * Validate the real HTTP grammar, then normalize only the published r2 shape.
 * Invalid/non-three-digit values still fail closed; only valid 600-999 values
 * take the explicit evidence-limitation path.
 */
export function normalizeHttpStatusForScanReportV2R2(
  value: number | null,
  label: string
): R2HttpStatusNormalization {
  if (value === null) return { status: null, unrepresentable: false };
  if (!isHttpStatusCode(value)) {
    throw new Error(`${label} must be null or an integer from 100 through 999.`);
  }
  if (!isScanReportV2R2HttpStatus(value)) {
    return { status: null, unrepresentable: true };
  }
  return { status: value, unrepresentable: false };
}
