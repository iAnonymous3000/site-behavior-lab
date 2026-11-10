import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fetchBytesResponseWithPolicy } from "./client-fetch-policy";
import { scanCorsHeaders } from "./cors";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import { publicClientHash } from "./edge-scan-gate";
import { chargeReportReadRateLimit } from "./public-scan-rate-limit-store";
import {
  PUBLIC_REPORT_API_ALLOW_HEADER,
  PUBLIC_REPORT_READ_ALLOW_HEADER,
  PUBLIC_REPORT_READ_QUOTAS,
  PUBLIC_REPORT_WORLD_LIMITS,
  REPORT_API_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_JSON_READ_RATE_LIMIT_PER_MINUTE,
  REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_RATE_LIMIT_PER_MINUTE,
  enforcePublicReportRouteEdge,
  parsePublicReportReadPath,
  refusePublicReportRouteMethod,
  type PublicReportReadQuota
} from "./report-read-edge";
import {
  REPORT_PDF_RATE_LIMIT_MAX,
  REPORT_READ_RATE_LIMIT_MAX,
  assertReportPdfRateLimit,
  assertReportReadRateLimit
} from "./scan-limits";
import { requireIndex } from "./source-markers";

const REPORT_ID = `20260721-${"a".repeat(32)}`;

test("the edge recognizes every storage/rendering report representation with the canonical id", () => {
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}`), {
    reportId: REPORT_ID,
    resource: "page",
    quota: "report-read"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/`), {
    reportId: REPORT_ID,
    resource: "page",
    quota: "report-read"
  });
  assert.deepEqual(parsePublicReportReadPath("HEAD", `/reports/${REPORT_ID}/opengraph-image`), {
    reportId: REPORT_ID,
    resource: "opengraph-image",
    quota: "report-read"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/twitter-image/`), {
    reportId: REPORT_ID,
    resource: "twitter-image",
    quota: "report-read"
  });
  // The printable rendering is the heaviest representation: the complete
  // evidence, server-rendered eagerly. It landed after the parser did and was
  // forwarded uncharged until this case existed.
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/print`), {
    reportId: REPORT_ID,
    resource: "print",
    quota: "report-read"
  });
  assert.deepEqual(parsePublicReportReadPath("HEAD", `/reports/${REPORT_ID}/print/`), {
    reportId: REPORT_ID,
    resource: "print",
    quota: "report-read"
  });
  assert.deepEqual(
    parsePublicReportReadPath(
      "GET",
      `/%72eports/${REPORT_ID.slice(0, -1)}%61/%6fpengraph-image`
    ),
    { reportId: REPORT_ID, resource: "opengraph-image", quota: "report-read" },
    "percent-encoded route segments must not bypass a quota Next applies after decoding"
  );

  for (const [method, pathname] of [
    ["GET", "/reports/not-a-report"],
    ["GET", `/reports/${REPORT_ID}/other`],
    ["GET", `/reports/${REPORT_ID}%2Fopengraph-image`],
    ["GET", `/reports/${REPORT_ID}/%zz`]
  ]) {
    assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname}`);
  }
});

test("a non-read method on a report route is refused at the edge, not forwarded uncharged", () => {
  // The earlier version of this file pinned POST /reports/<id> -> null as the
  // expected outcome, which restated the code's assumption that a null parse
  // meant "nothing to charge, forward it". Next renders the page for a POST
  // too, so null there was a bypass, not a policy. The contract is now: the
  // parser still has nothing to charge, AND the request never reaches the
  // container.
  const reportRoutes = [
    `/reports/${REPORT_ID}`,
    `/reports/${REPORT_ID}/`,
    `/reports/${REPORT_ID}/print`,
    `/reports/${REPORT_ID}/opengraph-image`,
    `/%72eports/${REPORT_ID}`,
    "/reports/not-a-report",
    "/reports/index.json",
    "/reports"
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const pathname of reportRoutes) {
      assert.equal(refusePublicReportRouteMethod(method, pathname), true, `${method} ${pathname} must be refused`);
      assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname} has nothing to charge`);
    }
  }
  for (const method of ["GET", "HEAD"]) {
    for (const pathname of reportRoutes) {
      assert.equal(refusePublicReportRouteMethod(method, pathname), false, `${method} ${pathname} is a read`);
    }
  }
  // Only report routes. The scan API takes POST by design and Node's other
  // routes answer their own 405s.
  for (const pathname of [
    "/api/scan",
    `/api/scans/${REPORT_ID}`,
    "/api/health",
    "/api",
    "/api/reportsx",
    `/x/api/reports/${REPORT_ID}`,
    "/reportsx",
    "/",
    "/directory"
  ]) {
    assert.equal(refusePublicReportRouteMethod("POST", pathname), false, `POST ${pathname} is not this rule's`);
  }
  assert.equal(PUBLIC_REPORT_READ_ALLOW_HEADER, "GET, HEAD");
  assert.equal(PUBLIC_REPORT_API_ALLOW_HEADER, "GET, HEAD, OPTIONS");
});

