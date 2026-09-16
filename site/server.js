// Serves the landing page. No dependencies, so the deploy is just node.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.webm': 'video/webm', '.png': 'image/png', '.ico': 'image/x-icon' };
const ROOT = __dirname;

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(ROOT) || !TYPES[path.extname(f)] || !fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
  }
  const long = path.extname(f) !== '.html';
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], 'Cache-Control': long ? 'public, max-age=604800' : 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 8080, () => console.log('birch site on ' + (process.env.PORT || 8080)));
