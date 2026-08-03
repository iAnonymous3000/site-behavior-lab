import { safeParseUrl } from "./report-url";
import { pageGraphToScanResult, type PageGraphAdapterInput, type PageGraphNetworkRequest } from "./pagegraph-adapter";
import type { FingerprintEventSummary, NetworkRequestProvenance, ScanResult, StorageRecord } from "./types";

export type GraphRecord = {
  id: string;
  kind: "node" | "edge";
  source?: string;
  target?: string;
  fields: Record<string, string>;
};

type GraphKey = {
  id: string;
  name: string;
};

const REQUEST_HINT = /\b(request|fetch|xhr|xmlhttprequest|network|resource)\b/i;
const STORAGE_HINT = /\b(local\s*storage|session\s*storage|storage)\b/i;
const API_HINT = /\b(api|call|method|web\s*api|js)\b/i;
const FINGERPRINT_API_HINTS = [
  /canvas/i,
  /webgl/i,
  /offlineaudiocontext/i,
  /\baudio\b/i,
  /rtcpeerconnection/i,
  /\bwebrtc\b/i,
  /navigator\.plugins/i,
  /navigator\.mimeTypes/i,
  /deviceMemory/i,
  /hardwareConcurrency/i,
  /screen\./i
];

// Defense in depth for callers that bypass the file picker. The byte ceiling
// is enforced before decoding by the r2 importer; these structural ceilings
// prevent a bounded file from expanding into unbounded record/field work.
export const PAGEGRAPH_R2_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const PAGEGRAPH_R2_MAX_RECORDS = 250_000;
export const PAGEGRAPH_R2_MAX_KEYS = 1_024;
const PAGEGRAPH_R2_MAX_FIELDS_PER_RECORD = 64;
const PAGEGRAPH_R2_MAX_FIELD_CHARS = 16_384;
export const PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION = "0.7.7" as const;
const PAGEGRAPH_R2_ABOUT_URL = "https://github.com/brave/brave-browser/wiki/PageGraph";

export type PageGraphDescription = {
  schemaVersion: typeof PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION;
  rootUrl: string;
  isRoot: true;
  scannedAt: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
};

export type PageGraphParseOptions = Omit<PageGraphAdapterInput, "requests" | "storage" | "fingerprintEvents">;

/** @deprecated Legacy/internal v1 compatibility utility; public uploads use the strict r2 builder. */
export function pageGraphGraphmlToScanResult(graphml: string, options: PageGraphParseOptions): ScanResult {
  return pageGraphToScanResult(pageGraphGraphmlToAdapterInput(graphml, options));
}

export type PageGraphUploadOverrides = Partial<PageGraphParseOptions>;

const INFERRED_ROOT_URL_WARNING =
  "The scanned page URL was inferred from the first observed URL because the export had no page/frame root node. First-party vs third-party classification may be off; re-run with an explicit page URL if it looks wrong.";

// Front-door entry point for ingesting a PageGraph GraphML export without the
// caller having to know the page URL up front: the scanned page URL is inferred
// from the graph (root/frame/document node) unless explicitly overridden.
/** @deprecated Legacy single-file v1 importer retained for compatibility tests only. */
export function pageGraphUploadToScanResult(graphml: string, overrides: PageGraphUploadOverrides = {}): ScanResult {
  const explicitUrl = overrides.requestedUrl?.trim();
  const detected = explicitUrl ? undefined : rootUrlFromRecords(parseGraphmlRecords(graphml));
  const requestedUrl = explicitUrl || detected?.url;
  if (!requestedUrl) {
    throw new Error("Could not determine the scanned page URL from this PageGraph file. It may not be a PageGraph GraphML export.");
  }

  const warnings = [...(overrides.warnings ?? [])];
  if (detected && !detected.confident) {
    warnings.push(INFERRED_ROOT_URL_WARNING);
  }

  return pageGraphGraphmlToScanResult(graphml, { ...overrides, requestedUrl, warnings });
}

export function extractPageGraphRootUrl(graphml: string): string | undefined {
  return rootUrlFromRecords(parseGraphmlRecords(graphml))?.url;
}

function rootUrlFromRecords(records: GraphRecord[]): { url: string; confident: boolean } | undefined {
  let fallback: string | undefined;
  let documentUrl: string | undefined;

  for (const record of records) {
    const url = firstUrl(record);
    if (!url) continue;
    fallback ??= url;

    const typeText = fieldText(record, ["node type", "edge type", "type", "label"]).toLowerCase();
    if (/\b(web\s*page|dom\s*root|frame|top\s*frame)\b/.test(typeText)) {
      return { url, confident: true };
    }
    if (!documentUrl && /\b(document|navigation)\b/.test(typeText)) {
      documentUrl = url;
    }
  }

  const inferred = documentUrl ?? fallback;
  return inferred ? { url: inferred, confident: false } : undefined;
}

