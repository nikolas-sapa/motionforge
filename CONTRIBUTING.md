# Contributing

Start with [README.md](README.md) for project scope, setup, and supported inputs.

## Development

- Use Node.js 22.9+ and the `ffmpeg` / `ffprobe` prerequisites listed in the README. No npm dependency installation is required.
- Run `npm test` for the Node test suites.
- Add focused tests for behavior changes. Preserve source-frame timestamp handling, provenance and hash validation, capture gates, and export checks.
- Do not weaken fit acceptance or source-timestamp rules to make a clip or demo pass. Current real-video evidence covers one physical clip only.

## Data and provider use

- Keep API keys out of source, issues, and pull requests. Use your own authorized key for live provider checks.
- Use public or explicitly approved footage, retain required attribution, and do not post private videos or captures.
- Label synthetic test fixtures as unit-only. Never describe a fixture as a live SAM result.
- Tracking has no automatic retries. Review the request and provider cost before any live check.

## Pull requests

Keep changes focused. Describe user-visible behavior, tests run, and known limitations. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
