import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeVideo, trackVideo } from "../spike/sam-api.mjs";
import { makeBoxPrompt } from "../spike/sam-stream.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILE_LIMIT = 25 * 1024 * 1024;
const BODY_LIMIT = 26 * 1024 * 1024;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const VIDEO_ROUTE = new RegExp(`^/api/videos/(${ID})$`);
const TRACK_ROUTE = new RegExp(`^/api/videos/(${ID})/tracks$`);
const STATIC = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["web/app.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["web/favicon.svg", "image/svg+xml"]],
  ["/fonts/GeistSans.woff2", ["web/fonts/GeistSans.woff2", "font/woff2"]],
  ["/fonts/GeistSans-Semibold.woff2", ["web/fonts/GeistSans-Semibold.woff2", "font/woff2"]],
  ["/fonts/GeistMono.woff2", ["web/fonts/GeistMono.woff2", "font/woff2"]],
  ["/fonts/OFL.txt", ["web/fonts/OFL.txt", "text/plain; charset=utf-8"]],
  ["/src/motion-fit.mjs", ["src/motion-fit.mjs", "text/javascript; charset=utf-8"]],
  ["/src/export-spring.mjs", ["src/export-spring.mjs", "text/javascript; charset=utf-8"]],
  ["/src/video-frame.mjs", ["src/video-frame.mjs", "text/javascript; charset=utf-8"]],
  ["/spike/viewer-state.mjs", ["spike/viewer-state.mjs", "text/javascript; charset=utf-8"]],
]);
const ERROR_CODES = {
  400: "BAD_REQUEST", 401: "MODEL_AUTH_FAILED", 403: "FORBIDDEN", 404: "NOT_FOUND",
  409: "TRACKING_BUSY", 413: "PAYLOAD_TOO_LARGE", 422: "INVALID_INPUT", 429: "RATE_LIMITED",
  500: "INTERNAL_ERROR", 502: "TRACKING_FAILED", 503: "TRACKING_UNAVAILABLE",
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = ERROR_CODES[status];
  }
}

function checkedOrigin(origin) {
  if (typeof origin !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(origin)) {
    throw new Error("Allowed origins must be exact HTTP loopback origins with a port");
  }
  const parsed = new URL(origin);
  if (Number(origin.slice(origin.lastIndexOf(":") + 1)) > 65535 || parsed.origin !== origin) {
    throw new Error("Invalid allowed origin port");
  }
  return origin;
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}

