import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResult, verifyCapture } from './viewer-state.mjs';

function capture() {
  return {
    schemaVersion: 1,
    provenance: {
      kind: 'meta-sam-live',
      model: 'sam-3.1',
      responseId: 'response-1',
      measurement: 'bounding-box-center',
      source: { name: 'capture.mp4', sha256: 'ab'.repeat(32), fileId: 'file-1' },
    },
    video: { width: 320, height: 240, frameCount: 3, timestamps: [0, 0.04, 0.08] },
    tracks: [{
      objectId: '1',
      samples: [
        { frameIndex: 0, t: 0, x: 20, y: 30, box: { x1: 10, y1: 20, x2: 30, y2: 40 } },
        { frameIndex: 2, t: 0.08, x: 30, y: 40, box: { x1: 20, y1: 30, x2: 40, y2: 50 } },
      ],
    }],
  };
}

function readyCapture() {
  const result = capture();
  return {
    videoHash: result.provenance.source.sha256,
    result,
    videoWidth: 320,
    videoHeight: 240,
    metadataReady: true,
  };
}

test('validateResult returns the same document without mutations', () => {
  const doc = capture();
  const before = structuredClone(doc);
  assert.equal(validateResult(doc), doc);
  assert.deepEqual(doc, before);
});

test('empty tracks are a valid no-matches capture and pass source verification', () => {
  const input = readyCapture();
  input.result.tracks = [];
  assert.equal(validateResult(input.result), input.result);
  assert.deepEqual(verifyCapture(input), { ok: true, reason: '' });
});

