import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";

/**
 * Independent reference instrument for the `cname-uncloaking` detector.
 *
 * WHY THIS EXISTS, and why it deliberately reimplements work the scanner
 * already does.
 *
 * The drafted reference protocol asked labelers to read "the blinded per-case
 * evidence bundle, including recorded DNS chains" and to judge them against
 * "the protocol's vendor list". Both halves of that come from this project: the
 * chain is what OUR resolver returned, and the vendor list is OUR catalog. A
 * study built that way can only measure whether our classifier agrees with our
 * own inputs. If our resolver follows a chain wrongly, or our catalog has never
 * heard of a tracking vendor, the detector and the reference make the SAME
 * mistake and the study reports perfect accuracy.
 *
 * So this tool takes nothing from the scanner:
 *
 *   - DNS chains are resolved through a resolver the reviewer names explicitly,
 *     and the exact `dig` command that reproduces each answer is written into
 *     the worksheet. A hostile reviewer can re-run it from their own network.
 *   - "Is this terminal name a tracking service" is decided against an EXTERNAL
 *     list the reviewer supplies and pins by digest. This module never imports
 *     lib/tracker-catalog or any other repository classifier.
 *   - Candidate hostnames come from the reviewer's OWN capture of the page (a
 *     browser-exported HAR), never from a scan report.
 *
 * What it does NOT do: decide the label. It produces a worksheet with a
 * proposed label and the evidence behind it; the reviewer reads it, forms their
 * own judgement, and seals their own source. Automating the reviewer away would
 * recreate the same single point of failure from the other direction.
 */

export const CNAME_REFERENCE_WORKSHEET_KIND =
  "site-behavior-cname-uncloaking-reference-worksheet";
export const CNAME_REFERENCE_TOOL_VERSION = "cname-reference@1";

/** Hostnames that must never be treated as evidence, whatever a HAR contains. */
const NON_PUBLIC_HOST = /^(localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+|\[.*\])$/i;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeHost(host) {
  return String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Registrable-domain comparison WITHOUT importing the scanner's `tldts` seam.
 *
 * A shared library would be a shared bug: if the scanner's public-suffix data
 * mis-splits a domain, an importing reference would mis-split it identically
 * and the disagreement would vanish. The reviewer supplies the suffix list they
 * are willing to stand behind, and same-site comparison is done against it
 * here. Falls back to a last-two-labels rule ONLY when the caller passes no
 * list, which the CLI refuses to do.
 */
export function registrableDomain(host, publicSuffixes) {
  const name = normalizeHost(host);
  if (!name || !name.includes(".")) return name;
  const labels = name.split(".");
  if (publicSuffixes && publicSuffixes.size > 0) {
    for (let i = 0; i < labels.length - 1; i += 1) {
      const candidate = labels.slice(i).join(".");
      if (publicSuffixes.has(candidate)) {
        return labels.slice(Math.max(0, i - 1)).join(".");
      }
    }
  }
  return labels.slice(-2).join(".");
}

/**
 * First-party hostnames the reviewer's own browser contacted, read from a HAR.
 *
 * HAR is used because every major browser exports it and no code in this
 * repository produces it. The reviewer captures the page themselves; this
 * function only reads what their browser recorded.
 */
export function firstPartyHostsFromHar(har, siteUrl, publicSuffixes) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("HAR has no log.entries array");
  }
  const siteHost = normalizeHost(new URL(siteUrl).hostname);
  const siteRegistrable = registrableDomain(siteHost, publicSuffixes);
  const hosts = new Set();
  for (const entry of entries) {
    const url = entry?.request?.url;
    if (typeof url !== "string") continue;
    let host;
    try {
      host = normalizeHost(new URL(url).hostname);
    } catch {
      continue;
    }
    if (!host || NON_PUBLIC_HOST.test(host)) continue;
    // The apex cannot be CNAME-aliased to a tracker without breaking the site,
    // so it is not a candidate; the detector skips it for the same reason.
    if (host === siteRegistrable) continue;
    if (registrableDomain(host, publicSuffixes) !== siteRegistrable) continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * Follow a hostname's CNAME chain through an explicitly named resolver.
 *
 * Bounded by hops so a resolver loop cannot hang a reviewer's worksheet. Every
 * answer records the resolver that produced it, because DNS answers are
 * location- and time-dependent and a reference label has to say where and when
 * it looked.
 */
export async function resolveCnameChain(host, { resolverAddress, maxHops = 10, timeoutMs = 5_000 }) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  resolver.setServers([resolverAddress]);
  const chain = [];
  let current = normalizeHost(host);
  for (let hop = 0; hop < maxHops; hop += 1) {
    let answers;
    try {
      answers = await resolver.resolveCname(current);
    } catch (error) {
      // NODATA/NXDOMAIN end a chain normally; anything else is recorded as a
      // resolution failure so the reviewer can see the case was not cleanly
      // determined rather than reading an empty chain as "no aliases".
      const code = error?.code ?? "UNKNOWN";
      return {
        chain,
        terminated: code === "ENODATA" || code === "ENOTFOUND",
        failureCode: code === "ENODATA" || code === "ENOTFOUND" ? null : code
      };
    }
    const next = normalizeHost(answers?.[0]);
    if (!next || chain.includes(next)) return { chain, terminated: true, failureCode: null };
    chain.push(next);
    current = next;
  }
  return { chain, terminated: false, failureCode: "MAX_HOPS" };
}

/**
 * Parse the reviewer's external tracking-service source.
 *
 * Accepts a newline-delimited list of domain suffixes with `#` comments, which
 * every widely used public tracker list can be reduced to and which a reviewer
 * can audit by eye. The parsed set is returned with the digest of the exact
 * bytes it came from, so the worksheet can pin the source it used.
 */
