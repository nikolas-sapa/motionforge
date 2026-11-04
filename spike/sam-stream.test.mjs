import assert from "node:assert/strict";
import test from "node:test";
import { makeBoxPrompt, readSamStream } from "./sam-stream.mjs";

const video = { width: 640, height: 480, frameCount: 240 };
const seed = { frameIndex: 141, box: { x1: 105, y1: 154, x2: 390, y2: 252 } };
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const completed = { type: "response.completed", response: { id: "resp-unit", status: "completed" } };
const stream = (text) => new Response(text, { headers: { "content-type": "text/event-stream" } });

test("box prompt preserves all six source coordinates and explicit frame 141", () => {
  assert.equal(makeBoxPrompt(seed, video), "<141f>1<|box;x1=105;y1=154;x2=390;y2=252;w=640;h=480|>");
});

test("eight invalid boxes or frame indexes are rejected before inference", () => {
  for (const value of [
    { ...seed, frameIndex: -1 }, { ...seed, frameIndex: 240 },
    { ...seed, frameIndex: 1.5 }, { ...seed, box: { ...seed.box, x1: -1 } },
    { ...seed, box: { ...seed.box, x2: 640 } }, { ...seed, box: { ...seed.box, y2: 480 } },
    { ...seed, box: { ...seed.box, x2: 105 } }, { ...seed, box: { ...seed.box, y1: "154" } },
  ]) assert.throws(() => makeBoxPrompt(value, video));
});

test("two deltas survive seven-byte transport chunks and retain both frame boundaries", async () => {
  const text = event({ type: "response.output_text.delta", delta: "<0f>first|>" })
    + event({ type: "response.output_text.delta", delta: "<1f>second|>" }) + event(completed);
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const result = await readSamStream(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(result.text, "<0f>first|>\n<1f>second|>");
  assert.equal(result.response.id, "resp-unit");
});

test("zero deltas remain missing text, never silently become zero matches", async () => {
  assert.equal((await readSamStream(stream(event(completed)))).text, null);
});

test("six incomplete or malformed streams reject without echoing provider text", async () => {
  for (const text of [
    "", "data: REMOTE_SECRET\n\n", event({ type: "response.failed" }),
    event({ type: "response.output_text.delta", delta: 42 }),
    event(completed) + event(completed),
    event(completed) + event({ type: "response.output_text.delta", delta: "late" }),
  ]) {
    await assert.rejects(readSamStream(stream(text)), (error) => {
      assert.doesNotMatch(error.message, /REMOTE_SECRET|late/);
      return true;
    });
  }
});

test("wrong MIME and HTTP 401 are rejected before record parsing", async () => {
  await assert.rejects(readSamStream(new Response(event(completed))));
  await assert.rejects(readSamStream(new Response("REMOTE_SECRET", { status: 401 })), /401/);
});
