import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { before, test } from "node:test";
import { promisify } from "node:util";
import { probeVideo } from "../spike/sam-api.mjs";
import { createMotionServer } from "../src/server.mjs";

const execFileAsync = promisify(execFile);
const secret = "testsecret-never-return";
const seed = { frameIndex: 0, box: { x1: 10, y1: 10, x2: 60, y2: 80 } };
const capture = { schemaVersion: 1, provenance: { kind: "injected-test-only" }, tracks: [] };
let scratch;
let fixture;
let bytes;
let probe;

before(async () => {
  scratch = await mkdtemp("/tmp/motionforge-http-test-");
  fixture = path.join(scratch, "fixture.mp4");
  await execFileAsync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30",
    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", fixture,
  ]);
  bytes = await readFile(fixture);
  probe = await probeVideo(fixture);
  assert.equal(probe.frameCount, 60);
  assert.equal(probe.width, 160);
  assert.equal(probe.height, 120);
});

async function start(t, options = {}) {
  const uploadsDir = await mkdtemp(path.join(scratch, "uploads-"));
  const server = createMotionServer({
    apiKey: secret, uploadsDir,
    tracker: async () => { throw new Error("Unexpected test tracker call"); },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const port = server.address().port;
  return { server, uploadsDir, port, origin: `http://127.0.0.1:${port}` };
}

function request(app, target, { method = "GET", headers = {}, body, noHost = false, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const mergedHeaders = { ...(method === "POST" ? { origin: app.origin } : {}), ...headers };
    for (const key of Object.keys(mergedHeaders)) {
      if (mergedHeaders[key] === undefined) delete mergedHeaders[key];
    }
    const req = http.request({
      hostname: "127.0.0.1", port: app.port, path: target, method,
      setHost: !noHost, headers: mergedHeaders,
    }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (chunks) {
      let index = 0;
      const send = () => {
        while (index < chunks.length) {
          if (!req.write(chunks[index++])) {
            req.once("drain", send);
            return;
          }
        }
        req.end();
      };
      send();
    } else req.end(body);
  });
}

function multipart(data = bytes, name = "fixture.mp4", extra = "") {
  const boundary = "motionforge-test-boundary";
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${name}"\r\nContent-Type: video/mp4\r\n\r\n`),
      data, Buffer.from(`\r\n${extra}--${boundary}--\r\n`),
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(app, options = multipart()) {
  return request(app, "/api/videos", { method: "POST", ...options });
}

async function track(app, id, body = seed) {
  return request(app, `/api/videos/${id}/tracks`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function errorContract(response) {
  const codes = {
    400: "BAD_REQUEST", 401: "MODEL_AUTH_FAILED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    409: "TRACKING_BUSY", 413: "PAYLOAD_TOO_LARGE", 422: "INVALID_INPUT", 429: "RATE_LIMITED",
    500: "INTERNAL_ERROR", 502: "TRACKING_FAILED", 503: "TRACKING_UNAVAILABLE",
  };
  const body = response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.equal(typeof body.error.code, "string");
  assert.equal(body.error.code, codes[response.status]);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0);
}

function sanitized(response, ...paths) {
  errorContract(response);
  for (const value of [secret, ...paths]) assert.ok(!response.text.includes(value));
}

test("local HTTP errors return exactly nested stable code and message strings", async (t) => {
  const app = await start(t, { apiKey: "" });
  const { id } = (await upload(app)).json();
  const responses = [
    [400, await upload(app, { body: "broken" })],
    [403, await request(app, "/api/health", { headers: { host: "example.com" } })],
    [404, await request(app, "/unknown")],
    [413, await request(app, `/api/videos/${id}/tracks`, {
      method: "POST", body: " ".repeat(8193), headers: { "content-type": "application/json" },
    })],
    [422, await track(app, id, { ...seed, path: fixture })],
    [503, await track(app, id)],
  ];
  for (const [status, response] of responses) {
    assert.equal(response.status, status);
    sanitized(response, fixture, app.uploadsDir);
  }
});

test("real upload: 201 flat SHA/frame metadata, UUID path, 200 metadata GET, no source GET", async (t) => {
  const app = await start(t, { tracker: async () => { throw new Error("must not run"); } });
  const response = await upload(app, multipart(bytes, "../Human.MP4"));
  assert.equal(response.status, 201);
  const metadata = response.json();
  assert.deepEqual(Object.keys(metadata).sort(), ["id", "name", "sha256", "width", "height", "frameCount", "timestamps"].sort());
  assert.match(metadata.id, /^[a-f0-9-]{36}$/);
  assert.equal(metadata.name, "Human.MP4");
  assert.equal(metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
  for (const field of ["width", "height", "frameCount", "timestamps"]) assert.deepEqual(metadata[field], probe[field]);
  assert.equal(response.headers.location, `/api/videos/${metadata.id}`);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const get = await request(app, response.headers.location);
  assert.equal(get.status, 200);
  assert.deepEqual(get.json(), metadata);
  assert.deepEqual(await readdir(app.uploadsDir), [`${metadata.id}.mp4`]);
  assert.deepEqual(await readFile(path.join(app.uploadsDir, `${metadata.id}.mp4`)), bytes);
  assert.equal((await request(app, `/uploads/${metadata.id}.mp4`)).status, 404);
  assert.equal((await upload(app, multipart(bytes, "clip.MOV"))).status, 201);
});

test("multipart: 25MiB file cap, 26MiB actual streamed cap and Content-Length upfront", async (t) => {
  const app = await start(t);
  const padding = Buffer.alloc(25 * 1024 * 1024 - bytes.length);
  padding.writeUInt32BE(padding.length, 0);
  padding.write("free", 4);
  assert.equal((await upload(app, multipart(Buffer.concat([bytes, padding])))).status, 201);
  const tooLarge = multipart(Buffer.alloc(25 * 1024 * 1024 + 1));
  assert.equal((await upload(app, tooLarge)).status, 413);
  const chunk = Buffer.alloc(1024 * 1024, 97);
  const streamed = await upload(app, {
    headers: { "content-type": "multipart/form-data; boundary=x" },
    chunks: [...Array(26).fill(chunk), Buffer.from("x")],
  });
  assert.equal(streamed.status, 413);
  const upfront = await upload(app, {
    headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(26 * 1024 * 1024 + 1) },
  });
  assert.equal(upfront.status, 413);
  assert.equal((await readdir(app.uploadsDir)).length, 1);
});

test("multipart: malformed 400; wrong extension, empty, duplicate and unknown fields 422", async (t) => {
  const app = await start(t);
  assert.equal((await upload(app, { body: "broken", headers: { "content-type": "multipart/form-data; boundary=x" } })).status, 400);
  assert.equal((await upload(app, { body: "broken" })).status, 400);
  assert.equal((await upload(app, multipart(bytes, "clip.webm"))).status, 422);
  assert.equal((await upload(app, multipart(Buffer.alloc(0)))).status, 422);
  for (const field of ["path", "url", "apiKey", "model", "other", "video"]) {
    const extra = `--motionforge-test-boundary\r\nContent-Disposition: form-data; name="${field}"\r\n\r\nforbidden\r\n`;
    assert.equal((await upload(app, multipart(bytes, "clip.mp4", extra))).status, 422);
  }
  const invalid = await upload(app, multipart(Buffer.from(`invalid ${secret} ${app.uploadsDir}`)));
  assert.equal(invalid.status, 422);
  sanitized(invalid, app.uploadsDir);
});

test("Host and Origin exactness: external Host 403, absent Host 400, missing/null/external Origin 403", async (t) => {
  const app = await start(t);
  for (const host of ["example.com", "127.0.0.1", `localhost:${app.port + 1}`, `127.0.0.1:${app.port}.evil`]) {
    assert.equal((await request(app, "/api/health", { headers: { host } })).status, 403);
  }
  assert.equal((await request(app, "/api/health", { noHost: true })).status, 400);
  for (const origin of [undefined, "", "null", "https://example.com", `${app.origin}/`, `http://localhost:${app.port + 1}`]) {
    const headers = { "content-type": "application/json", origin };
    assert.equal((await request(app, "/api/videos", { method: "POST", headers })).status, 403);
  }
  for (const origin of [app.origin, `http://localhost:${app.port}`]) {
    assert.equal((await upload(app, { ...multipart(), headers: { ...multipart().headers, origin } })).status, 201);
  }
  const health = await request(app, "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { modelConfigured: true, trackingAvailable: true });
  assert.equal(health.headers["access-control-allow-origin"], undefined);
});

test("explicit origins accept literal loopback only, exactly matched including Host", async (t) => {
  for (const origin of [
    "https://127.0.0.1:4000", "http://example.com:4000", "http://127.1:4000",
    "http://2130706433:4000", "http://[::1]:4000", "http://user@localhost:4000",
    "http://localhost:4000/", "http://localhost:4000?q=1", "http://localhost:4000#x",
    "http://localhost", "http://LOCALHOST:4000", "http://localhost:04000",
  ]) assert.throws(() => createMotionServer({ apiKey: "", allowedOrigins: [origin] }));
  const app = await start(t, { allowedOrigins: ["http://localhost:54633"] });
  const response = await request(app, "/api/videos", {
    method: "POST", ...multipart(),
    headers: { ...multipart().headers, host: "localhost:54633", origin: "http://localhost:54633" },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:54633");
  const missing = await request(app, "/api/videos", { method: "POST", headers: { origin: undefined } });
  assert.equal(missing.status, 403);
});

test("track input: malformed JSON 400, >8KiB 413, exact keys/source bounds 422, zero tracker calls", async (t) => {
  let calls = 0;
  const app = await start(t, { tracker: async () => { calls += 1; return capture; } });
  const { id } = (await upload(app)).json();
  for (const body of ["{", "", "not-json"]) {
    assert.equal((await request(app, `/api/videos/${id}/tracks`, {
      method: "POST", body, headers: { "content-type": "application/json" },
    })).status, 400);
  }
  assert.equal((await request(app, `/api/videos/${id}/tracks`, {
    method: "POST", body: " ".repeat(8193), headers: { "content-type": "application/json" },
  })).status, 413);
  assert.equal((await request(app, `/api/videos/${id}/tracks`, {
    method: "POST", chunks: [Buffer.alloc(8192, 32), Buffer.from(" ")],
    headers: { "content-type": "application/json" },
  })).status, 413);
  const invalid = [
    null, [], {}, { ...seed, frameIndex: -1 }, { ...seed, frameIndex: 60 },
    { ...seed, frameIndex: 0.5 }, { ...seed, box: null },
    ...["path", "file", "apiKey", "key", "model", "url", "concept"].map((field) => ({ ...seed, [field]: "/secret" })),
    ...[
      { x1: -1 }, { y1: -1 }, { x2: 160 }, { y2: 120 }, { x2: 10 },
      { y2: 10 }, { x1: 1.5 }, { x1: "10" }, { path: "/secret" },
    ].map((box) => ({ ...seed, box: { ...seed.box, ...box } })),
  ];
  for (const body of invalid) assert.equal((await track(app, id, body)).status, 422);
  assert.equal(calls, 0);
});

test("missing key: 503 and zero tracker calls; safe health", async (t) => {
  let calls = 0;
  const app = await start(t, { apiKey: "", tracker: async () => { calls += 1; return capture; } });
  const { id } = (await upload(app)).json();
  assert.equal((await track(app, id)).status, 503);
  assert.equal(calls, 0);
  assert.deepEqual((await request(app, "/api/health")).json(), { modelConfigured: false, trackingAvailable: false });
});

test("tracking: handler-only capture unchanged, exact path/prompt/key, cache and global 409", async (t) => {
  const calls = [];
  let finish;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const app = await start(t, { tracker: async (args) => {
    calls.push(args);
    entered();
    await new Promise((resolve) => { finish = resolve; });
    return capture;
  } });
  const { id } = (await upload(app)).json();
  const second = (await upload(app)).json();
  const pending = track(app, id);
  await started;
  const busy = await track(app, second.id);
  assert.equal(busy.status, 409);
  sanitized(busy, fixture, app.uploadsDir);
  assert.equal((await track(app, id)).status, 409);
  finish();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), capture);
  assert.deepEqual(calls, [{ path: path.join(app.uploadsDir, `${id}.mp4`), boxPrompt: seed, apiKey: secret }]);
  const cached = await track(app, id, { box: { y2: 80, x2: 60, y1: 10, x1: 10 }, frameIndex: 0 });
  assert.equal(cached.status, 200);
  assert.deepEqual(cached.json(), capture);
  assert.equal(calls.length, 1);
});

test("budget: three trackers reserve six provider requests/minute; next returns 429", async (t) => {
  let calls = 0;
  const app = await start(t, { tracker: async () => { calls += 1; return capture; } });
  const { id } = (await upload(app)).json();
  for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
    assert.equal((await track(app, id, { ...seed, frameIndex })).status, 200);
  }
  const limited = await track(app, id, { ...seed, frameIndex: 3 });
  assert.equal(limited.status, 429);
  sanitized(limited, fixture, app.uploadsDir);
  assert.equal(calls, 3);
  assert.equal((await track(app, id)).status, 200);
  assert.equal(calls, 3);
});

test("cache distinguishes video, frame and box coordinates", async (t) => {
  let calls = 0;
  const app = await start(t, { tracker: async () => { calls += 1; return capture; } });
  const { id } = (await upload(app)).json();
  const other = (await upload(app)).json();
  assert.equal((await track(app, id)).status, 200);
  assert.equal((await track(app, id, { ...seed, box: { ...seed.box, x1: 11 } })).status, 200);
  assert.equal((await track(app, other.id)).status, 200);
  assert.equal(calls, 3);
});

for (const status of [401, 403, 429]) {
  test(`upstream ${status}: no retry, disabled until restart, sanitized`, async (t) => {
    let calls = 0;
    const app = await start(t, { tracker: async () => {
      calls += 1;
      throw Object.assign(new Error(`${secret} ${fixture}`), { status });
    } });
    const { id } = (await upload(app)).json();
    const first = await track(app, id);
    assert.equal(first.status, status);
    sanitized(first, fixture, app.uploadsDir);
    assert.equal((await track(app, id)).status, 503);
    assert.equal(calls, 1);
    assert.deepEqual((await request(app, "/api/health")).json(), { modelConfigured: true, trackingAvailable: false });
  });
}

test("upstream and filesystem failures never expose messages, paths or key", async (t) => {
  const app = await start(t, { tracker: async () => { throw new Error(`${secret} ${fixture}`); } });
  const { id } = (await upload(app)).json();
  const failed = await track(app, id);
  assert.equal(failed.status, 502);
  sanitized(failed, fixture, app.uploadsDir);
  const blocker = path.join(scratch, "not-a-directory");
  await writeFile(blocker, secret, { flag: "wx" });
  const broken = await start(t, { uploadsDir: blocker });
  const diskFailure = await upload(broken);
  assert.equal(diskFailure.status, 500);
  sanitized(diskFailure, blocker, scratch);
});

test("static exact allowlist: existing modules/fonts 200+HEAD; private/unknown routes 404", async (t) => {
  const app = await start(t);
  for (const target of [
    "/src/motion-fit.mjs", "/src/export-spring.mjs", "/src/video-frame.mjs",
    "/spike/viewer-state.mjs", "/fonts/GeistSans.woff2", "/fonts/GeistSans-Semibold.woff2",
    "/fonts/GeistMono.woff2", "/fonts/OFL.txt",
  ]) {
    const response = await request(app, target);
    assert.equal(response.status, 200, target);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    const head = await request(app, target, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal((await request(app, target, { method: "POST" })).status, 404);
  }
  for (const target of [
    "/src/server.mjs", "/.env", "/.env.local", "/.git/config", "/results/anything",
    "/uploads/anything", "/spike/sam-api.mjs", "/package.json", "/unknown", "/../src/server.mjs",
    "/%2e%2e/src/server.mjs", "/src%2fmotion-fit.mjs", "/src/motion-fit.mjs?x=1",
    "/api/videos/not-a-uuid", "/api/videos/11111111-1111-4111-8111-111111111111",
  ]) assert.equal((await request(app, target)).status, 404, target);
});

for (const [target, file] of [
  ["/", "index.html"], ["/app.mjs", "app.mjs"], ["/styles.css", "styles.css"], ["/favicon.svg", "favicon.svg"],
]) {
  test(`frontend static ${target}: exact bytes and 200 GET/HEAD`, async (t) => {
    const expected = await readFile(new URL(`../web/${file}`, import.meta.url));
    const app = await start(t);
    const response = await request(app, target);
    assert.equal(response.status, 200);
    assert.equal(response.text, expected.toString());
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    const head = await request(app, target, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
  });
}
