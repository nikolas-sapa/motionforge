import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createViewerServer } from './serve-viewer.mjs';
import { validateResult, verifyCapture } from './viewer-state.mjs';
import { fitMotion, predictMotion, springState } from '../src/motion-fit.mjs';
import { exportSpring } from '../src/export-spring.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function withServer(fn) {
  const server = createViewerServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves HTML and all exact module routes with correct MIME', async () => {
  await withServer(async (base) => {
    for (const url of ['/', '/viewer.html']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.text();
      const onDisk = await readFile(path.join(root, 'spike/viewer.html'), 'utf8');
      assert.equal(body, onDisk);
    }
    for (const url of ['/src/motion-fit.mjs', '/spike/viewer-state.mjs', '/src/export-spring.mjs']) {
      const mod = await fetch(base + url);
      assert.equal(mod.status, 200);
      assert.match(mod.headers.get('content-type'), /javascript/);
      assert.equal(mod.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(mod.headers.get('cache-control'), 'no-store');
      assert.equal(await mod.text(), await readFile(path.join(root, url.slice(1)), 'utf8'));
    }
  });
});

test('traversal, dotfiles, and unknown paths return 404', async () => {
  await withServer(async (base) => {
    const paths = [
      '/../../.env.local',
      '/.env.local',
      '/%2e%2e/%2e%2e/.env.local',
      '/%2e%2e%2f%2e%2e%2f.env.local',
      '/src/../.env.local',
      '/spike/../package.json',
      '/favicon.ico',
      '/src/motion-fit.mjs/extra',
      '/src/export-spring.mjs/extra',
      '/src/%65xport-spring.mjs',
      '/src/export-spring.test.mjs',
      '/spike/viewer-state.mjs/extra',
      '/spike/viewer-state.test.mjs',
      '/spike/sam-api.mjs',
      '/spike/viewer.test.mjs',
      '/spike/%76iewer-state.mjs',
      '/nonexistent',
    ];
    for (const p of paths) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, p);
    }
  });
});

function capture() {
  return {
    schemaVersion: 1,
    provenance: {
      kind: 'meta-sam-live',
      model: 'sam-3.1',
      responseId: 'test-response',
      measurement: 'bounding-box-center',
      source: { name: 'local.mp4', sha256: 'a'.repeat(64), fileId: 'test-file' },
    },
    video: { width: 320, height: 240, frameCount: 1, timestamps: [0] },
    tracks: [{
      objectId: 'object-1',
      samples: [{ frameIndex: 0, t: 0, x: 20, y: 20, box: { x1: 10, y1: 10, x2: 30, y2: 30 } }],
    }],
  };
}

async function viewerHarness(transform = (source) => source, crypto = webcrypto) {
  const elements = new Map();
  const frames = new Map();
  const revoked = [];
  const objects = new Map();
  const downloads = [];
  const body = { children: [], append(child) { this.children.push(child); } };
  let nextFrame = 0;
  let nextUrl = 0;
  let fitCalls = 0;
  function element(tag) {
    const listeners = new Map();
    const drawing = { clears: 0, boxes: 0, points: 0 };
    const context = {
      setTransform() {},
      clearRect() { drawing.clears += 1; drawing.boxes = 0; drawing.points = 0; },
      strokeRect() { drawing.boxes += 1; },
      arc() { drawing.points += 1; },
      fillRect() {}, fillText() {}, beginPath() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
    };
    return {
      listeners, drawing, value: '', textContent: '', disabled: true, hidden: false,
      style: {}, attributes: {}, children: [], files: [], width: 1000, height: 320,
      clientWidth: 320, clientHeight: 240, videoWidth: 0, videoHeight: 0,
      readyState: 0, currentSrc: '', currentTime: 0,
      addEventListener(name, fn) { listeners.set(name, fn); },
      async fire(name, event = {}) { return listeners.get(name)?.(event); },
      replaceChildren() { this.children = []; this.value = ''; },
      append(child) { this.children.push(child); },
      click() {
        if (tag === 'a') downloads.push({ name: this.download, url: this.href, blob: objects.get(this.href) });
      },
      remove() { body.children = body.children.filter((child) => child !== this); },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentSrc = ''; } },
      load() { this.readyState = 0; this.videoWidth = 0; this.videoHeight = 0; },
      getContext() { return context; },
      getBoundingClientRect() { return { width: 400, height: 80, left: 0 }; },
      setPointerCapture() {}, hasPointerCapture() { return false; },
    };
  }
  const sandbox = {
    document: {
      body,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, devicePixelRatio: 1 },
    URL: {
      createObjectURL(object) {
        const url = 'blob:test-' + ++nextUrl;
        objects.set(url, object);
        return url;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    crypto, performance, Blob,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    validateResult, verifyCapture, predictMotion, springState, exportSpring,
    fitMotion(...args) { fitCalls += 1; return fitMotion(...args); },
  };
  const html = await readFile(path.join(root, 'spike/viewer.html'), 'utf8');
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*;$/gm, '');
  vm.runInNewContext(transform(source) + '\nglobalThis.viewer = { state, runFit, updateOverlay, drawChart, startSim, captureGate };', sandbox);
  const { viewer } = sandbox;
  const get = (id) => elements.get(id);
  function ready(doc = capture()) {
    viewer.state.result = validateResult(doc);
    viewer.state.videoHash = doc.provenance.source.sha256;
    viewer.state.videoUrl = 'blob:current';
    viewer.state.metadataReady = true;
    Object.assign(get('video'), { videoWidth: 320, videoHeight: 240, readyState: 1, currentSrc: 'blob:current' });
    viewer.state.selectedTrack = doc.tracks[0] || null;
  }
  return { ...viewer, get, frames, revoked, downloads, body, ready, fitCalls: () => fitCalls };
}

