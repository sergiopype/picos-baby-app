// Tiny static server for local testing: node scripts/serve.mjs [port]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('app'); const port = +process.argv[2] || 5173;
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('serving app/ on http://localhost:' + port));