/** @deprecated Tolerant legacy/internal parser; the public r2 producer uses the strict entry point below. */
export function pageGraphGraphmlToAdapterInput(graphml: string, options: PageGraphParseOptions): PageGraphAdapterInput {
  const records = parseGraphmlRecords(graphml);
  return pageGraphRecordsToAdapterInput(records, options);
}

function pageGraphRecordsToAdapterInput(
  records: GraphRecord[],
  options: PageGraphParseOptions
): PageGraphAdapterInput {
  const warnings = [...(options.warnings ?? [])];
  const hasSchema = hasPageGraphSchema(records);
  const requests = hasSchema ? extractSchemaRequests(records) : extractHeuristicRequests(records);
  const storage = hasSchema ? extractSchemaStorage(records) : extractStorage(records);
  const fingerprintEvents = hasSchema ? extractSchemaFingerprintEvents(records) : extractFingerprintEvents(records);

  if (records.length === 0) {
    warnings.push("No PageGraph nodes or edges were found in the supplied GraphML.");
  }
  if (requests.length === 0) {
    warnings.push("No PageGraph network request observations were extracted.");
  }

  return {
    ...options,
    requests,
    storage,
    fingerprintEvents,
    warnings
  };
}

/**
 * Fail-closed PageGraph parser used by the r2 import producer. The legacy v1
 * viewer intentionally tolerates older/heuristic exports; r2 provenance may
 * only claim current-schema facts that were actually present in the graph.
 */
export function pageGraphGraphmlToStrictAdapterInput(
  graphml: string,
  options: PageGraphParseOptions
): PageGraphAdapterInput & { graphRootUrl: string; description: PageGraphDescription } {
  if (graphml.length > PAGEGRAPH_R2_MAX_ARTIFACT_BYTES) {
    throw new Error(`PageGraph r2 artifacts must not exceed ${PAGEGRAPH_R2_MAX_ARTIFACT_BYTES} decoded characters.`);
  }
  const description = parseStrictPageGraphDescription(graphml);
  const records = parseStrictGraphmlRecords(graphml);
  assertStrictRecordEnvelope(records);
  if (records.length === 0 || !hasPageGraphSchema(records)) {
    throw new Error("PageGraph r2 import requires the current node type / edge type schema.");
  }
  const graphRootUrl = strictGraphRootUrl(records, description.rootUrl);

  const index = buildGraphIndex(records);
  const requestIds = new Set<string>();
  for (const edge of index.edges) {
    if (edgeType(edge) !== "request start") continue;
    const resource = edge.target ? index.recordsById.get(edge.target) : undefined;
    if (!resource || nodeType(resource) !== "resource" || !firstField(resource, ["url"])) {
      throw new Error("PageGraph r2 request-start edges must target a resource with an explicit URL.");
    }
    const requestId = firstField(edge, ["request id"]);
    if (!requestId || requestIds.has(requestId)) {
      throw new Error("PageGraph r2 request-start edges require unique explicit request ids.");
    }
    requestIds.add(requestId);
    if (!firstField(edge, ["resource type", "request type"])) {
      throw new Error("PageGraph r2 request-start edges require an explicit resource type.");
    }
    strictNonnegativeIntegerField(edge, "timestamp");
  }

  return { ...pageGraphRequestRecordsToAdapterInput(records, options), graphRootUrl, description };
}

function pageGraphRequestRecordsToAdapterInput(
  records: GraphRecord[],
  options: PageGraphParseOptions
): PageGraphAdapterInput {
  const warnings = [...(options.warnings ?? [])];
  const requests = extractSchemaRequests(records);
  if (requests.length === 0) {
    warnings.push("No PageGraph network request observations were extracted.");
  }
  // The public r2 producer deliberately supports request evidence only. Do
  // not traverse and materialize storage or JS-API summaries that it would
  // immediately discard; raw GraphML can contain sensitive values even when
  // the output contract correctly marks those families unsupported.
  return { ...options, requests, warnings };
}

function strictGraphRootUrl(records: GraphRecord[], expectedUrl: string): string {
  const matching = records.filter((record) => {
    if (record.kind !== "node") return false;
    const type = nodeType(record)?.toLowerCase();
    if (type !== "dom root" && type !== "web page") return false;
    return firstField(record, ["url"]) === expectedUrl;
  });
  if (matching.length !== 1) {
    throw new Error(
      "PageGraph r2 import requires exactly one explicit DOM root/web-page node whose URL matches the GraphML description."
    );
  }
  return expectedUrl;
}