function assertBlocked(harness) {
  assert.equal(harness.get('trackselect').disabled, true);
  assert.equal(harness.state.selectedTrack, null);
  assert.equal(harness.state.fit, null);
  assert.equal(harness.get('release80').disabled, true);
  assert.equal(harness.get('stopbtn').disabled, true);
  assert.equal(harness.get('exportbtn').disabled, true);
  assert.equal(harness.get('handle').attributes['aria-disabled'], 'true');
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.get('overlay').drawing.boxes, 0);
  assert.equal(harness.get('chart').drawing.points, 0);
}

test('matching capture draws one observed box and calls real fit once; missing metadata calls fit zero times', async () => {
  const harness = await viewerHarness();
  harness.ready();
  harness.updateOverlay();
  assert.equal(harness.get('overlay').drawing.boxes, 1);
  harness.runFit();
  assert.equal(harness.fitCalls(), 1);
  assert.match(harness.get('fitstatus').textContent, /Fit rejected/);
  harness.state.metadataReady = false;
  harness.runFit();
  assert.equal(harness.fitCalls(), 1);
  assertBlocked(harness);
});

test('export is initially disabled; no capture, hash mismatch and rejected fits produce zero downloads', async () => {
  const html = await readFile(path.join(root, 'spike/viewer.html'), 'utf8');
  assert.match(html, /<button id="exportbtn" type="button" disabled>Download JavaScript spring<\/button>/);
  const harness = await viewerHarness();
  assert.equal(harness.get('exportbtn').disabled, true);
  assert.equal(typeof harness.get('exportbtn').listeners.get('click'), 'function');
  await harness.get('exportbtn').fire('click');
  assertBlocked(harness);
  harness.ready();
  harness.runFit();
  assert.equal(harness.state.fit, null);
  assert.equal(harness.get('exportbtn').disabled, true);
  await harness.get('exportbtn').fire('click');
  harness.state.fit = { status: 'fitted', parameters: { decay: 0.4, omega: 3 } };
  harness.state.videoHash = 'b'.repeat(64);
  await harness.get('exportbtn').fire('click');
  assertBlocked(harness);
  assert.equal(harness.downloads.length, 0);
});

test('handler-only accepted-fit state downloads real generator text for current fit, not stale fit, and cleans up', async () => {
  const harness = await viewerHarness();
  harness.ready();
  const acceptedFitForHandlerOnly = { status: 'fitted', parameters: { decay: 0.4, omega: 3 } };
  harness.state.fit = acceptedFitForHandlerOnly;
  assert.equal(typeof harness.get('exportbtn').listeners.get('click'), 'function');
  await harness.get('exportbtn').fire('click');
  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.downloads[0].name, 'motionforge-spring.mjs');
  assert.match(harness.downloads[0].blob.type, /javascript/);
  assert.equal(await harness.downloads[0].blob.text(), exportSpring(acceptedFitForHandlerOnly));
  assert.ok(harness.revoked.includes(harness.downloads[0].url));
  assert.equal(harness.body.children.length, 0);
  harness.state.fit = { status: 'fitted', parameters: { decay: 0.2, omega: 4 } };
  await harness.get('exportbtn').fire('click');
  assert.equal(harness.downloads.length, 2);
  assert.equal(await harness.downloads[1].blob.text(), exportSpring(harness.state.fit));
  assert.notEqual(await harness.downloads[1].blob.text(), exportSpring(acceptedFitForHandlerOnly));
  assert.ok(harness.revoked.includes(harness.downloads[1].url));
  assert.equal(harness.body.children.length, 0);
  harness.get('trackselect').value = '';
  await harness.get('trackselect').fire('change');
  assert.equal(harness.get('exportbtn').disabled, true);
  await harness.get('exportbtn').fire('click');
  assert.equal(harness.downloads.length, 2);
});

