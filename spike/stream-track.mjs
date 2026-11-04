import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { parseSamBoxes } from './sam-api.mjs';
import { validateResult } from './viewer-state.mjs';

let stage = 'input-validation';
try {
  const mode = process.argv[2];
  if (!['baseline', 'seeded'].includes(mode)) throw new Error('Invalid mode');
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error('Missing credential');
  const original = validateResult(JSON.parse(await readFile('results/oscillator-sam.capture.json', 'utf8')));
  const hash = createHash('sha256')
    .update(await readFile('uploads/physical-oscillator-6s-8s.mp4')).digest('hex');
  if (hash !== original.provenance.source.sha256) throw new Error('Source changed');
  const prefix = mode === 'baseline' ? 'results/oscillator-stream' : 'results/oscillator-seeded';
  try {
    await lstat(`${prefix}.request.json`);
    throw new Error('Attempt already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const prompt = mode === 'baseline'
    ? 'blue box'
    : '<141f>1<|box;x1=105;y1=154;x2=390;y2=252;w=640;h=480|>';
  const request = {
    model: 'sam-3.1',
    stream: true,
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_video', file_id: original.provenance.source.fileId },
      ],
    }],
  };
  if (mode === 'seeded') request.metadata = { propagation_direction: 'both' };
  await writeFile(`${prefix}.request.json`, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });
  stage = 'request';
  const response = await fetch('https://api.meta.ai/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    console.error(`SAM stream HTTP status ${response.status}`);
    throw new Error('Provider rejected request');
  }
  stage = 'stream-read';
  const raw = await response.text();
  await writeFile(`${prefix}.response.sse`, raw, { flag: 'wx' });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected SSE response');
  }
  stage = 'event-decoding';
  const events = [];
  for (const block of raw.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') events.push(JSON.parse(data));
  }
  const completed = events.findLast((event) => event.type === 'response.completed')?.response;
  if (completed?.status !== 'completed' || !completed.id) throw new Error('Stream incomplete');
  const deltas = events.filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta);
  if (!deltas.every((delta) => typeof delta === 'string')) throw new Error('Invalid delta');
  const frameText = (text) => text.replace(/\|>(?=<\d+f>)/g, '|>\n');
  stage = 'record-decoding';
  const records = parseSamBoxes(frameText(deltas.join('')));
  const byObject = new Map();
  for (const record of records) {
    if (record.frameIndex >= original.video.frameCount
      || record.width !== original.video.width || record.height !== original.video.height) {
      throw new Error('Source-frame mismatch');
    }
    if (!byObject.has(record.objectId)) byObject.set(record.objectId, []);
    byObject.get(record.objectId).push({
      frameIndex: record.frameIndex,
      t: original.video.timestamps[record.frameIndex],
      x: (record.x1 + record.x2) / 2,
      y: (record.y1 + record.y2) / 2,
      box: { x1: record.x1, y1: record.y1, x2: record.x2, y2: record.y2 },
    });
  }
  const capture = validateResult({
    schemaVersion: 1,
    provenance: {
      kind: 'meta-sam-live',
      model: 'sam-3.1',
      responseId: completed.id,
      createdAt: completed.created_at ?? null,
      measurement: 'bounding-box-center',
      source: original.provenance.source,
    },
    video: original.video,
    tracks: [...byObject].map(([objectId, samples]) => ({ objectId, samples })),
  });
  const finalText = (completed.output ?? [])
    .flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text')
    .map((part) => part.text).join('');
  let finalMessageFrames = null;
  try {
    finalMessageFrames = new Set(parseSamBoxes(frameText(finalText)).map((r) => r.frameIndex)).size;
  } catch {}
  const diagnostics = {
    mode,
    responseId: completed.id,
    sourceFrames: original.video.frameCount,
    observedFrames: new Set(records.map((r) => r.frameIndex)).size,
    firstFrame: records[0]?.frameIndex ?? null,
    lastFrame: records.at(-1)?.frameIndex ?? null,
    eventCount: events.length,
    deltaEvents: deltas.length,
    finalMessageFrames,
  };
  stage = 'artifact-write';
  await writeFile(`${prefix}.capture.json`, `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
  await writeFile(`${prefix}.diagnostics.json`, `${JSON.stringify(diagnostics, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(diagnostics));
} catch {
  console.error(`Streaming spike failed at ${stage}; no retries performed`);
  process.exitCode = 1;
}
