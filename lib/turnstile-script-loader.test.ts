import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnstileScriptLoader, type TurnstileScriptElement } from "./turnstile-script-loader";

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

function stubHost() {
  const injected: TurnstileScriptElement[] = [];
  const listeners: { load: (() => void)[]; error: (() => void)[] }[] = [];
  const present: { remove(): void }[] = [];
  let loaded = false;
  const document = {
    querySelectorAll: () => [...present],
    createElement: () => {
      const index = listeners.push({ load: [], error: [] }) - 1;
      const element = {
        src: "",
        async: false,
        defer: false,
        addEventListener: (type: "load" | "error", listener: () => void) => {
          listeners[index][type].push(listener);
        }
      } satisfies TurnstileScriptElement;
      injected.push(element);
      return element;
    },
    head: {
      appendChild: (element: TurnstileScriptElement) => {
        // A real tag stays in the document after it fails, which is the whole
        // hazard: its load and error events have already fired.
        present.push({ remove: () => present.splice(present.indexOf(present[0]), 1) });
        void element;
      }
    }
  };
  return {
    injected,
    present,
    fire: (index: number, type: "load" | "error") => listeners[index][type].forEach((listener) => listener()),
    host: () => ({ document, loaded: () => loaded }),
    succeed: () => {
      loaded = true;
    }
  };
}

test("a failed Turnstile load stays retryable instead of deadlocking the remount", async () => {
  const stub = stubHost();
  const load = createTurnstileScriptLoader(SRC, stub.host);

  const first = load();
  const firstSettled = first.then(
    () => "resolved",
    () => "rejected"
  );
  stub.fire(0, "error");
  assert.equal(await firstSettled, "rejected");

  // The remount. Before the fix this attached {once:true} listeners to the tag
  // left behind by the failed attempt, whose events had already fired, so the
  // promise never settled: no widget, no error, only a page reload recovered.
  const second = load();
  let settled = false;
  void second.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  assert.equal(stub.injected.length, 2, "a retry must inject a fresh script, not listen to the dead one");
  stub.fire(1, "load");
  await second;
  assert.equal(settled, true);
});

test("concurrent callers share one in-flight load and a loaded script resolves at once", async () => {
  const stub = stubHost();
  const load = createTurnstileScriptLoader(SRC, stub.host);

  const a = load();
  const b = load();
  assert.equal(stub.injected.length, 1, "a second caller must not inject a second script");
  stub.fire(0, "load");
  await Promise.all([a, b]);

  stub.succeed();
  await load();
  assert.equal(stub.injected.length, 1, "an already-loaded script needs no new tag");
});

test("the loader refuses outside a browser", async () => {
  const load = createTurnstileScriptLoader(SRC, () => null);
  await assert.rejects(load(), /only available in the browser/);
});
