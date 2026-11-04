import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseSamBoxes, probeVideo, trackVideo } from "./sam-api.mjs";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MASK = "x=0;y=0;data=27,60,~pa,ylo!ad~x";
const MASK_C = "x=0;y=0;c=0.5;data=27,60,~pa,ylo!ad~x";
const MASK_WITH_PIPE = "x=0;y=0;data=27,60,~pa|ylo!ad~x";

const wrap = (inner) => inner.replaceAll("[", "<").replaceAll("]", ">");

function rec(id, box, conf, mask) {
  const maskInner = mask ?? (conf == null ? MASK : MASK_C);
  return String(id) + "[|box;" + box + "|]" + "[|mask;" + maskInner + "|]";
}

function line(frameIndex, records) {
  return "[" + frameIndex + "f]" + records.join(",");
}

const FIXTURE = wrap(
  line(0, [
    rec(0, "x1=211;y1=228;x2=270;y2=254;w=320;h=334"),
    rec(1, "x1=155;y1=228;x2=202;y2=254;w=320;h=334"),
  ]),
);

const CONF_FIXTURE = wrap(
  line(0, [
    rec(1, "x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375", 1),
    rec(3, "x1=10;y1=20;x2=40;y2=60;w=1800;h=1200;c=0.25", 1),
  ]),
);

test("parses documented fixture records", () => {
  const out = parseSamBoxes(FIXTURE);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    frameIndex: 0, objectId: "0",
    x1: 211, y1: 228, x2: 270, y2: 254, width: 320, height: 334,
  });
  assert.deepEqual(out[1], {
    frameIndex: 0, objectId: "1",
    x1: 155, y1: 228, x2: 202, y2: 254, width: 320, height: 334,
  });
  assert.equal(Object.hasOwn(out, "sourceWidth"), false);
  assert.equal(Object.hasOwn(out, "sourceHeight"), false);
});

test("parses a mask payload containing a pipe", () => {
  const text = wrap(line(0, [
    rec(4, "x1=1;y1=1;x2=10;y2=10;w=320;h=334", null, MASK_WITH_PIPE),
  ]));
  assert.equal(parseSamBoxes(text).length, 1);
});

test("accepts optional confidence fields and sparse object ids", () => {
  const out = parseSamBoxes(CONF_FIXTURE);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.objectId), ["1", "3"]);
});

test("sorts out-of-order frames without inventing absent ones", () => {
  const text = wrap([
    line(30, [rec(0, "x1=1;y1=1;x2=10;y2=10;w=320;h=334")]),
    line(31, [rec(0, "x1=2;y1=1;x2=11;y2=10;w=320;h=334")]),
    line(29, [rec(0, "x1=0;y1=1;x2=9;y2=10;w=320;h=334")]),
  ].join("\n"));
  const out = parseSamBoxes(text);
  assert.deepEqual(out.map((r) => r.frameIndex), [29, 30, 31]);
});

test("empty input yields no records", () => {
  assert.deepEqual(parseSamBoxes(""), []);
  assert.throws(() => parseSamBoxes(null), /string/);
  assert.throws(() => parseSamBoxes(undefined), /string/);
  assert.throws(() => parseSamBoxes(42), /string/);
});

test("malformed line errors never echo remote control characters or secrets", () => {
  assert.throws(
    () => parseSamBoxes("\u001b[31mFAKE_REMOTE_SECRET\u0000\u0007\r"),
    (err) => {
      assert.equal(err.message, "malformed SAM line");
      assert.doesNotMatch(err.message, /FAKE_REMOTE_SECRET|[\u0000-\u001f]/);
      return true;
    },
  );
});

