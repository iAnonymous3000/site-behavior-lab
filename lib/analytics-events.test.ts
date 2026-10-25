import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ADOBE_DOWNLOAD_LINK,
  ADOBE_EXIT_LINK,
  ADOBE_LINK_TYPE_NAMES,
  ADOBE_PAGE_VIEW,
  GA4_STANDARD_EVENT_NAMES,
  SCROLL_DEPTH_EVENT
} from "./analytics-event-vocabulary";
import {
  analyticsBeaconFormat,
  decodeAnalyticsBeacon,
  GA4_STANDARD_EVENTS,
  scrollDepthPercent,
  type AnalyticsBeaconBody,
  type DecodedAnalyticsBeacon
} from "./analytics-events";
import { CUSTOM_EVENT_LABEL, MAX_DECODED_BODY_CHARS } from "./pixel-events";

/**
 * The decoder for a check after scrolling's analytics events (build brief
 * approved 2026-10-25, section 1 and owner call 1): the two formats by path
 * and format parameters alone, GA4's batched body lines, Adobe's URL and
 * urlencoded beacons, the vocabulary rule and the scroll-depth matcher, the
 * one value read, and nothing else in its output.
 */

const root = process.cwd();
const GA = "v=2&tid=G-TEST123&gtm=45je5a&_p=1&cid=111.222&ul=en-us&sr=1280x720&dl=https%3A%2F%2Fwww.example.com%2Fsecret%3Ftoken%3Dabc&dt=Private%20Title";

function body(value: string | null, flags: Partial<AnalyticsBeaconBody> = {}): () => AnalyticsBeaconBody {
  return () => ({ value, truncated: false, unreadable: false, ...flags });
}

const none = body(null);

function decode(url: string, read: () => AnalyticsBeaconBody = none): DecodedAnalyticsBeacon {
  const decoded = decodeAnalyticsBeacon(url, read);
  assert.ok(decoded, `not decoded: ${url}`);
  return decoded;
}

const ev = (name: string, percent: number | null = null) => ({ name, percent });
const custom = ev(CUSTOM_EVENT_LABEL);

test("GA4: the URL's event and each batched body line are events, in order", () => {
  const decoded = decode(
    `https://region1.google-analytics.com/g/collect?${GA}&en=page_view&_ee=1`,
    body("en=scroll&epn.percent_scrolled=90&_et=12\r\nen=user_engagement&_et=5000\r\nen=Newsletter_Signup&ep.plan=gold\r\n")
  );
  assert.deepEqual(decoded, {
    format: "GA4",
    events: [ev("page_view"), ev("scroll", 90), ev("user_engagement"), custom],
    complete: true
  });
  // A batch with no event in the URL, as GA4 sends one: every event is a line.
  const batched = decode(`https://region1.google-analytics.com/g/collect?${GA}`, body("en=page_view\nen=scroll&epn.percent_scrolled=90"));
  assert.deepEqual(batched.events, [ev("page_view"), ev("scroll", 90)]);
  assert.equal(batched.complete, true);
  // A single event with an empty body.
  assert.deepEqual(decode(`https://analytics.google.com/g/collect?${GA}&en=page_view`, body("")), {
    format: "GA4",
    events: [ev("page_view")],
    complete: true
  });
});

test("GA4 is recognized by format, never by host: server-side tagging on the site's own host decodes the same", () => {
  for (const host of ["gtm.example.com", "sgtm.example.co.uk", "metrics.example.org", "region1.google-analytics.com", "localhost:8080"]) {
    const url = `https://${host}/g/collect?${GA}&en=page_view`;
    assert.equal(analyticsBeaconFormat(url), "GA4", host);
    assert.deepEqual(decode(url, body("en=scroll_depth_20%25")).events, [ev("page_view"), ev(SCROLL_DEPTH_EVENT, 20)], host);
  }
  // A collection path under a prefix is still GA4's.
  assert.equal(analyticsBeaconFormat(`https://www.example.com/metrics/g/collect?${GA}`), "GA4");
});