function strictNonnegativeIntegerField(record: GraphRecord, name: string): number {
  const value = firstField(record, [name]);
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      `PageGraph r2 request-start edges require exact canonical nonnegative integer millisecond ${name} tokens.`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PageGraph r2 request-start ${name} exceeds the safe integer envelope.`);
  }
  return parsed;
}

/**
 * Parse the capture provenance embedded by PageGraph itself. The sidecar is
 * useful transport metadata, but it must not be able to replace or rewrite
 * the artifact's own schema, root, wall-clock time, or capture interval.
 */
function parseStrictPageGraphDescription(graphml: string): PageGraphDescription {
  const descriptions = [...graphml.matchAll(/<desc\b([^>]*)>([\s\S]*?)<\/desc>/gi)];
  if (descriptions.length !== 1 || (descriptions[0]?.[1] ?? "").trim() !== "") {
    throw new Error("PageGraph r2 artifacts require exactly one attribute-free GraphML description.");
  }
  const body = descriptions[0]?.[2] ?? "";
  const schemaVersion = strictDescriptionValue(body, "version");
  if (schemaVersion !== PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `PageGraph r2 artifacts require PageGraph schema ${PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION}; received ${schemaVersion || "missing"}.`
    );
  }
  if (strictDescriptionValue(body, "is_root") !== "true") {
    throw new Error("PageGraph r2 artifacts require an is_root=true GraphML description.");
  }
  if (strictDescriptionValue(body, "about") !== PAGEGRAPH_R2_ABOUT_URL) {
    throw new Error(`PageGraph r2 artifacts require the current PageGraph about URL (${PAGEGRAPH_R2_ABOUT_URL}).`);
  }
  if (strictDescriptionValue(body, "frame_id") !== "0") {
    throw new Error("PageGraph r2 artifacts require the root frame_id 0 description.");
  }

  const rootUrl = strictDescriptionHttpUrl(strictDescriptionValue(body, "url"));
  const scannedAt = pageGraphDateToIso(strictDescriptionValue(body, "date"));
  const timeBlocks = [...body.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)];
  if (timeBlocks.length !== 1 || (timeBlocks[0]?.[1] ?? "").trim() !== "") {
    throw new Error("PageGraph r2 artifacts require exactly one attribute-free description time interval.");
  }
  const time = timeBlocks[0]?.[2] ?? "";
  const startedAtMs = strictDescriptionInteger(time, "start");
  const endedAtMs = strictDescriptionInteger(time, "end");
  if (startedAtMs !== 0 || endedAtMs < startedAtMs) {
    throw new Error("PageGraph r2 description time must be a nonnegative navigation-start interval beginning at zero.");
  }
  assertExactDescriptionChildren(body);

  return {
    schemaVersion: PAGEGRAPH_R2_SUPPORTED_SCHEMA_VERSION,
    rootUrl,
    isRoot: true,
    scannedAt,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs
  };
}

function assertExactDescriptionChildren(body: string): void {
  let remainder = body;
  for (const tag of ["version", "about", "is_root", "frame_id", "url", "date"]) {
    remainder = remainder.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "i"), "");
  }
  remainder = remainder.replace(/<time\b[^>]*>[\s\S]*?<\/time>/i, "");
  if (remainder.trim() !== "") {
    throw new Error("PageGraph r2 description contains unknown, duplicate, or malformed child elements.");
  }
}

function strictDescriptionValue(body: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1 || (matches[0]?.[1] ?? "").trim() !== "") {
    throw new Error(`PageGraph r2 description requires exactly one attribute-free ${tag} value.`);
  }
  const raw = (matches[0]?.[2] ?? "").trim();
  if (!raw || /<[^>]*>/.test(raw)) {
    throw new Error(`PageGraph r2 description ${tag} must be a nonempty scalar value.`);
  }
  return decodeXml(raw);
}

function strictDescriptionInteger(body: string, tag: string): number {
  const value = strictDescriptionValue(body, tag);
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`PageGraph r2 description ${tag} must be a nonnegative integer millisecond value.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PageGraph r2 description ${tag} exceeds the safe integer envelope.`);
  }
  return parsed;
}

function strictDescriptionHttpUrl(value: string): string {
  const parsed = safeParseUrl(value);
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.toString() !== value
  ) {
    throw new Error("PageGraph r2 description URL must be a canonical credential-free HTTP(S) URL.");
  }
  return value;
}

function pageGraphDateToIso(value: string): string {
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error("PageGraph r2 description date must be nonnegative decimal Unix seconds.");
  }
  const seconds = Number(match[1]);
  const milliseconds = Number((match[2] ?? "").padEnd(3, "0").slice(0, 3) || "0");
  const epochMs = seconds * 1000 + milliseconds;
  if (!Number.isSafeInteger(epochMs)) {
    throw new Error("PageGraph r2 description date exceeds the safe timestamp envelope.");
  }
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("PageGraph r2 description date is outside the supported timestamp range.");
  }
  return date.toISOString();
}

function assertStrictRecordEnvelope(records: GraphRecord[]): void {
  if (records.length > PAGEGRAPH_R2_MAX_RECORDS) {
    throw new Error(`PageGraph r2 artifacts must not exceed ${PAGEGRAPH_R2_MAX_RECORDS} graph records.`);
  }
  for (const record of records) {
    if (
      record.id.length > 512 ||
      (record.source?.length ?? 0) > 512 ||
      (record.target?.length ?? 0) > 512
    ) {
      throw new Error("PageGraph r2 graph identifiers exceed the 512-character envelope.");
    }
    const fields = Object.entries(record.fields);
    if (fields.length > PAGEGRAPH_R2_MAX_FIELDS_PER_RECORD) {
      throw new Error(`PageGraph r2 records must not exceed ${PAGEGRAPH_R2_MAX_FIELDS_PER_RECORD} fields.`);
    }
    if (fields.some(([name, value]) => name.length > 256 || value.length > PAGEGRAPH_R2_MAX_FIELD_CHARS)) {
      throw new Error("PageGraph r2 graph fields exceed the public import envelope.");
    }
  }
}

export function parseGraphmlRecords(graphml: string): GraphRecord[] {
  const keys = parseGraphKeys(graphml);
  return [...parseGraphElements(graphml, "node", keys), ...parseGraphElements(graphml, "edge", keys)];
}

type StrictGraphParseState = {
  recordCount: number;
  recordIds: Set<string>;
};

function parseStrictGraphmlRecords(graphml: string): GraphRecord[] {
  const keys = parseGraphKeys(graphml, true);
  const state: StrictGraphParseState = { recordCount: 0, recordIds: new Set() };
  const nodes = parseGraphElements(graphml, "node", keys, state);
  const edges = parseGraphElements(graphml, "edge", keys, state);
  return [...nodes, ...edges];
}

function parseGraphKeys(graphml: string, strict = false): Map<string, GraphKey> {
  const keys = new Map<string, GraphKey>();
  const keyPattern = /<key\b([^>]*)\/?>/gi;
  for (const match of graphml.matchAll(keyPattern)) {
    if (strict && keys.size >= PAGEGRAPH_R2_MAX_KEYS) {
      throw new Error(`PageGraph r2 artifacts must not exceed ${PAGEGRAPH_R2_MAX_KEYS} key declarations.`);
    }
    const attributes = parseAttributes(match[1] ?? "", strict);
    if (strict) assertExactAttributeNames(attributes, ["id", "for", "attr.name", "attr.type"], "key");
    const id = attributes.id;
    if (!id) {
      if (strict) throw new Error("PageGraph r2 key declarations require an explicit id.");
      continue;
    }
    if (strict && keys.has(id)) {
      throw new Error(`PageGraph r2 artifacts must not contain duplicate key declarations (${id}).`);
    }
    const name = normalizeFieldName(attributes["attr.name"] ?? attributes.name ?? id);
    if (strict && (id.length > 256 || !name || name.length > 256)) {
      throw new Error("PageGraph r2 key ids and names must be nonempty and at most 256 characters.");
    }
    keys.set(id, {
      id,
      name
    });
  }
  return keys;
}

function parseGraphElements(
  graphml: string,
  kind: "node" | "edge",
  keys: Map<string, GraphKey>,
  strictState?: StrictGraphParseState
): GraphRecord[] {
  const records: GraphRecord[] = [];
  const pattern = new RegExp(`<${kind}\\b([^>]*)>([\\s\\S]*?)<\\/${kind}>`, "gi");
  for (const match of graphml.matchAll(pattern)) {
    if (strictState && ++strictState.recordCount > PAGEGRAPH_R2_MAX_RECORDS) {
      throw new Error(`PageGraph r2 artifacts must not exceed ${PAGEGRAPH_R2_MAX_RECORDS} graph records.`);
    }
    const attributes = parseAttributes(match[1] ?? "", strictState !== undefined);
    if (strictState) {
      assertExactAttributeNames(
        attributes,
        kind === "node" ? ["id"] : ["id", "source", "target"],
        kind
      );
    }
    const body = match[2] ?? "";
    const explicitId = attributes.id;
    if (strictState && (!explicitId || !explicitId.trim())) {
      throw new Error(`PageGraph r2 ${kind} records require an explicit nonempty id.`);
    }
    const id = explicitId ?? `${kind}-${records.length + 1}`;
    if (strictState) {
      if (strictState.recordIds.has(id)) {
        throw new Error(`PageGraph r2 artifacts must not contain duplicate node/edge ids (${id}).`);
      }
      strictState.recordIds.add(id);
      if (
        id.length > 512 ||
        (attributes.source?.length ?? 0) > 512 ||
        (attributes.target?.length ?? 0) > 512
      ) {
        throw new Error("PageGraph r2 graph identifiers exceed the 512-character envelope.");
      }
    }
    const fields: Record<string, string> = {};

    // parseAttributes already XML-decodes values; decoding again here would
    // double-decode entities (e.g. "&amp;lt;" -> "<" instead of "&lt;").
    for (const [name, value] of Object.entries(attributes)) {
      // XML identity/join attributes remain available on the GraphRecord. In
      // strict mode they must not collide with PageGraph's own data field
      // named "id" (the capture's numeric node identity).
      if (strictState && (name === "id" || name === "source" || name === "target")) continue;
      assignGraphField(fields, normalizeFieldName(name), value, strictState !== undefined);
    }

    const dataPattern = /<data\b([^>]*)>([\s\S]*?)<\/data>/gi;
    const dataKeys = strictState ? new Set<string>() : undefined;
    for (const dataMatch of body.matchAll(dataPattern)) {
      const dataAttributes = parseAttributes(dataMatch[1] ?? "", strictState !== undefined);
      if (strictState) assertExactAttributeNames(dataAttributes, ["key"], "data");
      const key = dataAttributes.key ?? "";
      if (strictState && (!key || !keys.has(key))) {
        throw new Error("PageGraph r2 data fields must reference an explicit declared key.");
      }
      if (dataKeys?.has(key)) {
        throw new Error(`PageGraph r2 records must not contain duplicate data field declarations (${key}).`);
      }
      dataKeys?.add(key);
      const name = normalizeFieldName(keys.get(key)?.name ?? key);
      if (!name) continue;
      assignGraphField(fields, name, decodeXml(stripTags(dataMatch[2] ?? "").trim()), strictState !== undefined);
    }

    records.push({
      id,
      kind,
      source: attributes.source,
      target: attributes.target,
      fields
    });
  }
  return records;
}

function assignGraphField(fields: Record<string, string>, name: string, value: string, strict: boolean): void {
  if (strict) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new Error(`PageGraph r2 records must not contain duplicate normalized fields (${name}).`);
    }
    if (Object.keys(fields).length >= PAGEGRAPH_R2_MAX_FIELDS_PER_RECORD) {
      throw new Error(`PageGraph r2 records must not exceed ${PAGEGRAPH_R2_MAX_FIELDS_PER_RECORD} fields.`);
    }
    if (name.length > 256 || value.length > PAGEGRAPH_R2_MAX_FIELD_CHARS) {
      throw new Error("PageGraph r2 graph fields exceed the public import envelope.");
    }
  }
  fields[name] = value;
}

function assertExactAttributeNames(
  attributes: Record<string, string>,
  allowed: readonly string[],
  element: string
): void {
  const unknown = Object.keys(attributes).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new Error(`PageGraph r2 ${element} elements contain unknown attributes (${unknown.join(", ")}).`);
  }
}

function hasPageGraphSchema(records: GraphRecord[]): boolean {
  return records.some((record) => firstField(record, ["node type", "edge type"]) !== undefined);
}

function extractSchemaRequests(records: GraphRecord[]): PageGraphNetworkRequest[] {
  const index = buildGraphIndex(records);
  const completionsByRequestId = requestCompletionMap(index.edges);
  const requests: PageGraphNetworkRequest[] = [];

  for (const edge of index.edges) {
    if (edgeType(edge) !== "request start") continue;
    const resource = edge.target ? index.recordsById.get(edge.target) : undefined;
    if (!resource || nodeType(resource) !== "resource") continue;

    const url = firstField(resource, ["url"]);
    if (!url) continue;

    const requestId = firstField(edge, ["request id"]);
    const completion = requestId ? completionsByRequestId.get(requestId) : undefined;
    // Current PageGraph captures write the type on the "request start" edge as
    // "resource type" (Blink's human-readable name); older captures used a
    // "request type" attribute there or carried the type on the completion
    // edge (which stays first: the completion reflects the final type after
    // redirects). Read all three before falling back to URL inference, or
    // every current capture degrades to extension guessing.
    const rawResourceType =
      firstField(completion, ["resource type"]) ?? firstField(edge, ["resource type", "request type"]);
    requests.push({
      url,
      domain: hostnameFromUrl(url),
      resourceType: rawResourceType ? normalizePageGraphResourceType(rawResourceType) : inferResourceType(url),
      // PageGraph 0.7.7 declares the request-edge "status" attribute as a
      // string and writes lifecycle tokens into it ("started" on the start
      // edge, "complete" on the completion edge, "error" on a request error),
      // never an HTTP response code. Parsing that attribute as a number would
      // publish any out-of-vocabulary value as if it were an HTTP status, so
      // the importer leaves HTTP status unavailable rather than inventing one
      // (docs/pagegraph-schema.md). The capture carries no response code
      // anywhere else either: completion edges record only response hash,
      // headers, and size.
      startedAtMs: numberField(edge, ["timestamp"]),
      requestId,
      provenance: extractSchemaRequestProvenance(edge, resource, index)
    });
  }

  return dedupeRequests(requests);
}

function extractSchemaRequestProvenance(
  requestStart: GraphRecord,
  resource: GraphRecord,
  index: GraphIndex
): NetworkRequestProvenance | undefined {
  const actor = requestStart.source ? index.recordsById.get(requestStart.source) : undefined;
  const attributedScript = scriptForActor(actor, index);
  const injector = attributedScript ? injectorForScript(attributedScript, index) : undefined;
  const actorUrl = firstUrl(actor);
  const scriptUrl = firstUrl(attributedScript);
  const injectorUrl = firstUrl(injector);

  const provenance: NetworkRequestProvenance = {
    graphRecordId: resource.id,
    initiatorId: actor?.id,
    initiatorType: nodeType(actor),
    initiatorUrl: actorUrl,
    initiatorDomain: hostnameFromUrl(actorUrl ?? ""),
    scriptId: firstField(attributedScript, ["script id"]) ?? attributedScript?.id,
    scriptUrl,
    scriptDomain: hostnameFromUrl(scriptUrl ?? ""),
    injectedById: injector?.id,
    injectedByUrl: injectorUrl,
    injectedByDomain: hostnameFromUrl(injectorUrl ?? "")
  };

  for (const key of Object.keys(provenance) as (keyof NetworkRequestProvenance)[]) {
    if (!provenance[key]) delete provenance[key];
  }

  return Object.keys(provenance).length > 1 ? provenance : undefined;
}

function extractSchemaStorage(records: GraphRecord[]): StorageRecord[] {
  const index = buildGraphIndex(records);
  const storage: StorageRecord[] = [];

  for (const edge of index.edges) {
    if (edgeType(edge) !== "storage set") continue;
    const target = edge.target ? index.recordsById.get(edge.target) : undefined;
    const targetType = nodeType(target);
    if (targetType !== "local storage" && targetType !== "session storage" && targetType !== "storage") continue;

    const key = firstField(edge, ["key"]);
    if (!key) continue;
    const value = firstField(edge, ["value"]);
    storage.push({
      area: targetType === "session storage" ? "sessionStorage" : "localStorage",
      key,
      valueBytes: byteLength(value ?? "")
    });
  }

  return uniqueStorage(storage);
}

function extractSchemaFingerprintEvents(records: GraphRecord[]): FingerprintEventSummary[] {
  const index = buildGraphIndex(records);
  const counts = new Map<string, number>();

  for (const edge of index.edges) {
    if (edgeType(edge) !== "js call") continue;
    const target = edge.target ? index.recordsById.get(edge.target) : undefined;
    const targetType = nodeType(target);
    if (targetType !== "web API" && targetType !== "JS builtin") continue;

    const api = firstField(target, ["method"]);
    if (!api || !FINGERPRINT_API_HINTS.some((pattern) => pattern.test(api))) continue;
    counts.set(api, (counts.get(api) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([api, count]) => ({ api, count }))
    .sort((a, b) => b.count - a.count || a.api.localeCompare(b.api));
}

type GraphIndex = {
  recordsById: Map<string, GraphRecord>;
  edges: GraphRecord[];
  incomingByTarget: Map<string, GraphRecord[]>;
};

function buildGraphIndex(records: GraphRecord[]): GraphIndex {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const edges = records.filter((record) => record.kind === "edge");
  const incomingByTarget = new Map<string, GraphRecord[]>();

  for (const edge of edges) {
    if (!edge.target) continue;
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.target, incoming);
  }

  return { recordsById, edges, incomingByTarget };
}

function requestCompletionMap(edges: GraphRecord[]): Map<string, GraphRecord> {
  const completions = new Map<string, GraphRecord>();
  for (const edge of edges) {
    const type = edgeType(edge);
    if (type !== "request complete" && type !== "request error") continue;
    const requestId = firstField(edge, ["request id"]);
    if (!requestId) continue;
    const existing = completions.get(requestId);
    if (!existing || edgeType(edge) === "request complete") {
      completions.set(requestId, edge);
    }
  }
  return completions;
}

function scriptForActor(actor: GraphRecord | undefined, index: GraphIndex): GraphRecord | undefined {
  if (!actor) return undefined;
  if (nodeType(actor) === "script") return actor;

  for (const edge of index.incomingByTarget.get(actor.id) ?? []) {
    const type = edgeType(edge);
    if (type !== "create node" && type !== "insert node") continue;
    const source = edge.source ? index.recordsById.get(edge.source) : undefined;
    if (nodeType(source) === "script") return source;
  }

  return undefined;
}

function injectorForScript(script: GraphRecord, index: GraphIndex): GraphRecord | undefined {
  for (const edge of index.incomingByTarget.get(script.id) ?? []) {
    const type = edgeType(edge);
    if (type !== "execute" && type !== "execute from attribute") continue;
    const source = edge.source ? index.recordsById.get(edge.source) : undefined;
    if (source) return source;
  }
  return undefined;
}

function nodeType(record: GraphRecord | undefined): string | undefined {
  return firstField(record, ["node type"]);
}

function edgeType(record: GraphRecord | undefined): string | undefined {
  return firstField(record, ["edge type"]);
}

function extractHeuristicRequests(records: GraphRecord[]): PageGraphNetworkRequest[] {
  const requests: PageGraphNetworkRequest[] = [];
  const recordsById = new Map(records.map((record) => [record.id, record]));

  for (const record of records) {
    const typeText = fieldText(record, ["type", "edge type", "node type", "label", "event", "action"]);
    const url = firstUrl(record);
    if (!url || (!REQUEST_HINT.test(typeText) && !REQUEST_HINT.test(fieldText(record)))) continue;
    const source = record.source ? recordsById.get(record.source) : undefined;

    requests.push({
      url,
      domain: hostnameFromUrl(url),
      method: firstField(record, ["method", "request method", "http method"]),
      resourceType: firstField(record, ["resource type", "resource", "initiator type"]) ?? inferResourceType(typeText),
      status: numberField(record, ["status", "status code", "response status", "http status"]),
      startedAtMs: numberField(record, ["timestamp", "time", "started at", "startedatms", "elapsed"]),
      provenance: extractRequestProvenance(record, source)
    });
  }

  return dedupeRequests(requests);
}

function extractRequestProvenance(record: GraphRecord, source: GraphRecord | undefined): NetworkRequestProvenance | undefined {
  const initiatorUrl =
    firstUrlField(record, ["initiator url", "initiator uri", "actor url", "executor url", "source url", "source script url"]) ??
    firstUrl(source);
  const initiatorType =
    firstField(record, ["initiator type", "actor type", "executor type", "source type"]) ??
    firstField(source, ["type", "node type", "label"]);
  const scriptUrl =
    firstUrlField(record, ["script url", "source script url", "initiator script url", "executor script url"]) ??
    (looksLikeScript(initiatorType, initiatorUrl) ? initiatorUrl : undefined);
  const injectedByUrl = firstUrlField(record, [
    "injected by url",
    "injector url",
    "creator url",
    "created by url",
    "parent script url",
    "injected script url"
  ]);

  const provenance: NetworkRequestProvenance = {
    initiatorId: firstField(record, ["initiator id", "actor id", "executor id", "source id"]) ?? record.source,
    initiatorType,
    initiatorUrl,
    initiatorDomain: firstField(record, ["initiator domain", "actor domain", "executor domain", "source domain"]) ?? hostnameFromUrl(initiatorUrl ?? ""),
    scriptId: firstField(record, ["script id", "source script id", "initiator script id"]) ?? (scriptUrl ? record.source : undefined),
    scriptUrl,
    scriptDomain: firstField(record, ["script domain", "source script domain"]) ?? hostnameFromUrl(scriptUrl ?? ""),
    injectedById: firstField(record, ["injected by id", "injector id", "creator id", "created by id"]),
    injectedByUrl,
    injectedByDomain: firstField(record, ["injected by domain", "injector domain", "creator domain"]) ?? hostnameFromUrl(injectedByUrl ?? "")
  };

  const hasCausalField = Object.values(provenance).some(Boolean);
  if (!hasCausalField) return undefined;

  return {
    graphRecordId: record.id,
    ...provenance
  };
}

function extractStorage(records: GraphRecord[]): StorageRecord[] {
  const storage: StorageRecord[] = [];

  for (const record of records) {
    const text = fieldText(record);
    if (!STORAGE_HINT.test(text)) continue;

    const area = /session\s*storage/i.test(text) ? "sessionStorage" : "localStorage";
    const key = firstField(record, ["key", "storage key", "name"]);
    if (!key) continue;
    const value = firstField(record, ["value", "storage value"]);
    const valueBytes = numberField(record, ["value bytes", "valuebytes", "size", "length"]) ?? byteLength(value ?? "");
    storage.push({ area, key, valueBytes });
  }

  return uniqueStorage(storage);
}

function extractFingerprintEvents(records: GraphRecord[]): FingerprintEventSummary[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const text = fieldText(record);
    if (!API_HINT.test(text) && !FINGERPRINT_API_HINTS.some((pattern) => pattern.test(text))) continue;

    const api = firstField(record, ["api", "web api", "method", "call", "function", "name", "event"]) ?? matchingApiLabel(text);
    if (!api || !FINGERPRINT_API_HINTS.some((pattern) => pattern.test(api))) continue;
    counts.set(api, (counts.get(api) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([api, count]) => ({ api, count }))
    .sort((a, b) => b.count - a.count || a.api.localeCompare(b.api));
}

function firstUrl(record: GraphRecord | undefined): string | undefined {
  if (!record) return undefined;
  for (const [name, value] of Object.entries(record.fields)) {
    if (!/\b(url|uri|href|request|resource)\b/i.test(name)) continue;
    const direct = safeParseUrl(value);
    if (direct && (direct.protocol === "http:" || direct.protocol === "https:")) return direct.toString();
    const embedded = value.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    if (embedded) return embedded;
  }
  return undefined;
}

function firstField(record: GraphRecord | undefined, names: string[]): string | undefined {
  if (!record) return undefined;
  for (const name of names) {
    const normalized = normalizeFieldName(name);
    const value = record.fields[normalized];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function firstUrlField(record: GraphRecord | undefined, names: string[]): string | undefined {
  const value = firstField(record, names);
  if (!value) return undefined;
  const direct = safeParseUrl(value);
  if (direct && (direct.protocol === "http:" || direct.protocol === "https:")) return direct.toString();
  return value.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
}

function numberField(record: GraphRecord, names: string[]): number | undefined {
  const value = firstField(record, names);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fieldText(record: GraphRecord, names?: string[]): string {
  if (names) {
    return names.map((name) => firstField(record, [name]) ?? "").join(" ");
  }
  return Object.entries(record.fields)
    .map(([name, value]) => `${name} ${value}`)
    .join(" ");
}

function matchingApiLabel(text: string): string | undefined {
  const labels = [
    "canvas.toDataURL",
    "canvas.toBlob",
    "canvas.getImageData",
    "webgl.getParameter",
    "webgl.readPixels",
    "audio.OfflineAudioContext.startRendering",
    "webrtc.RTCPeerConnection"
  ];
  return labels.find((label) => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text));
}

/**
 * Playwright's resourceType vocabulary, the report contract for request
 * records. Values already in it pass through unchanged.
 */
const PLAYWRIGHT_RESOURCE_TYPES = new Set([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other"
]);

/**
 * Fold a PageGraph resource-type value into the report's Playwright
 * vocabulary. Real captures carry Blink's human-readable names ("Image",
 * "CSS stylesheet", "SVG document", "Raw", "Text track"); leaving them raw
 * silently degrades every type-specific consumer (filter-rule request types,
 * type filters) to "other".
 */
export function normalizePageGraphResourceType(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text) return "other";
  if (PLAYWRIGHT_RESOURCE_TYPES.has(text)) return text;
  if (/stylesheet|^css$/.test(text)) return "stylesheet";
  if (/svg|image|img|icon/.test(text)) return "image";
  if (/script/.test(text)) return "script";
  if (/font/.test(text)) return "font";
  if (/xhr|ajax|^raw$/.test(text)) return "xhr";
  if (/audio|video|media/.test(text)) return "media";
  if (/text ?track|^track$/.test(text)) return "texttrack";
  if (/manifest/.test(text)) return "manifest";
  if (/websocket/.test(text)) return "websocket";
  if (/document|frame|navigation/.test(text)) return "document";
  return "other";
}

function inferResourceType(text: string): string {
  if (/script/i.test(text)) return "script";
  if (/image|img/i.test(text)) return "image";
  if (/stylesheet|css/i.test(text)) return "stylesheet";
  if (/xhr|fetch/i.test(text)) return "xhr";
  if (/document|navigation/i.test(text)) return "document";
  return "other";
}

function looksLikeScript(type: string | undefined, url: string | undefined): boolean {
  return /script|js/i.test(`${type ?? ""} ${url ?? ""}`);
}

function dedupeRequests(requests: PageGraphNetworkRequest[]): PageGraphNetworkRequest[] {
  const seen = new Set<string>();
  const deduped: PageGraphNetworkRequest[] = [];
  for (const request of requests) {
    // The graph's own request id is the identity when the capture provides
    // one: distinct requests can share method, URL, status, and timestamp,
    // and a field-shape key would silently collapse them.
    const key = request.requestId
      ? `id:${request.requestId} ${request.url}`
      : `${request.method ?? "GET"} ${request.url} ${request.status ?? ""} ${request.startedAtMs ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(request);
  }
  return deduped;
}

function uniqueStorage(records: StorageRecord[]): StorageRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.area}:${record.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseAttributes(source: string, strict = false): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let consumedThrough = 0;
  for (const match of source.matchAll(attributePattern)) {
    if (strict && source.slice(consumedThrough, match.index).trim() !== "") {
      throw new Error("PageGraph r2 elements contain malformed attribute syntax.");
    }
    const name = match[1];
    if (strict && Object.prototype.hasOwnProperty.call(attributes, name)) {
      throw new Error(`PageGraph r2 elements must not contain duplicate attributes (${name}).`);
    }
    attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
    consumedThrough = (match.index ?? 0) + match[0].length;
  }
  if (strict && source.slice(consumedThrough).replace(/\/\s*$/, "").trim() !== "") {
    throw new Error("PageGraph r2 elements contain malformed attribute syntax.");
  }
  return attributes;
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function hostnameFromUrl(url: string): string | undefined {
  return safeParseUrl(url)?.hostname;
}

function byteLength(value: string): number {
  return new Blob([value]).size;
}