test("rejects malformed output", () => {
  assert.throws(() => parseSamBoxes("hello world"), /malformed/);
  assert.throws(() => parseSamBoxes(wrap("[0f]0[|box;x1=1|]")), /box|mask/);
  const dup = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334"),
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334"),
  ]));
  assert.throws(() => parseSamBoxes(dup), /duplicate/);
  const oob = wrap(line(0, [rec(0, "x1=310;y1=1;x2=400;y2=5;w=320;h=334")]));
  assert.throws(() => parseSamBoxes(oob), /bounds/);
  const dims = wrap([
    line(0, [rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334")]),
    line(1, [rec(0, "x1=1;y1=1;x2=5;y2=5;w=640;h=334")]),
  ].join("\n"));
  assert.throws(() => parseSamBoxes(dims), /dimension/);
  const zero = wrap(line(0, [rec(0, "x1=5;y1=5;x2=5;y2=5;w=320;h=334")]));
  assert.throws(() => parseSamBoxes(zero), /zero-size/);
  const zeroDimensions = wrap(line(0, [rec(0, "x1=0;y1=0;x2=1;y2=1;w=0;h=334")]));
  assert.throws(() => parseSamBoxes(zeroDimensions), /positive/);
  const unsafeFrame = wrap(line("9007199254740992", [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334"),
  ]));
  assert.throws(() => parseSamBoxes(unsafeFrame), /safe integer/);
  const unsafeCoordinate = wrap(line(0, [
    rec(0, "x1=9007199254740992;y1=1;x2=9007199254740993;y2=5;w=320;h=334"),
  ]));
  assert.throws(() => parseSamBoxes(unsafeCoordinate), /safe integer/);
  const unsafeDimension = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=9007199254740992;h=334"),
  ]));
  assert.throws(() => parseSamBoxes(unsafeDimension), /safe integer/);
  const unsafeMaskDimension = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334", null, "x=0;y=0;data=9007199254740992,60,~payload"),
  ]));
  assert.throws(() => parseSamBoxes(unsafeMaskDimension), /safe integer/);
  const invalidBoxConfidence = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334;c=1.1"),
  ]));
  assert.throws(() => parseSamBoxes(invalidBoxConfidence), /confidence/);
  const invalidMaskConfidence = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334", null, "x=0;y=0;c=1.1;data=27,60,~payload"),
  ]));
  assert.throws(() => parseSamBoxes(invalidMaskConfidence), /confidence/);
  for (const confidence of ["NaN", "Infinity", "-0.1"]) {
    const invalidConfidence = wrap(line(0, [
      rec(0, `x1=1;y1=1;x2=5;y2=5;w=320;h=334;c=${confidence}`),
    ]));
    assert.throws(() => parseSamBoxes(invalidConfidence), /box|confidence/);
  }
  const trailingText = wrap(line(0, [
    rec(0, "x1=1;y1=1;x2=5;y2=5;w=320;h=334", null, MASK_WITH_PIPE),
  ])) + "stray";
  assert.throws(() => parseSamBoxes(trailingText), /separator/);
});

test("missing api key rejects before any fetch", async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return new Response("{}", { status: 200 }); };
  await assert.rejects(
    () => trackVideo({ path: "x.mp4", concept: "ball", apiKey: "  ", fetchImpl }),
    /MODEL_API_KEY/,
  );
  assert.equal(called, 0);
});

function mockJsonResponder(bodies, calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const body = bodies[calls.length - 1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: body.__status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function makeTinyVideo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "motionforge-sam-"));
  const file = path.join(dir, "tiny.mp4");
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=red:s=160x120:d=2:r=24",
    "-pix_fmt", "yuv420p", file,
  ], { timeout: 30_000 });
  return file;
}

async function runCli(args, env) {
  return execFileAsync(
    process.execPath,
    ["spike/sam-track.mjs", ...args],
    { cwd: PROJECT_ROOT, env, timeout: 15_000 },
  ).then(
    (result) => ({ code: 0, stdout: String(result.stdout), stderr: String(result.stderr) }),
    (error) => ({ code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }),
  );
}

test("probe accepts a real two-second video", async (t) => {
  const video = await makeTinyVideo(t);
  const probe = await probeVideo(video);
  assert.equal(probe.width, 160);
  assert.equal(probe.height, 120);
  assert.equal(probe.frameCount, 48);
  assert.equal(probe.timestamps[0], 0);
  assert.equal(probe.timestamps[47], 1.958333);
});

