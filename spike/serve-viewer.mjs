import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ROUTES = new Map([
  ['/', { file: 'spike/viewer.html', type: 'text/html; charset=utf-8' }],
  ['/viewer.html', { file: 'spike/viewer.html', type: 'text/html; charset=utf-8' }],
  ['/src/motion-fit.mjs', { file: 'src/motion-fit.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/spike/viewer-state.mjs', { file: 'spike/viewer-state.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/src/export-spring.mjs', { file: 'src/export-spring.mjs', type: 'text/javascript; charset=utf-8' }],
]);

export function createViewerServer() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const route = ROUTES.get(pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const body = await readFile(path.join(root, route.file));
      res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': body.length });
      if (req.method === 'HEAD') res.end();
      else res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createViewerServer();
  server.listen(4173, '127.0.0.1', () => {
    const { port, address } = server.address();
    console.log(`Viewer ready at http://${address}:${port}/`);
  });
}
