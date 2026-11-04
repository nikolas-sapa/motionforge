import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createProductApp, contentRect, sourcePoint, sourceBox, releaseVelocity } from '../web/app.mjs';
import { exportSpring } from '../src/export-spring.mjs';
import { springState } from '../src/motion-fit.mjs';
import { seekTimeForFrame } from '../src/video-frame.mjs';

const unitFile = () => new File(['explicit unit-only video bytes, not footage'], 'unit-only.mp4', { type: 'video/mp4' });
const unitHash = createHash('sha256').update('explicit unit-only video bytes, not footage').digest('hex');
const unitMetadata = () => ({
  id: 'unit-video', name: 'unit-only.mp4', sha256: unitHash,
  width: 320, height: 240, frameCount: 3, timestamps: [0, 0.041, 0.097],
});
const unitCapture = () => ({
  schemaVersion: 1,
  provenance: {
    kind: 'meta-sam-live', model: 'sam-3.1', responseId: 'unit-only-not-live',
    measurement: 'bounding-box-center',
    source: { name: 'unit-only.mp4', fileId: 'unit-only', sha256: unitHash },
  },
  video: { width: 320, height: 240, frameCount: 3, timestamps: [0, 0.041, 0.097] },
  tracks: [{
    objectId: 'unit-object',
    samples: [{ frameIndex: 0, t: 0, x: 20, y: 30, box: { x1: 10, y1: 20, x2: 30, y2: 40 } }],
  }],
});
const captureFile = (doc) => new File([JSON.stringify(doc)], 'unit-only-capture.json', { type: 'application/json' });
const handlerOnlyFit = () => ({
  status: 'fitted', axis: 'x',
  parameters: { decay: 0.4, omega: 3, offset: 20, a: 1, b: 0, t0: 0, frequencyHz: 3 / (2 * Math.PI) },
  metrics: { trainNrmse: 0.01, holdoutNrmse: 0.02 },
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function harness(transport, { reducedMotion = false } = {}) {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const elements = new Map();
  const frames = new Map();
  const videoFrames = new Map();
  const objects = new Map();
  const revoked = [];
  const downloads = [];
  const requests = [];
  let clock = 0;
  let nextId = 0;
  function element(tag = '') {
    const listeners = new Map();
    const attrs = new Map();
    const classes = new Set();
    const drawing = { boxes: 0, points: 0 };
    const ctx = {
      setTransform() {}, clearRect() { drawing.boxes = 0; drawing.points = 0; },
      strokeRect() { drawing.boxes++; }, arc() { drawing.points++; },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillRect() {}, fillText() {},
    };
    return {
      tag, listeners, drawing, disabled: false, hidden: false, value: '', textContent: '',
      files: [], children: [], dataset: {}, width: 1000, height: 240, clientWidth: 640, clientHeight: 480,
      style: { setProperty(name, value) { this[name] = value; } },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
      paused: true, seeking: false, readyState: 0, currentSrc: '', src: '', currentTime: 0,
      videoWidth: 0, videoHeight: 0, duration: 1,
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name) { listeners.delete(name); },
      async fire(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name); },
      removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; this.value = ''; },
      remove() { document.body.children = document.body.children.filter((child) => child !== this); },
      click() { if (tag === 'a') downloads.push({ name: this.download, blob: objects.get(this.href), url: this.href }); },
      focus() {},
      getContext() { return ctx; },
      getBoundingClientRect() { return { x: 10, y: 20, left: 10, top: 20, width: 640, height: 480 }; },
      setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
      pause() { this.paused = true; },
      async play() { this.paused = false; },
      load() { this.readyState = 0; },
      requestVideoFrameCallback(fn) { videoFrames.set(++nextId, fn); return nextId; },
      cancelVideoFrameCallback(id) { videoFrames.delete(id); },
    };
  }
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = element();
    el.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    el.hidden = /\shidden(?:\s|>)/.test(match[0]);
    elements.set(match[1], el);
  }
  const tabs = ['dot', 'button', 'toast'].map((name) => {
    const tab = element('button');
    tab.dataset.targetTab = name;
    return tab;
  });
  const document = {
    body: element('body'), getElementById: (id) => {
      assert.ok(elements.has(id), 'HTML must contain #' + id);
      return elements.get(id);
    },
    createElement: element,
    querySelectorAll: () => tabs,
  };
  const platform = {
    crypto: webcrypto, Blob, File, FormData, AbortController, devicePixelRatio: 2,
    performance: { now: () => clock },
    navigator: { clipboard: { writeText: async (text) => { platform.copied = text; } } },
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener() {},
    URL: {
      createObjectURL(value) { const url = 'blob:unit-' + ++nextId; objects.set(url, value); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (transport) return transport(url, options);
      return { ok: true, json: async () => url === '/api/health'
        ? { modelConfigured: false, trackingAvailable: false } : unitMetadata() };
    },
  };
  const app = createProductApp(document, platform);
  await app.ready;
  const get = (id) => document.getElementById(id);
  function metadata() {
    Object.assign(get('video'), { currentSrc: app.state.videoUrl, readyState: 2, videoWidth: 320, videoHeight: 240 });
    get('video').onloadedmetadata();
  }
  function present(mediaTime) {
    const callbacks = [...videoFrames.values()];
    videoFrames.clear();
    for (const fn of callbacks) fn(clock, { mediaTime });
  }
  async function readyCapture() {
    await app.loadVideo(unitFile());
    metadata();
    await app.importCapture(captureFile(unitCapture()));
    present(0);
  }
  return { app, get, tabs, platform, frames, videoFrames, downloads, requests, revoked,
    metadata, present, readyCapture, tick: (time) => { clock = time; } };
}

