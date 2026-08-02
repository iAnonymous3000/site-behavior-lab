import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerifierLib = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<VerifierLib>;

function verifierLib() {
  return nativeImport(
    pathToFileURL(
      path.join(process.cwd(), "scripts", "github-cli-verifier-lib.mjs")
    ).href
  );
}

test("Node-only extraction ignores hostile tar and unzip commands", async (t) => {
  const { extractGithubCliBinary } = await verifierLib();
  const fixture = mkdtempSync(path.join(tmpdir(), "sbl-gh-extract-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const hostileBin = path.join(fixture, "bin");
  const marker = path.join(fixture, "external-extractor-ran");
  mkdirSync(hostileBin, { recursive: true });
  for (const command of ["tar", "unzip"]) {
    const executable = path.join(hostileBin, command);
    writeFileSync(
      executable,
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 99\n`,
      "utf8"
    );
    chmodSync(executable, 0o700);
  }
  const binary = Buffer.from("#!/bin/sh\nprintf verifier\\n", "utf8");
  const priorPath = process.env.PATH;
  process.env.PATH = hostileBin;
  try {
    assert.deepEqual(
      extractGithubCliBinary(buildTarGz("fixture-linux/bin/gh", binary), {
        directory: "fixture-linux",
        format: "tar.gz"
      }),
      binary
    );
    assert.deepEqual(
      extractGithubCliBinary(buildZip("fixture-darwin/bin/gh", binary), {
        directory: "fixture-darwin",
        format: "zip"
      }),
      binary
    );
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
  assert.equal(existsSync(marker), false);
  const helperSource = readFileSync(
    path.join(process.cwd(), "scripts", "github-cli-verifier-lib.mjs"),
    "utf8"
  );
  assert.doesNotMatch(helperSource, /node:child_process|spawnSync|execFile/);
  assert.doesNotMatch(helperSource, /\bcopyFile\b|\brename\b/);
});

test("PATH candidates are canonical absolute paths even for cwd entries", async () => {
  const { absolutePathGhCandidates } = await verifierLib();
  const cwd = path.join(path.sep, "private", "tmp", "verifier-cwd");
  const candidates = absolutePathGhCandidates(
    [".", "relative-bin", path.join(path.sep, "trusted", "bin")].join(
      path.delimiter
    ),
    cwd
  );
  assert.deepEqual(candidates, [
    path.join(cwd, "gh"),
    path.join(cwd, "relative-bin", "gh"),
    path.join(path.sep, "trusted", "bin", "gh")
  ]);
  assert.equal(candidates.every((candidate: string) => path.isAbsolute(candidate)), true);
  assert.equal(candidates.includes("gh"), false);
});

test("the verifier never executes hostile PATH or cwd gh candidates", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "sbl-gh-path-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const hostileBin = path.join(fixture, "hostile-bin");
  const marker = path.join(fixture, "fake-gh-ran");
  mkdirSync(hostileBin);
  for (const candidate of [
    path.join(hostileBin, "gh"),
    path.join(fixture, "gh")
  ]) {
    writeFileSync(
      candidate,
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf 'gh version 2.96.0 (fake)\\n'\n`,
      "utf8"
    );
    chmodSync(candidate, 0o700);
  }
  const verifier = path.join(
    process.cwd(),
    "scripts",
    "ensure-gh-attestation-verifier.mjs"
  );
  for (const candidatePath of [hostileBin, "."]) {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: candidatePath,
        SITE_BEHAVIOR_LAB_GH_BOOTSTRAP_OFFLINE: "1"
      }
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No byte-pinned GitHub CLI 2\.96\.0 verifier/);
    assert.equal(existsSync(marker), false);
  }
});

