import { REPORT_ID_PATTERN } from "./report-validation";

const CORRECTIONS_SCHEMA = "https://sitebehavior.org/corrections.schema.json";
const CORRECTIONS_POLICY = "https://sitebehavior.org/corrections/";
const EVENT_ID_PATTERN = /^SBL-CORR-[0-9]{4}-[0-9]{3,}$/;
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const EVENT_STATES = new Set(["active", "corrected", "superseded", "withdrawn"]);
export const CORRECTIONS_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const LEDGER_KEYS = new Set(["$schema", "schemaVersion", "policy", "entries"]);
const EVENT_KEYS = new Set([
  "eventId",
  "publishedAt",
  "state",
  "reportIds",
  "summary",
  "detailsUrl",
  "replacementReportIds",
  "supersedesEventId"
]);

export type CorrectionsEventState = "active" | "corrected" | "superseded" | "withdrawn";

export interface CorrectionsLedgerEvent {
  readonly eventId: string;
  readonly publishedAt: string;
  readonly state: CorrectionsEventState;
  readonly reportIds: readonly string[];
  readonly summary: string;
  readonly detailsUrl: string;
  readonly replacementReportIds?: readonly string[];
  readonly supersedesEventId?: string;
}

export interface ParsedCorrectionsLedger {
  readonly $schema: typeof CORRECTIONS_SCHEMA;
  readonly schemaVersion: 1;
  readonly policy: typeof CORRECTIONS_POLICY;
  readonly entries: readonly CorrectionsLedgerEvent[];
}

export interface ReportCorrections {
  readonly subjectEvents: readonly CorrectionsLedgerEvent[];
  readonly replacementEvents: readonly CorrectionsLedgerEvent[];
  readonly currentSubjectEvent: CorrectionsLedgerEvent | null;
  readonly suppressIndexing: boolean;
}

export interface CorrectionsLedgerParseOptions {
  /** Deterministic validation clock. Defaults to the real current time. */
  readonly now?: number | Date;
}

export interface CorrectionsPinnedBundleBytes {
  readonly report: Uint8Array;
  readonly sidecar: Uint8Array;
}

export type CorrectionsPinnedBundles = ReadonlyMap<string, CorrectionsPinnedBundleBytes>;

