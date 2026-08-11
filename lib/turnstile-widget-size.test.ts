import assert from "node:assert/strict";
import test from "node:test";
import {
  selectTurnstileWidgetSize,
  TURNSTILE_FLEXIBLE_MIN_WIDTH_PX
} from "./turnstile-widget-size";

test("Turnstile uses compact mode below the flexible widget's documented minimum", () => {
  assert.equal(TURNSTILE_FLEXIBLE_MIN_WIDTH_PX, 300);
  assert.equal(selectTurnstileWidgetSize(0), "compact");
  assert.equal(selectTurnstileWidgetSize(299.99), "compact");
  assert.equal(selectTurnstileWidgetSize(Number.NaN), "compact");
});

test("Turnstile uses flexible mode when its container can satisfy the minimum", () => {
  assert.equal(selectTurnstileWidgetSize(300), "flexible");
  assert.equal(selectTurnstileWidgetSize(640), "flexible");
});
