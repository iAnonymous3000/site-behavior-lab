import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import {
  MAX_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT,
  MAX_RECORDED_PROXY_BLOCKS,
  MAX_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT,
  MAX_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT,
  MAX_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT,
  startPublicScanProxy
} from "./public-scan-proxy";

test("public scan proxy refuses private DNS results before opening the upstream socket", async (t) => {
  let privateServerHits = 0;
  const privateServer = http.createServer((_request, response) => {
    privateServerHits += 1;
    response.end("private metadata");
  });
  await listen(privateServer);

  const privatePort = (privateServer.address() as AddressInfo).port;
  const proxy = await startPublicScanProxy({
    allowNonStandardPortsForTests: true,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }]
  });

  t.after(async () => {
    await proxy.close();
    await closeServer(privateServer);
  });

  await assert.rejects(() => proxyGet(proxy.server, `http://rebind.test:${privatePort}/latest`));

  assert.equal(privateServerHits, 0);
  assert.deepEqual(proxy.blockedTargets, [
    {
      target: `http://rebind.test:${privatePort}/`,
      reason: "non-public-address"
    }
  ]);
});

test("public scan proxy retries host resolution after a rejected pin", async (t) => {
  let resolveCalls = 0;
  const proxy = await startPublicScanProxy({
    resolveHost: async () => {
      resolveCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    }
  });

  t.after(() => proxy.close());

  await assert.rejects(() => proxyGet(proxy.server, "http://rebind.test/first"));
  await assert.rejects(() => proxyGet(proxy.server, "http://rebind.test/second"));

  assert.equal(resolveCalls, 2);
  assert.deepEqual(proxy.blockedTargets, [
    { target: "http://rebind.test/", reason: "non-public-address" },
    { target: "http://rebind.test/", reason: "non-public-address" }
  ]);
});

test("public scan proxy cleanly refuses plaintext websocket upgrades", async (t) => {
  const proxy = await startPublicScanProxy({
    resolveHost: async () => [{ address: "1.1.1.1", family: 4 }]
  });

  t.after(() => proxy.close());

  const response = await rawProxyUpgrade(proxy.server, "ws://socket.test/events");

  assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  assert.deepEqual(proxy.blockedTargets, [{ target: "ws://socket.test/", reason: "upgrade-blocked" }]);
});

test("public scan proxy records a DNS failure as resolution-failed, not a private-address block", async (t) => {
  const proxy = await startPublicScanProxy({
    resolveHost: async () => {
      throw new Error("getaddrinfo ENOTFOUND dead.test");
    }
  });

  t.after(() => proxy.close());

  await assert.rejects(() => proxyGet(proxy.server, "http://dead.test/pixel"));

  assert.deepEqual(proxy.blockedTargets, [{ target: "http://dead.test/", reason: "resolution-failed" }]);
});

test("public scan proxy records a non-standard port as blocked-port before resolving", async (t) => {
  let resolveCalls = 0;
  const proxy = await startPublicScanProxy({
    resolveHost: async () => {
      resolveCalls += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    }
  });

  t.after(() => proxy.close());

  await assert.rejects(() => proxyGet(proxy.server, "http://ports.test:8080/admin"));

  assert.equal(resolveCalls, 0);
  assert.deepEqual(proxy.blockedTargets, [{ target: "http://ports.test:8080/", reason: "blocked-port" }]);
});