test('hash mismatch blocks dropdown, keyboard, fitting, overlay, chart and animation with zero fit calls', async () => {
  const harness = await viewerHarness();
  harness.ready();
  harness.updateOverlay();
  harness.drawChart();
  harness.state.videoHash = 'b'.repeat(64);
  harness.get('trackselect').value = 'object-1';
  await harness.get('trackselect').fire('change');
  await harness.get('handle').fire('keydown', { key: 'Enter', preventDefault() {} });
  await harness.get('release80').fire('click');
  harness.runFit();
  harness.updateOverlay();
  harness.drawChart();
  harness.startSim(80);
  assert.equal(harness.fitCalls(), 0);
  assertBlocked(harness);
});

test('mismatched dimensions and stale currentSrc each block all selection and fit state', async () => {
  const harness = await viewerHarness();
  for (const change of [
    () => { harness.get('video').videoWidth = 640; },
    () => { harness.get('video').currentSrc = 'blob:previous'; },
    () => { harness.get('video').readyState = 0; },
  ]) {
    harness.ready();
    change();
    harness.runFit();
    assertBlocked(harness);
  }
  assert.equal(harness.fitCalls(), 0);
});

test('repeated Release retains exactly one RAF; mismatch stops its next frame; track change resets handle', async () => {
  const harness = await viewerHarness();
  harness.ready();
  harness.state.fit = { parameters: {} };
  harness.startSim(80);
  const firstFrame = harness.state.sim.raf;
  harness.startSim(80);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.frames.has(firstFrame), false);
  harness.state.videoHash = 'b'.repeat(64);
  harness.frames.get(harness.state.sim.raf)(performance.now());
  assertBlocked(harness);
  harness.ready();
  harness.state.fit = { parameters: {} };
  harness.startSim(80);
  harness.get('trackselect').value = '';
  await harness.get('trackselect').fire('change');
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.get('handle').attributes['aria-valuenow'], '0');
  assert.equal(harness.state.fit, null);
});