function boundedBody(req, limit) {
  if (Number(req.headers["content-length"]) > limit) {
    req.resume();
    throw new RequestError(413, "Request body too large");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onError = () => {
      cleanup();
      reject(new RequestError(400, "Could not read request body"));
    };
    const onAborted = () => onError();
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new RequestError(413, "Request body too large"));
      } else chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function createMotionServer({
  apiKey = process.env.MODEL_API_KEY,
  allowedOrigins = [],
  uploadsDir = path.join(ROOT, "uploads"),
  tracker = trackVideo,
} = {}) {
  if (!Array.isArray(allowedOrigins)) throw new Error("Allowed origins must be an array");
  const extraOrigins = allowedOrigins.map(checkedOrigin);
  const videos = new Map();
  const cache = new Map();
  const configured = typeof apiKey === "string" && apiKey.trim().length > 0;
  let blocked = false;
  let active = false;
  let providerRequests = [];

  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      const port = server.address().port;
      const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]);
      const hosts = new Set([...origins].map((origin) => origin.slice("http://".length)));
      if (!hosts.has(req.headers.host)) throw new RequestError(403, "Host not allowed");
      if (req.method === "POST" && req.url.startsWith("/api/")) {
        if (!origins.has(req.headers.origin)) throw new RequestError(403, "Origin not allowed");
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("vary", "Origin");
      }

      if (req.method === "GET" && req.url === "/api/health") {
        json(res, 200, { modelConfigured: configured, trackingAvailable: configured && !blocked });
        return;
      }

      if (req.method === "POST" && req.url === "/api/videos") {
        const buffer = await boundedBody(req, BODY_LIMIT);
        const contentType = req.headers["content-type"];
        if (!/^multipart\/form-data(?:;|$)/i.test(contentType ?? "")) {
          throw new RequestError(400, "Expected multipart form data");
        }
        let form;
        try {
          form = await new Response(buffer, { headers: { "content-type": contentType } }).formData();
        } catch {
          throw new RequestError(400, "Malformed multipart form data");
        }
        const entries = [...form.entries()];
        if (entries.length !== 1 || entries[0][0] !== "video" || !(entries[0][1] instanceof File)) {
          throw new RequestError(422, "Expected exactly one video file");
        }
        const file = entries[0][1];
        if (file.size > FILE_LIMIT) throw new RequestError(413, "Video exceeds 25MiB");
        if (file.size < 1) throw new RequestError(422, "Video must not be empty");
        const name = path.basename(file.name.replaceAll("\\", "/"));
        const extension = path.extname(name).toLowerCase();
        if (extension !== ".mp4" && extension !== ".mov") {
          throw new RequestError(422, "Video must be MP4 or MOV");
        }
        const id = randomUUID();
        const storedPath = path.join(uploadsDir, `${id}${extension}`);
        const bytes = Buffer.from(await file.arrayBuffer());
        await mkdir(uploadsDir, { recursive: true });
        await writeFile(storedPath, bytes, { flag: "wx" });
        let probe;
        try {
          probe = await probeVideo(storedPath);
        } catch {
          throw new RequestError(422, "Video is unsupported or invalid");
        }
        const metadata = {
          id, name, sha256: createHash("sha256").update(bytes).digest("hex"),
          width: probe.width, height: probe.height, frameCount: probe.frameCount, timestamps: probe.timestamps,
        };
        videos.set(id, { path: storedPath, metadata });
        res.setHeader("location", `/api/videos/${id}`);
        json(res, 201, metadata);
        return;
      }

      const videoMatch = req.url.match(VIDEO_ROUTE);
      if (req.method === "GET" && videoMatch && videos.has(videoMatch[1])) {
        json(res, 200, videos.get(videoMatch[1]).metadata);
        return;
      }

      const trackMatch = req.url.match(TRACK_ROUTE);
      if (req.method === "POST" && trackMatch && videos.has(trackMatch[1])) {
        const video = videos.get(trackMatch[1]);
        const buffer = await boundedBody(req, 8 * 1024);
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
          throw new RequestError(400, "Expected JSON");
        }
        let body;
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        } catch {
          throw new RequestError(400, "Malformed JSON");
        }
        if (!exactKeys(body, ["frameIndex", "box"]) || !exactKeys(body.box, ["x1", "y1", "x2", "y2"])) {
          throw new RequestError(422, "Expected only frameIndex and source box coordinates");
        }
        try {
          makeBoxPrompt(body, video.metadata);
        } catch {
          throw new RequestError(422, "Invalid source-frame box");
        }
        const { frameIndex, box: { x1, y1, x2, y2 } } = body;
        const cacheKey = JSON.stringify([trackMatch[1], frameIndex, x1, y1, x2, y2]);
        if (cache.has(cacheKey)) {
          json(res, 200, cache.get(cacheKey));
          return;
        }
        if (!configured || blocked) throw new RequestError(503, "Tracking unavailable");
        if (active) throw new RequestError(409, "Another tracking request is active");
        const now = Date.now();
        providerRequests = providerRequests.filter((time) => time > now - 60_000);
        if (providerRequests.length + 2 > 6) throw new RequestError(429, "Tracking request budget exceeded");
        providerRequests.push(now, now);
        active = true;
        let capture;
        try {
          capture = await tracker({ path: video.path, boxPrompt: body, apiKey });
        } catch (error) {
          const status = error?.status;
          if ([401, 403, 429].includes(status)) {
            blocked = true;
            throw new RequestError(status, "Tracking provider unavailable");
          }
          throw new RequestError(502, "Tracking provider failed");
        } finally {
          active = false;
        }
        cache.set(cacheKey, capture);
        json(res, 200, capture);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && STATIC.has(req.url)) {
        const [relativePath, contentType] = STATIC.get(req.url);
        let bytes;
        try {
          bytes = await readFile(path.join(ROOT, relativePath));
        } catch {
          throw new RequestError(404, "Not found");
        }
        res.writeHead(200, { "content-type": contentType, "content-length": bytes.length });
        res.end(req.method === "HEAD" ? undefined : bytes);
        return;
      }
      throw new RequestError(404, "Not found");
    } catch (error) {
      req.resume();
      if (!res.headersSent && !res.destroyed) {
        json(res, error instanceof RequestError ? error.status : 500, {
          error: {
            code: error instanceof RequestError ? error.code : ERROR_CODES[500],
            message: error instanceof RequestError ? error.message : "Internal server error",
          },
        });
      }
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let port = 4173;
  const allowedOrigins = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[++index];
    if (argument === "--port" && /^(?:0|[1-9]\d{0,4})$/.test(value ?? "") && Number(value) <= 65535) {
      port = Number(value);
    } else if (argument === "--allowed-origin" && value !== undefined) {
      allowedOrigins.push(checkedOrigin(value));
    } else {
      throw new Error("Expected --port PORT or --allowed-origin ORIGIN");
    }
  }
  const server = createMotionServer({ allowedOrigins });
  server.listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${server.address().port}`);
  });
}
