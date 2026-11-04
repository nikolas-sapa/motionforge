import assert from 'node:assert/strict';
import test from 'node:test';
import { fitMotion, predictMotion, springState } from '../src/motion-fit.mjs';

function track({
  frequency = 1.2,
  decay = 0.45,
  amplitude = 80,
  phase = 0.4,
  offset = 220,
  duration = 5,
  fps = 30,
  axis = 'x',
  start = 0,
  noise = 0,
  irregular = false,
} = {}) {
  const samples = [];
  for (let i = 0; i <= duration * fps; i += 1) {
    const t = i / fps + (irregular && i > 0 ? Math.sin(i * 1.7) * 0.003 : 0);
    const p = offset + amplitude * Math.exp(-decay * t)
      * Math.cos(2 * Math.PI * frequency * t + phase)
      + noise * Math.sin(i * 2.3999632297);
    samples.push({ t: start + t, x: axis === 'x' ? p : 100, y: axis === 'y' ? p : 100 });
  }
  return samples;
}

for (const [frequency, decay] of [[1.2, 0.45], [0.65, 0.18], [2.25, 0.9]]) {
  test(`recover ${frequency} Hz / ${decay} s^-1 within 2% / 0.03 s^-1`, () => {
    const samples = track({ frequency, decay });
    const fit = fitMotion(samples);
    assert.equal(fit.status, 'fitted', JSON.stringify(fit));
    assert.ok(Math.abs(fit.parameters.frequencyHz - frequency) / frequency < 0.02);
    assert.ok(Math.abs(fit.parameters.decay - decay) < 0.03);
    assert.ok(fit.metrics.holdoutNrmse < 0.01);
    assert.ok(fit.metrics.trainNrmse < 0.01);
    assert.equal(fit.parameters.mass, 1);
    assert.ok(Math.abs(fit.parameters.stiffness
      - (fit.parameters.omega ** 2 + fit.parameters.decay ** 2)) < 1e-10);
    assert.ok(Math.abs(fit.parameters.damping - 2 * fit.parameters.decay) < 1e-10);
    assert.ok(Math.abs(predictMotion(fit.parameters, samples[0].t) - samples[0].x) < 1);
  });
}

test('recover noisy irregular timestamps within 3% frequency and 0.02 normalized error', () => {
  const samples = track({ noise: 0.4, irregular: true }).filter((_, i) => i % 7 !== 3);
  const fit = fitMotion(samples);
  assert.equal(fit.status, 'fitted', JSON.stringify(fit));
  assert.ok(Math.abs(fit.parameters.frequencyHz - 1.2) / 1.2 < 0.03);
  assert.ok(fit.metrics.holdoutNrmse < 0.02);
});

test('choose vertical motion and preserve a nonzero source timestamp', () => {
  const samples = track({ axis: 'y', start: 12.5 });
  const fit = fitMotion(samples);
  assert.equal(fit.status, 'fitted', JSON.stringify(fit));
  assert.equal(fit.axis, 'y');
  assert.equal(fit.parameters.t0, 12.5);
  assert.ok(Math.abs(predictMotion(fit.parameters, 12.5) - samples[0].y) < 1);
});

test('accept undamped oscillation without inventing negative decay', () => {
  const fit = fitMotion(track({ decay: 0 }));
  assert.equal(fit.status, 'fitted', JSON.stringify(fit));
  assert.ok(fit.parameters.decay >= 0 && fit.parameters.decay < 0.03);
});

test('honor a selected axis rather than silently switching to the moving axis', () => {
  assert.equal(fitMotion(track(), { axis: 'y' }).reason, 'stationary');
});

for (const [name, samples, reason] of [
  ['empty', [], 'insufficient-samples'],
  ['39 observations', track().slice(0, 39), 'insufficient-samples'],
  ['stationary', track({ amplitude: 0 }), 'stationary'],
  ['one-second clip', track({ duration: 1, fps: 60 }), 'insufficient-duration'],
  ['NaN coordinate', track().map((s, i) => i === 4 ? { ...s, x: NaN } : s), 'invalid-samples'],
  ['duplicate timestamp', track().map((s, i, a) => i === 4 ? { ...s, t: a[3].t } : s), 'invalid-samples'],
  ['reversed time', track().reverse(), 'invalid-samples'],
  ['large missing interval', track().filter((s) => s.t < 1 || s.t > 2), 'tracking-gap'],
]) {
  test(`reject ${name}: ${reason}`, () => {
    const result = fitMotion(samples);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, reason);
    assert.equal(result.parameters, undefined);
  });
}

