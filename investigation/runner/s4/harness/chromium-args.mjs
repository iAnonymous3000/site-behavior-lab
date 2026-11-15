// The switches the scanner's Playwright 1.65.0 passes to chromium_headless_shell-1254 (Chrome for
// Testing 158.0.8127.18) for lib/scanner.ts getSharedBrowser's launch options, read from the browser's
// own argv on 2026-11-14 (scripts/scanner-argv-out.txt in the S4 work folder). Kept in its order.
export const SCANNER_SWITCHES = [
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-edgeupdater",
  "--disable-extensions",
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
  "--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-updater-scheduler",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--disable-search-engine-choice-screen",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--enable-unsafe-swiftshader",
  "--edge-skip-compat-layer-relaunch",
  "--disable-stack-profiler",
  "--disable-infobars",
  "--disable-sync",
  "--do-not-de-elevate",
  "--headless",
  "--hide-scrollbars",
  "--mute-audio",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
  "--no-sandbox",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
];

// Each change from the scanner's launch, reported before use:
// - removed --remote-debugging-pipe: Playwright's own control channel; no Playwright drives this browser.
// - removed --no-startup-window: the recorder needs a page target to attach to; the browser opens about:blank.
// - --remote-debugging-port fixed at 9222 (the scanner reserves a free loopback port), loopback only.
// - --user-data-dir under /tmp (the scanner's is Playwright's temporary profile, also under the tmp dir).
// - added --proxy-server and --proxy-bypass-list=<-loopback>: the scanner routes each context through its
//   guard proxy with Playwright's per-context proxy { server, bypass: "<-loopback>" }; without Playwright
//   the same routing is a launch flag.
export function launchArgs({ debuggingPort, profileDir, proxyPort }) {
  return [
    ...SCANNER_SWITCHES,
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDir}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "about:blank"
  ];
}