test("public scan proxy rejects response-byte overrides that could disable its safe cap", async () => {
  await assert.rejects(
    () => startPublicScanProxy({ responseByteLimitBytes: MAX_PUBLIC_SCAN_PROXY_RESPONSE_BYTE_LIMIT + 1 }),
    /positive integer no greater/
  );
  await assert.rejects(() => startPublicScanProxy({ responseByteLimitBytes: 0 }), /positive integer no greater/);
  await assert.rejects(
    () => startPublicScanProxy({ uploadByteLimitBytes: MAX_PUBLIC_SCAN_PROXY_UPLOAD_BYTE_LIMIT + 1 }),
    /positive integer no greater/
  );
  await assert.rejects(() => startPublicScanProxy({ uploadByteLimitBytes: 0 }), /positive integer no greater/);
  await assert.rejects(
    () => startPublicScanProxy({ transactionLimit: MAX_PUBLIC_SCAN_PROXY_TRANSACTION_LIMIT + 1 }),
    /transaction limit must be a positive integer no greater/
  );
  await assert.rejects(
    () => startPublicScanProxy({ transactionLimit: 0 }),
    /transaction limit must be a positive integer no greater/
  );
  await assert.rejects(
    () => startPublicScanProxy({ uniqueTargetLimit: MAX_PUBLIC_SCAN_PROXY_UNIQUE_TARGET_LIMIT + 1 }),
    /unique-target limit must be a positive integer no greater/
  );
  await assert.rejects(
    () => startPublicScanProxy({ uniqueTargetLimit: 0 }),
    /unique-target limit must be a positive integer no greater/
  );
});

test("public scan proxy bounds target fan-out before a second DNS lookup", async (t) => {
  let resolveCalls = 0;
  const proxy = await startPublicScanProxy({
    transactionLimit: 10,
    uniqueTargetLimit: 1,
    resolveHost: async () => {
      resolveCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    }
  });
  t.after(() => proxy.close());

  await assert.rejects(() => proxyGet(proxy.server, "http://first-target.test/"));
  await assert.rejects(() => proxyGet(proxy.server, "http://second-target.test/"));

  assert.equal(resolveCalls, 1);
  assert.equal(proxy.blockedTargets.some((entry) => entry.reason === "resource-limit"), true);
  assert.deepEqual(proxy.getDiagnostics().trafficBudget, {
    name: "proxy-traffic",
    family: "requests",
    transactionLimit: 10,
    transactionsSeen: 2,
    uniqueTargetLimit: 1,
    uniqueTargetsSeen: 1,
    captureLoss: {
      family: "requests",
      phaseId: null,
      kind: "cap",
      count: 1,
      detail: "proxy-traffic"
    }
  });
});

test("public scan proxy bounds repeated HTTP transactions independently of page routing", async (t) => {
  let resolveCalls = 0;
  const proxy = await startPublicScanProxy({
    transactionLimit: 1,
    uniqueTargetLimit: 10,
    resolveHost: async () => {
      resolveCalls += 1;
      return [{ address: "127.0.0.1", family: 4 }];
    }
  });
  t.after(() => proxy.close());

  await assert.rejects(() => proxyGet(proxy.server, "http://same-target.test/one"));
  await assert.rejects(() => proxyGet(proxy.server, "http://same-target.test/two"));

  assert.equal(resolveCalls, 1);
  assert.equal(proxy.getDiagnostics().trafficBudget.captureLoss?.count, 1);
});

test("blocked-target diagnostics stay bounded without losing a later private-address signal", async (t) => {
  const proxy = await startPublicScanProxy({
    resolveHost: async (hostname) => {
      if (hostname === "private-late.test") return [{ address: "127.0.0.1", family: 4 }];
      throw new Error("synthetic DNS failure");
    }
  });
  t.after(() => proxy.close());

  for (let index = 0; index < MAX_RECORDED_PROXY_BLOCKS + 5; index += 1) {
    await assert.rejects(() => proxyGet(proxy.server, "http://dead-many.test/pixel"));
  }
  await assert.rejects(() => proxyGet(proxy.server, "http://private-late.test/metadata"));

  assert.equal(proxy.blockedTargets.length, MAX_RECORDED_PROXY_BLOCKS);
  assert.equal(proxy.blockedTargets.some((entry) => entry.reason === "non-public-address"), true);
});

