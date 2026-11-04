function validateTimes(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0
    || timestamps.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= timestamps[i - 1]))) {
    throw new RangeError("Invalid source timestamps");
  }
}

export function frameIndexAtTime(timestamps, time) {
  validateTimes(timestamps);
  if (!Number.isFinite(time) || time < 0) throw new RangeError("Invalid media time");
  let best = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    if (Math.abs(timestamps[i] - time) < Math.abs(timestamps[best] - time)) best = i;
  }
  return best;
}

export function seekTimeForFrame(timestamps, index, duration) {
  validateTimes(timestamps);
  if (!Number.isSafeInteger(index) || index < 0 || index >= timestamps.length
    || !Number.isFinite(duration) || duration <= timestamps[index]) {
    throw new RangeError("Invalid source-frame seek");
  }
  const time = timestamps[index];
  const gap = timestamps[index + 1] !== undefined ? timestamps[index + 1] - time
    : index > 0 ? time - timestamps[index - 1] : duration - time;
  return Math.min(time + Math.min(gap / 4, 0.001), (time + duration) / 2);
}
