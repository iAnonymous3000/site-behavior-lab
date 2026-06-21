import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEdgePublicHttpUrl, assertEdgePublicHttpUrlShape } from "./edge-url-safety";

test("assertEdgePublicHttpUrl allows public DNS answers", async () => {
  await assert.doesNotReject(() =>
    assertEdgePublicHttpUrl(new URL("https://example.com/"), {
      fetch: mockDnsFetch({
        A: ["93.184.216.34"],
        AAAA: ["2606:2800:220:1:248:1893:25c8:1946"]
      })
    })
  );
});

test("assertEdgePublicHttpUrl blocks private DNS answers", async () => {
  await assert.rejects(
    () =>
      assertEdgePublicHttpUrl(new URL("https://rebind.example/"), {
        fetch: mockDnsFetch({ A: ["127.0.0.1"] })
      }),
    /Local and private network targets are blocked/
  );
});

test("assertEdgePublicHttpUrl fails closed when DNS cannot be verified", async () => {
  await assert.rejects(
    () =>
      assertEdgePublicHttpUrl(new URL("https://broken.example/"), {
        fetch: async () => new Response("resolver unavailable", { status: 502 })
      }),
    /could not be verified as public/
  );
});

test("assertEdgePublicHttpUrl caches successful hostname checks", async () => {
  let calls = 0;
  const cache = new Map<string, Promise<void>>();
  const dnsFetch = mockDnsFetch({ A: ["93.184.216.34"] }, () => {
    calls += 1;
  });

  await assertEdgePublicHttpUrl(new URL("https://example.com/a"), { cache, fetch: dnsFetch });
  await assertEdgePublicHttpUrl(new URL("https://example.com/b"), { cache, fetch: dnsFetch });

  assert.equal(calls, 2);
});

test("assertEdgePublicHttpUrlShape rejects unsafe direct URLs without DNS", () => {
  assert.doesNotThrow(() => assertEdgePublicHttpUrlShape(new URL("https://1.1.1.1/")));
  assert.throws(() => assertEdgePublicHttpUrlShape(new URL("https://127.0.0.1/")), /Local and private/);
  assert.throws(() => assertEdgePublicHttpUrlShape(new URL("https://example.com:8443/")), /standard HTTP and HTTPS ports/);
});

type MockDnsRecords = Partial<Record<"A" | "AAAA", string[]>>;

function mockDnsFetch(records: MockDnsRecords, onCall?: () => void): typeof fetch {
  return async (input) => {
    onCall?.();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const type = url.searchParams.get("type") === "AAAA" ? "AAAA" : "A";
    const recordType = type === "AAAA" ? 28 : 1;
    const answers = (records[type] ?? []).map((data) => ({ type: recordType, data }));

    return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
      headers: { "Content-Type": "application/dns-json" }
    });
  };
}