function assertBlocked(h) {
  for (const id of ['runbtn', 'stopbtn', 'exportbtn', 'copybtn']) assert.equal(h.get(id).disabled, true, id);
  assert.equal(h.app.state.fit, null);
  assert.equal(h.frames.size, 0);
  assert.equal(h.get('overlay').drawing.boxes, 0);
  assert.equal(h.get('chart').drawing.points, 0);
}

test('native structure uses 3 real font faces, 2 preloads, no framework or fabricated default data', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.equal((css.match(/@font-face/g) || []).length, 3);
  assert.ok((html.match(/rel="preload"/g) || []).length >= 2);
  assert.match(html, /Motion, sampled\./);
  assert.match(html, /https:\/\/github.com\/nikolas-sapa\/motionforge/);
  assert.doesNotMatch(source, /innerHTML|eval\(|new Function|synthetic|Math\.sin/);
  assert.doesNotMatch(html, /<video[^>]*\scontrols/);
});

test('initial state and unavailable health permit 0 tracking, downloads or animation frames', async () => {
  const h = await harness();
  assertBlocked(h);
  assert.equal(h.get('trackbtn').disabled, true);
  await h.get('trackbtn').fire('click');
  await h.get('exportbtn').fire('click');
  await h.get('runbtn').fire('click');
  assert.equal(h.requests.filter((request) => request.options.method === 'POST').length, 0);
  assert.equal(h.downloads.length, 0);
  assertBlocked(h);
});

test('local upload uses exactly 1 actual File field named video and no client credentials', async () => {
  const h = await harness();
  await h.app.loadVideo(unitFile());
  const request = h.requests.find((entry) => entry.options.method === 'POST');
  assert.equal(request.url, '/api/videos');
  const entries = [...request.options.body.entries()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], 'video');
  assert.ok(entries[0][1] instanceof File);
  assert.equal(entries[0][1].name, 'unit-only.mp4');
  assert.equal(request.options.headers, undefined);
});

test('oversize 25MiB+1, empty and wrong-extension unit files cause 0 reads, 0 digests and 0 POSTs', async () => {
  for (const [name, size, message] of [
    ['unit-only.mp4', 25 * 1024 * 1024 + 1, /exceeds 25 MiB/],
    ['unit-only.mov', 0, /empty/],
    ['unit-only.webm', 10, /extension.*MP4 or MOV/],
  ]) {
    const h = await harness();
    let reads = 0;
    let digests = 0;
    h.platform.crypto = { subtle: { digest: async () => { digests++; return new ArrayBuffer(32); } } };
    await h.app.loadVideo({ name, size, arrayBuffer: async () => { reads++; return new ArrayBuffer(1); } });
    assert.equal(reads, 0, name);
    assert.equal(digests, 0, name);
    assert.equal(h.requests.filter((request) => request.options.method === 'POST').length, 0);
    assert.match(h.get('status').textContent, message);
    const sticky = h.get('status').textContent;
    h.app.gate();
    await h.get('video').fire('timeupdate');
    assert.equal(h.get('status').textContent, sticky);
    assertBlocked(h);
  }
});

