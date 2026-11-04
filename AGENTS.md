# MotionForge

Developer-tool capability spike: observed object motion to an approximate, interactive spring.

## Scope

- One visible object, fixed camera, predominantly one-axis underdamped oscillation.
- Use real source-frame timestamps. Never assume a SAM output line is the next source frame.
- Fit bounding-box centers, not real physical mass or stiffness.
- `mass: 1` is a simulation convention. Exported coefficients are not measured physical properties.
- No product UI or code export until a real SAM/video spike passes.
- Do not fabricate live SAM results or silently replace API calls with synthetic trajectories.

## Verification

Numerical core: `node --test spike/motion-fit.test.mjs`

Node 26, ffmpeg, and ffprobe are available locally. The spike uses Node built-ins without a framework or package dependencies.

The numerical suite covers known frequencies/decay, irregular timestamps, held-out observations, invalid input, rejection cases, and agreement with independent RK4 integration. Synthetic success does not establish real-video success.

`src/motion-fit.mjs` and `spike/motion-fit.test.mjs` are correctness-critical, lead-authored artifacts. Do not change thresholds or tests to make a clip pass.

## Credentials and Captures

- `.env.example` names `MODEL_API_KEY`. Store actual values only in ignored `.env.local` or the process environment.
- Never print keys or raw authenticated request/response errors.
- `results/`, `uploads/`, and `captures/` are ignored. Do not commit personal video or captures.
- Source SHA256, model/response identity, explicit object identity, and source timestamps accompany captures.
- No automatic API retries during the spike.
- No deployment or public repository publication without explicit approval.

## Verified Local Workflow

- Start the diagnostic viewer with `node spike/serve-viewer.mjs`, loopback port 4173. Restart it after changing the server route allowlist; HTML changes alone are read per request.
- Separate suites: `node --test spike/motion-fit.test.mjs`, `node --test spike/sam-api.test.mjs`, `node --test spike/viewer-state.test.mjs`, `node --test spike/viewer.test.mjs`, and `node --test spike/export-spring.test.mjs`.
- The browser tests use `/opt/homebrew/bin/python3.14` with Playwright 1.58.0 and managed Chromium 1208. The configured system Google Chrome path is absent.
- `src/export-spring.mjs` exports dependency-free JavaScript with `parameters`, `springState`, and `sample(timeSeconds, initialConditions)`. It exports coefficients, not recorded positions.

## Live Spike Evidence, 2026-11-04

- Three authorized SAM segmentation requests have been consumed. Do not issue further model requests without renewed approval.
- The noun prompt `blue box` produced only frames 141 through 239 of the 240-frame clip, in both non-streamed and streamed requests. Streaming alone did not resolve the missing observations.
- A verified box at frame 141, propagated both directions, produced all 240 frames. The unchanged fitter accepted object `1` on axis `x`.
- Frozen capture: `results/oscillator-seeded.capture.json`. Frozen assessment: `results/oscillator-seeded-assessment.json`. Read these artifacts rather than re-running the model or re-deriving reported measurements.
- Native browser checks verified overlays, meaningful spring movement with the source video paused, stop/restart, pointer drag/release, a real JavaScript download, and blocked exports for rejected, invalid, and hash-mismatched inputs.
- `spike/stream-track.mjs` is a hardcoded investigation recipe for this public source clip, not a general tracking CLI. Its request, raw SSE, and diagnostic artifacts stay in ignored `results/`.
- Only one physical clip has passed. Broader video reliability and a general upload-to-SAM product interface remain unvalidated.