test("seeded bridge sends exactly 2 requests, native frame 2, both directions, and retains sparse source frames 0 and 2", async (t) => {
  const video = await makeTinyVideo(t);
  const probe = await probeVideo(video);
  const calls = [];
  const seed = { frameIndex: 2, box: { x1: 10, y1: 10, x2: 50, y2: 40 } };
  const frames = [0, 2].map((index) => wrap(line(index, [
    rec(1, "x1=10;y1=10;x2=50;y2=40;w=160;h=120"),
  ])));
  const events = [
    ...frames.map((delta) => ({ type: "response.output_text.delta", delta })),
    { type: "response.completed", response: { status: "completed", id: "resp-unit-seeded" } },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1
      ? new Response(JSON.stringify({ id: "file-unit-seeded" }), { headers: { "content-type": "application/json" } })
      : new Response(events, { headers: { "content-type": "text/event-stream" } });
  };
  const capture = await trackVideo({ path: video, boxPrompt: seed, apiKey: "test-key", fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.meta.ai/v1/files");
  assert.equal(calls[0].opts.body.get("purpose"), "user_data");
  assert.equal(calls[1].url, "https://api.meta.ai/v1/responses");
  assert.deepEqual(JSON.parse(calls[1].opts.body), {
    model: "sam-3.1", stream: true,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "<2f>1<|box;x1=10;y1=10;x2=50;y2=40;w=160;h=120|>" },
      { type: "input_video", file_id: "file-unit-seeded" },
    ] }],
    metadata: { propagation_direction: "both" },
  });
  assert.equal(capture.provenance.responseId, "resp-unit-seeded");
  assert.deepEqual(capture.tracks.map((track) => track.objectId), ["1"]);
  assert.deepEqual(capture.tracks[0].samples.map(({ frameIndex, t, x, y }) => ({ frameIndex, t, x, y })), [
    { frameIndex: 0, t: probe.timestamps[0], x: 30, y: 25 },
    { frameIndex: 2, t: probe.timestamps[2], x: 30, y: 25 },
  ]);
});

