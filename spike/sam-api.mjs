import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const API_ORIGIN = "https://api.meta.ai";
const MODEL = "sam-3.1";
const SUPPORTED_CODECS = new Set(["h264", "hevc", "mpeg4"]);
const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180_000;

const FRAME_RE = /^<(\d+)f>/;
const OBJECT_RE = /^(\d+)/;
const BOX_RE = /^<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=(\d+(?:\.\d+)?))?\|>/;
const MASK_RE = /^<\|mask;x=0;y=0(?:;c=(\d+(?:\.\d+)?))?;data=(\d+),(\d+),([~!])(?:(?!\|>)[\s\S])*\|>/;

function safeInteger(text) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error("SAM value must be a safe integer");
  return value;
}

function validateConfidence(text) {
  if (text === undefined) return;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("SAM confidence must be finite and in [0,1]");
  }
}

export function parseSamBoxes(text) {
  if (typeof text !== "string") throw new Error("SAM output text must be a string");
  if (text === "") return [];
  const records = [];
  const seen = new Set();
  let frameW = null;
  let frameH = null;
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("malformed SAM output: no frame lines");
  for (const line of lines) {
    const fm = line.match(FRAME_RE);
    if (!fm) throw new Error("malformed SAM line");
    const frameIndex = safeInteger(fm[1]);
    let rest = line.slice(fm[0].length);
    if (rest.length === 0) throw new Error(`frame ${frameIndex} carries no records`);
    while (rest.length > 0) {
      const om = rest.match(OBJECT_RE);
      if (!om) throw new Error("malformed record: missing object id");
      const objectId = om[1];
      safeInteger(objectId);
      rest = rest.slice(om[0].length);
      const bm = rest.match(BOX_RE);
      if (!bm) throw new Error(`malformed box token for object ${objectId}`);
      rest = rest.slice(bm[0].length);
      const mm = rest.match(MASK_RE);
      if (!mm) throw new Error(`missing mask token for object ${objectId}`);
      rest = rest.slice(mm[0].length);
      const [, x1s, y1s, x2s, y2s, ws, hs] = bm;
      const [x1, y1, x2, y2, w, h] = [x1s, y1s, x2s, y2s, ws, hs].map(safeInteger);
      safeInteger(mm[2]);
      safeInteger(mm[3]);
      validateConfidence(bm[7]);
      validateConfidence(mm[1]);
      if (w <= 0 || h <= 0) throw new Error("source dimensions must be positive");
      if (frameW === null) {
        frameW = w;
        frameH = h;
      } else if (w !== frameW || h !== frameH) {
        throw new Error(`dimension change: expected ${frameW}x${frameH}, got ${w}x${h}`);
      }
      if (x2 <= x1 || y2 <= y1) throw new Error(`zero-size box for object ${objectId}`);
      if (x1 < 0 || y1 < 0 || x2 > w || y2 > h) {
        throw new Error(`box out of bounds for object ${objectId} in ${w}x${h}`);
      }
      const key = `${frameIndex}:${objectId}`;
      if (seen.has(key)) throw new Error(`duplicate record for object ${objectId} on frame ${frameIndex}`);
      seen.add(key);
      records.push({
        frameIndex,
        objectId,
        x1,
        y1,
        x2,
        y2,
        width: w,
        height: h,
      });
      if (rest.length > 0) {
        if (rest[0] !== ",") throw new Error("malformed record separator");
        rest = rest.slice(1);
        if (rest.length === 0) throw new Error("trailing separator");
      }
    }
  }
  records.sort((a, b) => a.frameIndex - b.frameIndex || Number(a.objectId) - Number(b.objectId));
  return records;
}

export async function probeVideo(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_frames",
        "-show_entries", "stream=width,height,codec_name,duration:format=duration:frame=best_effort_timestamp_time",
        "-of", "json",
        filePath,
      ],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch {
    throw new Error("ffprobe failed on input video");
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe returned unparseable metadata");
  }
  const stream = parsed?.streams?.[0];
  const frames = parsed?.frames;
  if (!stream || !Array.isArray(frames) || frames.length === 0) {
    throw new Error("no selected video stream or frames");
  }
  const { width, height, codec_name: codec } = stream;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("stream dimensions must be positive safe integers");
  }
  if (!SUPPORTED_CODECS.has(codec)) {
    throw new Error(`unsupported codec: ${codec}`);
  }
  if (width > 1920 || height > 1080) {
    throw new Error(`dimensions ${width}x${height} exceed 1920x1080`);
  }
  const timestamps = frames.map((f) => Number(f.best_effort_timestamp_time));
  if (timestamps.some((t) => !Number.isFinite(t) || t < 0)) {
    throw new Error("nonfinite or negative frame timestamp");
  }
  for (let i = 1; i < timestamps.length; i += 1) {
    if (timestamps[i] <= timestamps[i - 1]) {
      throw new Error("frame timestamps are not strictly increasing");
    }
  }
  const frameCount = timestamps.length;
  if (frameCount < 40 || frameCount > 600) {
    throw new Error(`frame count ${frameCount} outside 40..600`);
  }
  const duration = [stream.duration, parsed.format?.duration]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  if (duration === undefined) throw new Error("missing positive video duration");
  if (duration < 2 || duration > 10) {
    throw new Error(`duration ${duration.toFixed(3)}s outside 2..10s`);
  }
  return { width, height, frameCount, timestamps, codec };
}

