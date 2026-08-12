import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession } from "playwright";
import { adblockEngineStatus, getAdblockEngine } from "./adblock-engine";
import { recordedBuildCommit } from "./build-provenance";
import {
  MAX_NATIVE_NETWORK_RECORDS,
  MAX_NATIVE_SHIELDS_EVENTS,
  buildNativeShieldsDifferentialReceipt,
  nativeShieldsDifferentialReceiptText,
  parseCdpFrame,
  parseCdpNetworkRequest,
  parseNativeAdblockEvent,
  type NativeShieldsDifferentialReceipt,
  type RawCdpFrame,
  type RawCdpNetworkRequest,
  type RawNativeAdblockEvent
} from "./native-shields-differential";
import { startPublicScanProxy, type PublicScanProxy } from "./public-scan-proxy";
import { assertPublicHttpUrl, normalizeUrl } from "./url-safety";

const DEFAULT_DWELL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DWELL_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEDICATED_PROFILE_MARKER = ".site-behavior-lab-native-shields-profile-v1";
const DEDICATED_PROFILE_MARKER_CONTENT = "Site Behavior Lab native Shields research profile v1\n";

type ExecutableLabel = NativeShieldsDifferentialReceipt["capture"]["browser"]["executableLabel"];

export type NativeShieldsCliOptions = {
  url: string;
  output: string;
  bravePath: string | null;
  executableLabel: ExecutableLabel | null;
  profileDir: string | null;
  dwellMs: number;
  timeoutMs: number;
  headless: boolean;
};

export function parseNativeShieldsCliArgs(argv: string[]): NativeShieldsCliOptions | { help: true } {
  const options: NativeShieldsCliOptions = {
    url: "",
    output: "",
    bravePath: null,
    executableLabel: null,
    profileDir: null,
    dwellMs: DEFAULT_DWELL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headless: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--headed") {
      options.headless = false;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
    index += 1;
    if (argument === "--url") options.url = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--brave") options.bravePath = value;
    else if (argument === "--label") options.executableLabel = executableLabel(value);
    else if (argument === "--profile-dir") options.profileDir = value;
    else if (argument === "--dwell-ms") options.dwellMs = boundedInteger(value, 0, MAX_DWELL_MS, "dwell-ms");
    else if (argument === "--timeout-ms") options.timeoutMs = boundedInteger(value, 1_000, MAX_TIMEOUT_MS, "timeout-ms");
    else throw new TypeError(`unknown option ${argument}`);
  }
  if (!options.url) throw new TypeError("--url is required");
  if (!options.output) throw new TypeError("--output is required");
  return options;
}

export function nativeShieldsCliHelp(): string {
  return `Usage: npm run shields:native-diff -- --url https://example.com --output /tmp/native-shields.json [options]

Options:
  --brave <path>       Brave executable (auto-detected when omitted)
  --label <value>      brave-stable, brave-beta, brave-nightly, or custom
  --profile-dir <path> Reusable dedicated research profile (never a normal Brave profile)
  --dwell-ms <ms>      Post-DOM-content dwell, 0-${MAX_DWELL_MS} (default ${DEFAULT_DWELL_MS})
  --timeout-ms <ms>    Navigation timeout, 1000-${MAX_TIMEOUT_MS} (default ${DEFAULT_TIMEOUT_MS})
  --headed             Run with a visible browser window (headless by default)
  --help               Show this help

The runner always uses Site Behavior Lab's connect-time public-address proxy,
writes a redacted research receipt with mode 0600, and refuses to overwrite it.
`;
}

async function main(): Promise<void> {
  const parsed = parseNativeShieldsCliArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(nativeShieldsCliHelp());
    return;
  }
  const receipt = await captureNativeShieldsDifferential(parsed);
  const output = path.resolve(parsed.output);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, nativeShieldsDifferentialReceiptText(receipt), { flag: "wx", mode: 0o600 });
  process.stdout.write(
    `Wrote ${output}: ${receipt.status}, ${receipt.coverage.nativeEvents} native event(s), ` +
      `${receipt.coverage.correlatedNativeEvents} correlated.\n`
  );
}