test("the one matcher places the report JSON and the PDF, and nothing near them, in their own quotas", () => {
  const encodedId = `${REPORT_ID.slice(0, -1)}%61`;
  const mustMatch: Array<[string, string, "json" | "pdf", PublicReportReadQuota]> = [
    ["GET", `/api/reports/${REPORT_ID}`, "json", "report-json-read"],
    ["HEAD", `/api/reports/${REPORT_ID}`, "json", "report-json-read"],
    // A trailing slash is charged, as it is on the page routes: the edge does
    // not rely on what the application then does with that spelling.
    ["GET", `/api/reports/${REPORT_ID}/`, "json", "report-json-read"],
    ["GET", `/api/reports/${REPORT_ID}/pdf`, "pdf", "report-pdf"],
    ["HEAD", `/api/reports/${REPORT_ID}/pdf`, "pdf", "report-pdf"],
    ["GET", `/api/reports/${REPORT_ID}/pdf/`, "pdf", "report-pdf"],
    // Percent-encoded spellings of every segment land in the same quota.
    ["GET", `/%61pi/%72eports/${encodedId}`, "json", "report-json-read"],
    ["GET", `/%61pi/%72eports/${encodedId}/%70df`, "pdf", "report-pdf"]
  ];
  for (const [method, pathname, resource, quota] of mustMatch) {
    assert.deepEqual(
      parsePublicReportReadPath(method, pathname),
      { reportId: REPORT_ID, resource, quota },
      `${method} ${pathname}`
    );
  }

  const mustNotMatch = [
    // Deeper than any route.
    `/api/reports/${REPORT_ID}/pdf/extra`,
    `/api/reports/${REPORT_ID}/pdf//`,
    // Not a resource of the API family; the page family's names do not carry over.
    `/api/reports/${REPORT_ID}/other`,
    `/api/reports/${REPORT_ID}/print`,
    `/api/reports/${REPORT_ID}/opengraph-image`,
    // Routing is case-sensitive, and so is the canonical id.
    `/api/reports/${REPORT_ID}/PDF`,
    `/API/reports/${REPORT_ID}`,
    `/api/Reports/${REPORT_ID}`,
    `/api/reports/${REPORT_ID.toUpperCase()}`,
    // Not a canonical id: Node answers these without reading the store.
    "/api/reports/not-a-report",
    "/api/reports/not-a-report/pdf",
    `/api/reports/${REPORT_ID}%0A`,
    `/api/reports/${REPORT_ID}a`,
    "/api/reports",
    "/api/reports/",
    // An encoded slash is not a segment boundary, and a bad escape is no segment.
    `/api/reports/${REPORT_ID}%2Fpdf`,
    `/api/reports/${REPORT_ID}/%zz`,
    // Empty segments.
    `/api/reports//${REPORT_ID}`,
    `/api/reports/${REPORT_ID}//pdf`,
    `/api//reports/${REPORT_ID}`,
    // Near-miss roots.
    `/api/report/${REPORT_ID}`,
    `/api/reportsx/${REPORT_ID}`,
    `/apix/reports/${REPORT_ID}`,
    `/x/api/reports/${REPORT_ID}`,
    `/api/scans/${REPORT_ID}`,
    // The API family's names do not carry over to the page family either.
    `/reports/${REPORT_ID}/pdf`,
    `/reports/${REPORT_ID}/json`
  ];
  for (const pathname of mustNotMatch) {
    for (const method of ["GET", "HEAD"]) {
      assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname}`);
    }
  }
  // A method that is not a read has nothing to charge on any spelling.
  for (const [, pathname] of mustMatch) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname}`);
      assert.equal(refusePublicReportRouteMethod(method, pathname), true, `${method} ${pathname}`);
    }
  }
});

/**
 * Every URL the app can render under app/reports/[id], as the suffix after
 * the id (empty for the page itself), derived from Next's file conventions on
 * the real directory tree rather than from a list this file would have to be
 * told about.
 */
function renderableReportRepresentations(dir: string, prefix: string[] = []): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dotfiles and _private folders are outside routing.
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      // Route groups and parallel slots add no URL segment.
      const segments =
        entry.name.startsWith("(") || entry.name.startsWith("@") ? prefix : [...prefix, entry.name];
      for (const suffix of renderableReportRepresentations(path.join(dir, entry.name), segments)) {
        found.add(suffix);
      }
      continue;
    }
    const base = entry.name.replace(/\.[^.]+$/, "");
    if (base === "page" || base === "route" || base === "default") {
      found.add(prefix.join("/"));
    } else if (["opengraph-image", "twitter-image", "icon", "apple-icon"].includes(base)) {
      found.add([...prefix, base].join("/"));
    }
  }
  return found;
}

test("every representation app/reports/[id] can render is a charged edge read", () => {
  // The printable route landed after the parser did and was forwarded
  // uncharged until this test existed, because nothing tied the parser's
  // allow-list to the directory Next routes from. This walks that directory,
  // so the next route file cannot land without either a charge or a
  // deliberate change to this policy.
  const representations = renderableReportRepresentations(path.join(process.cwd(), "app", "reports", "[id]"));
  assert.ok(representations.has(""), "the walk should have found the report page itself");
  assert.ok(representations.has("print"), "the walk should have found the printable route");
  for (const suffix of representations) {
    const pathname = suffix === "" ? `/reports/${REPORT_ID}` : `/reports/${REPORT_ID}/${suffix}`;
    const parsed = parsePublicReportReadPath("GET", pathname);
    assert.ok(
      parsed,
      `${pathname} is a representation the app renders but the edge does not charge; ` +
        "extend parsePublicReportReadPath in lib/report-read-edge.ts in the same change as the route"
    );
    assert.equal(parsed.resource, suffix === "" ? "page" : suffix);
    assert.equal(parsed.reportId, REPORT_ID);
  }
});