test("public scan proxy forwards a normal HTTP upload and meters it separately from the response", async (t) => {
  const upstream = http.createServer((request, response) => {
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
    });
    request.on("end", () => {
      response.setHeader("Connection", "close");
      response.end(String(received));
    });
  });
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(64, 6);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const wire = await rawProxyPost(proxy.server, `http://public.test:${upstreamPort}/upload`, Buffer.from("hello"));

  assert.equal(rawResponseBody(wire).toString(), "5");
  assert.deepEqual(proxy.getDiagnostics().uploadByteBudget, {
    name: "request-upload",
    family: "requests",
    limitBytes: 6,
    forwardedBytes: 5,
    remainingBytes: 1,
    limitReached: false,
    captureLoss: null
  });
  assert.equal(proxy.getDiagnostics().responseByteBudget.forwardedBytes, 1);
});

test("public scan proxy truncates an oversized HTTP upload before bytes exceed the aggregate cap", async (t) => {
  let settleObserved!: (bytes: number) => void;
  const observed = new Promise<number>((resolve) => {
    settleObserved = resolve;
  });
  const upstream = http.createServer((request) => {
    let received = 0;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      settleObserved(received);
    };
    request.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
    });
    request.once("end", settle);
    request.once("close", settle);
  });
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(64, 16);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  await rawProxyPost(proxy.server, `http://public.test:${upstreamPort}/oversized`, Buffer.alloc(1024 * 1024)).catch(
    () => Buffer.alloc(0)
  );

  assert.equal(await observed, 16);
  assert.deepEqual(proxy.getDiagnostics().uploadByteBudget, {
    name: "request-upload",
    family: "requests",
    limitBytes: 16,
    forwardedBytes: 16,
    remainingBytes: 0,
    limitReached: true,
    captureLoss: {
      family: "requests",
      phaseId: null,
      kind: "cap",
      count: 1,
      detail: "request-upload"
    }
  });
  assert.equal(proxy.getDiagnostics().responseByteBudget.forwardedBytes, 0);
  assert.deepEqual(proxy.blockedTargets, []);
});

test("public scan proxy caps CONNECT client-to-upstream bytes including the parser head", async (t) => {
  let settleObserved!: (bytes: number) => void;
  const observed = new Promise<number>((resolve) => {
    settleObserved = resolve;
  });
  const upstream = net.createServer((socket) => {
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
    });
    socket.once("close", () => settleObserved(received));
  });
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(64, 16);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  await rawProxyConnectUpload(
    proxy.server,
    `tunnel.test:${upstreamPort}`,
    Buffer.alloc(1024 * 1024)
  ).catch(() => Buffer.alloc(0));

  assert.equal(await observed, 16);
  assert.equal(proxy.getDiagnostics().uploadByteBudget.forwardedBytes, 16);
  assert.equal(proxy.getDiagnostics().uploadByteBudget.captureLoss?.count, 1);
  assert.equal(proxy.getDiagnostics().responseByteBudget.forwardedBytes, 0);
  assert.equal(proxy.getDiagnostics().trafficBudget.transactionsSeen, 1);
  assert.deepEqual(proxy.blockedTargets, []);
});

test("public scan proxy synchronously aggregates concurrent CONNECT uploads without overshoot", async (t) => {
  let totalReceived = 0;
  let closedConnections = 0;
  let settleObserved!: (bytes: number) => void;
  const observed = new Promise<number>((resolve) => {
    settleObserved = resolve;
  });
  const upstream = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      totalReceived += chunk.byteLength;
    });
    socket.once("close", () => {
      closedConnections += 1;
      if (closedConnections === 2) settleObserved(totalReceived);
    });
  });
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(64, 20);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  await Promise.all(
    [Buffer.alloc(32, "a"), Buffer.alloc(32, "b")].map((payload) =>
      rawProxyConnectUpload(proxy.server, `tunnel.test:${upstreamPort}`, payload).catch(() => Buffer.alloc(0))
    )
  );

  assert.equal(await observed, 20);
  assert.equal(proxy.getDiagnostics().uploadByteBudget.forwardedBytes, 20);
  assert.equal(proxy.getDiagnostics().uploadByteBudget.captureLoss?.count, 2);
});