test('upload422 structured unsupported-clip message survives gate/time/seek with exactly 1 POST and 0 retries', async () => {
  const message = 'Unsupported clip: duration must be between 2 and 10 seconds.';
  const h = await harness(async (url) => url === '/api/health'
    ? { ok: true, json: async () => ({ modelConfigured: false, trackingAvailable: false }) }
    : { ok: false, status: 422, json: async () => ({ error: { code: 'UNSUPPORTED_CLIP', message } }) });
  await h.app.loadVideo(unitFile());
  assert.equal(h.get('status').textContent, message);
  h.app.gate();
  await h.get('video').fire('timeupdate');
  await h.get('video').fire('seeked');
  assert.equal(h.get('status').textContent, message);
  assert.equal(h.requests.filter((request) => request.options.method === 'POST').length, 1);
  assertBlocked(h);
});

test('upload validator and JSON parse details survive, while 1 transport exception uses generic fallback without private text', async () => {
  for (const [response, expected] of [
    [{ ok: true, json: async () => ({ ...unitMetadata(), sha256: '0'.repeat(64) }) }, /metadata did not match the source video/],
    [{ ok: true, json: async () => { throw new SyntaxError('Unit response JSON is malformed.'); } }, /Unit response JSON is malformed/],
    [null, /Local upload unavailable/],
  ]) {
    const h = await harness(async (url) => {
      if (url === '/api/health') return { ok: true, json: async () => ({ modelConfigured: false, trackingAvailable: false }) };
      if (!response) throw new Error('UNIT_TRANSPORT_PRIVATE_MARKER');
      return response;
    });
    await h.app.loadVideo(unitFile());
    assert.match(h.get('status').textContent, expected);
    assert.doesNotMatch(h.get('status').textContent, /UNIT_TRANSPORT_PRIVATE_MARKER/);
    assert.equal(h.requests.filter((request) => request.options.method === 'POST').length, 1);
    assertBlocked(h);
  }
});

test('tracking401/429 sanitized messages remain sticky, refresh health exactly once, and cause 0 POST retries', async () => {
  for (const [statusCode, message] of [
    [401, 'Tracking authorization failed. Restart after checking server configuration.'],
    [429, 'Tracking rate limit reached. No retry was sent.'],
  ]) {
    let healthReads = 0;
    const h = await harness(async (url) => {
      if (url === '/api/health') {
        healthReads++;
        return { ok: true, json: async () => ({ modelConfigured: true, trackingAvailable: healthReads === 1 }) };
      }
      if (url.endsWith('/tracks')) return { ok: false, status: statusCode, json: async () => ({ error: { code: 'TRACKING_BLOCKED', message } }) };
      return { ok: true, json: async () => unitMetadata() };
    });
    await h.app.loadVideo(unitFile());
    h.metadata();
    h.present(0.041);
    await h.get('overlay').fire('pointerdown', { pointerId: 1, clientX: 50, clientY: 80 });
    await h.get('overlay').fire('pointerup', { pointerId: 1, clientX: 150, clientY: 180 });
    await h.get('trackbtn').fire('click');
    assert.equal(h.get('status').textContent, message);
    assert.equal(healthReads, 2);
    assert.deepEqual(h.app.state.health, { modelConfigured: true, trackingAvailable: false });
    assert.match(h.get('healthstatus').textContent, /blocked|restart/i);
    assert.equal(h.get('trackbtn').disabled, true);
    h.app.gate();
    await h.get('video').fire('timeupdate');
    await h.get('trackbtn').fire('click');
    assert.equal(h.get('status').textContent, message);
    assert.equal(h.requests.filter((request) => request.url.endsWith('/tracks')).length, 1);
    assertBlocked(h);
  }
});

