import { fitMotion, predictMotion, springState } from '../src/motion-fit.mjs';
import { exportSpring } from '../src/export-spring.mjs';
import { frameIndexAtTime, seekTimeForFrame } from '../src/video-frame.mjs';
import { validateResult, verifyCapture } from '../spike/viewer-state.mjs';

export function contentRect(rect, width, height) {
  const scale = Math.min(rect.width / width, rect.height / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  return {
    left: rect.left + (rect.width - drawnWidth) / 2,
    top: rect.top + (rect.height - drawnHeight) / 2,
    width: drawnWidth, height: drawnHeight, scale,
  };
}

export function sourcePoint(clientX, clientY, rect, width, height) {
  return {
    x: Math.max(0, Math.min(width - 1, Math.round((clientX - rect.left) / rect.scale))),
    y: Math.max(0, Math.min(height - 1, Math.round((clientY - rect.top) / rect.scale))),
  };
}

export function sourceBox(a, b) {
  const box = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
  return box.x2 - box.x1 >= 4 && box.y2 - box.y1 >= 4 ? box : null;
}

export function releaseVelocity(history, now, lastMovement) {
  if (now - lastMovement >= 100) return 0;
  const recent = history.filter((sample) => sample.time >= now - 80);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent.at(-1);
  return last.time > first.time ? (last.position - first.position) * 1000 / (last.time - first.time) : 0;
}

export function createProductApp(document, platform = globalThis) {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const chart = $('chart');
  const target = $('target');
  const tabs = [...document.querySelectorAll('[data-target-tab]')];
  const reducedMotion = platform.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    generation: 0, captureGeneration: 0, trackGeneration: 0,
    file: null, videoHash: null, videoUrl: null, metadataReady: false,
    upload: null, uploadBusy: false, tracking: false, health: null,
    result: null, selectedTrack: null, fit: null, mode: null,
    captureBlocked: false, inputError: null, roi: null, roiDrag: null,
    presentedTime: null, presentedIndex: null, frameReady: false, seekTarget: null,
    videoFrame: 0, uploadController: null, trackController: null,
    target: 'dot',
    sim: {
      raf: 0, running: false, position: 0, velocity: 0,
      start: 0, initialPosition: 0, initialVelocity: 0,
      dragging: false, grabOffset: 0, history: [], lastMovement: 0, pending: null,
    },
  };

  function status(message, error = false) {
    $('status').textContent = state.inputError || message;
    $('status').dataset.error = String(Boolean(state.inputError || error));
  }

  function metadataCurrent() {
    return state.metadataReady && video.readyState >= 1 && video.currentSrc === state.videoUrl
      && video.videoWidth > 0 && video.videoHeight > 0;
  }

  function captureCheck() {
    return verifyCapture({
      videoHash: state.videoHash, result: state.result,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      metadataReady: metadataCurrent(),
    });
  }

  function sourceGate() {
    if (!state.videoHash || !metadataCurrent() || state.captureBlocked) return false;
    if (state.result && !captureCheck().ok) return false;
    if (state.upload && (state.upload.sha256 !== state.videoHash
      || state.upload.width !== video.videoWidth || state.upload.height !== video.videoHeight)) return false;
    return Boolean(state.upload || state.result);
  }

  function clearCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function stopSimulation() {
    if (state.sim.raf) platform.cancelAnimationFrame(state.sim.raf);
    state.sim.raf = 0;
    state.sim.running = false;
    $('stopbtn').disabled = true;
  }

  function placeTarget(position) {
    const stage = $('previewstage').getBoundingClientRect();
    const targetWidth = target.offsetWidth || (state.target === 'toast' ? 150 : state.target === 'button' ? 90 : 28);
    const limit = Math.max(0, Math.min(160, stage.width / 2 - targetWidth / 2 - 16));
    target.style.transform = 'translate3d(' + position + 'px, 0, 0)';
    target.setAttribute('aria-valuenow', String(Math.round(position)));
    target.setAttribute('aria-valuemin', String(Math.floor(Math.min(-limit, position))));
    target.setAttribute('aria-valuemax', String(Math.ceil(Math.max(limit, position))));
    return position;
  }

  function clearFit() {
    stopSimulation();
    state.fit = null;
    state.sim.dragging = false;
    state.sim.position = 0;
    state.sim.velocity = 0;
    state.sim.pending = null;
    placeTarget(0);
    target.hidden = true;
    target.setAttribute('aria-disabled', 'true');
    $('previewempty').hidden = false;
    $('code').textContent = '';
    $('codeempty').hidden = false;
    $('chartempty').hidden = false;
    for (const id of ['frequency', 'decay', 'trainerror', 'holdouterror']) $(id).textContent = '—';
    for (const id of ['runbtn', 'stopbtn', 'exportbtn', 'copybtn']) $(id).disabled = true;
    for (const tab of tabs) tab.disabled = true;
    $('fitstatus').textContent = 'No fit yet. Observations will appear here.';
    $('runbtn').textContent = 'Release from 80px';
    $('simstatus').textContent = 'Drag and release. The fitted spring responds to your gesture.';
    clearCanvas(overlay);
    clearCanvas(chart);
  }

  function controls() {
    const captured = captureCheck().ok && !state.captureBlocked;
    const fitted = captured && state.fit?.status === 'fitted';
    const source = sourceGate();
    const frame = source && state.frameReady && video.paused && !video.seeking;
    $('playbtn').disabled = !source;
    $('playbtn').textContent = video.paused ? 'Play' : 'Pause';
    $('frameslider').disabled = !source || !times();
    $('trackselect').disabled = !captured || !state.result.tracks.length || state.tracking;
    $('trackbtn').disabled = !(frame && state.roi && state.roi.frameIndex === state.presentedIndex
      && state.upload && state.health?.modelConfigured && state.health?.trackingAvailable && !state.tracking);
    $('trackbtn').textContent = state.tracking ? 'Tracking…' : 'Track object';
    $('trackbtn').classList.toggle('primary', !fitted);
    $('exportbtn').classList.toggle('primary', fitted);
    for (const id of ['runbtn', 'copybtn', 'exportbtn']) $(id).disabled = !fitted;
    $('stopbtn').disabled = !fitted || !state.sim.running;
    target.setAttribute('aria-disabled', String(!fitted));
    for (const tab of tabs) tab.disabled = !fitted;
    for (const [id, active] of [
      ['step-source', !source], ['step-object', source && !fitted], ['step-spring', fitted],
    ]) {
      if (active) $(id).setAttribute('aria-current', 'step');
      else $(id).removeAttribute('aria-current');
    }
  }

  function gate(prompt = false) {
    const checked = captureCheck();
    if (prompt && !state.result && !state.captureBlocked && sourceGate()) return true;
    if (!checked.ok || state.captureBlocked || (prompt && !sourceGate())) {
      state.selectedTrack = null;
      $('trackselect').value = '';
      clearFit();
      controls();
      if (state.inputError || state.result) status(checked.reason, true);
      return false;
    }
    return true;
  }

  function inputError(message, blocked = false) {
    state.inputError = message;
    state.captureBlocked = blocked;
    state.selectedTrack = null;
    clearFit();
    controls();
    status(message, true);
  }

  function times() {
    if (state.upload?.sha256 === state.videoHash) return state.upload.timestamps;
    if (state.result?.provenance.source.sha256.toLowerCase() === state.videoHash) return state.result.video.timestamps;
    return null;
  }

  function updatePresented() {
    const timestamps = times();
    if (!timestamps || state.presentedTime === null) return;
    state.presentedIndex = frameIndexAtTime(timestamps, state.presentedTime);
    state.frameReady = !video.seeking && (state.seekTarget === null || state.seekTarget === state.presentedIndex);
    if (state.frameReady) state.seekTarget = null;
    $('frameslider').max = String(timestamps.length - 1);
    $('frameslider').value = String(state.presentedIndex);
    $('framereadout').textContent = 'Frame ' + state.presentedIndex + ' / ' + (timestamps.length - 1);
  }

  function observeFrames(generation) {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      $('roistatus').textContent = 'Frame-accurate selection needs a browser with video-frame callbacks. Saved captures still work.';
      return;
    }
    state.videoFrame = video.requestVideoFrameCallback((now, metadata) => {
      if (generation !== state.generation || video.currentSrc !== state.videoUrl) return;
      state.videoFrame = 0;
      state.presentedTime = metadata.mediaTime;
      updatePresented();
      renderOverlay();
      controls();
      observeFrames(generation);
    });
  }

  function validateUpload(doc) {
    if (!doc || typeof doc.id !== 'string' || !doc.id || typeof doc.name !== 'string'
      || doc.sha256 !== state.videoHash || !Number.isSafeInteger(doc.width) || doc.width <= 0
      || !Number.isSafeInteger(doc.height) || doc.height <= 0
      || !Number.isSafeInteger(doc.frameCount) || doc.frameCount <= 0
      || !Array.isArray(doc.timestamps) || doc.timestamps.length !== doc.frameCount) {
      throw new Error('Local upload metadata did not match the source video.');
    }
    frameIndexAtTime(doc.timestamps, doc.timestamps[0]);
    if (metadataCurrent() && (video.videoWidth !== doc.width || video.videoHeight !== doc.height)) {
      throw new Error('Local upload dimensions did not match the source video.');
    }
    return doc;
  }

  function serverErrorMessage(doc, fallback) {
    return doc && typeof doc === 'object' && Object.keys(doc).length === 1
      && doc.error && typeof doc.error === 'object' && Object.keys(doc.error).length === 2
      && typeof doc.error.code === 'string' && doc.error.code.trim()
      && typeof doc.error.message === 'string' && doc.error.message.trim()
      ? doc.error.message : fallback;
  }

  function captureReady() {
    if (!state.result) { controls(); return; }
    if (!gate()) return;
    if (state.result.tracks.length === 0) {
      state.selectedTrack = null;
      clearFit();
      controls();
      status('No objects found. Draw a new rectangle or import another saved capture.');
      return;
    }
    status(state.mode === 'saved' ? 'Saved SAM capture verified against this source.' : 'SAM capture verified against this source.');
    if (!state.selectedTrack) {
      const automatic = state.mode === 'live'
        ? state.result.tracks.find((track) => track.objectId === '1') || (state.result.tracks.length === 1 ? state.result.tracks[0] : null)
        : state.result.tracks.length === 1 ? state.result.tracks[0] : null;
      if (automatic) selectTrack(automatic.objectId);
    }
    controls();
  }

  async function loadVideo(file) {
    const generation = ++state.generation;
    state.captureGeneration++;
    state.trackGeneration++;
    state.uploadController?.abort();
    state.trackController?.abort();
    if (state.videoFrame && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(state.videoFrame);
    state.videoFrame = 0;
    video.pause();
    if (state.videoUrl) platform.URL.revokeObjectURL(state.videoUrl);
    Object.assign(state, {
      file: file || null, videoHash: null, videoUrl: null, metadataReady: false,
      upload: null, uploadBusy: false, tracking: false, result: null, selectedTrack: null,
      mode: null, captureBlocked: false, inputError: null, roi: null, roiDrag: null,
      presentedTime: null, presentedIndex: null, frameReady: false, seekTarget: null,
    });
    clearFit();
    $('trackselect').replaceChildren();
    $('objectfield').hidden = true;
    $('dropzone').hidden = Boolean(file);
    $('videostage').hidden = !file;
    $('mode').textContent = 'Rectangle prompt · no point guessing';
    $('sourceinfo').textContent = file ? file.name : 'No source loaded.';
    $('framereadout').textContent = 'Frame —';
    $('frameslider').value = '0';
    $('roistatus').textContent = 'Pause on a frame, then draw a rectangle around one object.';
    video.onloadedmetadata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    controls();
    if (!file) { status('Choose a source video to begin.'); return; }
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      inputError(file.size === 0
        ? 'Video file is empty. Choose a non-empty MP4 or MOV.'
        : 'Video file size is invalid. Choose an MP4 or MOV.', true);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      inputError('Video exceeds 25 MiB. Choose a smaller MP4 or MOV.', true);
      return;
    }
    if (typeof file.name !== 'string' || !/\.(mp4|mov)$/i.test(file.name)) {
      inputError('Unsupported video extension. Choose an MP4 or MOV.', true);
      return;
    }
    status('Reading and hashing source locally…');
    try {
      const buffer = await file.arrayBuffer();
      if (generation !== state.generation) return;
      const digest = await platform.crypto.subtle.digest('SHA-256', buffer);
      if (generation !== state.generation) return;
      state.videoHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      state.videoUrl = platform.URL.createObjectURL(file);
      const url = state.videoUrl;
      video.onloadedmetadata = () => {
        if (generation !== state.generation || video.currentSrc !== url || video.readyState < 1) return;
        state.metadataReady = true;
        $('videostage').style.setProperty('--source-ratio', video.videoWidth + ' / ' + video.videoHeight);
        if (state.upload && (state.upload.width !== video.videoWidth || state.upload.height !== video.videoHeight)) {
          inputError('Local upload dimensions did not match the source video.', true);
          return;
        }
        if (!state.videoFrame) observeFrames(generation);
        updatePresented();
        captureReady();
      };
      video.onerror = () => {
        if (generation !== state.generation) return;
        state.metadataReady = false;
        inputError('Video metadata could not be loaded. Choose a supported MP4 or MOV.', true);
      };
      video.src = url;
    } catch {
      if (generation === state.generation) inputError('Video read or hash failed. Choose the source again.', true);
      return;
    }
    state.uploadController = new platform.AbortController();
    state.uploadBusy = true;
    const form = new platform.FormData();
    form.append('video', file);
    status('Uploading to the local server. Meta is not contacted until you track.');
    let failureMessage = 'Local upload unavailable. You can still import a saved SAM capture for this video.';
    try {
      const response = await platform.fetch('/api/videos', {
        method: 'POST', body: form, signal: state.uploadController.signal,
      });
      if (generation !== state.generation) return;
      let doc;
      try {
        doc = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) failureMessage = 'Invalid local upload response: ' + error.message;
        throw error;
      }
      if (generation !== state.generation) return;
      if (!response.ok) {
        failureMessage = serverErrorMessage(doc, failureMessage);
        throw new Error(failureMessage);
      }
      try {
        state.upload = validateUpload(doc);
      } catch (error) {
        failureMessage = error.message;
        throw error;
      }
      $('sourceinfo').textContent = doc.name + ' · ' + doc.width + ' × ' + doc.height + ' · ' + doc.frameCount + ' source frames';
      updatePresented();
      if (state.result) captureReady();
      else status('Source ready. Pause on a frame and draw an object rectangle.');
    } catch {
      if (generation === state.generation && !state.result) {
        inputError(failureMessage);
      }
    } finally {
      if (generation === state.generation) {
        state.uploadBusy = false;
        controls();
      }
    }
  }

  function bindCapture(doc, mode) {
    state.result = validateResult(doc);
    state.mode = mode;
    state.captureBlocked = false;
    state.selectedTrack = null;
    $('mode').textContent = mode === 'saved' ? 'Saved SAM capture · no live request' : 'Live SAM capture · rectangle prompt';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = doc.tracks.length ? 'Select an object' : 'No objects found';
    $('trackselect').replaceChildren(placeholder);
    for (const track of doc.tracks) {
      const option = document.createElement('option');
      option.value = track.objectId;
      option.textContent = track.objectId + ' · ' + track.samples.length + ' observations';
      $('trackselect').append(option);
    }
    $('objectfield').hidden = doc.tracks.length === 0;
    if (state.videoHash && state.videoHash !== doc.provenance.source.sha256.toLowerCase()) {
      inputError('Video SHA256 does not match capture source.sha256.', true);
      return;
    }
    updatePresented();
    captureReady();
  }

  async function importCapture(file) {
    const generation = state.generation;
    const captureGeneration = ++state.captureGeneration;
    state.trackGeneration++;
    state.trackController?.abort();
    state.tracking = false;
    state.inputError = null;
    state.captureBlocked = false;
    state.result = null;
    state.selectedTrack = null;
    state.roi = null;
    state.roiDrag = null;
    clearFit();
    $('objectfield').hidden = true;
    controls();
    if (!file) { status('Import a saved SAM capture for the selected source.'); return; }
    status('Reading saved SAM capture…');
    try {
      const text = await file.text();
      if (generation !== state.generation || captureGeneration !== state.captureGeneration) return;
      bindCapture(validateResult(JSON.parse(text)), 'saved');
    } catch (error) {
      if (generation !== state.generation || captureGeneration !== state.captureGeneration) return;
      state.result = null;
      inputError('Invalid saved capture: ' + error.message, true);
    }
  }

  function selectTrack(id) {
    clearFit();
    state.selectedTrack = null;
    if (!gate()) return;
    state.selectedTrack = state.result.tracks.find((track) => track.objectId === id) || null;
    $('trackselect').value = state.selectedTrack?.objectId || '';
    if (state.selectedTrack) fitSelected();
    controls();
    renderOverlay();
  }

  function fitSelected() {
    if (!gate() || !state.selectedTrack) return;
    stopSimulation();
    state.fit = null;
    const fit = fitMotion(state.selectedTrack.samples, { axis: 'auto' });
    if (fit.status !== 'fitted') {
      clearFit();
      $('fitstatus').textContent = 'Fit rejected: ' + fit.reason + '. Interactive preview and export disabled.';
      controls();
      renderChart();
      return;
    }
    state.fit = fit;
    state.sim.position = 0;
    state.sim.velocity = 0;
    placeTarget(0);
    $('fitstatus').textContent = 'Fitted on ' + fit.axis + ' · ' + fit.metrics.sampleCount + ' source observations';
    $('frequency').textContent = fit.parameters.frequencyHz.toFixed(4);
    $('decay').textContent = fit.parameters.decay.toFixed(4);
    $('trainerror').textContent = fit.metrics.trainNrmse.toFixed(4);
    $('holdouterror').textContent = fit.metrics.holdoutNrmse.toFixed(4);
    $('code').textContent = exportSpring(fit);
    $('codeempty').hidden = true;
    target.hidden = false;
    $('previewempty').hidden = true;
    controls();
    renderChart();
  }

  function canvasSize(canvas, height) {
    const dpr = platform.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const cssHeight = height || canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, cssHeight);
    return { ctx, width, height: cssHeight };
  }

  function renderOverlay() {
    clearCanvas(overlay);
    if (!gate(true)) return;
    const { ctx } = canvasSize(overlay);
    const bounds = overlay.getBoundingClientRect();
    const rect = contentRect(bounds, video.videoWidth, video.videoHeight);
    let box = state.roi?.frameIndex === state.presentedIndex ? state.roi.box : null;
    let center = null;
    if (!box && state.selectedTrack && state.presentedIndex !== null) {
      const sample = state.selectedTrack.samples.find((item) => item.frameIndex === state.presentedIndex);
      if (sample) { box = sample.box; center = sample; }
    }
    if (!box) return;
    const x = rect.left - bounds.left + box.x1 * rect.scale;
    const y = rect.top - bounds.top + box.y1 * rect.scale;
    const width = (box.x2 - box.x1) * rect.scale;
    const height = (box.y2 - box.y1) * rect.scale;
    const corner = Math.min(14, width / 3, height / 3);
    for (const [color, lineWidth] of [['#000', 4], ['#fff', 2]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + width, y, -1, 1], [x, y + height, 1, -1], [x + width, y + height, -1, -1]]) {
        ctx.moveTo(cx + dx * corner, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * corner);
      }
      ctx.stroke();
    }
    if (center) {
      ctx.fillStyle = '#ededed';
      ctx.beginPath();
      ctx.arc(rect.left - bounds.left + center.x * rect.scale, rect.top - bounds.top + center.y * rect.scale, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function renderChart() {
    clearCanvas(chart);
    if (!gate() || !state.selectedTrack) return;
    const { ctx, width, height } = canvasSize(chart, 230);
    const samples = state.selectedTrack.samples;
    const axis = state.fit?.axis || 'x';
    const start = samples[0].t;
    const end = samples.at(-1).t;
    const values = samples.map((sample) => sample[axis]);
    const predicted = state.fit ? Array.from({ length: 401 }, (_, i) => {
      const time = start + (end - start) * i / 400;
      return { time, value: predictMotion(state.fit.parameters, time) };
    }) : [];
    let minimum = Math.min(...values, ...predicted.map((point) => point.value));
    let maximum = Math.max(...values, ...predicted.map((point) => point.value));
    const padding = (maximum - minimum) * 0.1 || 1;
    minimum -= padding;
    maximum += padding;
    const x = (time) => 48 + (width - 64) * (time - start) / (end - start || 1);
    const y = (value) => height - 30 - (height - 52) * (value - minimum) / (maximum - minimum);
    ctx.strokeStyle = '#2e2e2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, 16); ctx.lineTo(48, height - 30); ctx.lineTo(width - 16, height - 30);
    ctx.stroke();
    ctx.font = '10px "Geist Mono"';
    ctx.fillStyle = '#8f8f8f';
    ctx.fillText(axis + ' px', 8, 18);
    ctx.fillText(maximum.toFixed(0), 8, 34);
    ctx.fillText(minimum.toFixed(0), 8, height - 30);
    ctx.fillText(start.toFixed(3) + 's', 48, height - 10);
    ctx.fillText(end.toFixed(3) + 's', Math.max(48, width - 78), height - 10);
    if (predicted.length) {
      ctx.strokeStyle = '#ededed';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      predicted.forEach((point, i) => {
        if (i === 0) ctx.moveTo(x(point.time), y(point.value));
        else ctx.lineTo(x(point.time), y(point.value));
      });
      ctx.stroke();
    }
    ctx.fillStyle = '#8f8f8f';
    for (const sample of samples) {
      ctx.beginPath();
      ctx.arc(x(sample.t), y(sample[axis]), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    $('chartempty').hidden = true;
  }

  function seekFrame(index) {
    if (!gate(true) || !times()) return;
    try {
      const time = seekTimeForFrame(times(), index, video.duration);
      video.pause();
      state.frameReady = false;
      state.presentedTime = null;
      state.seekTarget = index;
      if (state.roi?.frameIndex !== index) state.roi = null;
      clearCanvas(overlay);
      video.currentTime = time;
      controls();
    } catch {
      inputError('That source frame could not be presented. Choose a valid frame.');
    }
  }

  function clearForBox() {
    state.captureGeneration++;
    state.trackGeneration++;
    state.trackController?.abort();
    state.tracking = false;
    state.result = null;
    state.selectedTrack = null;
    state.inputError = null;
    state.captureBlocked = false;
    state.mode = null;
    clearFit();
    $('objectfield').hidden = true;
    $('mode').textContent = 'Rectangle prompt · no point guessing';
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (!gate(true)) return;
    const wasPlaying = !video.paused;
    video.pause();
    if (wasPlaying || video.seeking || !state.frameReady || state.presentedIndex === null) {
      if (wasPlaying && state.presentedIndex !== null) seekFrame(state.presentedIndex);
      status('Wait for a paused, presented source frame before drawing.');
      controls();
      return;
    }
    const rect = contentRect(overlay.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    clearForBox();
    state.roi = null;
    state.roiDrag = {
      start: sourcePoint(event.clientX, event.clientY, rect, video.videoWidth, video.videoHeight),
      frameIndex: state.presentedIndex, pointerId: event.pointerId,
    };
    overlay.setPointerCapture(event.pointerId);
    controls();
  });

  overlay.addEventListener('pointermove', (event) => {
    if (!gate(true) || !state.roiDrag || event.pointerId !== state.roiDrag.pointerId) return;
    const rect = contentRect(overlay.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    const point = sourcePoint(event.clientX, event.clientY, rect, video.videoWidth, video.videoHeight);
    const box = sourceBox(state.roiDrag.start, point);
    state.roi = box ? { frameIndex: state.roiDrag.frameIndex, box } : null;
    renderOverlay();
    controls();
  });

  overlay.addEventListener('pointerup', (event) => {
    if (!gate(true) || !state.roiDrag || event.pointerId !== state.roiDrag.pointerId) return;
    const rect = contentRect(overlay.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    const point = sourcePoint(event.clientX, event.clientY, rect, video.videoWidth, video.videoHeight);
    const box = sourceBox(state.roiDrag.start, point);
    state.roi = box ? { frameIndex: state.roiDrag.frameIndex, box } : null;
    state.roiDrag = null;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    $('roistatus').textContent = state.roi
      ? 'Frame ' + state.roi.frameIndex + ' · [' + Object.values(state.roi.box).join(', ') + '] source pixels'
      : 'Draw a rectangle at least 4 source pixels wide and tall.';
    renderOverlay();
    controls();
  });
  overlay.addEventListener('pointercancel', () => { state.roiDrag = null; state.roi = null; clearCanvas(overlay); controls(); });

  $('trackbtn').addEventListener('click', async () => {
    if (!gate(true) || !state.health?.modelConfigured || !state.health?.trackingAvailable
      || !state.upload || !state.roi || !state.frameReady || !video.paused || video.seeking
      || state.roi.frameIndex !== state.presentedIndex || state.tracking) return;
    const generation = state.generation;
    const trackGeneration = ++state.trackGeneration;
    const seed = { frameIndex: state.roi.frameIndex, box: { ...state.roi.box } };
    state.captureGeneration++;
    state.trackController?.abort();
    state.trackController = new platform.AbortController();
    state.inputError = null;
    state.tracking = true;
    clearFit();
    controls();
    status('Tracking this rectangle with Meta SAM 3.1. No automatic retries.');
    let failureMessage = 'Tracking failed. Check local server availability, then choose a new input. No retry was sent.';
    try {
      const response = await platform.fetch('/api/videos/' + encodeURIComponent(state.upload.id) + '/tracks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(seed), signal: state.trackController.signal,
      });
      if (generation !== state.generation || trackGeneration !== state.trackGeneration) return;
      let doc;
      try {
        doc = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) failureMessage = 'Invalid local tracking response: ' + error.message;
        throw error;
      }
      if (generation !== state.generation || trackGeneration !== state.trackGeneration) return;
      if (!response.ok) {
        failureMessage = serverErrorMessage(doc, failureMessage);
        throw new Error(failureMessage);
      }
      try {
        bindCapture(validateResult(doc), 'live');
      } catch (error) {
        failureMessage = error.message;
        throw error;
      }
    } catch {
      if (generation === state.generation && trackGeneration === state.trackGeneration) {
        inputError(failureMessage, true);
        await refreshHealth();
      }
    } finally {
      if (generation === state.generation && trackGeneration === state.trackGeneration) {
        state.tracking = false;
        controls();
      }
    }
  });

  function startSimulation(position, velocity = 0) {
    stopSimulation();
    if (!gate() || !state.fit) return;
    video.pause();
    Object.assign(state.sim, {
      position, velocity, initialPosition: position, initialVelocity: velocity,
      start: platform.performance.now(), running: true, pending: null,
    });
    placeTarget(position);
    controls();
    $('simstatus').textContent = 'New release · fitted spring, not a source-path replay.';
    const generation = state.generation;
    const fit = state.fit;
    const step = (now) => {
      state.sim.raf = 0;
      if (!gate() || !state.fit || state.fit !== fit || generation !== state.generation || !state.sim.running) return;
      const result = springState(fit.parameters, Math.max(0, (now - state.sim.start) / 1000), {
        position: state.sim.initialPosition, velocity: state.sim.initialVelocity,
      });
      state.sim.position = result.position;
      state.sim.velocity = result.velocity;
      placeTarget(result.position);
      state.sim.raf = platform.requestAnimationFrame(step);
    };
    state.sim.raf = platform.requestAnimationFrame(step);
  }

  function changeTarget(name) {
    if (!gate() || !state.fit || !['dot', 'button', 'toast'].includes(name)) return;
    state.target = name;
    target.dataset.target = name;
    $('targetlabel').textContent = name === 'button' ? 'Ship it' : name === 'toast' ? 'Changes saved' : '';
    for (const tab of tabs) {
      const active = tab.dataset.targetTab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    }
    $('previewstage').setAttribute('aria-labelledby', 'tab-' + name);
    placeTarget(state.sim.position);
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => changeTarget(tab.dataset.targetTab));
    tab.addEventListener('keydown', (event) => {
      if (!gate() || !state.fit) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      changeTarget(tabs[next].dataset.targetTab);
      tabs[next].focus();
    });
  }

  target.addEventListener('pointerdown', (event) => {
    if (!gate() || !state.fit) return;
    video.pause();
    stopSimulation();
    const rect = $('previewstage').getBoundingClientRect();
    const now = platform.performance.now();
    state.sim.position = placeTarget(state.sim.position);
    state.sim.grabOffset = event.clientX - (rect.left + rect.width / 2 + state.sim.position);
    state.sim.dragging = true;
    state.sim.history = [{ time: now, position: state.sim.position }];
    state.sim.lastMovement = now;
    state.sim.pending = null;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  target.addEventListener('pointermove', (event) => {
    if (!gate() || !state.fit || !state.sim.dragging) return;
    const rect = $('previewstage').getBoundingClientRect();
    const position = placeTarget(event.clientX - rect.left - rect.width / 2 - state.sim.grabOffset);
    const now = platform.performance.now();
    if (position !== state.sim.position) state.sim.lastMovement = now;
    state.sim.position = position;
    state.sim.history.push({ time: now, position });
    state.sim.history = state.sim.history.filter((sample) => sample.time >= now - 160);
  });
  target.addEventListener('pointerup', (event) => {
    if (!gate() || !state.fit || !state.sim.dragging) return;
    state.sim.dragging = false;
    const now = platform.performance.now();
    const rect = $('previewstage').getBoundingClientRect();
    const position = placeTarget(event.clientX - rect.left - rect.width / 2 - state.sim.grabOffset);
    if (position !== state.sim.position) state.sim.lastMovement = now;
    state.sim.position = position;
    state.sim.history.push({ time: now, position: state.sim.position });
    const velocity = releaseVelocity(state.sim.history, now, state.sim.lastMovement);
    state.sim.velocity = velocity;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (reducedMotion) {
      state.sim.pending = { position: state.sim.position, velocity };
      $('runbtn').textContent = 'Run release';
      $('simstatus').textContent = 'Reduced motion: release held. Press Run release to animate.';
    } else startSimulation(state.sim.position, velocity);
  });
  target.addEventListener('pointercancel', () => { state.sim.dragging = false; });
  target.addEventListener('lostpointercapture', () => { state.sim.dragging = false; });
  target.addEventListener('keydown', (event) => {
    if (!gate() || !state.fit) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      stopSimulation();
      video.pause();
      state.sim.position = placeTarget(state.sim.position + (event.key === 'ArrowRight' ? 8 : -8));
      state.sim.velocity = 0;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startSimulation(state.sim.position, 0);
    }
  });
  $('runbtn').addEventListener('click', () => {
    if (!gate() || !state.fit) return;
    const initial = state.sim.pending || { position: 80, velocity: 0 };
    $('runbtn').textContent = 'Release from 80px';
    startSimulation(initial.position, initial.velocity);
  });
  $('stopbtn').addEventListener('click', () => {
    if (!gate() || !state.fit) return;
    stopSimulation();
    $('simstatus').textContent = 'Stopped at the current position. Release again to restart.';
  });

  $('exportbtn').addEventListener('click', () => {
    if (!gate() || !state.fit) return;
    const blob = new platform.Blob([exportSpring(state.fit)], { type: 'text/javascript; charset=utf-8' });
    const anchor = document.createElement('a');
    const url = platform.URL.createObjectURL(blob);
    try {
      anchor.href = url;
      anchor.download = 'motionforge-spring.mjs';
      document.body.append(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      platform.URL.revokeObjectURL(url);
    }
  });
  $('copybtn').addEventListener('click', async () => {
    if (!gate() || !state.fit) return;
    const fit = state.fit;
    try {
      await platform.navigator.clipboard.writeText(exportSpring(fit));
      if (state.fit === fit && gate()) status('JavaScript spring copied.');
    } catch {
      if (state.fit === fit && gate()) status('Clipboard unavailable. Download the JavaScript module instead.');
    }
  });
  $('videofile').addEventListener('change', () => {
    const file = $('videofile').files[0];
    $('videofile').value = '';
    return loadVideo(file);
  });
  $('capturefile').addEventListener('change', () => {
    const file = $('capturefile').files[0];
    $('capturefile').value = '';
    return importCapture(file);
  });
  $('trackselect').addEventListener('change', () => selectTrack($('trackselect').value));
  $('frameslider').addEventListener('input', () => seekFrame(Number($('frameslider').value)));
  $('playbtn').addEventListener('click', async () => {
    if (!gate(true)) return;
    if (video.paused) {
      try { await video.play(); } catch { status('Playback unavailable. Use the source-frame slider.'); }
    } else {
      video.pause();
      if (state.presentedIndex !== null) seekFrame(state.presentedIndex);
    }
    controls();
  });
  video.addEventListener('seeked', () => { updatePresented(); renderOverlay(); controls(); });
  video.addEventListener('timeupdate', renderOverlay);
  video.addEventListener('play', controls);
  video.addEventListener('pause', controls);
  video.addEventListener('ended', controls);
  $('dropzone').addEventListener('dragover', (event) => {
    event.preventDefault();
    $('dropzone').classList.add('is-dragging');
  });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('is-dragging'));
  $('dropzone').addEventListener('drop', (event) => {
    event.preventDefault();
    $('dropzone').classList.remove('is-dragging');
    loadVideo(event.dataTransfer.files[0]);
  });
  platform.addEventListener('resize', () => {
    renderOverlay();
    if (state.result) renderChart();
    if (state.fit && gate()) placeTarget(state.sim.position);
  });

  async function refreshHealth() {
    try {
      const response = await platform.fetch('/api/health');
      const health = await response.json();
      const configured = response.ok && health.modelConfigured === true;
      state.health = { modelConfigured: configured, trackingAvailable: configured && health.trackingAvailable === true };
    } catch {
      state.health = { modelConfigured: false, trackingAvailable: false };
    }
    $('healthstatus').textContent = state.health.trackingAvailable
      ? 'Live tracking available on the local server.'
      : state.health.modelConfigured
        ? 'Tracking is blocked. Resolve provider access or rate limits, then restart the local server. Saved captures still work.'
        : 'Configure MODEL_API_KEY on the local server to enable tracking. Saved capture import still works.';
    controls();
  }

  clearFit();
  controls();
  const ready = refreshHealth();

  return { state, ready, loadVideo, importCapture, gate, selectTrack, fitSelected,
    renderOverlay, renderChart, seekFrame, startSimulation, stopSimulation, changeTarget };
}

if (typeof document !== 'undefined') createProductApp(document);