test("public scan proxy forwards a socket-level HTTP response below the aggregate byte cap", async (t) => {
  const upstream = responseServer(() => "hello");
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(6);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const wire = await rawProxyGet(proxy.server, `http://public.test:${upstreamPort}/under`);

  assert.equal(rawResponseBody(wire).toString(), "hello");
  assert.deepEqual(proxy.getDiagnostics().responseByteBudget, {
    name: "request-capture",
    family: "requests",
    limitBytes: 6,
    forwardedBytes: 5,
    remainingBytes: 1,
    limitReached: false,
    captureLoss: null
  });
});

test("public scan proxy permits an exact HTTP byte-cap response, then refuses new upstream work", async (t) => {
  let upstreamHits = 0;
  const upstream = responseServer(() => {
    upstreamHits += 1;
    return "hello";
  });
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(5);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const exact = await rawProxyGet(proxy.server, `http://public.test:${upstreamPort}/exact`);
  assert.equal(rawResponseBody(exact).toString(), "hello");
  assert.deepEqual(proxy.getDiagnostics().responseByteBudget, {
    name: "request-capture",
    family: "requests",
    limitBytes: 5,
    forwardedBytes: 5,
    remainingBytes: 0,
    limitReached: true,
    captureLoss: null
  });

  const refused = await rawProxyGet(proxy.server, `http://public.test:${upstreamPort}/refused`);
  assert.equal(refused.byteLength, 0);
  assert.equal(upstreamHits, 1);
  assert.deepEqual(proxy.getDiagnostics().responseByteBudget.captureLoss, {
    family: "requests",
    phaseId: null,
    kind: "cap",
    count: 1,
    detail: "request-capture"
  });
});

test("public scan proxy truncates a socket-level HTTP response that exceeds the byte cap", async (t) => {
  const upstream = responseServer(() => "abcdef");
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(5);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const wire = await rawProxyGet(proxy.server, `http://public.test:${upstreamPort}/over`);

  assert.equal(rawResponseBody(wire).toString(), "abcde");
  assert.deepEqual(proxy.getDiagnostics().responseByteBudget, {
    name: "request-capture",
    family: "requests",
    limitBytes: 5,
    forwardedBytes: 5,
    remainingBytes: 0,
    limitReached: true,
    captureLoss: {
      family: "requests",
      phaseId: null,
      kind: "cap",
      count: 1,
      detail: "request-capture"
    }
  });
});

test("public scan proxy caps raw upstream bytes in a CONNECT tunnel", async (t) => {
  const upstream = net.createServer((socket) => socket.end("abcdef"));
  await listen(upstream);
  const upstreamPort = portOf(upstream);
  const proxy = await budgetTestProxy(5);

  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });

  const wire = await rawProxyConnect(proxy.server, `tunnel.test:${upstreamPort}`);

  assert.match(wire.toString(), /^HTTP\/1\.1 200 Connection Established/);
  assert.equal(rawResponseBody(wire).toString(), "abcde");
  assert.equal(proxy.getDiagnostics().responseByteBudget.forwardedBytes, 5);
  assert.equal(proxy.getDiagnostics().responseByteBudget.captureLoss?.count, 1);
});

test("public scan proxy aggregates one byte budget across HTTP responses and CONNECT tunnels", async (t) => {
  let httpHits = 0;
  const httpUpstream = responseServer(() => {
    httpHits += 1;
    return "http";
  });
  const tunnelUpstream = net.createServer((socket) => socket.end("tls!"));
  await Promise.all([listen(httpUpstream), listen(tunnelUpstream)]);
  const httpPort = portOf(httpUpstream);
  const tunnelPort = portOf(tunnelUpstream);
  const proxy = await budgetTestProxy(10);

  t.after(async () => {
    await proxy.close();
    await Promise.all([closeServer(httpUpstream), closeServer(tunnelUpstream)]);
  });

  const first = await rawProxyGet(proxy.server, `http://public.test:${httpPort}/one`);
  const second = await rawProxyConnect(proxy.server, `tunnel.test:${tunnelPort}`);
  const third = await rawProxyGet(proxy.server, `http://public.test:${httpPort}/three`);
  const refused = await rawProxyGet(proxy.server, `http://public.test:${httpPort}/four`);

  assert.equal(rawResponseBody(first).toString(), "http");
  assert.equal(rawResponseBody(second).toString(), "tls!");
  assert.equal(rawResponseBody(third).toString(), "ht");
  assert.equal(refused.byteLength, 0);
  assert.equal(httpHits, 2);
  assert.deepEqual(proxy.getDiagnostics().responseByteBudget, {
    name: "request-capture",
    family: "requests",
    limitBytes: 10,
    forwardedBytes: 10,
    remainingBytes: 0,
    limitReached: true,
    captureLoss: {
      family: "requests",
      phaseId: null,
      kind: "cap",
      count: 2,
      detail: "request-capture"
    }
  });
});

