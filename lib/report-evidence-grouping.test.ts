import assert from "node:assert/strict";
import test from "node:test";
import {
  groupCookiesByDomain,
  groupStorageByArea,
  recordsCovered
} from "./report-evidence-grouping";
import { isReviewedCookieName, isReviewedStorageKey } from "./public-name-policy";
import type { CookieRecord, StorageRecord } from "./types";

function cookie(partial: Partial<CookieRecord> & { domain: string }): CookieRecord {
  return {
    name: "unreviewed_name",
    path: "/",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: false,
    thirdParty: true,
    ...partial
  };
}

function storage(partial: Partial<StorageRecord> & { key: string }): StorageRecord {
  return { area: "localStorage", valueBytes: 10, ...partial };
}

// A name the redaction policy publishes, so the fixtures assert on the real
// policy rather than on an assumption about it.
const REVIEWED_COOKIE = "receive-cookie-deprecation";

test("the fixture's reviewed name really is reviewed, and its counterpart is not", () => {
  assert.ok(isReviewedCookieName(REVIEWED_COOKIE), "fixture assumes this name is publishable");
  assert.ok(!isReviewedCookieName("unreviewed_name"), "fixture assumes this name is withheld");
});

test("no cookies produce no groups", () => {
  assert.deepEqual(groupCookiesByDomain([]), []);
  assert.deepEqual(groupStorageByArea([]), []);
});

test("cookies collapse onto the domain that set them", () => {
  const groups = groupCookiesByDomain([
    cookie({ domain: ".adform.net" }),
    cookie({ domain: ".360yield.com" }),
    cookie({ domain: ".adform.net", session: true }),
    cookie({ domain: ".360yield.com" }),
    cookie({ domain: ".360yield.com" })
  ]);

  assert.deepEqual(
    groups.map((group) => [group.domain, group.count]),
    [
      [".360yield.com", 3],
      [".adform.net", 2]
    ],
    "the domain with the most records leads"
  );
  assert.equal(groups[1].persistent, 1);
  assert.equal(groups[1].session, 1);
});

test("every record lands in exactly one group", () => {
  const cookies = [
    cookie({ domain: "a.example" }),
    cookie({ domain: "b.example" }),
    cookie({ domain: "a.example" })
  ];
  const groups = groupCookiesByDomain(cookies);
  assert.equal(
    groups.reduce((total, group) => total + group.count, 0),
    cookies.length
  );
});

test("a group is third-party if any record in it crossed the boundary", () => {
  const mixed = groupCookiesByDomain([
    cookie({ domain: "x.example", thirdParty: false }),
    cookie({ domain: "x.example", thirdParty: true })
  ]);
  assert.equal(mixed[0].thirdParty, true, "a third-party record must not be absorbed into first-party");

  const firstParty = groupCookiesByDomain([cookie({ domain: "y.example", thirdParty: false })]);
  assert.equal(firstParty[0].thirdParty, false);
});

test("reviewed names survive grouping and withheld ones are counted, not invented", () => {
  const groups = groupCookiesByDomain([
    cookie({ domain: ".360yield.com", name: REVIEWED_COOKIE }),
    cookie({ domain: ".360yield.com", name: "unreviewed_name" }),
    cookie({ domain: ".360yield.com", name: "another_unreviewed" })
  ]);
  assert.deepEqual(groups[0].namedCookies, [REVIEWED_COOKIE]);
  assert.equal(groups[0].hiddenNames, 2);
  assert.equal(groups[0].namedCookies.length + groups[0].hiddenNames, groups[0].count);
});

test("a repeated reviewed name is listed once but still counted once per record", () => {
  const groups = groupCookiesByDomain([
    cookie({ domain: "z.example", name: REVIEWED_COOKIE, path: "/" }),
    cookie({ domain: "z.example", name: REVIEWED_COOKIE, path: "/app" })
  ]);
  assert.deepEqual(groups[0].namedCookies, [REVIEWED_COOKIE]);
  assert.equal(groups[0].count, 2);
});

test("ties break by third-party first, then by domain, so the order is stable", () => {
  const groups = groupCookiesByDomain([
    cookie({ domain: "b.example", thirdParty: false }),
    cookie({ domain: "c.example", thirdParty: true }),
    cookie({ domain: "a.example", thirdParty: true })
  ]);
  assert.deepEqual(
    groups.map((group) => group.domain),
    ["a.example", "c.example", "b.example"]
  );
});

test("storage groups by area and sums the recorded value sizes", () => {
  const groups = groupStorageByArea([
    storage({ key: "k1", valueBytes: 98 }),
    storage({ key: "k2", valueBytes: 67 }),
    storage({ key: "s1", area: "sessionStorage", valueBytes: 5 })
  ]);
  assert.deepEqual(
    groups.map((group) => [group.area, group.count, group.valueBytes]),
    [
      ["localStorage", 2, 165],
      ["sessionStorage", 1, 5]
    ]
  );
});

test("storage keeps reviewed keys and counts the withheld ones", () => {
  const reviewed = ["k", "key", "state", "theme", "id"].find((candidate) =>
    isReviewedStorageKey(candidate)
  );
  const groups = groupStorageByArea([
    storage({ key: "unreviewed_storage_key_value" }),
    ...(reviewed ? [storage({ key: reviewed })] : [])
  ]);
  assert.equal(groups[0].hiddenNames, 1);
  assert.deepEqual(groups[0].namedKeys, reviewed ? [reviewed] : []);
});

/**
 * The disclosure under the list counts RECORDS, not groups. Counting groups
 * there would tell a reader 259 records were withheld when the real number is
 * two orders of magnitude different.
 */
test("the overflow count is in records, not groups", () => {
  const groups = groupCookiesByDomain([
    cookie({ domain: "a.example" }),
    cookie({ domain: "a.example" }),
    cookie({ domain: "a.example" }),
    cookie({ domain: "b.example" }),
    cookie({ domain: "b.example" }),
    cookie({ domain: "c.example" })
  ]);
  assert.equal(recordsCovered(groups, 1), 3);
  assert.equal(recordsCovered(groups, 2), 5);
  assert.equal(recordsCovered(groups, groups.length), 6);
  assert.equal(recordsCovered(groups, 99), 6, "asking for more groups than exist is not an error");
  assert.equal(recordsCovered([], 5), 0);
});
