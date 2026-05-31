'use strict';

/**
 * Static file server for the LG Remote PWA.
 *
 * The remote now talks to the TV DIRECTLY from the browser (see
 * public/lgtv.js), so this process is just a dumb host for the static files —
 * no TV connection, no relay, no dependencies. Run it on a machine on the same
 * Wi-Fi as the TV and open it from your phone over http://<host>:<PORT>.
 *
 * NOTE on hosting: a *direct* browser→TV connection only works when this app is
 * opened over plain HTTP (or localhost). An installed HTTPS PWA is blocked by
 * the browser from reaching the TV (self-signed cert + mixed content). See the
 * README for details.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3777;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let fp = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  LG Remote (direct) running`);
  console.log(`  Open  http://localhost:${PORT}  on this machine`);
  console.log(`  Phone http://<this-machine-ip>:${PORT}  on the same Wi-Fi\n`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