async function proxyGet(proxyServer: string, targetUrl: string): Promise<string> {
  const proxy = new URL(proxyServer);
  const target = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: target.toString(),
        headers: {
          Host: target.host
        }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function responseServer(body: () => string): http.Server {
  return http.createServer((_request, response) => {
    const payload = body();
    response.setHeader("Content-Length", Buffer.byteLength(payload));
    response.setHeader("Connection", "close");
    response.end(payload);
  });
}

async function budgetTestProxy(responseByteLimitBytes: number, uploadByteLimitBytes?: number) {
  return startPublicScanProxy({
    allowNonStandardPortsForTests: true,
    responseByteLimitBytes,
    ...(uploadByteLimitBytes === undefined ? {} : { uploadByteLimitBytes }),
    resolveHost: async () => [{ address: "1.1.1.1", family: 4 }],
    connectUpstreamForTests: (target) => net.connect({ host: "127.0.0.1", port: target.port })
  });
}

function portOf(server: net.Server): number {
  return (server.address() as AddressInfo).port;
}

async function listen(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function rawProxyGet(proxyServer: string, targetUrl: string): Promise<Buffer> {
  const proxy = new URL(proxyServer);
  const target = new URL(targetUrl);
  return collectSocket(
    net.connect({ host: proxy.hostname, port: Number(proxy.port) }),
    [
      `GET ${target.toString()} HTTP/1.1`,
      `Host: ${target.host}`,
      "Connection: close",
      "",
      ""
    ].join("\r\n")
  );
}

async function rawProxyConnect(proxyServer: string, authority: string): Promise<Buffer> {
  const proxy = new URL(proxyServer);
  return collectSocket(
    net.connect({ host: proxy.hostname, port: Number(proxy.port) }),
    [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Connection: close", "", ""].join("\r\n")
  );
}

async function rawProxyPost(proxyServer: string, targetUrl: string, body: Buffer): Promise<Buffer> {
  const proxy = new URL(proxyServer);
  const target = new URL(targetUrl);
  const headers = Buffer.from(
    [
      `POST ${target.toString()} HTTP/1.1`,
      `Host: ${target.host}`,
      `Content-Length: ${body.byteLength}`,
      "Connection: close",
      "",
      ""
    ].join("\r\n")
  );
  return collectSocket(net.connect({ host: proxy.hostname, port: Number(proxy.port) }), Buffer.concat([headers, body]));
}

async function rawProxyConnectUpload(proxyServer: string, authority: string, body: Buffer): Promise<Buffer> {
  const proxy = new URL(proxyServer);
  const headers = Buffer.from(
    [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Connection: close", "", ""].join("\r\n")
  );
  return collectSocket(net.connect({ host: proxy.hostname, port: Number(proxy.port) }), Buffer.concat([headers, body]));
}

function collectSocket(socket: net.Socket, request: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", reject);
  });
}

function rawResponseBody(response: Buffer): Buffer {
  const boundary = response.indexOf("\r\n\r\n");
  return boundary < 0 ? Buffer.alloc(0) : response.subarray(boundary + 4);
}

async function rawProxyUpgrade(proxyServer: string, targetUrl: string): Promise<string> {
  const proxy = new URL(proxyServer);
  const target = new URL(targetUrl);

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => {
      socket.write(
        [
          `GET ${target.toString()} HTTP/1.1`,
          `Host: ${target.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "",
          ""
        ].join("\r\n")
      );
    });

    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}
