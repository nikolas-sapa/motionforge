import assert from "node:assert/strict";
import test from "node:test";
import { frameIndexAtTime, seekTimeForFrame } from "../src/video-frame.mjs";

test("irregular and nonzero source timestamps select exact frames without assuming fps or shifting time", () => {
  const times = [1, 1.03, 1.08, 1.2];
  for (let i = 0; i < times.length; i += 1) assert.equal(frameIndexAtTime(times, times[i]), i);
  assert.equal(frameIndexAtTime([1, 2], 1.5), 0);
  assert.equal(frameIndexAtTime(times, 0), 0);
  assert.equal(frameIndexAtTime(times, 99), 3);
});

test("all four seek targets lie strictly inside their presentation interval and within 1ms of source PTS", () => {
  const times = [1, 1.03, 1.08, 1.2];
  for (let i = 0; i < times.length; i += 1) {
    const target = seekTimeForFrame(times, i, 1.24);
    assert.ok(target > times[i] && target < (times[i + 1] ?? 1.24));
    assert.ok(target - times[i] <= 0.001000000001);
  }
});

test("six invalid timing arrays, indexes or durations reject instead of inventing frame zero", () => {
  for (const times of [[], [NaN], [-1], [1, 1], [2, 1]]) {
    assert.throws(() => frameIndexAtTime(times, 0), RangeError);
  }
  assert.throws(() => frameIndexAtTime([0, 1], NaN), RangeError);
  for (const index of [-1, 2, 0.5]) assert.throws(() => seekTimeForFrame([0, 1], index, 2), RangeError);
  assert.throws(() => seekTimeForFrame([0, 1], 1, 1), RangeError);
});
