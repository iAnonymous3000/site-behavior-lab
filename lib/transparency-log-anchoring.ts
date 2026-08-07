import { TRANSPARENCY_LOG_MAX_ANCHOR_PROOF_CHARS, type TransparencyLogAnchor } from "./publication-transparency-log";

/**
 * OpenTimestamps anchoring for the publication transparency log.
 *
 * An anchor is an existence proof: once the chain head is committed into
 * Bitcoin via the OpenTimestamps aggregation network, every entry beneath
 * that head provably existed before the block that confirms it. This is the
 * one integrity property the log could not provide for itself, since a hash
 * chain alone says nothing about WHEN its prefix existed.
 *
 * This module is deliberately dependency-free. Submission needs exactly one
 * HTTP POST of the raw digest, and the calendar's reply IS the timestamp
 * proof body; wrapping it into a standard detached `.ots` file is fixed byte
 * concatenation, implemented here against the published serialization format.
 *
 * HONESTY BOUNDARY, stated once and enforced in names: `inspectOtsProof` is a
 * STRUCTURAL check. It proves the stored proof is a well-formed detached
 * timestamp whose committed message is exactly our chain head, and it reports
 * which attestation kinds the proof carries. It does not replay the operation
 * tree or check Bitcoin block headers; that is what the standard `ots`
 * verifier is for, and the status CLI prints the exact command. A structural
 * pass therefore means "this is our digest's proof, safe to publish", never
 * "Bitcoin has confirmed it".
 */

/** Detached-timestamp file header from the OpenTimestamps serialization spec. */
export const OTS_HEADER_MAGIC = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94
]);
const OTS_VERSION = 0x01;
const OTS_SHA256_OP = 0x08;
/** Attestation tags precede their payloads inside the proof's operation tree. */
const PENDING_ATTESTATION_TAG = Uint8Array.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const BITCOIN_ATTESTATION_TAG = Uint8Array.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

/** A calendar reply larger than this is not a timestamp; refuse before base64. */
export const MAX_CALENDAR_RESPONSE_BYTES = 16 * 1024;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface OtsProofInspection {
  /** Count of calendar promises still awaiting Bitcoin aggregation. */
  readonly pendingAttestations: number;
  /** Count of completed Bitcoin block attestations. */
  readonly bitcoinAttestations: number;
}

export function digestHexToBytes(headHex: string): Uint8Array {
  if (!SHA256_HEX_PATTERN.test(headHex)) throw new Error("The chain head must be 64 lowercase hex characters.");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(headHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Wrap a calendar's serialized timestamp into a standard detached `.ots`
 * proof for our head digest: header magic, format version, the sha256 hash-op
 * tag naming the digest algorithm, the digest itself, then the calendar's
 * operation tree verbatim.
 */
export function buildDetachedOtsProof(headHex: string, calendarTimestamp: Uint8Array): Uint8Array {
  if (calendarTimestamp.length === 0) throw new Error("The calendar returned an empty timestamp.");
  if (calendarTimestamp.length > MAX_CALENDAR_RESPONSE_BYTES) {
    throw new Error("The calendar response exceeds the timestamp size ceiling.");
  }
  const digest = digestHexToBytes(headHex);
  const proof = new Uint8Array(OTS_HEADER_MAGIC.length + 2 + digest.length + calendarTimestamp.length);
  proof.set(OTS_HEADER_MAGIC, 0);
  proof[OTS_HEADER_MAGIC.length] = OTS_VERSION;
  proof[OTS_HEADER_MAGIC.length + 1] = OTS_SHA256_OP;
  proof.set(digest, OTS_HEADER_MAGIC.length + 2);
  proof.set(calendarTimestamp, OTS_HEADER_MAGIC.length + 2 + digest.length);
  return proof;
}

/**
 * Structural inspection of a detached proof against the head it must commit
 * to. Throws on anything malformed; see the module docblock for what a pass
 * does and does not mean.
 */
export function inspectOtsProof(proof: Uint8Array, expectedHeadHex: string): OtsProofInspection {
  const digest = digestHexToBytes(expectedHeadHex);
  const minimum = OTS_HEADER_MAGIC.length + 2 + digest.length + 1;
  if (proof.length < minimum) throw new Error("The proof is too small to be a detached timestamp.");
  for (let index = 0; index < OTS_HEADER_MAGIC.length; index += 1) {
    if (proof[index] !== OTS_HEADER_MAGIC[index]) throw new Error("The proof does not carry the OpenTimestamps header.");
  }
  if (proof[OTS_HEADER_MAGIC.length] !== OTS_VERSION) throw new Error("The proof declares an unsupported format version.");
  if (proof[OTS_HEADER_MAGIC.length + 1] !== OTS_SHA256_OP) {
    throw new Error("The proof commits to a digest algorithm other than sha256.");
  }
  for (let index = 0; index < digest.length; index += 1) {
    if (proof[OTS_HEADER_MAGIC.length + 2 + index] !== digest[index]) {
      throw new Error("The proof commits to a different digest than the chain head it claims to anchor.");
    }
  }
  const tree = proof.subarray(OTS_HEADER_MAGIC.length + 2 + digest.length);
  const pendingAttestations = countOccurrences(tree, PENDING_ATTESTATION_TAG);
  const bitcoinAttestations = countOccurrences(tree, BITCOIN_ATTESTATION_TAG);
  if (pendingAttestations + bitcoinAttestations === 0) {
    throw new Error("The proof carries no calendar or Bitcoin attestation.");
  }
  return { pendingAttestations, bitcoinAttestations };
}

/** Build a validated anchor row from a calendar's reply. Fails closed. */
export function anchorFromCalendarTimestamp(
  entryCount: number,
  headHex: string,
  calendarTimestamp: Uint8Array
): TransparencyLogAnchor {
  const proof = buildDetachedOtsProof(headHex, calendarTimestamp);
  inspectOtsProof(proof, headHex);
  const encoded = Buffer.from(proof).toString("base64");
  if (encoded.length > TRANSPARENCY_LOG_MAX_ANCHOR_PROOF_CHARS) {
    throw new Error("The encoded proof exceeds the anchor size ceiling.");
  }
  return { entryCount, head: headHex, proofType: "opentimestamps", proof: encoded };
}

/**
 * A pending attestation embeds its calendar URI as plain bytes, so an
 * existing anchor can be attributed to the calendar that issued it. Used only
 * to make re-runs idempotent; attribution is a convenience, never a proof.
 */
export function proofMentionsCalendar(anchor: TransparencyLogAnchor, calendarUrl: string): boolean {
  const host = new URL(calendarUrl).host;
  const proof = Buffer.from(anchor.proof, "base64");
  return countOccurrences(proof, new TextEncoder().encode(host)) > 0;
}

function countOccurrences(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0;
  let count = 0;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    count += 1;
  }
  return count;
}
