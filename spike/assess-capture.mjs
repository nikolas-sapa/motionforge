import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fitMotion } from '../src/motion-fit.mjs';
import { validateResult } from './viewer-state.mjs';

const args = process.argv.slice(2);
if (args.length !== 4) {
  console.error('Expected capture path, source video path, object id, and new assessment output path');
  process.exitCode = 2;
} else {
  const [capturePath, videoPath, objectId, outputPath] = args;
  try {
    const capture = validateResult(JSON.parse(await readFile(capturePath, 'utf8')));
    const sourceHash = createHash('sha256').update(await readFile(videoPath)).digest('hex');
    if (sourceHash !== capture.provenance.source.sha256.toLowerCase()) {
      throw new Error('Source video does not match capture');
    }
    const track = capture.tracks.find((candidate) => candidate.objectId === objectId);
    if (!track) throw new Error('Requested object id not found; inspect capture before selecting');
    const report = {
      assessedAt: new Date().toISOString(),
      sourceHash,
      responseId: capture.provenance.responseId,
      model: capture.provenance.model,
      objectId,
      measurement: capture.provenance.measurement,
      fit: fitMotion(track.samples),
      limitations: [
        'Bounding-box centers approximate observed screen-space motion.',
        'A successful fit is not proof of correct object identity; inspect overlays.',
        'Simulation mass is fixed to one, not recovered from video.',
        'Held-out observations are interleaved, not future-input validation.',
      ],
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`assessment: ${report.fit.status}; saved ${outputPath}`);
    process.exitCode = report.fit.status === 'fitted' ? 0 : 1;
  } catch (error) {
    console.error(`assessment failed: ${error.message}`);
    process.exitCode = 2;
  }
}
