import assert from "node:assert/strict";
import { createHash, hash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { sha256BytesHex, sha256Hex } from "./sha256";

type HashModule = { sha256Hex: typeof sha256Hex; sha256BytesHex: typeof sha256BytesHex };

function loadHash(globals: Record<string, unknown> = {}): HashModule {
  const exports = {};
  runInNewContext(readFileSync(path.join(__dirname, "sha256.js"), "utf8"), {
    exports, TextEncoder, ...globals
  });
  return exports as HashModule;
}

test("native and portable SHA-256 match independent vectors and UTF-8 boundary cases", () => {
  const implementations = [
    { sha256Hex, sha256BytesHex },
    loadHash(),
    loadHash({ process: { env: {} } }),
    loadHash({ process: { getBuiltinModule: () => undefined } })
  ];
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"]
  ];
  const texts = ["é", "e\u0301", "😀\u0000\u2028", "\ud800", "\udc00", "x\ud800y"];
  for (const size of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4096]) {
    texts.push("x".repeat(size), "é😀".repeat(size));
  }
  for (const text of texts) vectors.push([text, createHash("sha256").update(text).digest("hex")]);
  for (const implementation of implementations) {
    for (const [text, expected] of vectors) {
      assert.equal(implementation.sha256Hex(text), expected);
      assert.equal(implementation.sha256BytesHex(new TextEncoder().encode(text)), expected);
    }
    // Hash the view, not its backing buffer, including bytes that are not UTF-8.
    const bytes = Uint8Array.from({ length: 513 }, (_, index) => index % 256).subarray(17, 499);
    assert.equal(implementation.sha256BytesHex(bytes), createHash("sha256").update(bytes).digest("hex"));
  }
});

test("a native synchronous implementation is used when available", () => {
  let calls = 0;
  const implementation = loadHash({
    process: {
      getBuiltinModule: (name: string) => {
        assert.equal(name, "crypto");
        return { hash: (...args: Parameters<typeof hash>) => { calls += 1; return hash(...args); } };
      }
    }
  });
  assert.equal(implementation.sha256Hex("abc"), sha256Hex("abc"));
  assert.equal(implementation.sha256BytesHex(new Uint8Array([0, 255])), sha256BytesHex(new Uint8Array([0, 255])));
  assert.equal(calls, 2);
});
