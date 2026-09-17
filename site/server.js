// Serves the landing page. No dependencies, so the deploy is just node.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.webm': 'video/webm', '.png': 'image/png', '.ico': 'image/x-icon' };
const ROOT = __dirname;

const https = require('https');
const RAW = 'https://raw.githubusercontent.com/veds260/birch/main/install.sh';
let cached = { at: 0, body: null };

// birch.video/install is the installer, fetched from the repo so there's one copy of it
function installer(res) {
  const reply = body => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); res.end(body); };
  if (cached.body && Date.now() - cached.at < 300000) return reply(cached.body);
  https.get(RAW, r => {
    let body = ''; r.on('data', d => body += d);
    r.on('end', () => {
      if (r.statusCode !== 200 || !body.startsWith('#!')) {
        if (cached.body) return reply(cached.body);
        res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end('echo "Could not fetch the Birch installer, try again in a minute"; exit 1\n');
      }
      cached = { at: Date.now(), body }; reply(body);
    });
  }).on('error', () => { if (cached.body) return reply(cached.body); res.writeHead(502); res.end('exit 1\n'); });
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/install' || p === '/install.sh') return installer(res);
  // one address for the site, so www goes to the bare domain
  if ((req.headers.host || '').startsWith('www.')) { res.writeHead(301, { Location: 'https://birch.video' + req.url }); return res.end(); }
  if (p === '/github') { res.writeHead(302, { Location: 'https://github.com/veds260/birch' }); return res.end(); }
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(ROOT) || !TYPES[path.extname(f)] || !fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
  }
  const long = path.extname(f) !== '.html';
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], 'Cache-Control': long ? 'public, max-age=604800' : 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 8080, () => console.log('birch site on ' + (process.env.PORT || 8080)));
