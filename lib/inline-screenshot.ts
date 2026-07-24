/**
 * Admission boundary for screenshot data URIs that can reach an HTMLImageElement.
 *
 * Report JSON is untrusted, including locally uploaded files. Merely checking a
 * data-URI prefix would hand arbitrary compressed bytes to the browser's image
 * decoders. Keep this validator runtime-neutral and allocation-light: it checks
 * canonical base64 in place, reads only the bytes needed for container headers,
 * and caps both compressed bytes and decoded image dimensions.
 */
export const INLINE_SCREENSHOT_LIMITS = Object.freeze({
  maxUriChars: 8 * 1024 * 1024,
  maxDecodedBytes: 6 * 1024 * 1024,
  maxWidth: 4_096,
  maxHeight: 4_096,
  // The largest production screenshot is the Pixel 7 viewport at device scale
  // (roughly 1024 x 2216). Four megapixels leaves deliberate headroom without
  // admitting image-dimension bombs.
  maxPixels: 4_194_304,
  maxContainerChunks: 4_096,
  maxJpegHeaderBytes: 64 * 1024
});

type ScreenshotKind = "png" | "jpeg" | "webp";

type CanonicalBase64 = {
  byteLength: number;
  byteAt(index: number): number;
};

const DATA_URI_PREFIXES: ReadonlyArray<readonly [ScreenshotKind, string]> = [
  ["png", "data:image/png;base64,"],
  ["jpeg", "data:image/jpeg;base64,"],
  ["webp", "data:image/webp;base64,"]
];

function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function canonicalBase64(body: string): CanonicalBase64 | null {
  if (body.length === 0 || body.length % 4 !== 0) return null;

  let padding = 0;
  if (body.charCodeAt(body.length - 1) === 61) padding += 1;
  if (body.charCodeAt(body.length - 2) === 61) padding += 1;
  const dataChars = body.length - padding;
  if (padding > 2 || dataChars < 2) return null;

  // Scan once instead of running a multi-megabyte regular expression. Padding
  // is legal only in the final quartet, and canonical encodings zero all unused
  // bits in that quartet.
  for (let index = 0; index < dataChars; index += 1) {
    if (sextet(body.charCodeAt(index)) < 0) return null;
  }
  for (let index = dataChars; index < body.length; index += 1) {
    if (body.charCodeAt(index) !== 61) return null;
  }
  if (padding === 2 && (sextet(body.charCodeAt(dataChars - 1)) & 0x0f) !== 0) return null;
  if (padding === 1 && (sextet(body.charCodeAt(dataChars - 1)) & 0x03) !== 0) return null;

  const byteLength = (body.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > INLINE_SCREENSHOT_LIMITS.maxDecodedBytes) return null;

  return {
    byteLength,
    byteAt(index: number): number {
      if (!Number.isSafeInteger(index) || index < 0 || index >= byteLength) return -1;
      const quartet = Math.floor(index / 3) * 4;
      const offset = index % 3;
      const a = sextet(body.charCodeAt(quartet));
      const b = sextet(body.charCodeAt(quartet + 1));
      if (offset === 0) return (a << 2) | (b >> 4);
      const c = sextet(body.charCodeAt(quartet + 2));
      if (offset === 1) return ((b & 0x0f) << 4) | (c >> 2);
      const d = sextet(body.charCodeAt(quartet + 3));
      return ((c & 0x03) << 6) | d;
    }
  };
}

function u16be(bytes: CanonicalBase64, offset: number): number {
  return bytes.byteAt(offset) * 256 + bytes.byteAt(offset + 1);
}

function u24le(bytes: CanonicalBase64, offset: number): number {
  return bytes.byteAt(offset) + bytes.byteAt(offset + 1) * 256 + bytes.byteAt(offset + 2) * 65_536;
}

function u32be(bytes: CanonicalBase64, offset: number): number {
  return (
    bytes.byteAt(offset) * 16_777_216 +
    bytes.byteAt(offset + 1) * 65_536 +
    bytes.byteAt(offset + 2) * 256 +
    bytes.byteAt(offset + 3)
  );
}

function u32le(bytes: CanonicalBase64, offset: number): number {
  return (
    bytes.byteAt(offset) +
    bytes.byteAt(offset + 1) * 256 +
    bytes.byteAt(offset + 2) * 65_536 +
    bytes.byteAt(offset + 3) * 16_777_216
  );
}

function bytesEqual(bytes: CanonicalBase64, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  return expected.every((value, index) => bytes.byteAt(offset + index) === value);
}

function fourCc(bytes: CanonicalBase64, offset: number): string | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  let result = "";
  for (let index = 0; index < 4; index += 1) {
    const code = bytes.byteAt(offset + index);
    if (code < 32 || code > 126) return null;
    result += String.fromCharCode(code);
  }
  return result;
}

function safeDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= INLINE_SCREENSHOT_LIMITS.maxWidth &&
    height <= INLINE_SCREENSHOT_LIMITS.maxHeight &&
    width * height <= INLINE_SCREENSHOT_LIMITS.maxPixels
  );
}