test("3 invalid seeded requests cause 0 fetches; a returned object 2 cannot replace explicitly selected object 1", async (t) => {
  const video = await makeTinyVideo(t);
  const seed = { frameIndex: 2, box: { x1: 10, y1: 10, x2: 50, y2: 40 } };
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error("Unexpected unit transport call"); };
  for (const input of [
    { boxPrompt: { ...seed, frameIndex: 48 } },
    { boxPrompt: { ...seed, box: { ...seed.box, x2: 160 } } },
    { boxPrompt: seed, concept: "square" },
  ]) await assert.rejects(trackVideo({ path: video, apiKey: "test-key", fetchImpl: noFetch, ...input }));
  assert.equal(calls, 0);
  const delta = wrap(line(0, [rec(2, "x1=10;y1=10;x2=50;y2=40;w=160;h=120")]));
  const events = [
    { type: "response.output_text.delta", delta },
    { type: "response.completed", response: { status: "completed", id: "resp-unit-wrong-object" } },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  const fetchImpl = async () => ++calls === 1
    ? new Response(JSON.stringify({ id: "file-unit-wrong-object" }))
    : new Response(events, { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(
    trackVideo({ path: video, boxPrompt: seed, apiKey: "test-key", fetchImpl }), /Unexpected object identity/,
  );
  assert.equal(calls, 2);
});

test("unrecognized response JSON is an error, not zero matches", async (t) => {
  const video = await makeTinyVideo(t);
  const calls = [];
  const fetchImpl = mockJsonResponder([
    { id: "file-1", object: "file", status: "uploaded" },
    { status: "completed", id: "resp-1", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
  ], calls);
  await assert.rejects(
    () => trackVideo({ path: video, concept: "square", apiKey: "test-key", fetchImpl }),
    /output_text/,
  );
});

test("extracts output text from response message content", async (t) => {
  const video = await makeTinyVideo(t);
  const calls = [];
  const text = wrap(line(0, [rec(12, "x1=10;y1=10;x2=50;y2=40;w=160;h=120")]));
  const fetchImpl = mockJsonResponder([
    { id: "file-content", object: "file", status: "uploaded" },
    {
      status: "completed",
      id: "resp-content",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      }],
    },
  ], calls);
  const out = await trackVideo({ path: video, concept: "red square", apiKey: "test-key", fetchImpl });
  assert.deepEqual(out.tracks.map((track) => track.objectId), ["12"]);
});

test("rejects malformed and mixed refusal response lanes", async (t) => {
  const video = await makeTinyVideo(t);
  for (const output of [
    null,
    [{ type: "message", content: [{ type: "output_text", text: null }] }],
    [{ type: "message", content: [
      { type: "output_text", text: "" },
      { type: "refusal", refusal: "no" },
    ] }],
  ]) {
    const fetchImpl = mockJsonResponder([
      { id: "file-malformed" },
      { status: "completed", id: "resp-malformed", output },
    ], []);
    await assert.rejects(
      () => trackVideo({ path: video, concept: "square", apiKey: "test-key", fetchImpl }),
      /output_text/,
    );
  }
});

test("rejects record source dimensions mismatching probed video", async (t) => {
  const video = await makeTinyVideo(t);
  const text = wrap(line(0, [rec(0, "x1=10;y1=10;x2=50;y2=40;w=320;h=334")]));
  const fetchImpl = mockJsonResponder([
    { id: "file-dimensions" },
    { status: "completed", id: "resp-dimensions", output_text: text },
  ], []);
  await assert.rejects(
    () => trackVideo({ path: video, concept: "square", apiKey: "test-key", fetchImpl }),
    /dimensions do not match probed video/,
  );
});

test("provider status failures are sanitized and not retried", async (t) => {
  const video = await makeTinyVideo(t);
  for (const status of [401, 429]) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return new Response(`{"error":"secret detail ${status}"}`, { status });
    };
    await assert.rejects(
      () => trackVideo({ path: video, concept: "square", apiKey: "test-key", fetchImpl }),
      (err) => {
        assert.match(err.message, new RegExp("status " + status));
        assert.doesNotMatch(err.message, /secret detail|test-key/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.redirect, "error");
  }
});

test("transport errors never echo request secrets or provider text", async (t) => {
  const video = await makeTinyVideo(t);
  for (const failingCall of [1, 2]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === failingCall) throw new Error("request failed with test-key and raw provider body");
      return new Response(JSON.stringify({ id: "file-transport" }), { status: 200 });
    };
    await assert.rejects(
      () => trackVideo({ path: video, concept: "square", apiKey: "test-key", fetchImpl }),
      (err) => {
        const operation = failingCall === 1 ? "file upload" : "segmentation request";
        assert.equal(err.message, `${operation} transport failed`);
        assert.doesNotMatch(err.message, /test-key|raw provider body/);
        return true;
      },
    );
    assert.equal(calls, failingCall);
  }
});

test("CLI never prints injected transport exception secrets", async (t) => {
  const video = await makeTinyVideo(t);
  const output = path.join(path.dirname(video), "capture.json");
  const cliPath = path.join(PROJECT_ROOT, "spike/sam-track.mjs");
  const script = `
    globalThis.fetch = async () => { throw new Error("test-key raw provider body"); };
    process.argv = ${JSON.stringify([
      process.execPath, cliPath, "--video", video, "--concept", "square", "--output", output,
    ])};
    await import(${JSON.stringify(new URL("./sam-track.mjs", import.meta.url).href)});
  `;
  await assert.rejects(
    () => execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MODEL_API_KEY: "test-key" },
      timeout: 15_000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /file upload transport failed/);
      assert.doesNotMatch(err.stdout + err.stderr, /test-key|raw provider body/);
      return true;
    },
  );
});