export async function captureNativeShieldsDifferential(
  options: NativeShieldsCliOptions
): Promise<NativeShieldsDifferentialReceipt> {
  const target = normalizeUrl(options.url);
  await assertPublicHttpUrl(target, { timeoutMs: Math.min(options.timeoutMs, 10_000) });
  const resolvedExecutable = resolveBraveExecutable(options.bravePath, options.executableLabel);
  const output = path.resolve(options.output);
  if (existsSync(output)) throw new TypeError(`output already exists: ${output}`);

  const executableDigest = sha256File(resolvedExecutable.path);
  const runtimeDigest =
    resolvedExecutable.runtimePath === resolvedExecutable.path
      ? executableDigest
      : sha256File(resolvedExecutable.runtimePath);
  const [executableSha256, runtimeBinarySha256, engineStatus, engine] = await Promise.all([
    executableDigest,
    runtimeDigest,
    adblockEngineStatus(),
    getAdblockEngine()
  ]);
  const startedAt = new Date().toISOString();
  const networkRequests: RawCdpNetworkRequest[] = [];
  const nativeEvents: RawNativeAdblockEvent[] = [];
  const frames = new Map<string, RawCdpFrame>();
  let sequence = 0;
  let droppedNetworkRequestRecords = 0;
  let droppedNativeEvents = 0;
  let unparsableNetworkRecords = 0;
  let unparsableNativeEvents = 0;
  let rootFrameId: string | null = null;
  let context: BrowserContext | null = null;
  let proxy: PublicScanProxy | null = null;
  let profileDirectory: string | null = null;
  let removeProfileDirectory = false;
  let browserVersion = "unknown";
  let observedUrl: string | null = null;
  let navigationStatus: number | null = null;
  let navigationOutcome: NativeShieldsDifferentialReceipt["capture"]["navigation"]["outcome"] = "failed";
  let proxyBlockedTargets = 0;
  let proxyResourceLimitHit = false;

  try {
    proxy = await startPublicScanProxy();
    if (options.profileDir === null) {
      profileDirectory = mkdtempSync(path.join(tmpdir(), "sbl-native-shields-profile-"));
      removeProfileDirectory = true;
    } else {
      profileDirectory = prepareDedicatedProfileDirectory(options.profileDir);
    }
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: resolvedExecutable.path,
      headless: options.headless,
      // Playwright's generic Chromium defaults suppress component-backed and
      // extension-backed browser behavior. Brave's filter-list state is part
      // of the subject under test, so retain only the defaults that do not
      // disable that state. All resulting background traffic still traverses
      // the connect-time public-address proxy below.
      ignoreDefaultArgs: [
        "--disable-background-networking",
        "--disable-component-extensions-with-background-pages",
        "--disable-component-update",
        "--disable-extensions"
      ],
      locale: "en-US",
      proxy: { server: proxy.server, bypass: "<-loopback>" },
      serviceWorkers: "block",
      timezoneId: "America/Los_Angeles",
      viewport: { width: 1365, height: 768 }
    });
    browserVersion = boundedBrowserVersion(context.browser()?.version() ?? "unknown");
    const page = context.pages()[0] ?? await context.newPage();
    const session = await context.newCDPSession(page);
    session.on("event", ({ method, params }) => {
      sequence += 1;
      // A refused payload and a reached ceiling are different evidence stories:
      // one is possible schema drift silently eroding the differential, the
      // other is a bound to raise and re-run. Counted apart so a reader can
      // tell which happened.
      if (method === "Network.requestWillBeSent") {
        const request = parseCdpNetworkRequest(params, sequence);
        if (!request) {
          unparsableNetworkRecords += 1;
        } else if (networkRequests.length >= MAX_NATIVE_NETWORK_RECORDS) {
          droppedNetworkRequestRecords += 1;
        } else {
          networkRequests.push(request);
        }
      } else if (method === "Network.requestAdblockInfoReceived") {
        const event = parseNativeAdblockEvent(params, sequence);
        if (!event) {
          unparsableNativeEvents += 1;
        } else if (nativeEvents.length >= MAX_NATIVE_SHIELDS_EVENTS) {
          droppedNativeEvents += 1;
        } else {
          nativeEvents.push(event);
        }
      } else if (method === "Page.frameNavigated" && isRecord(params)) {
        const frame = parseCdpFrame(params.frame);
        if (frame) {
          frames.set(frame.id, frame);
          if (!frame.parentId) rootFrameId = frame.id;
        }
      } else if (method === "Page.frameAttached" && isRecord(params)) {
        const frameId = stringOrNull(params.frameId);
        const parentId = stringOrNull(params.parentFrameId);
        if (frameId && parentId) frames.set(frameId, { id: frameId, parentId, url: "" });
      }
    });
    await Promise.all([session.send("Network.enable"), session.send("Page.enable")]);
    await seedFrameTree(session, frames, (frameId) => {
      rootFrameId = frameId;
    });
    try {
      const response = await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs
      });
      navigationStatus = response?.status() ?? null;
      navigationOutcome = "completed";
    } catch (error) {
      navigationOutcome = isTimeoutError(error) ? "timeout" : "failed";
    }
    if (options.dwellMs > 0) await page.waitForTimeout(options.dwellMs);
    observedUrl = isHttpUrl(page.url()) ? page.url() : null;
  } finally {
    const diagnostics = proxy?.getDiagnostics();
    proxyBlockedTargets = proxy?.blockedTargets.length ?? 0;
    // Explicitly against a resolved object. `diagnostics?.x.captureLoss !== null`
    // short-circuits the whole chain to undefined when there are no
    // diagnostics, and `undefined !== null` is true, so absent evidence read as
    // an observed resource-limit hit.
    proxyResourceLimitHit =
      diagnostics !== undefined &&
      (diagnostics.trafficBudget.captureLoss !== null ||
        diagnostics.responseByteBudget.captureLoss !== null ||
        diagnostics.uploadByteBudget.captureLoss !== null);
    await context?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    if (profileDirectory !== null && removeProfileDirectory) {
      rmSync(profileDirectory, { recursive: true, force: true });
    }
  }

  const finishedAt = new Date().toISOString();
  return buildNativeShieldsDifferentialReceipt({
    startedAt,
    finishedAt,
    // Fresh per capture and never written down, so a published digest is not a
    // hash of an enumerable request id.
    requestIdSalt: randomBytes(32).toString("hex"),
    buildCommit: currentBuildCommit(),
    requestedUrl: target.toString(),
    observedUrl,
    navigation: { outcome: navigationOutcome, status: navigationStatus },
    browser: {
      executableLabel: resolvedExecutable.label,
      version: browserVersion,
      executableSha256,
      runtimeBinarySha256,
      runtimeBinaryKind: resolvedExecutable.runtimeKind,
      headless: options.headless
    },
    profile:
      options.profileDir === null
        ? "playwright-temporary-persistent"
        : "operator-dedicated-persistent",
    engineStatus,
    engine,
    rootFrameId,
    frames: [...frames.values()],
    networkRequests,
    nativeEvents,
    droppedNetworkRequestRecords,
    droppedNativeEvents,
    unparsableNetworkRecords,
    unparsableNativeEvents,
    proxyBlockedTargets,
    proxyResourceLimitHit
  });
}