function safePng(bytes: CanonicalBase64): boolean {
  if (
    bytes.byteLength < 57 ||
    !bytesEqual(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    u32be(bytes, 8) !== 13 ||
    fourCc(bytes, 12) !== "IHDR"
  ) {
    return false;
  }

  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  const bitDepth = bytes.byteAt(24);
  const colorType = bytes.byteAt(25);
  const validBitDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth));
  if (
    !safeDimensions(width, height) ||
    !validBitDepth ||
    bytes.byteAt(26) !== 0 ||
    bytes.byteAt(27) !== 0 ||
    (bytes.byteAt(28) !== 0 && bytes.byteAt(28) !== 1)
  ) {
    return false;
  }

  let position = 8;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  while (position < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > INLINE_SCREENSHOT_LIMITS.maxContainerChunks || position + 12 > bytes.byteLength) return false;
    const length = u32be(bytes, position);
    const type = fourCc(bytes, position + 4);
    const dataStart = position + 8;
    const chunkEnd = dataStart + length + 4;
    if (type === null || !Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    // Screenshots are static. Refuse APNG rather than letting an uploaded file
    // turn one bounded canvas into an attacker-controlled animation workload.
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      return length === 0 && sawImageData && chunkEnd === bytes.byteLength &&
        bytesEqual(bytes, chunkEnd - 4, [174, 66, 96, 130]);
    }
    position = chunkEnd;
  }
  return false;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function safeJpeg(bytes: CanonicalBase64): boolean {
  if (
    bytes.byteLength < 16 ||
    !bytesEqual(bytes, 0, [0xff, 0xd8]) ||
    !bytesEqual(bytes, bytes.byteLength - 2, [0xff, 0xd9])
  ) {
    return false;
  }

  const headerEnd = Math.min(bytes.byteLength - 2, INLINE_SCREENSHOT_LIMITS.maxJpegHeaderBytes);
  let position = 2;
  let chunkCount = 0;
  let dimensionsSafe = false;
  while (position < headerEnd) {
    chunkCount += 1;
    if (chunkCount > INLINE_SCREENSHOT_LIMITS.maxContainerChunks || bytes.byteAt(position) !== 0xff) return false;
    while (position < headerEnd && bytes.byteAt(position) === 0xff) position += 1;
    if (position >= headerEnd) return false;
    const marker = bytes.byteAt(position);
    position += 1;

    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.byteLength) return false;
    const segmentLength = u16be(bytes, position);
    if (segmentLength < 2 || position + segmentLength > bytes.byteLength - 2) return false;

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) return false;
      const height = u16be(bytes, position + 3);
      const width = u16be(bytes, position + 5);
      const components = bytes.byteAt(position + 7);
      if (components < 1 || components > 4 || segmentLength < 8 + components * 3) return false;
      dimensionsSafe = safeDimensions(width, height);
      if (!dimensionsSafe) return false;
    }
    if (marker === 0xda) return dimensionsSafe;
    position += segmentLength;
  }
  return false;
}

function safeWebp(bytes: CanonicalBase64): boolean {
  if (
    bytes.byteLength < 30 ||
    !bytesEqual(bytes, 0, [82, 73, 70, 70]) ||
    !bytesEqual(bytes, 8, [87, 69, 66, 80]) ||
    u32le(bytes, 4) + 8 !== bytes.byteLength
  ) {
    return false;
  }

  let position = 12;
  let chunkCount = 0;
  let canvas: [number, number] | null = null;
  let image: [number, number] | null = null;
  while (position < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > INLINE_SCREENSHOT_LIMITS.maxContainerChunks || position + 8 > bytes.byteLength) return false;
    const type = fourCc(bytes, position);
    const length = u32le(bytes, position + 4);
    const dataStart = position + 8;
    const chunkEnd = dataStart + length + (length & 1);
    if (type === null || !Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) return false;

    if (type === "ANIM" || type === "ANMF") return false;
    if (type === "VP8X") {
      if (position !== 12 || canvas !== null || length < 10) return false;
      const flags = bytes.byteAt(dataStart);
      if ((flags & 0xc3) !== 0) return false;
      canvas = [u24le(bytes, dataStart + 4) + 1, u24le(bytes, dataStart + 7) + 1];
      if (!safeDimensions(canvas[0], canvas[1])) return false;
    } else if (type === "VP8 ") {
      if (image !== null || length < 10 || (bytes.byteAt(dataStart) & 1) !== 0 ||
        !bytesEqual(bytes, dataStart + 3, [157, 1, 42])) return false;
      image = [
        bytes.byteAt(dataStart + 6) + (bytes.byteAt(dataStart + 7) & 0x3f) * 256,
        bytes.byteAt(dataStart + 8) + (bytes.byteAt(dataStart + 9) & 0x3f) * 256
      ];
    } else if (type === "VP8L") {
      if (image !== null || length < 5 || bytes.byteAt(dataStart) !== 0x2f) return false;
      const b0 = bytes.byteAt(dataStart + 1);
      const b1 = bytes.byteAt(dataStart + 2);
      const b2 = bytes.byteAt(dataStart + 3);
      const b3 = bytes.byteAt(dataStart + 4);
      image = [1 + b0 + ((b1 & 0x3f) << 8), 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10)];
    }
    position = chunkEnd;
  }

  if (position !== bytes.byteLength || image === null || !safeDimensions(image[0], image[1])) return false;
  return canvas === null || (canvas[0] === image[0] && canvas[1] === image[1]);
}

/** True only for a bounded, static, structurally recognizable scanner image. */
export function isSafeInlineScreenshotDataUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > INLINE_SCREENSHOT_LIMITS.maxUriChars) return false;
  const prefix = DATA_URI_PREFIXES.find((entry) => value.startsWith(entry[1]));
  if (!prefix) return false;
  const body = value.slice(prefix[1].length);
  const bytes = canonicalBase64(body);
  if (!bytes) return false;
  if (prefix[0] === "png") return safePng(bytes);
  if (prefix[0] === "jpeg") return safeJpeg(bytes);
  return safeWebp(bytes);
}