/** Strict structural and semantic parser used independently of filesystem I/O. */
export function parseCorrectionsLedger(
  value: unknown,
  options: CorrectionsLedgerParseOptions = {}
): ParsedCorrectionsLedger {
  const ledger = exactRecord(value, LEDGER_KEYS, "ledger");
  if (ledger.$schema !== CORRECTIONS_SCHEMA) throw new Error("$schema is not the canonical corrections schema URL");
  if (ledger.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (ledger.policy !== CORRECTIONS_POLICY) throw new Error("policy is not the canonical corrections policy URL");
  if (!Array.isArray(ledger.entries)) throw new Error("entries must be an array");

  const nowMs = validationNow(options.now);
  const parsedEntries: CorrectionsLedgerEvent[] = [];
  const originalReportIds = new Set<string>();
  const replacementReportIdsSeen = new Set<string>();
  const eventIds = new Set<string>();
  const latestSequenceByYear = new Map<number, number>();
  let previousPublishedAt = Number.NEGATIVE_INFINITY;
  for (const [index, candidate] of ledger.entries.entries()) {
    const label = `entries[${index}]`;
    const event = exactRecord(candidate, EVENT_KEYS, label);
    const eventId = requiredPattern(event.eventId, EVENT_ID_PATTERN, `${label}.eventId`);
    if (eventIds.has(eventId)) throw new Error(`${label}.eventId duplicates ${eventId}`);

    const publishedAt = requiredString(event.publishedAt, `${label}.publishedAt`);
    const publishedAtMs = rfc3339Timestamp(publishedAt);
    if (publishedAtMs === null) throw new Error(`${label}.publishedAt must be a valid RFC 3339 date-time`);
    if (publishedAtMs > nowMs + CORRECTIONS_FUTURE_TOLERANCE_MS) {
      throw new Error(`${label}.publishedAt is materially in the future`);
    }
    if (publishedAtMs < previousPublishedAt) throw new Error(`${label}.publishedAt is earlier than the preceding event`);

    const eventYear = Number(eventId.slice("SBL-CORR-".length, "SBL-CORR-".length + 4));
    const eventSequence = Number(eventId.slice(eventId.lastIndexOf("-") + 1));
    const publishedYear = Number(publishedAt.slice(0, 4));
    if (eventYear !== publishedYear) throw new Error(`${label}.eventId year must match publishedAt`);
    const expectedSequence = (latestSequenceByYear.get(eventYear) ?? 0) + 1;
    if (eventSequence !== expectedSequence) {
      throw new Error(`${label}.eventId must be the next sequential ID for ${eventYear}`);
    }
    if (typeof event.state !== "string" || !EVENT_STATES.has(event.state)) {
      throw new Error(`${label}.state is not recognized`);
    }
    const state = event.state as CorrectionsEventState;

    const reportIds = reportIdArray(event.reportIds, `${label}.reportIds`, true);
    const replacementReportIds = event.replacementReportIds === undefined
      ? []
      : reportIdArray(event.replacementReportIds, `${label}.replacementReportIds`, false);
    for (const reportId of reportIds) {
      if (replacementReportIdsSeen.has(reportId)) {
        throw new Error(`${label}.reportIds contains ${reportId}, which is already a replacement report`);
      }
      originalReportIds.add(reportId);
    }
    for (const reportId of replacementReportIds) {
      if (originalReportIds.has(reportId)) {
        throw new Error(`${label}.replacementReportIds contains ${reportId}, which is already an original report`);
      }
      replacementReportIdsSeen.add(reportId);
    }

    const summary = requiredString(event.summary, `${label}.summary`);
    if (summary.length > 500) throw new Error(`${label}.summary exceeds 500 characters`);
    if (summary.trim().length === 0) throw new Error(`${label}.summary must not be blank`);

    const detailsUrl = requiredString(event.detailsUrl, `${label}.detailsUrl`);
    if (!isCorrectionsDetailsUrl(detailsUrl)) throw new Error(`${label}.detailsUrl must be an absolute HTTPS URL`);

    let supersedesEventId: string | undefined;
    if (event.supersedesEventId !== undefined) {
      supersedesEventId = requiredPattern(event.supersedesEventId, EVENT_ID_PATTERN, `${label}.supersedesEventId`);
      if (!eventIds.has(supersedesEventId)) {
        throw new Error(`${label}.supersedesEventId must reference an earlier ledger event`);
      }
    }

    parsedEntries.push({
      eventId,
      publishedAt,
      state,
      reportIds,
      summary,
      detailsUrl,
      ...(event.replacementReportIds === undefined ? {} : { replacementReportIds }),
      ...(supersedesEventId === undefined ? {} : { supersedesEventId })
    });
    eventIds.add(eventId);
    latestSequenceByYear.set(eventYear, eventSequence);
    previousPublishedAt = publishedAtMs;
  }

  return {
    $schema: CORRECTIONS_SCHEMA,
    schemaVersion: 1,
    policy: CORRECTIONS_POLICY,
    entries: parsedEntries
  };
}

export function correctionsLedgerReportIds(
  value: unknown,
  options: CorrectionsLedgerParseOptions = {}
): ReadonlySet<string> {
  return parsedCorrectionsLedgerReportIds(parseCorrectionsLedger(value, options));
}

export function parsedCorrectionsLedgerReportIds(ledger: ParsedCorrectionsLedger): ReadonlySet<string> {
  const pinned = new Set<string>();
  for (const event of ledger.entries) {
    for (const reportId of event.reportIds) pinned.add(reportId);
    for (const reportId of event.replacementReportIds ?? []) pinned.add(reportId);
  }
  return pinned;
}

/** Resolve the public correction context for one immutable report identity. */
export function reportCorrections(
  ledger: ParsedCorrectionsLedger,
  reportId: string
): ReportCorrections {
  const subjectEvents = ledger.entries.filter((event) => event.reportIds.includes(reportId));
  const replacementEvents = ledger.entries.filter((event) => event.replacementReportIds?.includes(reportId) === true);
  const currentSubjectEvent = subjectEvents.at(-1) ?? null;
  return {
    subjectEvents,
    replacementEvents,
    currentSubjectEvent,
    suppressIndexing:
      currentSubjectEvent !== null &&
      currentSubjectEvent.state !== "active"
  };
}

/**
 * Assert the append-only contract across two repository revisions. Every old
 * entry must remain the exact same typed event at the same index, and every
 * report bundle it pinned must still have the exact report and sidecar bytes.
 * New entries may only be appended and must point to complete current bundles.
 */
export function assertCorrectionsLedgerHistory(
  previousValue: unknown,
  currentValue: unknown,
  previousBundles: CorrectionsPinnedBundles,
  currentBundles: CorrectionsPinnedBundles,
  options: CorrectionsLedgerParseOptions = {}
): void {
  const previous = parseCorrectionsLedger(previousValue, options);
  const current = parseCorrectionsLedger(currentValue, options);

  if (current.entries.length < previous.entries.length) {
    throw new Error("Corrections ledger entries were removed; history must be an unchanged prefix");
  }
  for (const [index, previousEvent] of previous.entries.entries()) {
    if (!sameCorrectionsEvent(previousEvent, current.entries[index])) {
      throw new Error(`Corrections ledger entries[${index}] changed; history must be an unchanged prefix`);
    }
  }

  const previousIds = parsedCorrectionsLedgerReportIds(previous);
  const currentIds = parsedCorrectionsLedgerReportIds(current);
  for (const reportId of currentIds) {
    if (!currentBundles.has(reportId)) {
      throw new Error(`Current correction-linked report ${reportId} is missing its report or provenance sidecar bytes`);
    }
  }
  for (const reportId of previousIds) {
    const previousBundle = previousBundles.get(reportId);
    if (previousBundle === undefined) {
      throw new Error(`Base correction-linked report ${reportId} is missing its report or provenance sidecar bytes`);
    }
    const currentBundle = currentBundles.get(reportId);
    if (currentBundle === undefined) {
      throw new Error(`Correction-linked report ${reportId} was removed`);
    }
    if (!sameBytes(previousBundle.report, currentBundle.report)) {
      throw new Error(`Correction-linked report ${reportId}.json changed`);
    }
    if (!sameBytes(previousBundle.sidecar, currentBundle.sidecar)) {
      throw new Error(`Correction-linked report ${reportId}.provenance.json changed`);
    }
  }
}

function reportIdArray(value: unknown, label: string, required: boolean): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${label} must be ${required ? "a non-empty" : "an"} array`);
  }
  const ids = value.map((candidate, index) => requiredPattern(candidate, REPORT_ID_PATTERN, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not contain duplicates`);
  return ids;
}