test("every route file under app/api/reports is a charged edge read", () => {
  // The JSON and the PDF reached the container with no edge check because the
  // matcher only knew the page tree. This walks the whole API report tree the
  // same way, the `[id]` routes and anything beside them, so a third report
  // API route cannot land unseen: it fails here until the edge charges it, or
  // until it is declared below with the reason it need not be charged.
  const routes = renderableReportRepresentations(path.join(process.cwd(), "app", "api", "reports"));
  assert.deepEqual(
    [...routes].sort(),
    ["[id]", "[id]/pdf"],
    "a route under app/api/reports that this test does not know: charge it in parsePublicReportReadPath " +
      "(lib/report-read-edge.ts) in the same change as the route, or declare it here"
  );
  for (const route of routes) {
    const pathname = `/api/reports/${route.replace("[id]", REPORT_ID)}`;
    const parsed = parsePublicReportReadPath("GET", pathname);
    assert.ok(parsed, `${pathname} is a route the app serves but the edge does not charge`);
    assert.equal(parsed.resource, route === "[id]" ? "json" : route.slice("[id]/".length));
    assert.equal(parsed.reportId, REPORT_ID);
  }
});

test("report-read ceilings are finite and retain the established per-client policy", () => {
  assert.equal(REPORT_READ_RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE, 1_200);
  assert.ok(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE > REPORT_READ_RATE_LIMIT_PER_MINUTE);
});

test("the API report quotas hold Node's per-client figures, and the two routes share one world bucket", () => {
  // Per client, each mirrors the Node limiter for the same route. The edge
  // cannot import lib/scan-limits.ts (it is Node-only), so the two files state
  // one number each and this holds them together.
  assert.equal(REPORT_JSON_READ_RATE_LIMIT_PER_MINUTE, REPORT_READ_RATE_LIMIT_MAX);
  assert.equal(REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE, REPORT_PDF_RATE_LIMIT_MAX);
  // For the world, API report reads as a whole start from the page's figure.
  assert.equal(REPORT_API_READ_GLOBAL_RATE_LIMIT_PER_MINUTE, REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE);

  // The PDF has a per-client bucket of its own and no world bucket of its
  // own: it spends the world bucket the JSON spends. The pages keep theirs.
  assert.deepEqual(PUBLIC_REPORT_READ_QUOTAS, {
    "report-read": { perClient: 120, world: "report-read" },
    "report-json-read": { perClient: 120, world: "report-api-read" },
    "report-pdf": { perClient: 10, world: "report-api-read" }
  });
  assert.deepEqual(PUBLIC_REPORT_WORLD_LIMITS, { "report-read": 1_200, "report-api-read": 1_200 });
});

const CLIENT = { "cf-connecting-ip": "203.0.113.7" };
const NOW = 60_001;

/** The limiter store's SQL surface over an in-memory database, standing in for the Durable Object's SQLite. */
function openStore(): { database: DatabaseSync; sql: DurableScanJobStoreSql } {
  const database = new DatabaseSync(":memory:");
  const sql: DurableScanJobStoreSql = {
    exec<T extends Record<string, ArrayBuffer | string | number | null>>(
      query: string,
      ...bindings: Array<ArrayBuffer | string | number | null>
    ) {
      const statement = database.prepare(query);
      // The limiter binds only text and integers.
      const values = bindings as Array<string | number | null>;
      const isRead = /^\s*SELECT\b/i.test(query);
      const rows = isRead ? (statement.all(...values) as T[]) : [];
      if (!isRead) statement.run(...values);
      return { toArray: () => rows };
    }
  };
  return { database, sql };
}

/**
 * The edge gate over the real limiter store, the way the Worker wires it: the
 * gate chooses the quota and names the client, the store charges it.
 */
function withEdge(
  callback: (edge: {
    send: (method: string, pathname: string, headers?: Record<string, string>) => Promise<Response | null>;
    used: (bucket: string) => number | undefined;
    rows: () => number;
  }) => Promise<void>
): Promise<void> {
  const { database, sql } = openStore();
  const tableExists = () =>
    database.prepare("SELECT name FROM sqlite_master WHERE name = 'public_scan_rate_limits'").get() !== undefined;
  return callback({
    send: (method, pathname, headers = CLIENT) =>
      enforcePublicReportRouteEdge(
        new Request(`https://scanner.invalid${pathname}`, { method, headers }),
        undefined,
        async ({ clientHash, quota }) => chargeReportReadRateLimit(sql, clientHash, NOW, quota)
      ),
    used: (bucket) => {
      if (!tableExists()) return undefined;
      const row = database.prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?").get(bucket);
      return row === undefined ? undefined : Number(row.used);
    },
    rows: () =>
      tableExists() ? Number(database.prepare("SELECT COUNT(*) AS count FROM public_scan_rate_limits").get()?.count) : 0
  }).finally(() => database.close());
}