export function parseTrackerSource(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  const suffixes = new Set();
  const rejectedRows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const value = line.split("#")[0].trim().toLowerCase();
    if (!value) continue;
    const suffix = value.replace(/^\.+/, "").replace(/\.$/, "");
    if (!suffix) continue;
    // Reject anything that is not a plain domain suffix instead of coercing it.
    // Ad-block syntax reduced by a lenient parser is actively dangerous here: an
    // exception rule (`@@||x.com^`) would become the positive entry `@@||x.com^`
    // and never match, silently removing a vendor from the reference; a `!`
    // comment would become an entry. A reference that quietly matches less than
    // the reviewer believes produces false negatives that look like detector
    // recall failures.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(suffix)) {
      // Real provider snapshots carry a handful of DNS-name artifacts that
      // are domain-shaped but not LDH hostnames (leading-hyphen labels,
      // underscore labels). Those rows are REJECTED AND RECORDED, never
      // silently dropped and never repaired: the worksheet discloses them
      // so a definition entry the instrument cannot match is visible, not
      // a quiet false-absent. Anything filter-syntax-shaped still refuses
      // the whole file: those bytes are not the claimed kind of list.
      if (/^[a-z0-9._-]+(\.[a-z0-9._-]+)*$/.test(suffix)) {
        rejectedRows.push({ line: index + 1, text: line.trim().slice(0, 80) });
        continue;
      }
      throw new Error(
        `tracker source line ${index + 1} is not a plain domain suffix: ${JSON.stringify(line)}. ` +
          "Convert filter-list syntax to bare domain suffixes deliberately; this parser will not guess."
      );
    }
    suffixes.add(suffix);
  }
  if (rejectedRows.length > 100) {
    throw new Error(
      `tracker source rejected ${rejectedRows.length} domain-shaped rows; the bytes are not a domain-suffix list`
    );
  }
  if (suffixes.size === 0) throw new Error("tracker source contains no entries");
  return { suffixes, digest: sha256Hex(Buffer.from(bytes)), rejectedRows };
}

/** Suffix match against the external source; returns the matching entry. */
export function matchExternalTracker(host, suffixes) {
  const name = normalizeHost(host);
  if (!name) return null;
  const labels = name.split(".");
  for (let i = 0; i < labels.length; i += 1) {
    const candidate = labels.slice(i).join(".");
    if (suffixes.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build one case's worksheet.
 *
 * `proposedLabel` is exactly the rule in the label definition: PRESENT when at
 * least one first-party subdomain the reviewer's own capture contacted resolves
 * through a CNAME chain to a name matched by the external source. A case where
 * any candidate failed to resolve is marked `determined: false`, because a
 * reference that could not look cannot honestly answer "absent" -- the same
 * distinction the scanner draws between a censored and a negative case.
 */
export async function buildCaseWorksheet(
  { caseId, url, hosts },
  { resolverAddress, trackerSuffixes, publicSuffixes, maxHops, timeoutMs, resolve = resolveCnameChain }
) {
  const resolutions = [];
  let anyMatch = false;
  let anyFailure = false;
  for (const host of hosts) {
    const { chain, terminated, failureCode } = await resolve(host, {
      resolverAddress,
      maxHops,
      timeoutMs
    });
    const siteRegistrable = registrableDomain(new URL(url).hostname, publicSuffixes);
    let matched = null;
    let matchedAt = null;
    for (const link of chain) {
      if (registrableDomain(link, publicSuffixes) === siteRegistrable) continue;
      const hit = matchExternalTracker(link, trackerSuffixes);
      if (hit) {
        matched = hit;
        matchedAt = link;
        break;
      }
    }
    if (matched) anyMatch = true;
    if (failureCode !== null || !terminated) anyFailure = true;
    resolutions.push({
      host,
      chain,
      resolutionFailureCode: failureCode,
      matchedExternalSuffix: matched,
      matchedChainLink: matchedAt,
      // The reproduction command is the point: it is what makes this a
      // reference a stranger can check rather than an assertion they must
      // accept.
      verifyCommand: `dig +noall +answer @${resolverAddress} ${host} CNAME`
    });
  }
  return {
    caseId,
    hostsExamined: hosts,
    resolutions,
    determined: !anyFailure,
    proposedLabel: anyMatch ? "present" : "absent"
  };
}

export function worksheetHeader({
  studyId,
  resolverAddress,
  trackerSourcePath,
  trackerSourceDigest,
  trackerSourceRejectedRows = [],
  publicSuffixSourcePath,
  publicSuffixSourceDigest,
  capturedAt
}) {
  return {
    schemaVersion: 1,
    artifactKind: CNAME_REFERENCE_WORKSHEET_KIND,
    toolVersion: CNAME_REFERENCE_TOOL_VERSION,
    studyId,
    resolver: resolverAddress,
    trackerSource: {
      path: trackerSourcePath,
      sha256: trackerSourceDigest,
      /** Rows the closed grammar rejected, disclosed, never repaired. */
      rejectedRows: trackerSourceRejectedRows
    },
    publicSuffixSource: {
      path: publicSuffixSourcePath,
      sha256: publicSuffixSourceDigest
    },
    capturedAt,
    independence: [
      "DNS chains resolved through the named resolver, not through the scanner.",
      "Tracking-service membership decided by the pinned external source, not by this repository's catalog.",
      "Candidate hostnames read from the reviewer's own browser capture, not from a scan report.",
      "This worksheet proposes a label; the reviewer decides and seals their own."
    ]
  };
}
