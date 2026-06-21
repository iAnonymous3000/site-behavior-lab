import { safeParseUrl } from "./report-url";
import { pageGraphToScanResult, type PageGraphAdapterInput, type PageGraphNetworkRequest } from "./pagegraph-adapter";
import type { FingerprintEventSummary, NetworkRequestProvenance, ScanResult, StorageRecord } from "./types";

type GraphRecord = {
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
const COOKIE_HINT = /\bcookie\b/i;
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

export type PageGraphParseOptions = Omit<PageGraphAdapterInput, "requests" | "storage" | "fingerprintEvents">;

export function pageGraphGraphmlToScanResult(graphml: string, options: PageGraphParseOptions): ScanResult {
  return pageGraphToScanResult(pageGraphGraphmlToAdapterInput(graphml, options));
}

export type PageGraphUploadOverrides = Partial<PageGraphParseOptions>;

const INFERRED_ROOT_URL_WARNING =
  "The scanned page URL was inferred from the first observed URL because the export had no page/frame root node. First-party vs third-party classification may be off; re-run with an explicit page URL if it looks wrong.";

// Front-door entry point for ingesting a PageGraph GraphML export without the
// caller having to know the page URL up front: the scanned page URL is inferred
// from the graph (root/frame/document node) unless explicitly overridden.
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

export function pageGraphGraphmlToAdapterInput(graphml: string, options: PageGraphParseOptions): PageGraphAdapterInput {
  const records = parseGraphmlRecords(graphml);
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

export function parseGraphmlRecords(graphml: string): GraphRecord[] {
  const keys = parseGraphKeys(graphml);
  return [...parseGraphElements(graphml, "node", keys), ...parseGraphElements(graphml, "edge", keys)];
}

function parseGraphKeys(graphml: string): Map<string, GraphKey> {
  const keys = new Map<string, GraphKey>();
  const keyPattern = /<key\b([^>]*)\/?>/gi;
  for (const match of graphml.matchAll(keyPattern)) {
    const attributes = parseAttributes(match[1] ?? "");
    const id = attributes.id;
    if (!id) continue;
    keys.set(id, {
      id,
      name: normalizeFieldName(attributes["attr.name"] ?? attributes.name ?? id)
    });
  }
  return keys;
}

function parseGraphElements(graphml: string, kind: "node" | "edge", keys: Map<string, GraphKey>): GraphRecord[] {
  const records: GraphRecord[] = [];
  const pattern = new RegExp(`<${kind}\\b([^>]*)>([\\s\\S]*?)<\\/${kind}>`, "gi");
  for (const match of graphml.matchAll(pattern)) {
    const attributes = parseAttributes(match[1] ?? "");
    const body = match[2] ?? "";
    const id = attributes.id ?? `${kind}-${records.length + 1}`;
    const fields: Record<string, string> = {};

    // parseAttributes already XML-decodes values; decoding again here would
    // double-decode entities (e.g. "&amp;lt;" -> "<" instead of "&lt;").
    for (const [name, value] of Object.entries(attributes)) {
      fields[normalizeFieldName(name)] = value;
    }

    const dataPattern = /<data\b([^>]*)>([\s\S]*?)<\/data>/gi;
    for (const dataMatch of body.matchAll(dataPattern)) {
      const dataAttributes = parseAttributes(dataMatch[1] ?? "");
      const key = dataAttributes.key ?? "";
      const name = normalizeFieldName(keys.get(key)?.name ?? key);
      if (!name) continue;
      fields[name] = decodeXml(stripTags(dataMatch[2] ?? "").trim());
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
    requests.push({
      url,
      domain: hostnameFromUrl(url),
      resourceType: firstField(completion, ["resource type"]) ?? firstField(edge, ["request type"]) ?? inferResourceType(url),
      status: numberField(completion ?? edge, ["status"]),
      startedAtMs: numberField(edge, ["timestamp"]),
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
    const key = `${request.method ?? "GET"} ${request.url} ${request.status ?? ""} ${request.startedAtMs ?? ""}`;
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

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attributePattern)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
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