test('empty tracks are valid and show No objects found with zero fitting or RAF', async () => {
  const harness = await viewerHarness();
  const doc = capture();
  doc.tracks = [];
  harness.ready(doc);
  harness.runFit();
  assert.match(harness.get('loadstatus').textContent, /No objects found/);
  assert.equal(harness.fitCalls(), 0);
  assertBlocked(harness);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('JSON replacement clears overlay immediately; stale completion and failure cannot replace newest result', async () => {
  const harness = await viewerHarness();
  for (const staleFailure of [false, true]) {
    harness.ready();
    harness.updateOverlay();
    const old = deferred();
    harness.get('jsonfile').files = [{ text: () => old.promise }];
    const pending = harness.get('jsonfile').fire('change');
    assert.equal(harness.state.result, null);
    assertBlocked(harness);
    const newest = capture();
    newest.provenance.responseId = 'newest';
    harness.get('jsonfile').files = [{ text: async () => JSON.stringify(newest) }];
    await harness.get('jsonfile').fire('change');
    if (staleFailure) old.reject(new Error('stale read error'));
    else old.resolve(JSON.stringify(capture()));
    await pending;
    assert.equal(harness.state.result.provenance.responseId, 'newest');
    assert.equal(harness.get('provenance').textContent.includes('stale read error'), false);
  }
  harness.get('jsonfile').files = [];
  await harness.get('jsonfile').fire('change');
  assert.equal(harness.state.result, null);
  assertBlocked(harness);
});

test('video generations discard stale file reads and digests; only current metadata can enable selection', async () => {
  const digest = deferred();
  const harness = await viewerHarness((source) => source, { subtle: { digest: () => digest.promise } });
  harness.ready();
  harness.updateOverlay();
  const oldRead = deferred();
  harness.get('videofile').files = [{ arrayBuffer: () => oldRead.promise }];
  const pendingRead = harness.get('videofile').fire('change');
  assertBlocked(harness);
  harness.get('videofile').files = [{ arrayBuffer: async () => new ArrayBuffer(1) }];
  const pendingDigest = harness.get('videofile').fire('change');
  await Promise.resolve();
  harness.get('videofile').files = [];
  await harness.get('videofile').fire('change');
  oldRead.resolve(new ArrayBuffer(1));
  digest.resolve(new Uint8Array(32).fill(170).buffer);
  await Promise.all([pendingRead, pendingDigest]);
  assert.equal(harness.state.videoUrl, null);
  assert.equal(harness.state.videoHash, null);
  assertBlocked(harness);

  harness.get('videofile').files = [{ arrayBuffer: async () => new ArrayBuffer(1) }];
  await harness.get('videofile').fire('change');
  assert.equal(harness.get('trackselect').disabled, true);
  const oldMetadata = harness.get('video').onloadedmetadata;
  Object.assign(harness.get('video'), { currentSrc: harness.state.videoUrl, readyState: 1, videoWidth: 320, videoHeight: 240 });
  oldMetadata();
  assert.equal(harness.get('trackselect').disabled, false);
  harness.get('videofile').files = [];
  await harness.get('videofile').fire('change');
  oldMetadata();
  assert.equal(harness.state.metadataReady, false);
  assertBlocked(harness);
});

test('invalid JSON clears previous provenance, chart and overlay immediately', async () => {
  const harness = await viewerHarness();
  harness.ready();
  harness.updateOverlay();
  harness.drawChart();
  harness.get('jsonfile').files = [{ text: async () => '{}' }];
  await harness.get('jsonfile').fire('change');
  assert.equal(harness.state.result, null);
  assert.equal(harness.get('provenance').textContent, 'none');
  assert.match(harness.get('loadstatus').textContent, /Invalid result JSON/);
  assertBlocked(harness);
});

test('unsupported schema error survives video events, overlay and chart updates with gate disabled', async () => {
  const harness = await viewerHarness();
  harness.ready();
  harness.get('jsonfile').files = [{ text: async () => '{"schemaVersion":0}' }];
  await harness.get('jsonfile').fire('change');
  const message = harness.get('loadstatus').textContent;
  assert.equal(message, 'Invalid result JSON: Unsupported schemaVersion.');
  for (const update of [
    () => harness.get('video').fire('timeupdate'),
    () => harness.get('video').fire('seeked'),
    () => harness.updateOverlay(),
    () => harness.drawChart(),
  ]) {
    await update();
    assert.equal(harness.get('loadstatus').textContent, message);
    assertBlocked(harness);
  }
  assert.equal(harness.fitCalls(), 0);
});

test('regression assertion turns red when central gate is disabled in memory', async () => {
  const harness = await viewerHarness((source) => source.replace('if (!gate.ok) {', 'if (false) {'));
  harness.ready();
  harness.state.videoHash = 'b'.repeat(64);
  harness.runFit();
  assert.throws(() => assertBlocked(harness), assert.AssertionError);
  assert.equal(harness.fitCalls(), 1);
});

test('POST returns 405; HEAD returns 200 with empty body', async () => {
  await withServer(async (base) => {
    const post = await fetch(base + '/', { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    const head = await fetch(base + '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    const body = await head.text();
    assert.equal(body, '');
  });
});

test('viewer source contains no API-key names, provider endpoints, or default fake trajectory', async () => {
  const html = await readFile(path.join(root, 'spike/viewer.html'), 'utf8');
  const lower = html.toLowerCase();
  for (const bad of [
    'model_api_key', 'api_key', 'apikey', 'openai', 'anthropic', 'claude.ai',
    'api.openai', 'generativelanguage', 'api.segment', 'fetch(', 'xmlhttprequest',
    'navigator.sendbeacon', 'innerhtml', 'eval(',
  ]) {
    assert.ok(!lower.includes(bad), 'viewer contains forbidden token: ' + bad);
  }
  assert.ok(!lower.includes('example track'), 'no example track');
  assert.ok(!lower.includes('fake'), 'no fake capture');
  assert.ok(lower.includes('no video or tracking result loaded'), 'required initial status present');
});