export function prepareDedicatedProfileDirectory(suppliedPath: string): string {
  let profileDirectory = path.resolve(suppliedPath);
  assertDedicatedProfileLocation(profileDirectory);
  if (existsSync(profileDirectory)) {
    if (lstatSync(profileDirectory).isSymbolicLink() || !statSync(profileDirectory).isDirectory()) {
      throw new TypeError(`dedicated profile path is not a real directory: ${profileDirectory}`);
    }
    const entries = readdirSync(profileDirectory);
    if (entries.length > 0 && !entries.includes(DEDICATED_PROFILE_MARKER)) {
      throw new TypeError(
        `refusing unmarked existing profile directory: ${profileDirectory}; use a new empty directory`
      );
    }
  } else {
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  }
  profileDirectory = realpathSync(profileDirectory);
  assertDedicatedProfileLocation(profileDirectory);
  const marker = path.join(profileDirectory, DEDICATED_PROFILE_MARKER);
  if (!existsSync(marker)) {
    writeFileSync(marker, DEDICATED_PROFILE_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  } else if (
    lstatSync(marker).isSymbolicLink() ||
    !statSync(marker).isFile() ||
    readFileSync(marker, "utf8") !== DEDICATED_PROFILE_MARKER_CONTENT
  ) {
    throw new TypeError(`dedicated profile marker is invalid: ${marker}`);
  }
  return profileDirectory;
}

function assertDedicatedProfileLocation(profileDirectory: string): void {
  const protectedRoots = [
    path.join(homedir(), "Library", "Application Support", "BraveSoftware"),
    path.join(homedir(), ".config", "BraveSoftware"),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "BraveSoftware")] : [])
  ].map((entry) => path.resolve(entry));
  if (
    profileDirectory === path.parse(profileDirectory).root ||
    profileDirectory === path.resolve(homedir()) ||
    protectedRoots.some(
      (root) => profileDirectory === root || profileDirectory.startsWith(`${root}${path.sep}`)
    )
  ) {
    throw new TypeError(`refusing normal or broad profile directory: ${profileDirectory}`);
  }
}