test('unconfigured health explains MODEL_API_KEY configuration with 0 credential reads or tracking POSTs', async () => {
  const h = await harness();
  assert.match(h.get('healthstatus').textContent, /MODEL_API_KEY/);
  assert.equal(h.get('trackbtn').disabled, true);
  assert.equal(h.requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('same video and invalid capture can each be selected twice: 2 uploads, 2 JSON reads, input values reset after File capture', async () => {
  const h = await harness();
  const videoInput = h.get('videofile');
  const captureInput = h.get('capturefile');
  for (const input of [videoInput, captureInput]) {
    let value = '';
    Object.defineProperty(input, 'value', {
      get: () => value,
      set: (next) => { value = next; if (next === '') input.files = []; },
    });
  }
  const sameVideo = unitFile();
  for (let count = 0; count < 2; count++) {
    videoInput.files = [sameVideo];
    videoInput.value = 'unit-only.mp4';
    const pending = videoInput.fire('change');
    assert.equal(videoInput.value, '');
    await pending;
    assert.equal(h.app.state.file, sameVideo);
  }
  assert.equal(h.requests.filter((request) => request.url === '/api/videos').length, 2);
  let reads = 0;
  const sameInvalid = { text: async () => { reads++; return '{"schemaVersion":0}'; } };
  for (let count = 0; count < 2; count++) {
    captureInput.files = [sameInvalid];
    captureInput.value = 'unit-invalid.json';
    const pending = captureInput.fire('change');
    assert.equal(captureInput.value, '');
    await pending;
    assert.match(h.get('status').textContent, /Unsupported schemaVersion/);
  }
  assert.equal(reads, 2);
  assertBlocked(h);
});

test('letterboxed and DPR-independent source coordinates are within 1px; clamped integer boxes need 4px', () => {
  const rect = contentRect({ left: 10, top: 20, width: 640, height: 640 }, 320, 240);
  assert.deepEqual(rect, { left: 10, top: 100, width: 640, height: 480, scale: 2 });
  assert.deepEqual(sourcePoint(308, 408, rect, 320, 240), { x: 149, y: 154 });
  assert.deepEqual(sourcePoint(-100, 9999, rect, 320, 240), { x: 0, y: 239 });
  assert.deepEqual(sourceBox({ x: 200, y: 180 }, { x: 149, y: 154 }), { x1: 149, y1: 154, x2: 200, y2: 180 });
  assert.equal(sourceBox({ x: 4, y: 4 }, { x: 7, y: 12 }), null);
});

test('source slider uses real PTS helper; frame 2 remains unavailable until actual presented metadata says frame 2', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.seekFrame(2);
  assert.equal(h.get('video').currentTime, seekTimeForFrame([0, 0.041, 0.097], 2, 1));
  assert.equal(h.app.state.frameReady, false);
  await h.get('video').fire('seeked');
  assert.equal(h.app.state.frameReady, false);
  h.present(0.041);
  assert.equal(h.app.state.presentedIndex, 1);
  assert.equal(h.app.state.frameReady, false);
  h.present(0.097);
  assert.equal(h.app.state.presentedIndex, 2);
  assert.equal(h.app.state.frameReady, true);
});

test('invalid schema and incorrect hash forced pointer/key/export/RAF events yield 0 downloads and 0 RAFs; errors persist', async () => {
  const h = await harness();
  await h.readyCapture();
  for (const doc of [{ schemaVersion: 0 }, { ...unitCapture(), provenance: { ...unitCapture().provenance, source: { ...unitCapture().provenance.source, sha256: '0'.repeat(64) } } }]) {
    await h.app.importCapture(captureFile(doc));
    const error = h.get('status').textContent;
    assert.match(error, /schemaVersion|SHA256/);
    for (const id of ['playbtn', 'frameslider', 'trackbtn', 'trackselect']) assert.equal(h.get(id).disabled, true, id);
    await h.get('playbtn').fire('click');
    await h.get('trackbtn').fire('click');
    h.get('trackselect').value = 'unit-object';
    await h.get('trackselect').fire('change');
    await h.get('runbtn').fire('click');
    await h.get('target').fire('pointerdown', { pointerId: 1, clientX: 100 });
    await h.get('target').fire('keydown', { key: 'Enter' });
    await h.get('exportbtn').fire('click');
    h.app.renderOverlay();
    h.app.renderChart();
    assert.equal(h.get('status').textContent, error);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.get('video').paused, true);
    assert.equal(h.requests.filter((request) => request.url.endsWith('/tracks')).length, 0);
    assertBlocked(h);
  }
});

test('one-sample unit capture uses real rejection path and permits 0 exports or RAFs', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.selectTrack('unit-object');
  assert.match(h.get('fitstatus').textContent, /rejected/i);
  await h.get('exportbtn').fire('click');
  await h.get('runbtn').fire('click');
  assert.equal(h.app.state.fit, null);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.frames.size, 0);
});