test('reject a monotonic drift rather than label it a spring', () => {
  const samples = track().map((s) => ({ ...s, x: 100 + 20 * s.t }));
  assert.equal(fitMotion(samples).status, 'rejected');
});

test('reject two strong frequencies that a single spring cannot represent', () => {
  const samples = track({ decay: 0 }).map((s) => ({
    ...s,
    x: s.x + 65 * Math.cos(2 * Math.PI * 2.1 * s.t),
  }));
  const result = fitMotion(samples);
  assert.equal(result.status, 'rejected');
  assert.equal(result.parameters, undefined);
});

test('held-out observations can reject a fit even when training observations are clean', () => {
  const samples = track().map((s, i) => ({
    ...s,
    x: s.x + (i % 5 === 0 ? 45 * (i % 10 === 0 ? 1 : -1) : 0),
  }));
  const result = fitMotion(samples);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'poor-fit');
});

test('reject an isolated large tracking jump', () => {
  const samples = track().map((s, i) => i === 57 ? { ...s, x: s.x + 500 } : s);
  assert.equal(fitMotion(samples).status, 'rejected');
});

test('spring state honors release position and velocity within 1e-10', () => {
  const p = { decay: 0.45, omega: 2 * Math.PI * 1.2 };
  const state = springState(p, 0, { position: 0.7, velocity: -0.3 });
  assert.ok(Math.abs(state.position - 0.7) < 1e-10);
  assert.ok(Math.abs(state.velocity + 0.3) < 1e-10);
});

test('interactive release reproduces the fitted displacement within 1e-8', () => {
  const fit = fitMotion(track());
  assert.equal(fit.status, 'fitted', JSON.stringify(fit));
  const p = fit.parameters;
  for (let i = 0; i < 100; i += 1) {
    const t = i / 23;
    const state = springState(p, t, {
      position: p.a,
      velocity: p.omega * p.b - p.decay * p.a,
    });
    assert.ok(Math.abs(state.position + p.offset - predictMotion(p, p.t0 + t)) < 1e-8);
  }
});

test('damped spring settles below 0.01 of release displacement after 20 seconds', () => {
  const state = springState({ decay: 0.45, omega: 2 * Math.PI * 1.2 }, 20);
  assert.ok(Math.abs(state.position) < 0.01);
});

test('analytic release agrees with independent RK4 integration within 1e-6', () => {
  for (const [decay, omega] of [[0, 4], [0.3, 9], [1.1, 16]]) {
    const stiffness = omega ** 2 + decay ** 2;
    const derivative = ([x, v]) => [v, -2 * decay * v - stiffness * x];
    const add = (state, delta, factor) => state.map((value, i) => value + delta[i] * factor);
    let state = [0.7, -0.3];
    const dt = 0.001;
    for (let step = 0; step < 1000; step += 1) {
      const a = derivative(state);
      const b = derivative(add(state, a, dt / 2));
      const c = derivative(add(state, b, dt / 2));
      const d = derivative(add(state, c, dt));
      state = state.map((value, i) => value + dt * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
    }
    const analytic = springState({ decay, omega }, 1, { position: 0.7, velocity: -0.3 });
    assert.ok(Math.abs(analytic.position - state[0]) < 1e-6);
    assert.ok(Math.abs(analytic.velocity - state[1]) < 1e-6);
  }
});

test('reject a 9 Hz signal outside the supported motion family', () => {
  const result = fitMotion(track({ frequency: 9, decay: 0.2 }));
  assert.equal(result.status, 'rejected');
});

test('invalid spring parameters or negative time throw instead of exporting unsafe numbers', () => {
  assert.throws(() => springState({ decay: -1, omega: 3 }, 1));
  assert.throws(() => springState({ decay: 1, omega: 0 }, 1));
  assert.throws(() => springState({ decay: 1, omega: 3 }, -1));
  assert.throws(() => fitMotion(track(), { axis: 'z' }));
});
