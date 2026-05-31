'use strict';

/**
 * LG Remote Bridge
 *
 * One persistent process that:
 *   - holds a single live SSAP connection to the TV (reused key, heartbeat)
 *   - serves the PWA over http://localhost:<PORT>
 *   - relays browser commands <-> TV over a local WebSocket (same origin, so no
 *     mixed-content / self-signed-cert / invalid-origin problems in the browser)
 *
 * Config + client-key persist to config.json next to this file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { LGClient } = require('./lib/lgclient');

const PORT = process.env.PORT || 3777;
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---- config persistence ---------------------------------------------------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('could not save config:', e.message); }
}

const config = loadConfig();
if (process.env.LG_TV_IP) config.ip = process.env.LG_TV_IP;

// ---- TV client -------------------------------------------------------------

const tv = new LGClient({
  ip: config.ip || null,
  clientKey: config.clientKey || null,
  onKey: (key) => { config.clientKey = key; saveConfig(config); }
});

tv.on('log', (m) => console.log('[tv]', m));
if (tv.ip) tv.start();

// ---- static file server ----------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // tiny REST surface for config + status
  if (u.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ip: tv.ip || '', ...tv.state() });
  }
  if (u.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { ip } = JSON.parse(body || '{}');
        if (!ip || !/^[0-9.]+$/.test(ip)) return sendJson(res, 400, { error: 'bad ip' });
        config.ip = ip;
        // changing TV invalidates the key; let setIp handle re-pair
        if (ip !== tv.ip) { config.clientKey = null; }
        saveConfig(config);
        tv.setIp(ip);
        if (!tv.connected) tv.start();
        sendJson(res, 200, { ok: true, ip });
      } catch (_) { sendJson(res, 400, { error: 'bad json' }); }
    });
    return;
  }

  // static
  let fp = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- browser <-> bridge websocket ------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

tv.on('state', (s) => broadcast({ type: 'state', ...s }));
tv.on('prompt', () => broadcast({ type: 'prompt' }));
tv.on('volume', (v) => broadcast({ type: 'volume', ...v }));

const APPS = {
  netflix: 'netflix',
  youtube: 'youtube.leanback.v4',
  disney: 'com.disney.disneyplus-prod',
  primevideo: 'amazon',
  spotify: 'spotify-beehive',
  appletv: 'com.apple.appletv',
  browser: 'com.webos.app.browser',
  livetv: 'com.webos.app.livetv'
};

wss.on('connection', (socket) => {
  // push current state immediately
  socket.send(JSON.stringify({ type: 'state', ...tv.state() }));

  socket.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch (_) { return; }

    try {
      switch (cmd.action) {
        case 'button':   await tv.button(cmd.name); break;       // UP/DOWN/LEFT/RIGHT/ENTER/BACK/HOME/MENU/EXIT/INFO...
        case 'click':    await tv.click(); break;
        case 'move':     await tv.move(cmd.dx, cmd.dy, cmd.drag); break;
        case 'scroll':   await tv.scroll(cmd.dx, cmd.dy); break;
        case 'volUp':    await tv.volumeUp(); break;
        case 'volDown':  await tv.volumeDown(); break;
        case 'mute':     await tv.setMute(cmd.value); break;
        case 'chUp':     await tv.channelUp(); break;
        case 'chDown':   await tv.channelDown(); break;
        case 'power':    await tv.turnOff(); break;              // power ON needs Wake-on-LAN (see README)
        case 'launch':   await tv.launch(APPS[cmd.app] || cmd.app); break;
        case 'getInputs': {
          const r = await tv.getInputs();
          socket.send(JSON.stringify({ type: 'inputs', devices: r.devices || [] }));
          break;
        }
        case 'switchInput': await tv.switchInput(cmd.inputId); break;
        case 'getChannels': {
          const r = await tv.getChannelList();
          socket.send(JSON.stringify({ type: 'channels', list: r.channelList || [] }));
          break;
        }
        case 'openChannel': await tv.openChannel(cmd.channelId); break;
        case 'toast':    await tv.toast(cmd.message || 'Hello from the bridge'); break;
        case 'getVolume':await tv._refreshStatus(); break;
        default: break;
      }
      socket.send(JSON.stringify({ type: 'ack', action: cmd.action }));
    } catch (e) {
      socket.send(JSON.stringify({ type: 'err', action: cmd.action, error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  LG Remote Bridge running`);
  console.log(`  Open  http://localhost:${PORT}  on this Mac`);
  console.log(`  TV    ${tv.ip || '(not set — enter it in the UI)'}\n`);
});

process.on('SIGINT', () => { tv.stop(); server.close(() => process.exit(0)); });
