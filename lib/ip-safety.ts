export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function isIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  return isIpv4Address(normalized) || isIpv6Address(normalized);
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (isIpv4Address(normalized)) return isPublicIpv4(normalized);
  if (isIpv6Address(normalized)) return isPublicIpv6(normalized);
  return false;
}

function isIpv4Address(address: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  return address.split(".").every((part) => {
    if (part.length === 0) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isIpv6Address(address: string): boolean {
  if (!address.includes(":") || /[^0-9a-f:.]/i.test(address)) return false;

  const compressed = address.split("::");
  if (compressed.length > 2) return false;

  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed[1] ? compressed[1].split(":") : [];
  const parts = [...left, ...right];
  let wordCount = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) return false;

    if (part.includes(".")) {
      if (index !== parts.length - 1 || !isIpv4Address(part)) return false;
      wordCount += 2;
      continue;
    }

    if (part.length > 4 || !/^[0-9a-f]+$/i.test(part)) return false;
    wordCount += 1;
  }

  return compressed.length === 1 ? wordCount === 8 : wordCount < 8;
}

function isPublicIpv6(address: string): boolean {
  const mappedIpv4 = mappedIpv4FromIpv6(address);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);

  if (address === "::" || address === "::1") return false;

  const [first, second] = leadingIpv6Words(address);
  if (first === 0) return false;
  if (first >= 0xfc00 && first <= 0xfdff) return false;
  if (first >= 0xff00 && first <= 0xffff) return false;
  if (first >= 0xfe80 && first <= 0xfebf) return false;
  if (first === 0x0100 && second === 0) return false;
  if (first === 0x0064 && second === 0xff9b) return false;
  if (first === 0x2001 && (second === 0 || second === 0x0002 || second === 0x0db8)) return false;
  if (first === 0x2002) return false;
  return true;
}

function leadingIpv6Words(address: string): [number, number] {
  const left = address.split("::", 1)[0];
  if (!left) return [0, 0];

  const words = left
    .split(":")
    .filter((part) => part && !part.includes("."))
    .map((part) => Number.parseInt(part, 16));

  return [words[0] ?? 0, words[1] ?? 0];
}

function mappedIpv4FromIpv6(address: string): string | null {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted && isIpv4Address(dotted[1])) return dotted[1];

  const words = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!words) return null;

  const high = Number.parseInt(words[1], 16);
  const low = Number.parseInt(words[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return null;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}