function clientAddress(index: number): Record<string, string> {
  return { "cf-connecting-ip": `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}` };
}

const API_WORLD_BUCKET = "report-api-read-global/1";

const API_READS: Array<{
  name: string;
  pathname: string;
  quota: PublicReportReadQuota;
  perClient: number;
  refusal: string;
}> = [
  {
    name: "the report JSON",
    pathname: `/api/reports/${REPORT_ID}`,
    quota: "report-json-read",
    perClient: 120,
    refusal: "Too many report requests. Try again shortly."
  },
  {
    name: "the PDF",
    pathname: `/api/reports/${REPORT_ID}/pdf`,
    quota: "report-pdf",
    perClient: 10,
    refusal: "Too many PDF requests. Print the page from your browser, or try again shortly."
  }
];

for (const read of API_READS) {
  test(`${read.name} is charged on GET and HEAD and refused at the per-client cap`, async () => {
    await withEdge(async (edge) => {
      const clientHash = await publicClientHash(new Headers(CLIENT));
      const clientBucket = `${read.quota}/1/${clientHash}`;

      // One GET and one HEAD each spend one token in the route's own client
      // bucket and one in the API world bucket. A query string does not change
      // the path that is charged.
      assert.equal(await edge.send("GET", `${read.pathname}?download=bundle`), null, "an allowed read goes on to the container");
      assert.equal(edge.used(clientBucket), 1);
      assert.equal(await edge.send("HEAD", read.pathname), null);
      assert.equal(edge.used(clientBucket), 2);
      assert.equal(edge.used(API_WORLD_BUCKET), 2);
      assert.equal(edge.rows(), 2, "one client bucket and one world bucket, and no other");

      for (let sent = 2; sent < read.perClient; sent += 1) {
        assert.equal(await edge.send(sent % 2 === 0 ? "GET" : "HEAD", read.pathname), null, `read ${sent + 1}`);
      }
      assert.equal(edge.used(clientBucket), read.perClient);

      for (const method of ["GET", "HEAD"]) {
        const refused = await edge.send(method, read.pathname);
        assert.equal(refused?.status, 429, `${method} past the cap`);
        assert.equal(refused?.headers.get("retry-after"), "60");
        assert.equal(refused?.headers.get("cache-control"), "no-store");
        assert.deepEqual(await refused!.json(), { ok: false, error: read.refusal });
      }
      // A refusal charges nothing, in either bucket.
      assert.equal(edge.used(clientBucket), read.perClient);
      assert.equal(edge.used(API_WORLD_BUCKET), read.perClient);

      // The cap is this client's alone.
      assert.equal(await edge.send("GET", read.pathname, { "cf-connecting-ip": "203.0.113.8" }), null);
    });
  });
}

test("a PDF request spends one unit of the API world bucket and one of the PDF client bucket, and nothing else", async () => {
  await withEdge(async (edge) => {
    const clientHash = await publicClientHash(new Headers(CLIENT));
    assert.equal(await edge.send("GET", `/api/reports/${REPORT_ID}/pdf`), null);
    assert.equal(edge.used(API_WORLD_BUCKET), 1);
    assert.equal(edge.used(`report-pdf/1/${clientHash}`), 1);
    // The PDF has no world bucket of its own. A world figure for it would be
    // spent by requests that never render, and a few addresses could use it up.
    assert.equal(edge.used("report-pdf-global/1"), undefined);
    assert.equal(edge.used(`report-json-read/1/${clientHash}`), undefined, "the JSON's client bucket is not the PDF's");
    assert.equal(edge.used("report-read-global/1"), undefined, "the pages' world bucket is untouched");
    assert.equal(edge.used(`report-read/1/${clientHash}`), undefined, "the pages' client bucket is untouched");
    assert.equal(edge.rows(), 2);

    // A JSON read by the same client adds to the same world bucket and to its
    // own client bucket.
    assert.equal(await edge.send("GET", `/api/reports/${REPORT_ID}`), null);
    assert.equal(edge.used(API_WORLD_BUCKET), 2);
    assert.equal(edge.used(`report-json-read/1/${clientHash}`), 1);
    assert.equal(edge.used(`report-pdf/1/${clientHash}`), 1);
    assert.equal(edge.rows(), 3);
  });
});

