import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

// The trust kernel's address classifier, asked by value.
//
// What is proved, and where it stops. Verus accepts that the kernel's Rust
// functions `is_public_ipv4` and `is_public_ipv6` return what the written
// table and rule of tools/trust-kernel/kernel/src/address.rs say, for every
// 32-bit and every 128-bit value. That statement is about those two Rust
// functions and nothing else. Between a text in this process and those
// functions stand four things no proof covers:
//
// - `readAddressValue` below, which turns a text into a value with Node's
//   own readers. Tested, not proved;
// - the two entry points of tools/trust-kernel/wasm/src/lib.rs, which join
//   the two halves of an IPv6 value and turn the answer into a number.
//   Tested by lib/address-kernel.test.ts, not proved;
// - the compiler that made the WebAssembly bytes from the checked source.
//   The bytes are held to the reproducibility contract by digest; that they
//   mean what the source means is trusted;
// - the WebAssembly engine of this Node.
//
// The kernel's own text reader (address_text.rs) is not used here at all.
//
// Node only: this module reads a file and must never be imported by a
// client component or by the Worker.

/**
 * The sha256 of the vendored module. It is the digest
 * tools/trust-kernel/reproducibility-contract.json records for every host
 * that built it; lib/address-kernel.test.ts holds the two together. A file
 * with any other bytes is refused before it is compiled.
 */
export const ADDRESS_KERNEL_SHA256 = "9af354a27aafa36b181399ed6ab270133b2b30b523f9262fa4e91c9e8cfdb244";

export const ADDRESS_KERNEL_FILE = path.join("lib", "trust-kernel-wasm", "sbl_trust_kernel_wasm.wasm");

export type AddressValue =
  | { family: 4; value: number }
  | { family: 6; high: bigint; low: bigint };

export interface AddressKernel {
  /** `is_public_ipv4` on the four octets as one number, first octet most significant. */
  isPublicIpv4(value: number): boolean;
  /** `is_public_ipv6` on the first eight bytes and the last eight bytes of the address. */
  isPublicIpv6(high: bigint, low: bigint): boolean;
}

interface KernelExports {
  sbl_is_public_ipv4_value(value: number): number;
  sbl_is_public_ipv6_value(high: bigint, low: bigint): number;
}

/**
 * Compiles the vendored module after checking its digest. Throws when the
 * file is missing, is not the pinned bytes, or does not start. Synchronous,
 * because the decisions it sits beside are.
 */
export function loadAddressKernel(
  file: string = path.join(process.cwd(), ADDRESS_KERNEL_FILE),
  expectedSha256: string = ADDRESS_KERNEL_SHA256
): AddressKernel {
  const bytes = readFileSync(file);
  const found = createHash("sha256").update(bytes).digest("hex");
  if (found !== expectedSha256) {
    throw new Error("The address kernel module is not the pinned one.");
  }
  // The module imports nothing, so it is given nothing.
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const kernel = instance.exports as unknown as KernelExports;
  if (typeof kernel.sbl_is_public_ipv4_value !== "function" || typeof kernel.sbl_is_public_ipv6_value !== "function") {
    throw new Error("The address kernel module has no value entry points.");
  }
  return {
    isPublicIpv4: (value) => kernelAnswer(kernel.sbl_is_public_ipv4_value(value)),
    isPublicIpv6: (high, low) => kernelAnswer(kernel.sbl_is_public_ipv6_value(high, low))
  };
}

/** The entry points return 1 or 0. Anything else is a failure, never a "no". */
export function kernelAnswer(code: number): boolean {
  if (code === 1) return true;
  if (code === 0) return false;
  throw new Error("The address kernel returned a value that is not an answer.");
}

/**
 * The value of an address text as Node reads it, or null when Node does not
 * read the text as one address. IPv4: `net.isIPv4`, then the four octets.
 * IPv6: `net.isIPv6`, then the URL parser's serialization, which has no
 * dotted part and at most one "::". A text with a zone ("fe80::1%en0") is
 * an address to `net.isIPv6` and has no single value, so it is null.
 */
export function readAddressValue(text: string): AddressValue | null {
  if (net.isIPv4(text)) {
    const octets = text.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return { family: 4, value: ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0 };
  }
  if (!net.isIPv6(text)) return null;

  let serialized: string;
  try {
    serialized = new URL(`http://[${text}]/`).hostname;
  } catch {
    return null;
  }
  if (!serialized.startsWith("[") || !serialized.endsWith("]")) return null;
  const halves = serialized.slice(1, -1).split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  const join = (four: string[]): bigint => four.reduce((value, word) => (value << BigInt(16)) | BigInt(Number.parseInt(word, 16)), BigInt(0));
  return { family: 6, high: join(words.slice(0, 4)), low: join(words.slice(4)) };
}

/** The checked function's answer for a value. */
export function kernelSaysPublic(kernel: AddressKernel, address: AddressValue): boolean {
  return address.family === 4 ? kernel.isPublicIpv4(address.value) : kernel.isPublicIpv6(address.high, address.low);
}