function resolveBraveExecutable(
  suppliedPath: string | null,
  suppliedLabel: ExecutableLabel | null
): {
  path: string;
  label: ExecutableLabel;
  runtimePath: string;
  runtimeKind: "executable" | "macos-framework";
} {
  if (suppliedPath) {
    const executablePath = path.resolve(suppliedPath);
    assertExecutableFile(executablePath);
    const label = suppliedLabel ?? inferExecutableLabel(executablePath);
    return { path: executablePath, label, ...resolveRuntimeBinary(executablePath, label) };
  }
  const candidates = braveExecutableCandidates();
  const selected = candidates.find((candidate) => existsSync(candidate.path));
  if (!selected) {
    throw new TypeError("Brave executable was not found; pass --brave <path>");
  }
  assertExecutableFile(selected.path);
  if (suppliedLabel && suppliedLabel !== selected.label) {
    return { path: selected.path, label: suppliedLabel, ...resolveRuntimeBinary(selected.path, suppliedLabel) };
  }
  return { ...selected, ...resolveRuntimeBinary(selected.path, selected.label) };
}

function braveExecutableCandidates(): Array<{ path: string; label: ExecutableLabel }> {
  if (process.platform === "darwin") {
    return [
      {
        path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        label: "brave-stable"
      },
      {
        path: "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta",
        label: "brave-beta"
      },
      {
        path: "/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly",
        label: "brave-nightly"
      }
    ];
  }
  return [
    { path: "/usr/bin/brave-browser", label: "brave-stable" },
    { path: "/usr/bin/brave-browser-beta", label: "brave-beta" },
    { path: "/usr/bin/brave-browser-nightly", label: "brave-nightly" }
  ];
}

function inferExecutableLabel(executablePath: string): ExecutableLabel {
  const lower = executablePath.toLowerCase();
  if (lower.includes("nightly")) return "brave-nightly";
  if (lower.includes("beta")) return "brave-beta";
  if (lower.includes("brave")) return "brave-stable";
  return "custom";
}

function resolveRuntimeBinary(
  executablePath: string,
  label: ExecutableLabel
): { runtimePath: string; runtimeKind: "executable" | "macos-framework" } {
  if (process.platform !== "darwin") return { runtimePath: executablePath, runtimeKind: "executable" };
  const marker = ".app/Contents/MacOS/";
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex < 0) return { runtimePath: executablePath, runtimeKind: "executable" };
  const appRoot = executablePath.slice(0, markerIndex + ".app".length);
  const frameworkName =
    label === "brave-nightly"
      ? "Brave Browser Nightly Framework"
      : label === "brave-beta"
        ? "Brave Browser Beta Framework"
        : "Brave Browser Framework";
  const framework = path.join(
    appRoot,
    "Contents",
    "Frameworks",
    `${frameworkName}.framework`,
    "Versions",
    "Current",
    frameworkName
  );
  if (existsSync(framework) && statSync(framework).isFile()) {
    return { runtimePath: framework, runtimeKind: "macos-framework" };
  }
  return { runtimePath: executablePath, runtimeKind: "executable" };
}

function executableLabel(value: string): ExecutableLabel {
  if (value === "brave-stable" || value === "brave-beta" || value === "brave-nightly" || value === "custom") {
    return value;
  }
  throw new TypeError("--label must be brave-stable, brave-beta, brave-nightly, or custom");
}

async function seedFrameTree(
  session: CDPSession,
  frames: Map<string, RawCdpFrame>,
  setRoot: (frameId: string) => void
): Promise<void> {
  const result = await session.send("Page.getFrameTree");
  const visit = (tree: unknown, root: boolean): void => {
    if (!isRecord(tree) || !isRecord(tree.frame)) return;
    const frame = parseCdpFrame(tree.frame);
    if (frame) {
      frames.set(frame.id, frame);
      if (root) setRoot(frame.id);
    }
    if (Array.isArray(tree.childFrames)) tree.childFrames.forEach((child) => visit(child, false));
  };
  visit(result.frameTree, true);
}

function currentBuildCommit(): string | null {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (status.trim() !== "") return null;
    const declared = recordedBuildCommit();
    if (declared) return declared;
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function assertExecutableFile(file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new TypeError(`Brave executable is not a file: ${file}`);
}

function boundedInteger(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`--${label} must be an integer from ${min} through ${max}`);
  }
  return parsed;
}

function boundedBrowserVersion(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : "unknown";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