const invalidDocuments = [
  ['wrong schema version', (doc) => { doc.schemaVersion = 2; }],
  ['wrong kind', (doc) => { doc.provenance.kind = 'fixture'; }],
  ['wrong model', (doc) => { doc.provenance.model = 'other'; }],
  ['wrong measurement', (doc) => { doc.provenance.measurement = 'centroid'; }],
  ['empty response ID', (doc) => { doc.provenance.responseId = ''; }],
  ['blank file ID', (doc) => { doc.provenance.source.fileId = ' '; }],
  ['nonstring object ID', (doc) => { doc.tracks[0].objectId = 1; }],
  ['blank object ID', (doc) => { doc.tracks[0].objectId = ' '; }],
  ['short hash', (doc) => { doc.provenance.source.sha256 = 'ab'; }],
  ['nonhex hash', (doc) => { doc.provenance.source.sha256 = 'z'.repeat(64); }],
  ['missing source', (doc) => { doc.provenance.source = null; }],
  ['missing video', (doc) => { doc.video = null; }],
  ['missing tracks', (doc) => { delete doc.tracks; }],
  ['zero width', (doc) => { doc.video.width = 0; }],
  ['fractional width', (doc) => { doc.video.width = 320.5; }],
  ['unsafe width', (doc) => { doc.video.width = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative height', (doc) => { doc.video.height = -1; }],
  ['fractional height', (doc) => { doc.video.height = 240.5; }],
  ['unsafe height', (doc) => { doc.video.height = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero frame count', (doc) => { doc.video.frameCount = 0; }],
  ['fractional frame count', (doc) => { doc.video.frameCount = 3.5; }],
  ['unsafe frame count', (doc) => { doc.video.frameCount = Number.MAX_SAFE_INTEGER + 1; }],
  ['timestamp count mismatch', (doc) => { doc.video.timestamps.pop(); }],
  ['negative source timestamp', (doc) => { doc.video.timestamps[0] = -0.01; }],
  ['nonfinite source timestamp', (doc) => { doc.video.timestamps[2] = Infinity; }],
  ['repeated source timestamp', (doc) => { doc.video.timestamps[1] = 0; }],
  ['decreasing source timestamp', (doc) => { doc.video.timestamps[2] = 0.02; }],
  ['duplicate object ID', (doc) => { doc.tracks.push(structuredClone(doc.tracks[0])); }],
  ['empty samples', (doc) => { doc.tracks[0].samples = []; }],
  ['negative sample frame', (doc) => { doc.tracks[0].samples[0].frameIndex = -1; }],
  ['fractional sample frame', (doc) => { doc.tracks[0].samples[0].frameIndex = 0.5; }],
  ['unsafe sample frame', (doc) => { doc.tracks[0].samples[0].frameIndex = Number.MAX_SAFE_INTEGER + 1; }],
  ['sample frame past source', (doc) => { doc.tracks[0].samples[1].frameIndex = 3; }],
  ['repeated sample frame', (doc) => { doc.tracks[0].samples[1].frameIndex = 0; }],
  ['decreasing sample frames', (doc) => { doc.tracks[0].samples.reverse(); }],
  ['mismatched sample timestamp', (doc) => { doc.tracks[0].samples[1].t = 0.082; }],
  ['negative sample timestamp', (doc) => { doc.tracks[0].samples[0].t = -0.0001; }],
  ['nonfinite sample timestamp', (doc) => { doc.tracks[0].samples[0].t = NaN; }],
  ['nonincreasing sample timestamps within tolerance', (doc) => {
    doc.video.timestamps = [0, 0.0001, 0.0002];
    doc.tracks[0].samples[1].t = 0;
  }],
  ['center outside box', (doc) => { doc.tracks[0].samples[0].x = 50; }],
  ['x differs from center beyond tolerance', (doc) => { doc.tracks[0].samples[0].x += 0.000002; }],
  ['y differs from center beyond tolerance', (doc) => { doc.tracks[0].samples[0].y += 0.000002; }],
  ['nonfinite center', (doc) => { doc.tracks[0].samples[0].y = Infinity; }],
  ['out of bounds center', (doc) => { doc.tracks[0].samples[0].x = -0.0000001; }],
  ['missing box', (doc) => { doc.tracks[0].samples[0].box = null; }],
  ['nonfinite box', (doc) => { doc.tracks[0].samples[0].box.x1 = NaN; }],
  ['zero width box', (doc) => { doc.tracks[0].samples[0].box.x2 = 10; }],
  ['negative height box', (doc) => { doc.tracks[0].samples[0].box.y2 = 10; }],
  ['box left of source', (doc) => { doc.tracks[0].samples[0].box.x1 = -1; }],
  ['box above source', (doc) => { doc.tracks[0].samples[0].box.y1 = -1; }],
  ['box right of source', (doc) => { doc.tracks[0].samples[0].box.x2 = 321; }],
  ['box below source', (doc) => { doc.tracks[0].samples[0].box.y2 = 241; }],
];

for (const [name, mutate] of invalidDocuments) {
  test('validateResult rejects ' + name, () => {
    const doc = capture();
    mutate(doc);
    assert.throws(() => validateResult(doc), Error);
  });
}

test('validateResult rejects non-document inputs', () => {
  for (const value of [null, undefined, [], true, 1, 'result']) {
    assert.throws(() => validateResult(value), Error);
  }
});

test('validateResult accepts timestamp and center differences within tolerances', () => {
  const doc = capture();
  doc.tracks[0].samples[1].t += 0.0005;
  doc.tracks[0].samples[0].x += 0.0000005;
  doc.tracks[0].samples[0].y -= 0.0000005;
  assert.equal(validateResult(doc), doc);
});

test('validateResult accepts full-frame boxes and multiple unique tracks', () => {
  const doc = capture();
  doc.tracks.push({
    objectId: '2',
    samples: [{ frameIndex: 1, t: 0.04, x: 160, y: 120, box: { x1: 0, y1: 0, x2: 320, y2: 240 } }],
  });
  assert.equal(validateResult(doc), doc);
});

test('verifyCapture accepts matching source hash and loaded dimensions without mutation', () => {
  const input = readyCapture();
  const before = structuredClone(input);
  assert.deepEqual(verifyCapture(input), { ok: true, reason: '' });
  assert.deepEqual(input, before);
});

test('verifyCapture compares hashes case-insensitively', () => {
  const input = readyCapture();
  input.videoHash = input.videoHash.toUpperCase();
  assert.equal(verifyCapture(input).ok, true);
  input.result.provenance.source.sha256 = input.videoHash;
  input.videoHash = input.videoHash.toLowerCase();
  assert.equal(verifyCapture(input).ok, true);
});

const invalidCaptures = [
  ['missing video hash', (input) => { input.videoHash = ''; }],
  ['absent video hash', (input) => { delete input.videoHash; }],
  ['nonstring video hash', (input) => { input.videoHash = 123; }],
  ['missing result', (input) => { input.result = null; }],
  ['hash mismatch', (input) => { input.videoHash = 'cd'.repeat(32); }],
  ['metadata not ready', (input) => { input.metadataReady = false; }],
  ['metadata readiness absent', (input) => { delete input.metadataReady; }],
  ['metadata readiness not boolean', (input) => { input.metadataReady = 'true'; }],
  ['width mismatch', (input) => { input.videoWidth = 321; }],
  ['height mismatch', (input) => { input.videoHeight = 241; }],
  ['missing video dimensions', (input) => { delete input.videoWidth; }],
  ['malformed result', (input) => { input.result = {}; }],
];

for (const [name, mutate] of invalidCaptures) {
  test('verifyCapture fails closed for ' + name, () => {
    const input = readyCapture();
    mutate(input);
    const result = verifyCapture(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  });
}
