import { springState } from './motion-fit.mjs';

export function exportSpring(fit) {
  if (fit?.status !== 'fitted' || !fit.parameters) {
    throw new TypeError('Export requires an accepted fit');
  }
  const { decay, omega } = fit.parameters;
  if (![decay, omega].every(Number.isFinite) || decay < 0 || omega <= 0
    || !Number.isFinite(decay * decay + omega * omega)) {
    throw new RangeError('Invalid spring parameters');
  }
  const initial = springState({ decay, omega }, 0);
  if (![initial.position, initial.velocity].every(Number.isFinite)) {
    throw new RangeError('Unrepresentable spring parameters');
  }
  return [
    `export const parameters = Object.freeze(${JSON.stringify({ decay, omega })});`,
    '',
    `export ${springState.toString()}`,
    '',
    'export function sample(timeSeconds, initialConditions = {}) {',
    '  return springState(parameters, timeSeconds, initialConditions);',
    '}',
    '',
  ].join('\n');
}