test("only GA4's own collection format and Adobe's classic beacons are recognized", () => {
  const unrecognized = [
    // Universal Analytics, GA4's measurement protocol version absent or other.
    "https://www.google-analytics.com/collect?v=1&tid=UA-1-1&t=event",
    "https://www.google-analytics.com/g/collect?v=1&tid=G-TEST123&en=page_view",
    "https://www.google-analytics.com/g/collect?tid=G-TEST123&en=page_view",
    // A property id that is not a GA4 measurement id.
    "https://www.google-analytics.com/g/collect?v=2&tid=UA-1-1&en=page_view",
    "https://www.google-analytics.com/g/collect?v=2&tid=g-test123&en=page_view",
    "https://www.google-analytics.com/g/collect?v=2&en=page_view",
    // A renamed endpoint, and paths that only look alike.
    "https://www.example.com/collect?v=2&tid=G-TEST123&en=page_view",
    "https://www.example.com/g/collector?v=2&tid=G-TEST123&en=page_view",
    "https://www.example.com/g/collect/?v=2&tid=G-TEST123&en=page_view",
    // Adobe's Web SDK carries JSON to /ee/.
    "https://edge.adobedc.net/ee/v1/interact?configId=abc",
    "https://smetrics.example.com/b/ssx/rsid/1/JS-2.22.0/s1",
    // Not an http(s) address, or not an address.
    "ftp://www.example.com/g/collect?v=2&tid=G-TEST123&en=page_view",
    "data:text/plain,/b/ss/",
    "not a url",
    ""
  ];
  for (const url of unrecognized) {
    assert.equal(analyticsBeaconFormat(url), null, url);
    let read = 0;
    assert.equal(
      decodeAnalyticsBeacon(url, () => {
        read += 1;
        return { value: "en=page_view", truncated: false, unreadable: false };
      }),
      null,
      url
    );
    assert.equal(read, 0, `the body of a request in no decoded format was read: ${url}`);
  }
});

test("a body is read once, and only for a request in a decoded format", () => {
  let reads = 0;
  const counting = () => {
    reads += 1;
    return { value: "en=scroll", truncated: false, unreadable: false };
  };
  decode(`https://www.example.com/g/collect?${GA}`, counting);
  decode("https://smetrics.example.com/b/ss/rsid/1/JS-2.22.0/s1?pe=lnk_o&pev2=x", counting);
  assert.equal(reads, 2);
});

test("Adobe: page views and custom links on a CNAME-style first-party host, from the URL and from a urlencoded POST body", () => {
  const base = "https://smetrics.example.com/b/ss/examplersid/1/JS-2.22.0/s12345";
  // A page view carries no link type.
  assert.deepEqual(decode(`${base}?AQB=1&ndh=1&pageName=Account%20Home&g=https%3A%2F%2Fwww.example.com%2F&events=event1&AQE=1`), {
    format: "Adobe Analytics",
    events: [ev(ADOBE_PAGE_VIEW)],
    complete: true
  });
  // A custom link named as a scroll depth, from the URL.
  assert.deepEqual(decode(`${base}?AQB=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&events=event41&AQE=1`).events, [ev(SCROLL_DEPTH_EVENT, 25)]);
  // The same from a urlencoded POST body, as the library sends a long beacon.
  const long = `AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2050&events=event42&c1=${"x".repeat(3_000)}&AQE=1`;
  assert.deepEqual(decode(base, body(long)), { format: "Adobe Analytics", events: [ev(SCROLL_DEPTH_EVENT, 50)], complete: true });
  // And from a text body sent with sendBeacon.
  assert.deepEqual(decode(base, body("AQB=1&pe=lnk_o&pev2=On+scroll_tracking+of+100&AQE=1")).events, [ev(SCROLL_DEPTH_EVENT, 100)]);
  // Any other custom link name is a custom event.
  assert.deepEqual(decode(`${base}?pe=lnk_o&pev2=OptimizelyLayerDecision&events=optimizelyLayerEvent`).events, [custom]);
  assert.deepEqual(decode(`${base}?pe=lnk_o`).events, [custom], "a custom link with no name");
  // Download and exit links are named by their type, never by their link name.
  assert.deepEqual(decode(`${base}?pe=lnk_d&pev2=https%3A%2F%2Fwww.example.com%2Fstatement.pdf`).events, [ev(ADOBE_DOWNLOAD_LINK)]);
  assert.deepEqual(decode(`${base}?pe=lnk_e&pev2=scroll_depth_50%25`).events, [ev(ADOBE_EXIT_LINK)]);
  // A link type Adobe's library does not send for links is a custom event.
  assert.deepEqual(decode(`${base}?pe=ms_s&pev3=video`).events, [custom]);
  // A beacon with no parameter at all carries no event.
  assert.deepEqual(decode(base), { format: "Adobe Analytics", events: [], complete: true });
  assert.deepEqual(ADOBE_LINK_TYPE_NAMES, [ADOBE_DOWNLOAD_LINK, ADOBE_EXIT_LINK, ADOBE_PAGE_VIEW]);
});