test('source replacement aborts and discards old upload and old JSON, binding 0 stale results to new file', async () => {
  const oldUpload = deferred();
  let uploads = 0;
  const h = await harness(async (url) => {
    if (url === '/api/health') return { ok: true, json: async () => ({ modelConfigured: false, trackingAvailable: false }) };
    if (++uploads === 1) return oldUpload.promise;
    return { ok: true, json: async () => unitMetadata() };
  });
  const first = h.app.loadVideo(unitFile());
  while (uploads === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  const oldJSON = deferred();
  const oldImport = h.app.importCapture({ text: () => oldJSON.promise });
  await h.app.loadVideo(unitFile());
  h.metadata();
  const firstRequest = h.requests.find((request) => request.options.method === 'POST');
  assert.equal(firstRequest.options.signal.aborted, true);
  oldUpload.resolve({ ok: true, json: async () => ({ ...unitMetadata(), id: 'stale' }) });
  oldJSON.resolve(JSON.stringify(unitCapture()));
  await Promise.all([first, oldImport]);
  assert.equal(h.app.state.upload.id, 'unit-video');
  assert.equal(h.app.state.result, null);
  assertBlocked(h);
});

test('track request has exactly frameIndex and integer box; changing ROI discards 1 stale tracking result', async () => {
  const tracked = deferred();
  const h = await harness(async (url) => ({
    ok: true, json: async () => url === '/api/health'
      ? { modelConfigured: true, trackingAvailable: true }
      : url.endsWith('/tracks') ? tracked.promise : unitMetadata(),
  }));
  await h.app.loadVideo(unitFile());
  h.metadata();
  h.present(0.041);
  await h.get('overlay').fire('pointerdown', { pointerId: 1, clientX: 50, clientY: 80 });
  await h.get('overlay').fire('pointermove', { pointerId: 1, clientX: 150, clientY: 180 });
  await h.get('overlay').fire('pointerup', { pointerId: 1, clientX: 150, clientY: 180 });
  const pending = h.get('trackbtn').fire('click');
  while (!h.requests.some((request) => request.url.endsWith('/tracks'))) await Promise.resolve();
  const request = h.requests.find((item) => item.url.endsWith('/tracks'));
  assert.deepEqual(JSON.parse(request.options.body), { frameIndex: 1, box: { x1: 20, y1: 30, x2: 70, y2: 80 } });
  await h.get('overlay').fire('pointerdown', { pointerId: 2, clientX: 80, clientY: 90 });
  assert.equal(request.options.signal.aborted, true);
  tracked.resolve(unitCapture());
  await pending;
  assert.equal(h.app.state.result, null);
  assert.equal(h.app.state.fit, null);
});

test('view-only unit fit clamps a 14.8ms-early RAF timestamp and advances after 100ms', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.state.fit = handlerOnlyFit();
  h.tick(1000);
  h.app.startSimulation(80, 0);
  const first = [...h.frames.values()][0];
  h.frames.clear();
  assert.doesNotThrow(() => first(985.2));
  assert.equal(h.app.state.sim.position, 80);
  assert.equal(h.app.state.sim.velocity, 0);
  assert.equal(h.frames.size, 1);
  const next = [...h.frames.values()][0];
  h.frames.clear();
  h.tick(1100);
  next(1100);
  assert.equal(h.app.state.sim.position, springState(h.app.state.fit.parameters, 0.1, { position: 80, velocity: 0 }).position);
  assert.equal(h.frames.size, 1);
});

