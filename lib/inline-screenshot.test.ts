import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INLINE_SCREENSHOT_LIMITS,
  isSafeInlineScreenshotDataUri
} from "./inline-screenshot";

// Real, decoder-valid 1x1/2x2 fixtures. The production scanner currently
// emits JPEG; PNG and WebP remain accepted for older/imported scanner output.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const JPEG = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z";
const WEBP = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBo";

function uri(type: "png" | "jpeg" | "webp", body: string): string {
  return `data:image/${type};base64,${body}`;
}

function mutateBase64(type: "png" | "jpeg" | "webp", body: string, mutate: (bytes: Buffer) => void): string {
  const bytes = Buffer.from(body, "base64");
  mutate(bytes);
  return uri(type, bytes.toString("base64"));
}

test("real static PNG, JPEG, and WebP scanner images pass the decoder boundary", () => {
  assert.equal(isSafeInlineScreenshotDataUri(uri("png", PNG)), true);
  assert.equal(isSafeInlineScreenshotDataUri(uri("jpeg", JPEG)), true);
  assert.equal(isSafeInlineScreenshotDataUri(uri("webp", WEBP)), true);
});

test("declared dimensions and total pixel area are bounded before browser decoding", () => {
  const hugePng = mutateBase64("png", PNG, (bytes) => bytes.writeUInt32BE(65_535, 16));
  assert.equal(isSafeInlineScreenshotDataUri(hugePng), false);

  const tooManyPixels = mutateBase64("png", PNG, (bytes) => {
    bytes.writeUInt32BE(INLINE_SCREENSHOT_LIMITS.maxWidth, 16);
    bytes.writeUInt32BE(INLINE_SCREENSHOT_LIMITS.maxHeight, 20);
  });
  assert.equal(isSafeInlineScreenshotDataUri(tooManyPixels), false);

  const hugeJpeg = mutateBase64("jpeg", JPEG, (bytes) => {
    const marker = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
    assert.ok(marker >= 0);
    bytes.writeUInt16BE(65_535, marker + 7);
  });
  assert.equal(isSafeInlineScreenshotDataUri(hugeJpeg), false);

  const hugeWebp = mutateBase64("webp", WEBP, (bytes) => {
    // Simple VP8 keyframe width is the low fourteen bits at payload + 6.
    bytes[26] = 0xff;
    bytes[27] = 0x3f;
  });
  assert.equal(isSafeInlineScreenshotDataUri(hugeWebp), false);
});

test("truncated or trailing image containers fail closed", () => {
  const png = Buffer.from(PNG, "base64");
  assert.equal(isSafeInlineScreenshotDataUri(uri("png", png.subarray(0, -12).toString("base64"))), false);

  const jpeg = Buffer.from(JPEG, "base64");
  assert.equal(isSafeInlineScreenshotDataUri(uri("jpeg", jpeg.subarray(0, -2).toString("base64"))), false);

  const webp = Buffer.from(WEBP, "base64");
  assert.equal(isSafeInlineScreenshotDataUri(uri("webp", webp.subarray(0, -1).toString("base64"))), false);

  assert.equal(isSafeInlineScreenshotDataUri(uri("png", `${PNG}AAAA`)), false);
});

test("base64 must be exact, padded, and canonical", () => {
  for (const body of ["", "AAAA=", "A===", "AB==", "AAA", "AA A=", "AA\nA=", "AA-A"]) {
    assert.equal(isSafeInlineScreenshotDataUri(uri("png", body)), false, body);
  }
  assert.equal(isSafeInlineScreenshotDataUri(`data:image/png;base64,${"A".repeat(INLINE_SCREENSHOT_LIMITS.maxUriChars)}`), false);
});

test("only the three scanner raster MIME types are accepted", () => {
  assert.equal(isSafeInlineScreenshotDataUri(`data:image/svg+xml;base64,${PNG}`), false);
  assert.equal(isSafeInlineScreenshotDataUri(`data:image/gif;base64,${PNG}`), false);
  assert.equal(isSafeInlineScreenshotDataUri(`DATA:image/png;base64,${PNG}`), false);
  assert.equal(isSafeInlineScreenshotDataUri("https://attacker.test/beacon.png"), false);
  assert.equal(isSafeInlineScreenshotDataUri(null), false);
});