test("names: Google's vocabulary as catalogued, a scroll depth in the scanner's words, everything else a custom event", () => {
  const named = (name: string) => decode(`https://www.example.com/g/collect?${GA}&en=${encodeURIComponent(name)}`).events;
  for (const name of ["page_view", "scroll", "click", "file_download", "video_start", "video_progress", "video_complete", "form_submit", "ad_impression"]) {
    assert.deepEqual(named(name), [ev(name)], name);
  }
  // The pixel decoder's rule: case-insensitive catalogue lookup of a safe token.
  assert.deepEqual(named("Page_View"), [ev("page_view")]);
  // The (c) matcher's positive cases.
  assert.deepEqual(named("scroll_depth_20%"), [ev(SCROLL_DEPTH_EVENT, 20)]);
  assert.deepEqual(named("On scroll_tracking of 25"), [ev(SCROLL_DEPTH_EVENT, 25)]);
  // Its negative cases, and the site's own words in general.
  for (const name of ["infinite_scroll_page_2", "scroll_section_3", "scroll_to_top", "scroll 2024", "video_play", "load", "Newsletter_Signup", "jane.doe@example signup", "a".repeat(64), "événement"]) {
    assert.deepEqual(named(name), [custom], name);
  }
  // An empty name is no event, as in the pixel decoder.
  assert.deepEqual(decode(`https://www.example.com/g/collect?${GA}&en=`).events, []);
  assert.deepEqual(decode(`https://www.example.com/g/collect?${GA}`, body("en=%20\r\nen=page_view")).events, [ev("page_view")]);
});

test("the scroll-depth matcher is exactly the three tests owner call 1 names", () => {
  const cases: Array<[string, number | null]> = [
    ["scroll_depth_20%", 20],
    ["On scroll_tracking of 25", 25],
    ["infinite_scroll_page_2", null],
    ["scroll_section_3", null],
    ["scroll_to_top", null],
    ["scroll 2024", null],
    // "scroll", case-insensitively.
    ["SCROLL_DEPTH_40", 40],
    ["Scroll Depth 60%", 60],
    ["depth_60", null],
    // A qualifier word, or a % sign.
    ["scroll_percent_75", 75],
    ["scroll 75%", 75],
    ["scroll_75", null],
    ["scroll%", null],
    // Exactly one integer, from 0 to 100.
    ["scroll_depth_0%", 0],
    ["scroll_depth_100%", 100],
    ["scroll_depth_101%", null],
    ["scroll_depth_007%", 7],
    ["scroll_depth_0100%", 100],
    ["scroll_depth_12.5%", null],
    ["scroll_depth_25_50", null],
    ["scroll_depth", null],
    ["scroll2_depth_25", null],
    [`scroll_depth_${"9".repeat(400)}%`, null],
    ["scroll depth -5%", 5],
    ["scroll depth ２５%", null]
  ];
  for (const [name, expected] of cases) assert.equal(scrollDepthPercent(name), expected, name);
});

test("percent_scrolled is kept only on GA4's scroll event, and only as an integer from 0 to 100", () => {
  const scroll = (query: string) => decode(`https://www.example.com/g/collect?${GA}&en=scroll&${query}`).events[0];
  assert.deepEqual(scroll("epn.percent_scrolled=90"), ev("scroll", 90));
  assert.deepEqual(scroll("ep.percent_scrolled=25"), ev("scroll", 25));
  assert.deepEqual(scroll("epn.percent_scrolled=0"), ev("scroll", 0));
  assert.deepEqual(scroll("epn.percent_scrolled=100"), ev("scroll", 100));
  for (const value of ["101", "90.5", "-1", "1e2", "ninety", "", " 90", "0x5a", "1000"]) {
    assert.deepEqual(scroll(`epn.percent_scrolled=${encodeURIComponent(value)}`), ev("scroll", null), value);
  }
  assert.deepEqual(scroll("_et=5"), ev("scroll", null));
  // Never on another event, standard or not.
  assert.deepEqual(decode(`https://www.example.com/g/collect?${GA}&en=page_view&epn.percent_scrolled=90`).events, [ev("page_view")]);
  assert.deepEqual(decode(`https://www.example.com/g/collect?${GA}&en=load&epn.percent_scrolled=90`).events, [custom]);
  // A body line's own parameters, never the URL's.
  assert.deepEqual(
    decode(`https://www.example.com/g/collect?${GA}&epn.percent_scrolled=50`, body("en=scroll\r\nen=scroll&epn.percent_scrolled=75")).events,
    [ev("scroll", null), ev("scroll", 75)]
  );
});