async function checkedJson(res, what) {
  if (!res.ok) {
    throw new Error(`${what} failed with status ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${what} returned malformed JSON`);
  }
  return body;
}

async function checkedFetch(fetchImpl, url, options, what) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new Error(`${what} transport failed`);
  }
  return checkedJson(response, what);
}

function extractOutputText(response) {
  if (response.output_text !== undefined && typeof response.output_text !== "string") return null;
  if (Array.isArray(response.output)) {
    const texts = [];
    for (const item of response.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) return null;
      for (const part of item.content) {
        if (part?.type !== "output_text" || typeof part.text !== "string") return null;
        texts.push(part.text);
      }
    }
    if (texts.length > 0) return texts.join("");
  }
  if (response.output !== undefined && !Array.isArray(response.output)) return null;
  if (typeof response.output_text === "string") return response.output_text;
  return null;
}

export async function trackVideo({ path: videoPath, concept, apiKey, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new Error("MODEL_API_KEY is required");
  const prompt = typeof concept === "string" ? concept.trim() : "";
  if (prompt.length < 1 || prompt.length > 120) {
    throw new Error("concept must be a 1..120 character noun phrase");
  }
  const ext = path.extname(videoPath).toLowerCase();
  if (ext !== ".mp4" && ext !== ".mov") {
    throw new Error("video must be an .mp4 or .mov file");
  }
  const fileStat = await stat(videoPath);
  if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > MAX_BYTES) {
    throw new Error("video size must be 1..25MiB");
  }
  const probe = await probeVideo(videoPath);
  const fileBytes = await readFile(videoPath);
  const sha256 = createHash("sha256").update(fileBytes).digest("hex");

  const authHeaders = { authorization: `Bearer ${key}` };
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("file", new Blob([fileBytes]), path.basename(videoPath));
  const upload = await checkedFetch(fetchImpl, `${API_ORIGIN}/v1/files`, {
    method: "POST",
    headers: authHeaders,
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, "file upload");
  if (typeof upload?.id !== "string" || upload.id.length === 0) {
    throw new Error("upload response missing file id");
  }

  const requestBody = {
    model: MODEL,
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_video", file_id: upload.id },
        ],
      },
    ],
  };
  const response = await checkedFetch(fetchImpl, `${API_ORIGIN}/v1/responses`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, "segmentation request");
  if (response?.status !== "completed" || typeof response?.id !== "string") {
    throw new Error("segmentation response did not complete");
  }
  const outputText = extractOutputText(response);
  if (outputText === null) {
    throw new Error("segmentation response missing output_text");
  }
  const records = parseSamBoxes(outputText);

  const byObject = new Map();
  for (const rec of records) {
    if (rec.frameIndex >= probe.frameCount) {
      throw new Error(`record frame ${rec.frameIndex} outside source video`);
    }
    if (rec.width !== probe.width || rec.height !== probe.height) {
      throw new Error("record dimensions do not match probed video");
    }
    const sample = {
      frameIndex: rec.frameIndex,
      t: probe.timestamps[rec.frameIndex],
      x: (rec.x1 + rec.x2) / 2,
      y: (rec.y1 + rec.y2) / 2,
      box: { x1: rec.x1, y1: rec.y1, x2: rec.x2, y2: rec.y2 },
    };
    if (!byObject.has(rec.objectId)) byObject.set(rec.objectId, []);
    byObject.get(rec.objectId).push(sample);
  }
  const tracks = [...byObject.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([objectId, samples]) => ({
      objectId,
      samples: samples.sort((a, b) => a.frameIndex - b.frameIndex),
    }));

  return {
    schemaVersion: 1,
    provenance: {
      kind: "meta-sam-live",
      model: MODEL,
      responseId: response.id,
      createdAt: response.created_at ?? null,
      measurement: "bounding-box-center",
      source: { name: path.basename(videoPath), sha256, fileId: upload.id },
    },
    video: {
      width: probe.width,
      height: probe.height,
      frameCount: probe.frameCount,
      timestamps: probe.timestamps,
    },
    tracks,
  };
}
