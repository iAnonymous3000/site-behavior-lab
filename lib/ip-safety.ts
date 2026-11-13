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
    // A leading zero means octal to inet_aton, and so to getaddrinfo and to
    // URL parsers: 0177.0.0.1 is loopback there. Reading the octet as decimal
    // would call that spelling 177.0.0.1 and public. It is not an address
    // here, so its caller resolves it and checks the answer instead.
    if (part.length > 1 && part.startsWith("0")) return false;
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
      // A dotted quad is the last 32 bits, so it ends the text. The parts of
      // both sides of "::" are one list here, and with nothing after the "::"
      // the last of them stands before it: "2600:8.8.8.8::" is no address,
      // and reading it as one judged the words before the quad alone.
      const endsTheText = index === parts.length - 1 && (compressed.length === 1 || right.length > 0);
      if (!endsTheText || !isIpv4Address(part)) return false;
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

  const [first, second, third] = leadingIpv6Words(address);
  // Public IPv6 is global unicast, 2000::/3, and nothing else: IANA assigns
  // routable space from that block alone. Refusing by the first word covers
  // the unspecified and loopback addresses, NAT64 (64:ff9b::/96 and
  // 64:ff9b:1::/48), the discard prefix (100::/64), SRv6 SIDs (5f00::/16),
  // unique local (fc00::/7), link-local (fe80::/10), the deprecated site-local
  // block beside it (fec0::/10), which some private networks still route, and
  // multicast (ff00::/8). It also covers the space the registry lists only as
  // "Reserved by IETF", which a list of named exclusions cannot reach: overlay
  // and mesh networks borrow it (0200::/7 for one), so a host can hold a route
  // there, and treating it as public would reopen the internal-network
  // boundary.
  if (first < 0x2000 || first > 0x3fff) return false;
  // 2001::/23 is IANA's IETF Protocol Assignments block. Enumerating the few
  // non-reachable prefixes inside it left the rest treated as public, so
  // 2001:1::4, 2001:10::/28 (deprecated ORCHID), 2001:20::/28 (ORCHIDv2), and
  // 2001:3::/32's unallocated neighbours all passed a guard whose whole job is
  // refusing addresses that are not globally reachable. Default-deny the block
  // and allow only what the registry marks Globally Reachable = True.
  //
  // Enumerating the exceptions rather than the exclusions is the safer shape:
  // a new protocol assignment defaults to refused (a scan target we decline,
  // which is visible and recoverable) instead of defaulting to allowed (a
  // boundary hole, which is neither).
  if (first === 0x2001 && second <= 0x01ff) {
    return isGloballyReachableProtocolAssignment(address, second, third);
  }
  // 2001:db8::/32 is documentation and sits OUTSIDE 2001::/23 (0x0db8 is far
  // above the 0x01ff ceiling above), so the block rule cannot cover it and it
  // needs its own line. Folding it into that rule silently made the
  // documentation prefix public.
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  // IANA marks this range non-globally-reachable. Keep its exact CIDR boundary
  // in sync with the IPv6 Special-Purpose Address Space registry.
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // 3fff::/20 documentation
  return true;
}

/**
 * The only prefixes inside 2001::/23 that IANA marks Globally Reachable = True.
 *
 * Kept as an explicit allow-list so the surrounding default-deny cannot be
 * widened by accident. Refusing one of these would be a real regression: they
 * are routable, and a scanner that declines them is declining honest targets.
 */
function isGloballyReachableProtocolAssignment(
  address: string,
  second: number,
  third: number
): boolean {
  // 2001:1::1/128 (Port Control Protocol anycast), 2001:1::2/128 (Traversal
  // Using Relays around NAT anycast), 2001:1::3/128 (DNS-SD service registration
  // anycast, RFC 9665). Exact addresses, so compare the normalized form.
  if (second === 0x0001) {
    const normalized = address.toLowerCase();
    return normalized === "2001:1::1" || normalized === "2001:1::2" || normalized === "2001:1::3";
  }
  // 2001:3::/32, Automatic Multicast Tunneling.
  if (second === 0x0003) return true;
  // 2001:4:112::/48, the AS112-v6 redirection service.
  if (second === 0x0004) return third === 0x0112;
  // 2001:20::/28, ORCHIDv2, is NOT globally reachable and is refused by the
  // caller's default-deny, as are 2001::/32 (Teredo), 2001:2::/48 (BMWG
  // benchmarking), 2001:10::/28 (deprecated ORCHID), and 2001:db8::/32 (docs).
  return false;
}

/**
 * Three words, not two: distinguishing 2001:4:112::/48 (globally reachable)
 * from its unallocated neighbours needs the third group.
 */
function leadingIpv6Words(address: string): [number, number, number] {
  const left = address.split("::", 1)[0];
  if (!left) return [0, 0, 0];

  const words = left
    .split(":")
    .filter((part) => part && !part.includes("."))
    .map((part) => Number.parseInt(part, 16));

  return [words[0] ?? 0, words[1] ?? 0, words[2] ?? 0];
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