test("a body not read in full is reported, never guessed at", () => {
  const ga = `https://www.example.com/g/collect?${GA}&en=page_view`;
  for (const read of [
    body("en=scroll", { truncated: true }),
    body(null, { unreadable: true }),
    () => {
      throw new Error("postData failed");
    },
    body(`en=scroll&ep.pad=${"x".repeat(MAX_DECODED_BODY_CHARS)}`)
  ]) {
    assert.deepEqual(decode(ga, read), { format: "GA4", events: [ev("page_view")], complete: false }, "the URL's event stays");
  }
  // A line that names no event, JSON, multipart.
  for (const text of [
    "en=scroll\r\n_et=5",
    '{"events":[{"name":"scroll"}]}',
    `--boundary\r\nContent-Disposition: form-data; name="en"\r\n\r\nscroll\r\n--boundary--\r\n`
  ]) {
    const decoded = decode(ga, body(text));
    assert.equal(decoded.complete, false, text);
  }
  // Adobe: the link type may be in the part not read, so no event at all.
  const adobe = "https://smetrics.example.com/b/ss/rsid/1/JS-2.22.0/s1";
  for (const read of [
    body("AQB=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025", { truncated: true }),
    body(null, { unreadable: true }),
    body('{"pe":"lnk_o"}'),
    body("AQB=1&pe=lnk_o\r\n&pev2=x"),
    body("opaque"),
    body(`pe=lnk_o&pad=${"x".repeat(MAX_DECODED_BODY_CHARS)}`)
  ]) {
    assert.deepEqual(decode(`${adobe}?pe=lnk_o&pev2=scroll_depth_25%25`, read), { format: "Adobe Analytics", events: [], complete: false });
  }
});

test("no other parameter, identifier or value reaches the decoder's output", () => {
  const secrets = ["SECRETCID", "SECRETPAGE", "SECRETTITLE", "SECRETUSER", "SECRETVALUE", "SECRETLINK", "SECRETEVENT", "G-TEST123", "event41", "examplersid"];
  const ga4 = decode(
    `https://gtm.example.com/g/collect?${GA}&cid=SECRETCID&uid=SECRETUSER&dl=https%3A%2F%2FSECRETPAGE&dt=SECRETTITLE&en=SECRETEVENT&ep.value=SECRETVALUE`,
    body("en=scroll&epn.percent_scrolled=90&ep.page=SECRETPAGE\r\nen=page_view&ep.user=SECRETUSER\r\nen=scroll_depth_SECRETEVENT_20%25")
  );
  const adobe = [
    decode("https://smetrics.example.com/b/ss/examplersid/1/JS-2.22.0/s1?pe=lnk_o&pev2=SECRETLINK&events=event41&v1=SECRETVALUE&pageName=SECRETPAGE"),
    decode("https://smetrics.example.com/b/ss/examplersid/1/JS-2.22.0/s1", body("pe=lnk_o&pev2=scroll%20depth%20SECRETLINK%2050%25&mid=SECRETCID&events=event41"))
  ];
  const serialized = JSON.stringify([ga4, ...adobe]);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `the output carries ${secret}`);
  assert.deepEqual(ga4.events, [custom, ev("scroll", 90), ev("page_view"), ev(SCROLL_DEPTH_EVENT, 20)]);
  assert.deepEqual(adobe.map((decoded) => decoded.events), [[custom], [ev(SCROLL_DEPTH_EVENT, 50)]]);
  // Every name the decoder returns is a word of the shared vocabulary, or the custom label.
  const words = new Set([...GA4_STANDARD_EVENT_NAMES, ...ADOBE_LINK_TYPE_NAMES, SCROLL_DEPTH_EVENT, CUSTOM_EVENT_LABEL]);
  for (const decoded of [ga4, ...adobe]) for (const event of decoded.events) assert.ok(words.has(event.name), event.name);
});

test("the vocabulary is Google's documented names, lowercase, each once, catalogued by the pixel decoder's own rule", () => {
  assert.ok(GA4_STANDARD_EVENT_NAMES.length >= 80);
  assert.equal(new Set(GA4_STANDARD_EVENT_NAMES).size, GA4_STANDARD_EVENT_NAMES.length);
  for (const name of GA4_STANDARD_EVENT_NAMES) assert.match(name, /^[a-z][a-z_]*[a-z]$/, name);
  assert.deepEqual([...GA4_STANDARD_EVENTS.values()], [...GA4_STANDARD_EVENT_NAMES]);
  // The brief's own examples.
  for (const name of ["page_view", "scroll", "click", "file_download", "video_start", "video_progress", "video_complete", "form_submit"]) {
    assert.ok(GA4_STANDARD_EVENT_NAMES.includes(name), name);
  }
  assert.equal(Object.isFrozen(GA4_STANDARD_EVENT_NAMES), true);
});

test("the decoder reuses the pixel decoder's name rules instead of restating them", () => {
  const source = readFileSync(path.join(root, "lib", "analytics-events.ts"), "utf8");
  const imported = /import \{([^}]*)\} from "\.\/pixel-events";/.exec(source)?.[1] ?? "";
  for (const name of ["isSafeEventToken", "buildEventVocabulary", "catalogEventName", "CUSTOM_EVENT_LABEL"]) {
    assert.match(imported, new RegExp(`\\b${name}\\b`), `${name} must come from lib/pixel-events.ts`);
    assert.doesNotMatch(source, new RegExp(`function ${name}\\b|const ${name}\\b`), `${name} is restated`);
  }
  // The custom label itself is never written out here.
  assert.equal(source.includes('"custom event"'), false);
});