test("API report reads are refused for the world at one shared cap, JSON and PDF alike, whoever asks", async () => {
  await withEdge(async (edge) => {
    const cap = REPORT_API_READ_GLOBAL_RATE_LIMIT_PER_MINUTE;
    const pdf = `/api/reports/${REPORT_ID}/pdf`;
    const reportSentence = "Too many report requests. Try again shortly.";

    // One reader first spends its own PDF allowance. Its next PDF request is
    // refused by its own bucket alone, and is told so in the PDF's sentence.
    for (let sent = 0; sent < REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE; sent += 1) {
      assert.equal(await edge.send("GET", pdf), null);
    }
    assert.deepEqual(await (await edge.send("GET", pdf))!.json(), {
      ok: false,
      error: "Too many PDF requests. Print the page from your browser, or try again shortly."
    });

    // Fill the rest of the world bucket from distinct clients, a PDF request
    // in every fourth place. No client nears its own cap, and about 300 PDF
    // requests are admitted in the minute, ten times what a world bucket
    // sized to the render slot would have let through.
    const others = cap - REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE;
    for (let index = 0; index < others; index += 1) {
      const pathname = index % 4 === 3 ? pdf : `/api/reports/${REPORT_ID}`;
      assert.equal(await edge.send(index % 2 === 0 ? "GET" : "HEAD", pathname, clientAddress(index)), null, `client ${index}`);
    }
    assert.equal(edge.used(API_WORLD_BUCKET), cap);
    assert.equal(edge.rows(), others + 2, "one row per admitted client and one for the world");

    // The first reader again: now its own bucket and the world's are both
    // spent, and the answer is the one that is true whichever it was.
    assert.deepEqual(await (await edge.send("GET", pdf))!.json(), { ok: false, error: reportSentence });

    // A reader who has asked for nothing is refused by the world bucket alone,
    // and the refusal says what is true of both routes. Its PDF request is
    // refused because the world's API reads are spent, three quarters of them
    // by JSON reads, so "Too many PDF requests" would be false.
    const late = clientAddress(cap);
    const lateHash = await publicClientHash(new Headers(late));
    for (const read of API_READS) {
      for (const method of ["GET", "HEAD"]) {
        const refused = await edge.send(method, read.pathname, late);
        assert.equal(refused?.status, 429, `${method} ${read.name} past the world cap`);
        assert.equal(refused?.headers.get("retry-after"), "60");
        assert.deepEqual(await refused!.json(), { ok: false, error: reportSentence });
      }
      assert.equal(
        edge.used(`${read.quota}/1/${lateHash}`),
        undefined,
        "a world refusal must not create a row for the refused client"
      );
    }
    assert.equal(edge.used(API_WORLD_BUCKET), cap);
    assert.equal(edge.rows(), others + 2);

    // The pages have a world bucket of their own, which none of this spent.
    assert.equal(edge.used("report-read-global/1"), undefined);
    assert.equal(await edge.send("GET", `/reports/${REPORT_ID}`, late), null, "a page read is still allowed");
    assert.equal(edge.used("report-read-global/1"), 1);
    assert.equal(edge.used(API_WORLD_BUCKET), cap, "and a page read does not spend the API world bucket");
  });
});

test("a client's page, JSON and PDF budgets are independent, and the pages' world bucket is apart from the API's", async () => {
  const reads: Array<{ pathname: string; quota: PublicReportReadQuota }> = [
    { pathname: `/reports/${REPORT_ID}`, quota: "report-read" },
    { pathname: `/api/reports/${REPORT_ID}`, quota: "report-json-read" },
    { pathname: `/api/reports/${REPORT_ID}/pdf`, quota: "report-pdf" }
  ];
  const worldBucket = (quota: PublicReportReadQuota) => `${PUBLIC_REPORT_READ_QUOTAS[quota].world}-global/1`;
  const clientHash = await publicClientHash(new Headers(CLIENT));
  // Every ordered pair: one kind of read spent to its cap, then one read of
  // another kind by the same client.
  for (const spent of reads) {
    for (const other of reads.filter((read) => read.quota !== spent.quota)) {
      await withEdge(async (edge) => {
        const pair = `${other.quota} after ${spent.quota} is exhausted`;
        const cap = PUBLIC_REPORT_READ_QUOTAS[spent.quota].perClient;
        for (let sent = 0; sent < cap; sent += 1) assert.equal(await edge.send("GET", spent.pathname), null);
        assert.equal((await edge.send("GET", spent.pathname))?.status, 429, `${spent.quota} is exhausted`);
        assert.equal(edge.used(worldBucket(spent.quota)), cap);
        assert.equal(edge.rows(), 2, `${spent.quota} charges its own client bucket and its world bucket only`);

        // Only the two API routes share a world bucket. The pages' is apart
        // from it in both directions.
        const sharesWorld = spent.quota !== "report-read" && other.quota !== "report-read";
        assert.equal(worldBucket(other.quota) === worldBucket(spent.quota), sharesWorld, pair);
        assert.equal(edge.used(`${other.quota}/1/${clientHash}`), undefined, `the client's budget: ${pair}`);
        assert.equal(edge.used(worldBucket(other.quota)), sharesWorld ? cap : undefined, `the world's budget: ${pair}`);

        assert.equal(await edge.send("GET", other.pathname), null, `still allowed: ${pair}`);
        assert.equal(edge.used(`${other.quota}/1/${clientHash}`), 1);
        assert.equal(edge.used(worldBucket(other.quota)), sharesWorld ? cap + 1 : 1);
        assert.equal(edge.used(`${spent.quota}/1/${clientHash}`), cap);
        assert.equal(edge.used(worldBucket(spent.quota)), sharesWorld ? cap + 1 : cap);
      });
    }
  }
});

