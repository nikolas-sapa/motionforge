import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSpring } from '../src/export-spring.mjs';
import { springState } from '../src/motion-fit.mjs';

const fit = { status: 'fitted', parameters: { decay: 0.4, omega: 3 } };
const load = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('generated module is dependency-free and contains only spring coefficients, not recorded motion', async () => {
  const code = exportSpring({ ...fit, samples: ['PRIVATE_TRACK_MARKER'], parameters: { ...fit.parameters, a: 12345 } });
  assert.doesNotMatch(code, /\bimport\b|PRIVATE_TRACK_MARKER|12345|samples/);
  const module = await load(code);
  assert.deepEqual(module.parameters, { decay: 0.4, omega: 3 });
  assert.equal(Object.isFrozen(module.parameters), true);
});

test('generated sample supports new positions and velocities, with exact initial conditions', async () => {
  const module = await load(exportSpring(fit));
  for (const initial of [{ position: 80, velocity: 0 }, { position: -35, velocity: 12 }]) {
    assert.deepEqual(module.sample(0, initial), initial);
    for (const t of [0.1, 0.5, 2, 10]) {
      assert.deepEqual(module.sample(t, initial), springState(fit.parameters, t, initial));
    }
  }
  assert.deepEqual(module.sample(0), { position: 1, velocity: 0 });
});

test('generated module retains invalid-time and invalid-release guards', async () => {
  const module = await load(exportSpring(fit));
  for (const t of [-1, NaN, Infinity]) assert.throws(() => module.sample(t), RangeError);
  assert.throws(() => module.sample(0, { position: Infinity }), RangeError);
});

test('export rejects absent or rejected fits', () => {
  for (const value of [null, {}, { status: 'rejected' }, { status: 'fitted' }]) {
    assert.throws(() => exportSpring(value), TypeError);
  }
});

test('export rejects invalid, nonnumeric, and overflowing coefficients rather than serializing null', () => {
  for (const parameters of [
    { decay: -1, omega: 3 }, { decay: 0.4, omega: 0 },
    { decay: NaN, omega: 3 }, { decay: Infinity, omega: 3 },
    { decay: '0.4', omega: 3 }, { decay: 0.4, omega: '3' },
    { decay: 0.4, omega: 1e200 }, { decay: 1e200, omega: 3 },
    { decay: 1, omega: Number.MIN_VALUE },
  ]) {
    assert.throws(() => exportSpring({ status: 'fitted', parameters }), RangeError);
  }
});
