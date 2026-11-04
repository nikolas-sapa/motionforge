export const FIT_LIMITS = Object.freeze({
  minSamples: 40,
  maxSamples: 1200,
  minDuration: 2,
  minSpanPixels: 4,
  maxGapSeconds: 0.5,
  minFrequencyHz: 0.35,
  maxFrequencyHz: 4,
  maxDecay: 2.5,
  maxTrainNrmse: 0.08,
  maxHoldoutNrmse: 0.1,
  maxPointError: 0.3,
});

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function span(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.95) - quantile(sorted, 0.05);
}

function solve(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-10) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let j = column; j < 4; j += 1) a[column][j] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let j = column; j < 4; j += 1) a[row][j] -= factor * a[column][j];
    }
  }
  return a.map((row) => row[3]);
}

function candidate(rows, decay, frequency) {
  const omega = 2 * Math.PI * frequency;
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const vector = [0, 0, 0];
  const basis = [];
  for (const { t, value } of rows) {
    const envelope = Math.exp(-decay * t);
    const terms = [1, envelope * Math.cos(omega * t), envelope * Math.sin(omega * t)];
    basis.push(terms);
    for (let i = 0; i < 3; i += 1) {
      vector[i] += terms[i] * value;
      for (let j = 0; j < 3; j += 1) matrix[i][j] += terms[i] * terms[j];
    }
  }
  const coefficients = solve(matrix, vector);
  if (!coefficients?.every(Number.isFinite)) return null;
  let loss = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const predicted = basis[i].reduce((sum, term, j) => sum + term * coefficients[j], 0);
    loss += (rows[i].value - predicted) ** 2;
  }
  return { coefficients, decay, omega, frequency, loss };
}

export function fitMotion(samples, { axis = 'auto' } = {}) {
  if (!['auto', 'x', 'y'].includes(axis)) throw new RangeError('Axis must be auto, x, or y');
  const reject = (reason) => ({ status: 'rejected', reason });
  if (!Array.isArray(samples)) return reject('invalid-samples');
  if (samples.length < FIT_LIMITS.minSamples) return reject('insufficient-samples');
  if (samples.length > FIT_LIMITS.maxSamples) return reject('too-many-samples');
  if (samples.some((s, i) => !s || ![s.t, s.x, s.y].every(Number.isFinite)
    || (i > 0 && s.t <= samples[i - 1].t))) return reject('invalid-samples');
  const t0 = samples[0].t;
  const duration = samples.at(-1).t - t0;
  if (duration < FIT_LIMITS.minDuration) return reject('insufficient-duration');
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
  if (Math.max(...gaps) > FIT_LIMITS.maxGapSeconds) return reject('tracking-gap');
  const spanX = span(samples.map((s) => s.x));
  const spanY = span(samples.map((s) => s.y));
  const selectedAxis = axis === 'auto' ? (spanX >= spanY ? 'x' : 'y') : axis;
  const scale = selectedAxis === 'x' ? spanX : spanY;
  if (scale < FIT_LIMITS.minSpanPixels) return reject('stationary');
  const rows = samples.map((s) => ({ t: s.t - t0, value: s[selectedAxis] }));
  const training = rows.filter((_, i) => i % 5 !== 0);
  const holdout = rows.filter((_, i) => i % 5 === 0);
  const medianGap = quantile([...gaps].sort((a, b) => a - b), 0.5);
  const frequencyMin = Math.max(FIT_LIMITS.minFrequencyHz, 1.5 / duration);
  const frequencyMax = Math.min(FIT_LIMITS.maxFrequencyHz, 0.4 / medianGap);
  if (frequencyMax <= frequencyMin) return reject('insufficient-sampling');
  let best = null;
  const consider = (decay, frequency) => {
    const fit = candidate(training, decay, frequency);
    if (fit && (!best || fit.loss < best.loss)) best = fit;
  };
  let frequencyStep = (frequencyMax - frequencyMin) / 120;
  let decayStep = FIT_LIMITS.maxDecay / 40;
  for (let fi = 0; fi <= 120; fi += 1) {
    for (let di = 0; di <= 40; di += 1) {
      consider(di * decayStep, frequencyMin + fi * frequencyStep);
    }
  }
  if (!best) return reject('singular-fit');
  for (let refinement = 0; refinement < 3; refinement += 1) {
    const center = best;
    for (let fi = -6; fi <= 6; fi += 1) {
      const frequency = center.frequency + fi * frequencyStep / 6;
      if (frequency < frequencyMin || frequency > frequencyMax) continue;
      for (let di = -6; di <= 6; di += 1) {
        const decay = center.decay + di * decayStep / 6;
        if (decay < 0 || decay > FIT_LIMITS.maxDecay) continue;
        consider(decay, frequency);
      }
    }
    frequencyStep /= 6;
    decayStep /= 6;
  }
  const [offset, a, b] = best.coefficients;
  const parameters = {
    offset,
    a,
    b,
    decay: best.decay,
    omega: best.omega,
    frequencyHz: best.frequency,
    mass: 1,
    stiffness: best.omega ** 2 + best.decay ** 2,
    damping: 2 * best.decay,
    t0,
  };
  const errorFor = (row) => row.value - predictMotion(parameters, row.t + t0);
  const nrmse = (set) => Math.sqrt(set.reduce((sum, row) => sum + errorFor(row) ** 2, 0)
    / set.length) / scale;
  const metrics = {
    trainNrmse: nrmse(training),
    holdoutNrmse: nrmse(holdout),
    maxNormalizedError: Math.max(...rows.map((row) => Math.abs(errorFor(row)))) / scale,
    sampleCount: samples.length,
    duration,
    spanPixels: scale,
  };
  if (metrics.trainNrmse > FIT_LIMITS.maxTrainNrmse
    || metrics.holdoutNrmse > FIT_LIMITS.maxHoldoutNrmse
    || metrics.maxNormalizedError > FIT_LIMITS.maxPointError) return reject('poor-fit');
  let previousSign = 0;
  let crossings = 0;
  for (const { value } of rows) {
    const displacement = value - offset;
    if (Math.abs(displacement) < scale * 0.04) continue;
    const sign = Math.sign(displacement);
    if (previousSign && sign !== previousSign) crossings += 1;
    previousSign = sign;
  }
  if (crossings < 3) return reject('insufficient-oscillation');
  if (Math.max(...gaps) > 0.75 / best.frequency) return reject('tracking-gap');
  return { status: 'fitted', axis: selectedAxis, parameters, metrics };
}

export function predictMotion(parameters, timestamp) {
  const { offset, a, b, decay, omega, t0 } = parameters;
  const t = timestamp - t0;
  return offset + Math.exp(-decay * t) * (a * Math.cos(omega * t) + b * Math.sin(omega * t));
}

export function springState({ decay, omega }, t, { position = 1, velocity = 0 } = {}) {
  if (![decay, omega, t, position, velocity].every(Number.isFinite)
    || decay < 0 || omega <= 0 || t < 0) throw new RangeError('Invalid spring state');
  const cosine = Math.cos(omega * t);
  const sine = Math.sin(omega * t);
  const b = (velocity + decay * position) / omega;
  const wave = position * cosine + b * sine;
  const derivative = omega * (-position * sine + b * cosine);
  const envelope = Math.exp(-decay * t);
  return {
    position: envelope * wave,
    velocity: envelope * (derivative - decay * wave),
  };
}