test("any other method on the report API is answered at the edge and charges nothing", async () => {
  await withEdge(async (edge) => {
    for (const pathname of [
      `/api/reports/${REPORT_ID}`,
      `/api/reports/${REPORT_ID}/pdf`,
      `/%61pi/reports/${REPORT_ID}`,
      "/api/reports/not-a-report"
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const answer = await edge.send(method, pathname);
        assert.equal(answer?.status, 405, `${method} ${pathname}`);
        assert.equal(answer?.headers.get("allow"), "GET, HEAD, OPTIONS");
        assert.equal(answer?.headers.get("cache-control"), "no-store");
        assert.equal(answer?.headers.get("access-control-allow-origin"), "*");
        assert.deepEqual(await answer!.json(), {
          ok: false,
          error: "Reports are read-only. Allowed methods: GET, HEAD, OPTIONS."
        });
      }
      // The preflight Node's routes give, so a cross-origin read still works.
      const preflight = await edge.send("OPTIONS", pathname, { ...CLIENT, origin: "https://site.example" });
      assert.equal(preflight?.status, 204, `OPTIONS ${pathname}`);
      assert.equal(preflight?.body, null);
      for (const [name, value] of Object.entries(scanCorsHeaders("https://site.example", undefined))) {
        assert.equal(preflight?.headers.get(name), value, `preflight ${name}`);
      }
    }
    assert.equal(edge.rows(), 0, "no method that is not a read may spend a token");

    // The page routes keep their own answer: no preflight, and no CORS headers.
    const page = await edge.send("OPTIONS", `/reports/${REPORT_ID}`);
    assert.equal(page?.status, 405);
    assert.equal(page?.headers.get("allow"), "GET, HEAD");
    assert.equal(page?.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await page!.json(), { ok: false, error: "Reports are read-only. Allowed methods: GET, HEAD." });
    assert.equal(edge.rows(), 0);
  });
});

test("a report read that cannot be charged is refused, never forwarded", async (t) => {
  // The gate logs the cause for the operator; keep it out of the test output.
  const logged = t.mock.method(console, "error", () => undefined);
  for (const pathname of [
    `/reports/${REPORT_ID}`,
    `/reports/${REPORT_ID}/print`,
    `/api/reports/${REPORT_ID}`,
    `/api/reports/${REPORT_ID}/pdf`
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const answer = await enforcePublicReportRouteEdge(
        new Request(`https://scanner.invalid${pathname}`, { method, headers: CLIENT }),
        undefined,
        async () => {
          throw new Error("the Durable Object did not answer");
        }
      );
      assert.equal(answer?.status, 503, `${method} ${pathname}`);
      assert.equal(answer?.headers.get("retry-after"), "5");
      assert.equal(answer?.headers.get("cache-control"), "no-store");
      assert.deepEqual(await answer!.json(), { ok: false, error: "Report reads are temporarily unavailable." });
    }
  }
  assert.equal(logged.mock.callCount(), 8, "each refusal names its cause in the log");
  // The store refuses a name that is not a quota instead of charging a bucket
  // with no limit. "constructor" is the case a plain property lookup would let
  // through.
  const { database, sql } = openStore();
  try {
    for (const name of ["constructor", "report", ""]) {
      assert.throws(
        () => chargeReportReadRateLimit(sql, "a".repeat(64), NOW, name as PublicReportReadQuota),
        /Invalid report-read quota/,
        JSON.stringify(name)
      );
    }
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'public_scan_rate_limits'").get(),
      undefined,
      "a refused quota name must not reach the store"
    );
  } finally {
    database.close();
  }
});

test("a path that is not a report read is passed through uncharged", async () => {
  await withEdge(async (edge) => {
    for (const pathname of [
      // A malformed id: Node answers 404 without reading the store.
      "/api/reports/not-a-report",
      "/api/reports/not-a-report/pdf",
      `/api/reports/${REPORT_ID.toUpperCase()}`,
      `/api/reports/${REPORT_ID}/pdf/extra`,
      "/reports/not-a-report",
      // Not report routes at all.
      "/api/health",
      `/api/scans/${REPORT_ID}`,
      "/",
      "/_next/static/chunk.js"
    ]) {
      for (const method of ["GET", "HEAD"]) {
        assert.equal(await edge.send(method, pathname), null, `${method} ${pathname} goes on to the container`);
      }
    }
    assert.equal(await edge.send("POST", "/api/scan"), null, "the scan API is not a report route");
    assert.equal(edge.rows(), 0, "nothing above may spend a token");
  });
});

