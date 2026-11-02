import type { CaseService } from "../core/case-service";
import { memoryStores, type MemoryStores } from "./memory-log-store";

/**
 * What the viewer's tests share with the workerd entry they bundle, so nothing here may use
 * Node. A case built in Node by the real store is carried to the Worker as plain data, and the
 * service is wrapped so every value crossing it is a structured copy, as it will be when a
 * Durable Object answers: anything that leans on one isolate's membership fails here first.
 */

export const VIEWER_HOSTNAME = "workspace.example";
export const VIEWER_ORIGIN = `https://${VIEWER_HOSTNAME}`;

/** One case's stores as plain data, each object as base64. */
export type StoresDump = Readonly<{ caseId: string; head: string | null; entries: readonly (readonly [string, string])[]; evidence: readonly (readonly [string, string])[] }>;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function dumpOfStores(caseId: string, stores: MemoryStores): StoresDump {
  return {
    caseId,
    head: stores.head.value,
    entries: [...stores.entries.objects].map(([address, bytes]) => [address, base64Of(bytes)] as const),
    evidence: [...stores.evidence.objects].map(([address, bytes]) => [address, base64Of(bytes)] as const)
  };
}

export function storesFromDump(dump: StoresDump): MemoryStores {
  const stores = memoryStores();
  for (const [address, base64] of dump.entries) stores.entries.objects.set(address, bytesOf(base64));
  for (const [address, base64] of dump.evidence) stores.evidence.objects.set(address, bytesOf(base64));
  stores.head.value = dump.head;
  return stores;
}

/** The same service, with every argument and every answer copied as RPC would copy it. */
export function acrossABoundary(service: CaseService): CaseService {
  const copied = <T>(value: T): T => structuredClone(value);
  return {
    open: async (assertion, caseId) => copied(await service.open(copied(assertion), copied(caseId))),
    evidence: async (assertion, caseId, digest, offset) => copied(await service.evidence(copied(assertion), copied(caseId), copied(digest), copied(offset))),
    claim: async (assertion, caseId, viewedHead, event) => copied(await service.claim(copied(assertion), copied(caseId), copied(viewedHead), copied(event)))
  };
}