test('view-only accepted state uses real springState: 1 RAF, paused source, Stop freezes exactly, targets do not change parameters', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.state.fit = handlerOnlyFit();
  const parameters = h.app.state.fit.parameters;
  h.get('video').currentTime = 0.041;
  h.app.startSimulation(80, 0);
  h.app.startSimulation(80, 0);
  assert.equal(h.frames.size, 1);
  const callback = [...h.frames.values()][0];
  h.frames.clear();
  h.tick(1000);
  callback(1000);
  assert.equal(h.app.state.sim.position, springState(parameters, 1, { position: 80, velocity: 0 }).position);
  assert.equal(h.get('video').paused, true);
  assert.equal(h.get('video').currentTime, 0.041);
  const position = h.app.state.sim.position;
  h.app.stopSimulation();
  assert.equal(h.frames.size, 0);
  assert.equal(h.app.state.sim.position, position);
  h.app.changeTarget('toast');
  assert.equal(h.app.state.fit.parameters, parameters);
  assert.equal(h.app.state.sim.position, position);
});

test('rendered spring pose equals the exported model beyond 160px, without flattening the oscillation', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.state.fit = handlerOnlyFit();
  h.app.startSimulation(80, 500);
  const callback = [...h.frames.values()][0];
  h.frames.clear();
  h.tick(400);
  callback(400);
  const expected = springState(h.app.state.fit.parameters, 0.4, { position: 80, velocity: 500 }).position;
  assert.ok(expected > 160);
  const shown = Number(h.get('target').style.transform.match(/translate3d\(([-\d.e+]+)px/)[1]);
  assert.equal(shown, expected);
  assert.equal(h.app.state.sim.position, expected);
});

test('pointer grab offset causes 0px jump, release velocity uses 80ms history, >=100ms stationary means 0px/s', async () => {
  assert.equal(releaseVelocity([{ time: 0, position: 0 }, { time: 40, position: 20 }, { time: 80, position: 40 }], 80, 80), 500);
  assert.equal(releaseVelocity([{ time: 0, position: 0 }, { time: 80, position: 40 }], 180, 80), 0);
  const h = await harness();
  await h.readyCapture();
  h.app.state.fit = handlerOnlyFit();
  h.app.state.sim.position = 40;
  await h.get('target').fire('pointerdown', { pointerId: 1, clientX: 380 });
  await h.get('target').fire('pointermove', { pointerId: 1, clientX: 380 });
  assert.equal(h.app.state.sim.position, 40);
});

test('pointer handoff preserves 500px/s velocity in real spring initial conditions; reduced motion schedules 0 automatic RAFs', async () => {
  for (const reducedMotion of [false, true]) {
    const h = await harness(undefined, { reducedMotion });
    await h.readyCapture();
    h.app.state.fit = handlerOnlyFit();
    h.app.state.sim.position = 40;
    await h.get('target').fire('pointerdown', { pointerId: 1, clientX: 380 });
    h.tick(40);
    await h.get('target').fire('pointermove', { pointerId: 1, clientX: 400 });
    h.tick(80);
    await h.get('target').fire('pointermove', { pointerId: 1, clientX: 420 });
    await h.get('target').fire('pointerup', { pointerId: 1, clientX: 420 });
    if (reducedMotion) {
      assert.equal(h.frames.size, 0);
      assert.equal(h.app.state.sim.pending.velocity, 500);
      await h.get('runbtn').fire('click');
    }
    assert.equal(h.frames.size, 1);
    assert.equal(h.app.state.sim.initialPosition, 80);
    assert.equal(h.app.state.sim.initialVelocity, 500);
  }
});

test('valid empty unit capture displays No objects found with 0 exports and 0 RAFs', async () => {
  const h = await harness();
  await h.readyCapture();
  const empty = unitCapture();
  empty.tracks = [];
  await h.app.importCapture(captureFile(empty));
  assert.match(h.get('status').textContent, /No objects found/);
  await h.get('exportbtn').fire('click');
  await h.get('runbtn').fire('click');
  assert.equal(h.downloads.length, 0);
  assertBlocked(h);
});

test('view-only accepted state exports exact real generator for current parameters; invalidation clears code and blocks stale export', async () => {
  const h = await harness();
  await h.readyCapture();
  h.app.state.fit = handlerOnlyFit();
  await h.get('exportbtn').fire('click');
  assert.equal(h.downloads.length, 1);
  assert.equal(await h.downloads[0].blob.text(), exportSpring(h.app.state.fit));
  assert.ok(h.revoked.includes(h.downloads[0].url));
  h.app.state.videoHash = '0'.repeat(64);
  await h.get('exportbtn').fire('click');
  assert.equal(h.downloads.length, 1);
  assert.equal(h.get('code').textContent, '');
  assertBlocked(h);
});