test("cache install refuses symlinks, nonregular entries, and clobbering", async (t) => {
  const {
    ensureSafeCacheDirectory,
    installCacheBinaryNoClobber
  } = await verifierLib();
  const fixture = mkdtempSync(path.join(tmpdir(), "sbl-gh-cache-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = realpathSync(fixture);
  const cacheDir = await ensureSafeCacheDirectory(root, [
    ".site-behavior-lab",
    "tools",
    "gh-fixture"
  ]);
  const destination = path.join(cacheDir, "gh");
  const victim = path.join(fixture, "victim");
  const binary = Buffer.from("pinned executable bytes");
  const expectedSha256 = createHash("sha256").update(binary).digest("hex");
  const verifyExecutable = async (candidate: string) =>
    (await readFile(candidate)).equals(binary);

  writeFileSync(victim, "do not replace", "utf8");
  symlinkSync(victim, destination);
  await assert.rejects(
    installCacheBinaryNoClobber({
      destination,
      binary,
      expectedSha256,
      verifyExecutable
    }),
    /a symbolic link; refusing replacement/
  );
  assert.equal(readFileSync(victim, "utf8"), "do not replace");

  unlinkSync(destination);
  mkdirSync(destination);
  await assert.rejects(
    installCacheBinaryNoClobber({
      destination,
      binary,
      expectedSha256,
      verifyExecutable
    }),
    /a non-regular entry; refusing replacement/
  );
  rmSync(destination, { recursive: true });

  let raced = false;
  await assert.rejects(
    installCacheBinaryNoClobber({
      destination,
      binary,
      expectedSha256,
      verifyExecutable: async (candidate: string) => {
        if (!raced && path.basename(candidate).startsWith(".gh-install-")) {
          writeFileSync(destination, "racing file", "utf8");
          raced = true;
        }
        return true;
      }
    }),
    /destination appeared during install; refusing replacement/
  );
  assert.equal(readFileSync(destination, "utf8"), "racing file");
  assert.equal(
    readdirSync(cacheDir).some((entry) => entry.startsWith(".gh-install-")),
    false
  );
  unlinkSync(destination);

  const installed = await installCacheBinaryNoClobber({
    destination,
    binary,
    expectedSha256,
    verifyExecutable
  });
  assert.equal(installed, destination);
  assert.deepEqual(readFileSync(destination), binary);
  assert.equal(
    readdirSync(cacheDir).some((entry) => entry.startsWith(".gh-install-")),
    false
  );
  await assert.rejects(
    installCacheBinaryNoClobber({
      destination,
      binary,
      expectedSha256,
      verifyExecutable
    }),
    /an untrusted regular file; refusing replacement/
  );
  const helperSource = readFileSync(
    path.join(process.cwd(), "scripts", "github-cli-verifier-lib.mjs"),
    "utf8"
  );
  assert.match(helperSource, /O_EXCL/);
  assert.match(helperSource, /O_NOFOLLOW/);
  assert.match(helperSource, /await link\(temporary, destination\)/);
  assert.doesNotMatch(helperSource, /\bcopyFile\b|\brename\b/);
});

test("cache directory creation rejects a symlinked parent chain", async (t) => {
  const { ensureSafeCacheDirectory } = await verifierLib();
  const fixture = mkdtempSync(path.join(tmpdir(), "sbl-gh-parent-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = realpathSync(fixture);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, ".site-behavior-lab"));

  await assert.rejects(
    ensureSafeCacheDirectory(root, [
      ".site-behavior-lab",
      "tools",
      "gh-fixture"
    ]),
    /must be a non-symbolic directory/
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("chunked downloads are canceled as soon as the byte ceiling is crossed", async () => {
  const { readBoundedResponseBody } = await verifierLib();
  let canceled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6).fill(1));
      controller.enqueue(new Uint8Array(6).fill(2));
    },
    cancel() {
      canceled = true;
    }
  });
  await assert.rejects(
    readBoundedResponseBody(
      {
        headers: new Headers(),
        body: oversized
      },
      10
    ),
    /exceeds the byte ceiling/
  );
  assert.equal(canceled, true);
  await assert.rejects(
    readBoundedResponseBody(
      {
        headers: new Headers({ "content-length": "11" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1]));
            controller.close();
          }
        })
      },
      10
    ),
    /exceeds the byte ceiling/
  );

  const accepted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]));
      controller.enqueue(Uint8Array.from([3, 4]));
      controller.close();
    }
  });
  assert.deepEqual(
    await readBoundedResponseBody(
      {
        headers: new Headers({ "content-length": "4" }),
        body: accepted
      },
      4
    ),
    Buffer.from([1, 2, 3, 4])
  );
  const verifierSource = readFileSync(
    path.join(process.cwd(), "scripts", "ensure-gh-attestation-verifier.mjs"),
    "utf8"
  );
  assert.doesNotMatch(verifierSource, /\.arrayBuffer\(/);
  assert.match(verifierSource, /readBoundedResponseBody/);
});

function buildTarGz(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  Buffer.from(name, "ascii").copy(header, 0);
  writeTarOctal(header, 100, 8, 0o755);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, contents.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148
  );
  const padding = Buffer.alloc(
    Math.ceil(contents.length / 512) * 512 - contents.length
  );
  return gzipSync(
    Buffer.concat([header, contents, padding, Buffer.alloc(1024)])
  );
}

function writeTarOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number
) {
  const encoded = `${value.toString(8).padStart(length - 2, "0")}\0 `;
  Buffer.from(encoded, "ascii").copy(buffer, offset);
}

function buildZip(name: string, contents: Buffer): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(contents);
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);

  const localRecord = Buffer.concat([local, nameBytes, compressed]);
  const centralRecord = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum =
      CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