test("refusals on the report API can be read across origins; page refusals are unchanged", async () => {
  await withEdge(async (edge) => {
    const exhaust = async (pathname: string, cap: number) => {
      for (let sent = 0; sent < cap; sent += 1) await edge.send("GET", pathname);
      return edge.send("GET", pathname, { ...CLIENT, origin: "https://site.example" });
    };
    for (const read of API_READS) {
      const refused = await exhaust(read.pathname, read.perClient);
      assert.equal(refused?.status, 429);
      for (const [name, value] of Object.entries(scanCorsHeaders("https://site.example", undefined))) {
        assert.equal(refused?.headers.get(name), value, `${read.name} refusal ${name}`);
      }
      // The wait is on the refusal and a cross-origin reader may read it.
      assert.equal(refused?.headers.get("retry-after"), "60");
      assert.equal(refused?.headers.get("access-control-expose-headers"), "Retry-After");
    }
    const page = await exhaust(`/reports/${REPORT_ID}`, REPORT_READ_RATE_LIMIT_PER_MINUTE);
    assert.equal(page?.status, 429);
    assert.equal(page?.headers.get("retry-after"), "60");
    assert.equal(page?.headers.get("access-control-allow-origin"), null);
    assert.equal(page?.headers.get("access-control-expose-headers"), null);
    assert.deepEqual(await page!.json(), { ok: false, error: "Too many report requests. Try again shortly." });
  });

  // A configured origin is honoured the way Node's routes honour it: another
  // origin gets the refusal with no allow-origin header.
  const refusedFor = async (origin: string) =>
    enforcePublicReportRouteEdge(
      new Request(`https://scanner.invalid/api/reports/${REPORT_ID}`, { headers: { ...CLIENT, origin } }),
      "https://site.example",
      async () => ({ allowed: false, retryAfterSeconds: 12.2 })
    );
  const allowed = await refusedFor("https://site.example");
  assert.equal(allowed?.headers.get("access-control-allow-origin"), "https://site.example");
  assert.equal(allowed?.headers.get("retry-after"), "13");
  assert.equal((await refusedFor("https://other.example"))?.headers.get("access-control-allow-origin"), null);
});

