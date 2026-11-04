const MAX_STREAM_BYTES = 64 * 1024 * 1024;

export function makeBoxPrompt(seed, video) {
  const { frameIndex, box } = seed ?? {};
  const { width, height, frameCount } = video ?? {};
  const { x1, y1, x2, y2 } = box ?? {};
  if (![frameIndex, width, height, frameCount, x1, y1, x2, y2].every(Number.isSafeInteger)
    || width <= 0 || height <= 0 || frameCount <= 0
    || frameIndex < 0 || frameIndex >= frameCount
    || x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 >= width || y2 >= height) {
    throw new Error("Invalid source-frame box prompt");
  }
  return `<${frameIndex}f>1<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${width};h=${height}|>`;
}

export async function readSamStream(response, what = "segmentation request") {
  if (!response.ok) {
    const error = new Error(`${what} failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
    throw new Error("Segmentation response must be an event stream");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts = [];
  let size = 0;
  try {
    for await (const bytes of response.body) {
      size += bytes.byteLength;
      if (size > MAX_STREAM_BYTES) throw new Error("Stream limit exceeded");
      parts.push(decoder.decode(bytes, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch {
    throw new Error("Segmentation stream could not be read within limits");
  }
  let completed = null;
  const deltas = [];
  for (const block of parts.join("").replaceAll("\r\n", "\n").split("\n\n")) {
    const data = block.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data.trim() === "[DONE]") continue;
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("Malformed segmentation stream event");
    }
    if (!value || Array.isArray(value) || typeof value.type !== "string") {
      throw new Error("Invalid segmentation stream event");
    }
    if (["error", "response.error", "response.failed", "response.incomplete"].includes(value.type)
      || value.error || value.response?.error) {
      throw new Error("Segmentation stream failed");
    }
    if (value.type === "response.output_text.delta") {
      if (completed || typeof value.delta !== "string") throw new Error("Invalid segmentation delta sequence");
      deltas.push(value.delta);
    }
    if (value.type === "response.completed") {
      if (completed || value.response?.status !== "completed"
        || typeof value.response.id !== "string" || !value.response.id) {
        throw new Error("Invalid segmentation completion");
      }
      completed = value.response;
    }
  }
  if (!completed) throw new Error("Segmentation stream did not complete");
  return {
    response: completed,
    text: deltas.length ? deltas.join("").replace(/\|>(?=<\d+f>)/g, "|>\n") : null,
  };
}