test("request shape targets Meta origin, sam-3.1, non-streamed input", async (t) => {
  const video = await makeTinyVideo(t);
  const probe = await probeVideo(video);
  const calls = [];
  const text = wrap(line(0, [rec(0, "x1=10;y1=10;x2=50;y2=40;w=160;h=120")]));
  const fetchImpl = mockJsonResponder([
    { id: "file-abc", object: "file", status: "uploaded" },
    { status: "completed", id: "resp-9", created_at: 1714502400, output_text: text },
  ], calls);
  const out = await trackVideo({ path: video, concept: "red square", apiKey: "test-key", fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.meta.ai/v1/files");
  assert.equal(calls[1].url, "https://api.meta.ai/v1/responses");
  assert.equal(calls[0].opts.redirect, "error");
  assert.equal(calls[1].opts.redirect, "error");
  assert.match(calls[0].opts.headers.authorization, /^Bearer /);
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.model, "sam-3.1");
  assert.equal(body.stream, false);
  assert.equal(body.input[0].type, "message");
  assert.equal(body.input[0].role, "user");
  assert.deepEqual(body.input[0].content[0], { type: "input_text", text: "red square" });
  assert.deepEqual(body.input[0].content[1], { type: "input_video", file_id: "file-abc" });
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.provenance.kind, "meta-sam-live");
  assert.equal(out.provenance.model, "sam-3.1");
  assert.equal(out.provenance.responseId, "resp-9");
  assert.equal(out.provenance.source.fileId, "file-abc");
  assert.match(out.provenance.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.video.width, probe.width);
  assert.equal(out.video.frameCount, probe.frameCount);
  assert.equal(out.tracks.length, 1);
  const sample = out.tracks[0].samples[0];
  assert.equal(sample.frameIndex, 0);
  assert.equal(sample.t, probe.timestamps[0]);
  assert.equal(sample.x, 30);
  assert.equal(sample.y, 25);
  assert.deepEqual(sample.box, { x1: 10, y1: 10, x2: 50, y2: 40 });
});

test("zero matches yields empty tracks, no fake trajectory", async (t) => {
  const video = await makeTinyVideo(t);
  const calls = [];
  const fetchImpl = mockJsonResponder([
    { id: "file-z", object: "file", status: "uploaded" },
    { status: "completed", id: "resp-z", output_text: "" },
  ], calls);
  const out = await trackVideo({ path: video, concept: "unicorn", apiKey: "test-key", fetchImpl });
  assert.deepEqual(out.tracks, []);
});

test("explicit empty output-text message is zero matches", async (t) => {
  const video = await makeTinyVideo(t);
  const fetchImpl = mockJsonResponder([
    { id: "file-empty", object: "file", status: "uploaded" },
    {
      status: "completed",
      id: "resp-empty",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      }],
    },
  ], []);
  const out = await trackVideo({ path: video, concept: "unicorn", apiKey: "test-key", fetchImpl });
  assert.deepEqual(out.tracks, []);
});

test("CLI fails closed without MODEL_API_KEY with the documented exit code", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "motionforge-cli-"));
  const outFile = path.join(dir, "out.json");
  await writeFile(path.join(dir, "placeholder"), "");
  const env = { ...process.env };
  delete env.MODEL_API_KEY;
  const result = await runCli(
    ["--video", "x.mp4", "--concept", "ball", "--output", outFile],
    env,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /MODEL_API_KEY/);
});

test("CLI rejects unknown and duplicate flags", async () => {
  const env = { ...process.env };
  delete env.MODEL_API_KEY;
  const unknown = await runCli(["--bogus", "value"], env);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown option/);
  const duplicate = await runCli(["--video", "first.mp4", "--video", "second.mp4"], env);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /duplicate option/);
});

test("CLI refuses existing files and symlinks before video or API work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "motionforge-output-"));
  const env = { ...process.env, MODEL_API_KEY: "test-key" };
  const existingFile = path.join(dir, "existing.json");
  await writeFile(existingFile, "preserve");
  const existing = await runCli(
    ["--video", path.join(dir, "missing.mp4"), "--concept", "ball", "--output", existingFile],
    env,
  );
  assert.equal(existing.code, 2);
  assert.match(existing.stderr, /refusing to overwrite/);
  assert.doesNotMatch(existing.stderr, /ffprobe|tracking failed/);
  assert.equal(await readFile(existingFile, "utf8"), "preserve");

  const linkTarget = path.join(dir, "missing-target.json");
  const symlinkOutput = path.join(dir, "output-link.json");
  await symlink(linkTarget, symlinkOutput);
  const linked = await runCli(
    ["--video", path.join(dir, "missing.mp4"), "--concept", "ball", "--output", symlinkOutput],
    env,
  );
  assert.equal(linked.code, 2);
  assert.match(linked.stderr, /refusing to overwrite/);
  assert.doesNotMatch(linked.stderr, /ffprobe|tracking failed/);
});