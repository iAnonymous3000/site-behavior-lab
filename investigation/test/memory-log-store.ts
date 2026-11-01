import type { HeadStore, LogStores, ObjectStore, UnreadableObject } from "../core/case-log";

/**
 * The log's stores in memory, for tests. The hosted store is not authorized yet, so
 * this and the filesystem store are the two implementations of the store rules, and
 * fs-log-store.test.ts holds both to one contract.
 */

export class MemoryObjects implements ObjectStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();

  async createOnly(address: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    if (this.objects.has(address)) return "exists";
    this.objects.set(address, new Uint8Array(bytes));
    return "created";
  }

  async read(address: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | UnreadableObject | null> {
    const bytes = this.objects.get(address);
    if (bytes === undefined) return null;
    if (bytes.length > maxBytes) return "too-large";
    return new Uint8Array(bytes);
  }
}

export class MemoryHead implements HeadStore {
  value: string | null = null;

  async read(maxChars: number): Promise<string | null> {
    return this.value !== null && this.value.length > maxChars ? "" : this.value;
  }

  async compareAndSwap(expected: string | null, next: string): Promise<boolean> {
    if (this.value !== expected) return false;
    this.value = next;
    return true;
  }
}

export type MemoryStores = LogStores & Readonly<{ entries: MemoryObjects; evidence: MemoryObjects; head: MemoryHead }>;

export function memoryStores(): MemoryStores {
  return { entries: new MemoryObjects(), evidence: new MemoryObjects(), head: new MemoryHead() };
}

/** An independent copy of everything stored, the state a fresh process would find. */
export function copyOfStores(stores: MemoryStores): MemoryStores {
  const copy = memoryStores();
  for (const [address, bytes] of stores.entries.objects) copy.entries.objects.set(address, bytes);
  for (const [address, bytes] of stores.evidence.objects) copy.evidence.objects.set(address, bytes);
  copy.head.value = stores.head.value;
  return copy;
}
