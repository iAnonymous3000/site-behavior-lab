export type StrictJsonFailure = "invalid-json" | "duplicate-key" | "too-large" | "too-deep";

/** Well above every managed report/schema shape, below JS call-stack risk. */
export const STRICT_JSON_MAX_NESTING_DEPTH = 128;

export class StrictJsonError extends Error {
  readonly reason: StrictJsonFailure;

  constructor(reason: StrictJsonFailure) {
    super(reason);
    this.reason = reason;
    this.name = "StrictJsonError";
  }
}

/**
 * Parse one bounded JSON value while rejecting duplicate object keys at every
 * nesting depth. JSON.parse alone silently keeps the last duplicate, which can
 * leave ignored sensitive bytes in an otherwise valid managed wire.
 */
export function parseStrictJson(text: string, maxUtf8Bytes?: number): unknown {
  if (
    maxUtf8Bytes !== undefined &&
    (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0 || new TextEncoder().encode(text).byteLength > maxUtf8Bytes)
  ) {
    throw new StrictJsonError("too-large");
  }

  const scanner = new JsonScanner(text);
  scanner.value();
  scanner.whitespace();
  if (!scanner.done()) throw new StrictJsonError("invalid-json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StrictJsonError("invalid-json");
  }
}

class JsonScanner {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  done(): boolean {
    return this.index === this.text.length;
  }

  whitespace(): void {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  value(depth = 0): void {
    this.whitespace();
    const token = this.text[this.index];
    if (token === "{") {
      if (depth >= STRICT_JSON_MAX_NESTING_DEPTH) throw new StrictJsonError("too-deep");
      return this.object(depth + 1);
    }
    if (token === "[") {
      if (depth >= STRICT_JSON_MAX_NESTING_DEPTH) throw new StrictJsonError("too-deep");
      return this.array(depth + 1);
    }
    if (token === '"') {
      this.string();
      return;
    }
    if (token === "t") return this.literal("true");
    if (token === "f") return this.literal("false");
    if (token === "n") return this.literal("null");
    this.number();
  }

  private object(depth: number): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.consume("}")) return;
    for (;;) {
      this.whitespace();
      if (this.text[this.index] !== '"') throw new StrictJsonError("invalid-json");
      const key = this.string();
      if (keys.has(key)) throw new StrictJsonError("duplicate-key");
      keys.add(key);
      this.whitespace();
      this.require(":");
      this.value(depth);
      this.whitespace();
      if (this.consume("}")) return;
      this.require(",");
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.whitespace();
    if (this.consume("]")) return;
    for (;;) {
      this.value(depth);
      this.whitespace();
      if (this.consume("]")) return;
      this.require(",");
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    for (;;) {
      if (this.index >= this.text.length) throw new StrictJsonError("invalid-json");
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          throw new StrictJsonError("invalid-json");
        }
      }
      if (code < 0x20) throw new StrictJsonError("invalid-json");
      if (code === 0x5c) {
        this.index += 1;
        if (this.index >= this.text.length) throw new StrictJsonError("invalid-json");
        const escape = this.text[this.index];
        if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new StrictJsonError("invalid-json");
          this.index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(escape)) throw new StrictJsonError("invalid-json");
      }
      this.index += 1;
    }
  }

  private literal(expected: "true" | "false" | "null"): void {
    if (!this.text.startsWith(expected, this.index)) throw new StrictJsonError("invalid-json");
    this.index += expected.length;
  }

  private number(): void {
    let cursor = this.index;
    if (this.text[cursor] === "-") cursor += 1;

    if (this.text[cursor] === "0") {
      cursor += 1;
    } else {
      const first = this.text.charCodeAt(cursor);
      if (first < 0x31 || first > 0x39) throw new StrictJsonError("invalid-json");
      cursor += 1;
      while (isDigit(this.text.charCodeAt(cursor))) cursor += 1;
    }

    if (this.text[cursor] === ".") {
      cursor += 1;
      if (!isDigit(this.text.charCodeAt(cursor))) throw new StrictJsonError("invalid-json");
      while (isDigit(this.text.charCodeAt(cursor))) cursor += 1;
    }

    if (this.text[cursor] === "e" || this.text[cursor] === "E") {
      cursor += 1;
      if (this.text[cursor] === "+" || this.text[cursor] === "-") cursor += 1;
      if (!isDigit(this.text.charCodeAt(cursor))) throw new StrictJsonError("invalid-json");
      while (isDigit(this.text.charCodeAt(cursor))) cursor += 1;
    }
    this.index = cursor;
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private require(expected: string): void {
    if (!this.consume(expected)) throw new StrictJsonError("invalid-json");
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}