test("the edge tells a reader what Node's own limiter tells them", async () => {
  const nodeRefusal = (assertLimit: (clientKey: string, now: number) => void, max: number): string => {
    const clientKey = `report-read-edge-test-${max}`;
    for (let sent = 0; sent < max; sent += 1) assertLimit(clientKey, 1_000);
    try {
      assertLimit(clientKey, 1_000);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("Node's limiter admitted a request past its ceiling");
  };
  const edgeRefusal = async (pathname: string, refusedBy?: "client" | "world") => {
    const refused = await enforcePublicReportRouteEdge(
      new Request(`https://scanner.invalid${pathname}`, { headers: CLIENT }),
      undefined,
      async () => ({ allowed: false, retryAfterSeconds: 1, ...(refusedBy ? { refusedBy } : {}) })
    );
    return ((await refused!.json()) as { error: string }).error;
  };
  const reportSentence = nodeRefusal(assertReportReadRateLimit, REPORT_READ_RATE_LIMIT_MAX);
  const pdfSentence = nodeRefusal(assertReportPdfRateLimit, REPORT_PDF_RATE_LIMIT_MAX);
  assert.notEqual(pdfSentence, reportSentence);

  // The JSON's refusal is Node's, whichever bucket refused.
  for (const refusedBy of ["client", "world", undefined] as const) {
    assert.equal(await edgeRefusal(`/api/reports/${REPORT_ID}`, refusedBy), reportSentence);
    assert.equal(await edgeRefusal(`/reports/${REPORT_ID}`, refusedBy), reportSentence);
  }
  // The PDF's own sentence is said only for the PDF's own per-client cap. A
  // refusal by the world bucket, which JSON reads spend too, gets the sentence
  // that is true of both, and so does a refusal that names no bucket, which is
  // what a Durable Object one release older returns.
  assert.equal(await edgeRefusal(`/api/reports/${REPORT_ID}/pdf`, "client"), pdfSentence);
  assert.equal(await edgeRefusal(`/api/reports/${REPORT_ID}/pdf`, "world"), reportSentence);
  assert.equal(await edgeRefusal(`/api/reports/${REPORT_ID}/pdf`), reportSentence);
});

test("the report page shows an edge refusal of its evidence fetch as it shows Node's", async (t) => {
  t.mock.method(console, "error", () => undefined);
  // The page builds its message from the status alone, so an edge 429 or 503
  // reads exactly as Node's does: the sentence below, then the page's own
  // "Try again or open the report JSON below." If the page starts reading the
  // body or the status differently, this pin fails and the edge's answer is
  // looked at again.
  const page = await readFile(path.join(process.cwd(), "app", "reports", "[id]", "saved-report-client.tsx"), "utf8");
  requireIndex(
    page,
    "httpError: (response) => new Error(`Report evidence returned HTTP ${response.status}.`)",
    "saved-report-client.tsx"
  );
  const shown = async (response: Response): Promise<string> => {
    try {
      await fetchBytesResponseWithPolicy(`/api/reports/${REPORT_ID}`, { cache: "no-store" }, {
        label: "Report evidence",
        maxBytes: 1_024,
        fetchImpl: (async () => response) as typeof fetch,
        httpError: (answer) => new Error(`Report evidence returned HTTP ${answer.status}.`)
      });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("a refusal was accepted as evidence");
  };
  const request = () => new Request(`https://scanner.invalid/api/reports/${REPORT_ID}`, { headers: CLIENT });
  const edge429 = await enforcePublicReportRouteEdge(request(), undefined, async () => ({
    allowed: false,
    retryAfterSeconds: 30
  }));
  const edge503 = await enforcePublicReportRouteEdge(request(), undefined, async () => {
    throw new Error("unavailable");
  });
  const node429 = new Response(JSON.stringify({ ok: false, error: "Too many report requests. Try again shortly." }), {
    status: 429,
    headers: { "content-type": "application/json" }
  });
  const edgeShown = await shown(edge429!);
  assert.equal(edgeShown, "Report evidence returned HTTP 429.");
  assert.equal(edgeShown, await shown(node429));
  assert.equal(await shown(edge503!), "Report evidence returned HTTP 503.");
});

test("a Worker one release older still charges a page read, and only Cloudflare's address names the client", async () => {
  await withEdge(async (edge) => {
    const hashes: string[] = [];
    for (const headers of [
      { "x-forwarded-for": "1.2.3.4" },
      { "x-forwarded-for": "5.6.7.8", "x-real-ip": "8.8.8.8" },
      { "cf-connecting-ip": "1.2.3.4" }
    ] as Record<string, string>[]) {
      await enforcePublicReportRouteEdge(
        new Request(`https://scanner.invalid/api/reports/${REPORT_ID}`, { headers }),
        undefined,
        async ({ clientHash }) => {
          hashes.push(clientHash);
          return { allowed: true };
        }
      );
    }
    assert.equal(hashes[0], hashes[1], "a caller-supplied forwarding header must not choose a bucket");
    assert.notEqual(hashes[1], hashes[2]);
    assert.equal(hashes[2], await publicClientHash(new Headers({ "cf-connecting-ip": "1.2.3.4" })));
    assert.equal(edge.rows(), 0);
  });

  // The older Worker's call carries no quota. It must land in the page bucket,
  // whose name has to stay as it was for counters already in the store.
  const { database, sql } = openStore();
  try {
    assert.deepEqual(chargeReportReadRateLimit(sql, "a".repeat(64), NOW), { allowed: true });
    assert.deepEqual(
      database
        .prepare("SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket")
        .all()
        .map((row) => ({ ...row })),
      [
        { bucket: "report-read-global/1", used: 1 },
        { bucket: `report-read/1/${"a".repeat(64)}`, used: 1 }
      ]
    );
  } finally {
    database.close();
  }
});

test("the Worker charges report reads only on its public path, never its own reads of a saved report", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const count = (needle: string) => source.split(needle).length - 1;

  // One call to the gate, in the public fetch handler, settled before the
  // request can be forwarded. The import is the only other mention.
  assert.equal(count("enforcePublicReportRouteEdge("), 1, "the gate must be called from exactly one place");
  const publicFetch = source.slice(
    requireIndex(source, "export default {\n  async fetch(request: Request, env: Env, ctx: ExecutionContext)"),
    requireIndex(source, "const durableAdmission = durableScanJobsEnabled")
  );
  const gate = requireIndex(publicFetch, "await enforcePublicReportRouteEdge(", "the public fetch handler");
  assert.match(
    publicFetch.slice(gate),
    /^await enforcePublicReportRouteEdge\(\s*request,\s*env\.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN,\s*\(charge\) => getContainer\(env\.SCANNER\)\.chargeReportReadRateLimit\(charge\)\s*\);\s*if \(reportRouteAnswer\) return reportRouteAnswer;/,
    "the gate's answer must be returned, and its charge must be the scanner Durable Object's"
  );
  assert.ok(
    gate < requireIndex(publicFetch, "if (!isScan) {\n      return forwardToContainer(request, env);", "the public fetch handler"),
    "the quota must settle before report storage or rendering can start"
  );
  assert.equal(count(".chargeReportReadRateLimit("), 1, "nothing else may spend the report-read quotas");

  // forwardToContainer is how the Worker itself reaches the container. If the
  // charge moved in there, the Worker's own reads would spend a reader's quota
  // and could be refused by it.
  const forward = source.slice(
    requireIndex(source, "async function forwardToContainer("),
    requireIndex(source, "function containerUnavailableResponse(")
  );
  assert.doesNotMatch(forward, /enforcePublicReportRouteEdge|chargeReportReadRateLimit|parsePublicReportReadPath/);

  // The Worker builds a saved report's URL itself in two places (a finished
  // durable job, and a job recovered from the registry). Both must hand the
  // request straight to forwardToContainer. A fetch of the public URL instead
  // would come back in through the public path and be charged.
  const internalRead = "reportUrl.pathname = `/api/reports/${reportId}`;";
  assert.equal(count(internalRead), 2, "the Worker's own reads of a saved report are the two this test knows");
  let from = 0;
  for (let site = 0; site < 2; site += 1) {
    const at = requireIndex(source, internalRead, "source", from);
    assert.match(
      source.slice(at, at + 420),
      /^reportUrl\.pathname = `\/api\/reports\/\$\{reportId\}`;\s*reportUrl\.search = "";\s*const headers = new Headers\(request\.headers\);\s*headers\.delete\("content-length"\);\s*headers\.delete\("content-type"\);\s*return forwardToContainer\(\s*new Request\(reportUrl, \{ method: "GET", headers, signal \}\),\s*env\s*\);/,
      `internal saved-report read ${site + 1} must go straight to forwardToContainer`
    );
    from = at + internalRead.length;
  }
});
