#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

const execFileAsync = promisify(execFile);
const dockerBin = process.env.DOCKER_BIN || "docker";
const image = process.env.DOCKER_SMOKE_IMAGE || "site-behavior-lab:smoke";
const token = process.env.DOCKER_SMOKE_SCAN_ACCESS_TOKEN || "docker-smoke-token";
const skipBuild = /^(1|true|yes|on)$/i.test(process.env.DOCKER_SMOKE_SKIP_BUILD || "");

let containerId = "";

try {
  await assertDockerAvailable();
  if (!skipBuild) {
    await run(dockerBin, ["build", "-t", image, "."]);
  }

  const port = await freePort();
  const runResult = await execFileAsync(dockerBin, [
    "run",
    "--rm",
    "-d",
    "-p",
    `127.0.0.1:${port}:3000`,
    "-e",
    `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN=${token}`,
    "-e",
    "SITE_BEHAVIOR_LAB_SCANNER_EGRESS=docker-smoke",
    image
  ]);
  containerId = runResult.stdout.trim();
  if (!containerId) throw new Error("Docker did not return a container id.");

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  await run("node", ["scripts/smoke-test.mjs"], {
    BASE_URL: baseUrl,
    SMOKE_SCAN_ACCESS_TOKEN: token
  });

  console.log(`Docker smoke passed for ${image} at ${baseUrl}.`);
} finally {
  if (containerId) {
    await execFileAsync(dockerBin, ["stop", containerId]).catch(() => undefined);
  }
}

async function assertDockerAvailable() {
  try {
    await run(dockerBin, ["version"]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Docker is required for this smoke test. Install Docker or set DOCKER_BIN to the Docker CLI path.");
    }
    throw error;
  }
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 90_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = await response.json();
      if (response.ok && health.ok === true) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_500);
  }

  throw new Error(`Docker container did not become healthy: ${lastError}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a smoke-test port."));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