function exactRecord(value: unknown, allowedKeys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredPattern(value: unknown, pattern: RegExp, label: string): string {
  const text = requiredString(value, label);
  if (!pattern.test(text)) throw new Error(`${label} has an invalid format`);
  return text;
}

function validationNow(value: number | Date | undefined): number {
  const now = value instanceof Date ? value.getTime() : (value ?? Date.now());
  if (!Number.isFinite(now)) throw new Error("validation now must be a finite timestamp");
  return now;
}

function sameCorrectionsEvent(left: CorrectionsLedgerEvent, right: CorrectionsLedgerEvent | undefined): boolean {
  return Boolean(
    right &&
      left.eventId === right.eventId &&
      left.publishedAt === right.publishedAt &&
      left.state === right.state &&
      sameStringArray(left.reportIds, right.reportIds) &&
      left.summary === right.summary &&
      left.detailsUrl === right.detailsUrl &&
      sameOptionalStringArray(left.replacementReportIds, right.replacementReportIds) &&
      left.supersedesEventId === right.supersedesEventId
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOptionalStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameStringArray(left, right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function isCorrectionsDetailsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isCorrectionsDateTime(value: string): boolean {
  return rfc3339Timestamp(value) !== null;
}

function rfc3339Timestamp(value: string): number | null {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
