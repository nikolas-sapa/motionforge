function validateResult(doc) {
  const err = (message) => { throw new Error(message); };
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) err('Result is not a JSON object.');
  if (doc.schemaVersion !== 1) err('Unsupported schemaVersion.');
  const p = doc.provenance;
  if (!p || typeof p !== 'object') err('Missing provenance.');
  if (p.kind !== 'meta-sam-live') err('Unexpected provenance.kind.');
  if (p.model !== 'sam-3.1') err('Unexpected provenance.model.');
  if (p.measurement !== 'bounding-box-center') err('Unexpected provenance.measurement.');
  if (!nonempty(p.responseId)) err('Missing provenance.responseId.');
  const src = p.source;
  if (!src || typeof src.name !== 'string' || typeof src.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/i.test(src.sha256) || !nonempty(src.fileId)) {
    err('Malformed provenance.source (need name, sha256, fileId).');
  }
  const v = doc.video;
  if (!v || !positiveInteger(v.width) || !positiveInteger(v.height)
    || !positiveInteger(v.frameCount) || !Array.isArray(v.timestamps)) {
    err('Malformed video metadata.');
  }
  if (v.timestamps.length !== v.frameCount) err('timestamps length does not equal frameCount.');
  for (let i = 0; i < v.timestamps.length; i += 1) {
    const t = v.timestamps[i];
    if (!Number.isFinite(t) || t < 0 || (i > 0 && t <= v.timestamps[i - 1])) {
      err('Timestamps must be finite, non-negative, strictly increasing.');
    }
  }
  if (!Array.isArray(doc.tracks)) err('tracks must be an array.');
  const ids = new Set();
  for (const track of doc.tracks) {
    if (!track || !nonempty(track.objectId)) err('Track missing objectId.');
    if (ids.has(track.objectId)) err('Duplicate objectId.');
    ids.add(track.objectId);
    if (!Array.isArray(track.samples) || track.samples.length === 0) err('Track has no samples.');
    let lastFrame = -1;
    let lastT = -Infinity;
    for (const s of track.samples) {
      if (!s || !Number.isSafeInteger(s.frameIndex) || s.frameIndex < 0
        || s.frameIndex >= v.frameCount || s.frameIndex <= lastFrame) {
        err('Sample frameIndex must be in range and strictly increasing.');
      }
      lastFrame = s.frameIndex;
      if (![s.t, s.x, s.y].every(Number.isFinite) || s.t < 0) err('Malformed sample.');
      if (s.t <= lastT) err('Sample timestamps must be strictly increasing.');
      lastT = s.t;
      if (Math.abs(s.t - v.timestamps[s.frameIndex]) > 1e-3) {
        err('Sample t does not match source timestamp at frameIndex.');
      }
      const b = s.box;
      if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)
        || b.x2 <= b.x1 || b.y2 <= b.y1) {
        err('Malformed box.');
      }
      if (b.x1 < 0 || b.y1 < 0 || b.x2 > v.width || b.y2 > v.height) {
        err('Box outside video bounds.');
      }
      if (s.x < 0 || s.x > v.width || s.y < 0 || s.y > v.height) {
        err('Sample center outside video bounds.');
      }
      if (Math.abs(s.x - (b.x1 + b.x2) / 2) > 1e-6
        || Math.abs(s.y - (b.y1 + b.y2) / 2) > 1e-6) {
        err('Sample x/y do not match bounding-box center.');
      }
    }
  }
  return doc;
}

function verifyCapture({ videoHash, result, videoWidth, videoHeight, metadataReady }) {
  if (typeof videoHash !== 'string' || !videoHash) {
    return { ok: false, reason: 'Load a source video before fitting or overlaying.' };
  }
  if (!result) return { ok: false, reason: 'Load a capture result before fitting or overlaying.' };
  try {
    validateResult(result);
  } catch {
    return { ok: false, reason: 'Capture result is invalid.' };
  }
  if (videoHash.toLowerCase() !== result.provenance.source.sha256.toLowerCase()) {
    return { ok: false, reason: 'Video SHA256 does not match capture source.sha256.' };
  }
  if (metadataReady !== true) {
    return { ok: false, reason: 'Wait for source video metadata.' };
  }
  if (videoWidth !== result.video.width || videoHeight !== result.video.height) {
    return { ok: false, reason: 'Video dimensions do not match capture metadata.' };
  }
  return { ok: true, reason: '' };
}

export { validateResult, verifyCapture };
