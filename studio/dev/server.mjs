// Development / web mode: serves the Studio UI in a browser, with the backend over HTTP.
// Usage: node dev/server.mjs [port]   (binds to 127.0.0.1 only: the backend can reach PLCs)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../dist/backend.mjs';

const root = fileURLToPath(new URL('../dist/renderer/', import.meta.url));
const api = createApi();
const port = Number(process.argv[2] ?? 8123);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  try {
    // Only this machine, by its loopback name (protects against DNS rebinding)
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host ?? '')) throw new Error('forbidden host');
    if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      if (req.headers['content-type'] !== 'application/json') throw new Error('JSON expected');
      let body = '';
      for await (const chunk of req) body += chunk;
      const method = req.url.slice(5);
      const fn = api[method];
      if (typeof fn !== 'function') throw new Error('Unknown method');
      const result = await fn(...JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: result ?? null }));
      return;
    }
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) throw new Error('forbidden');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    const isApi = req.url?.startsWith('/api/');
    res.writeHead(isApi ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(port, '127.0.0.1', () => console.log(`VirtualPLC Studio (web mode): http://127.0.0.1:${port}`));
