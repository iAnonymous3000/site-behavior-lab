import { isReviewedCookieName, isReviewedStorageKey } from "./public-name-policy";
import type { CookieRecord, StorageRecord } from "./types";

/**
 * Grouping for the cookie and storage evidence in the report rail.
 *
 * Both lists rendered one row per record, and the row led with the record's
 * NAME -- the single field redaction blanks. A real report therefore spent the
 * whole rail on twelve rows reading "Cookie 1 · name hidden for privacy",
 * "Cookie 2 · name hidden for privacy", and so on, with the informative fields
 * (which domain set it, whether it persists) in small text underneath, and then
 * disclosed that 256 further names were hidden and 259 further records were not
 * shown at all. Twelve near-identical rows out of 271 records is not a sample a
 * reader can do anything with.
 *
 * What redaction leaves intact is the setting domain, the session/persistent
 * split, and the first/third-party boundary, so that is what these group on.
 * The same twelve rows become "adform.net: 2 cookies, persistent, third-party",
 * and the list covers every record rather than the first twelve.
 *
 * Reviewed names are not thrown away. `isReviewedCookieName` exists precisely
 * because some names are safe to publish, and a named cookie is stronger
 * evidence than a count, so each group keeps the reviewed names it contains.
 */

export type CookieDomainGroup = {
  domain: string;
  /** Every cookie record observed on this domain. */
  count: number;
  persistent: number;
  session: number;
  thirdParty: boolean;
  /** Reviewed (publishable) cookie names in this group, in first-seen order. */
  namedCookies: string[];
  /** Cookies in this group whose name was withheld. */
  hiddenNames: number;
};

export type StorageAreaGroup = {
  area: StorageRecord["area"];
  count: number;
  /** Total recorded value size across the group's keys. */
  valueBytes: number;
  /** Reviewed (publishable) keys in this group, in first-seen order. */
  namedKeys: string[];
  /** Keys in this group whose name was withheld. */
  hiddenNames: number;
};

/**
 * Group cookie records by the domain that set them.
 *
 * Ordered by record count, then by domain, so the domain with the most cookies
 * leads and the order is stable for two domains with the same count. Third-party
 * groups lead within a tie because the report's whole subject is what crossed
 * the site's own boundary.
 */
export function groupCookiesByDomain(cookies: readonly CookieRecord[]): CookieDomainGroup[] {
  const groups = new Map<string, CookieDomainGroup>();
  for (const cookie of cookies) {
    let group = groups.get(cookie.domain);
    if (!group) {
      group = {
        domain: cookie.domain,
        count: 0,
        persistent: 0,
        session: 0,
        // One domain can only be on one side of the scanned site's registrable
        // boundary, but a malformed or mixed record must not silently claim
        // first-party: any third-party record marks the group.
        thirdParty: false,
        namedCookies: [],
        hiddenNames: 0
      };
      groups.set(cookie.domain, group);
    }
    group.count += 1;
    if (cookie.session) group.session += 1;
    else group.persistent += 1;
    if (cookie.thirdParty) group.thirdParty = true;
    if (isReviewedCookieName(cookie.name)) {
      if (!group.namedCookies.includes(cookie.name)) group.namedCookies.push(cookie.name);
    } else {
      group.hiddenNames += 1;
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      Number(right.thirdParty) - Number(left.thirdParty) ||
      left.domain.localeCompare(right.domain)
  );
}

/** Group storage records by their area, largest first. */
export function groupStorageByArea(storage: readonly StorageRecord[]): StorageAreaGroup[] {
  const groups = new Map<StorageRecord["area"], StorageAreaGroup>();
  for (const record of storage) {
    let group = groups.get(record.area);
    if (!group) {
      group = { area: record.area, count: 0, valueBytes: 0, namedKeys: [], hiddenNames: 0 };
      groups.set(record.area, group);
    }
    group.count += 1;
    group.valueBytes += record.valueBytes;
    if (isReviewedStorageKey(record.key)) {
      if (!group.namedKeys.includes(record.key)) group.namedKeys.push(record.key);
    } else {
      group.hiddenNames += 1;
    }
  }
  return [...groups.values()].sort(
    (left, right) => right.count - left.count || left.area.localeCompare(right.area)
  );
}

/**
 * How many records the first `shownGroups` groups account for.
 *
 * The rail caps how many GROUPS it draws, but the overflow disclosure counts
 * RECORDS ("+259 more observations not shown in this list"). Deriving the
 * record total from the drawn groups keeps that sentence true; counting groups
 * there would understate what the reader is not seeing by two orders of
 * magnitude.
 */
export function recordsCovered(
  groups: readonly { count: number }[],
  shownGroups: number
): number {
  return groups.slice(0, shownGroups).reduce((total, group) => total + group.count, 0);
}
