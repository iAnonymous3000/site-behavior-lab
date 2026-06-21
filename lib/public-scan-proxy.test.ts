import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import { startPublicScanProxy } from "./public-scan-proxy";

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
  assert.deepEqual(proxy.blockedTargets, [{ target: "ws://socket.test/", reason: "invalid-target" }]);
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

async function listen(server: http.Server): Promise<void> {
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

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
