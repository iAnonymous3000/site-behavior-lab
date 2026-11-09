/**
 * The one rule for which requests count as one client in every rate limit and
 * quota: the edge scan quota, the admission-attempt budget, the read limiters,
 * and the Node limiters for the address the trusted proxy hands them.
 *
 * It has no imports and uses no runtime API, so the Cloudflare Worker, the
 * Node server and the test runner all key a client the same way. A second copy
 * of this rule is how one limiter comes to count per address while another
 * counts per network.
 */

/** The key for a request whose edge supplied no client address. */
export const UNKNOWN_CLIENT_IDENTITY = "unknown";

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** `a.b.c.d:port`, as a proxy writes its peer when it records the connection's port. */
const IPV4_WITH_PORT_PATTERN = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;
/**
 * `[v6]` or `[v6]:port`. Only the bracketed form carries a port: a bare IPv6
 * address followed by ":port" cannot be told from one with a last group.
 */
const BRACKETED_PATTERN = /^\[([^[\]]*)\](?::(\d{1,5}))?$/;

/**
 * The limiter key for one client address.
 *
 * An IPv6 client is keyed on its /64. A single subscriber or host is routed a
 * whole /64 and can source a request from any of its 2^64 addresses, so a key
 * on the full address hands that one client a fresh allowance per request. An
 * IPv4 address is its own key, and an IPv4-mapped IPv6 address is the IPv4
 * client it names, so one client cannot hold two allowances by spelling.
 *
 * The address may arrive as a proxy wrote it: with a port (`a.b.c.d:port`,
 * `[v6]:port`), in brackets, or with an interface zone (`fe80::1%eth0`). Each
 * is keyed as the bare address is, because a port differs on every connection
 * and a key that kept it would be one bucket per connection.
 *
 * Anything that is not an address is returned trimmed and otherwise unchanged:
 * the caller decides what an unreadable identity means, and this function must
 * never merge two different strings it cannot interpret.
 */
export function clientIdentityForAddress(address: string): string {
  const text = address.trim();

  const withPort = IPV4_WITH_PORT_PATTERN.exec(text);
  const ipv4 = withPort !== null && isPort(withPort[2]) ? withPort[1] : text;
  if (isIpv4Address(ipv4)) return ipv4;

  const bracketed = BRACKETED_PATTERN.exec(text);
  if (bracketed !== null && bracketed[2] !== undefined && !isPort(bracketed[2])) return text;
  const groups = parseIpv6Groups(withoutZone(bracketed === null ? text : bracketed[1]));
  if (groups === null) return text;

  const mappedIpv4 =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  if (mappedIpv4) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/**
 * The client identity at the Cloudflare edge, before hashing.
 *
 * Only cf-connecting-ip is read. Cloudflare sets it at the sole public ingress
 * and a caller cannot; X-Forwarded-For and X-Real-IP arrive as the caller sent
 * them, so falling back to either would let a request choose its own quota
 * bucket. A request without the header shares one bucket with every other such
 * request.
 */
export function edgeClientIdentity(headers: Pick<Headers, "get">): string {
  const address = headers.get("cf-connecting-ip")?.trim();
  return address ? clientIdentityForAddress(address) : UNKNOWN_CLIENT_IDENTITY;
}

function isIpv4Address(text: string): boolean {
  const octets = IPV4_PATTERN.exec(text);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

function isPort(digits: string): boolean {
  return Number(digits) <= 65_535;
}

/** The address without its interface zone. A "%" with nothing after it is not a zone. */
function withoutZone(text: string): string {
  const zone = text.indexOf("%");
  return zone !== -1 && zone < text.length - 1 ? text.slice(0, zone) : text;
}

/**
 * The eight 16-bit groups of a bare IPv6 address, or null when the text is not
 * one. Accepts one "::" run and a dotted IPv4 tail.
 */
function parseIpv6Groups(bare: string): number[] | null {
  if (!bare.includes(":") || bare.length > 45) return null;

  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = parseIpv6Run(halves[0], !compressed);
  const tail = compressed ? parseIpv6Run(halves[1], true) : [];
  if (head === null || tail === null) return null;

  if (!compressed) return head.length === 8 ? head : null;
  // "::" stands for at least one group of zeros.
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

/** The groups of one side of "::". A dotted IPv4 tail may only end the whole address. */
function parseIpv6Run(run: string, endsAddress: boolean): number[] | null {
  if (run === "") return [];
  const parts = run.split(":");
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
      groups.push(Number.parseInt(part, 16));
      continue;
    }
    const ipv4 = endsAddress && index === parts.length - 1 ? IPV4_PATTERN.exec(part) : null;
    if (ipv4 === null) return null;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
  }
  return groups;
}
