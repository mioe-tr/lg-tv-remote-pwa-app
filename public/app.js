'use strict';

// ---- direct TV connection (no bridge — the browser speaks SSAP itself) -------
const $ = (s) => document.querySelector(s);
let muted = false;

// Persisted settings live in localStorage so an installed PWA remembers them.
const STORE = {
  get ip() { try { return localStorage.getItem('lg.ip') || ''; } catch (_) { return ''; } },
  set ip(v) { try { v ? localStorage.setItem('lg.ip', v) : localStorage.removeItem('lg.ip'); } catch (_) {} },
  get key() { try { return localStorage.getItem('lg.key') || null; } catch (_) { return null; } },
  set key(v) { try { v ? localStorage.setItem('lg.key', v) : localStorage.removeItem('lg.key'); } catch (_) {} }
};

// App-id shortcuts (moved here from the old server).
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

const tv = new LGTV({
  ip: STORE.ip || null,
  clientKey: STORE.key,
  onKey: (key) => { STORE.key = key; }
});

tv.on('state', (s) => onState(s));
tv.on('prompt', () => onPrompt());
tv.on('volume', (v) => { muted = !!v.muted; reflectMute(); });
tv.on('error', (msg) => toast(msg));
tv.on('log', (m) => console.log('[tv]', m));

// Route every UI action straight to the TV. Mirrors the old bridge switch.
async function send(obj) {
  try {
    switch (obj.action) {
      case 'button':   await tv.button(obj.name); break;
      case 'click':    await tv.click(); break;
      case 'move':     await tv.move(obj.dx, obj.dy, obj.drag); break;
      case 'scroll':   await tv.scroll(obj.dx, obj.dy); break;
      case 'volUp':    await tv.volumeUp(); break;
      case 'volDown':  await tv.volumeDown(); break;
      case 'mute':     await tv.setMute(obj.value); break;
      case 'chUp':     await tv.channelUp(); break;
      case 'chDown':   await tv.channelDown(); break;
      case 'power':    await tv.turnOff(); break;
      case 'launch':   await tv.launch(APPS[obj.app] || obj.app); break;
      case 'switchInput': await tv.switchInput(obj.inputId); break;
      case 'openChannel': await tv.openChannel(obj.channelId); break;
      case 'getInputs': {
        const r = await tv.getInputs();
        renderInputs(r.devices || []);
        break;
      }
      case 'getChannels': {
        const r = await tv.getChannelList();
        renderChannels(r.channelList || []);
        break;
      }
      default: break;
    }
  } catch (e) {
    if (!tv.paired) toast('not connected');
    else toast(e.message || 'command failed');
  }
}

// ---- status -----------------------------------------------------------------
function setStatus(cls, text) {
  const el = $('#statusDot');
  el.className = 'status ' + cls;
  $('#statusText').textContent = text;
}

function onState(s) {
  if (!s.ip) { openSheet(); setStatus('off', 'no tv'); return; }
  if (s.connected && s.paired) { setStatus('on', 'live'); closeSheet(); }
  else if (s.connected && !s.paired) setStatus('wait', 'pairing');
  else setStatus('off', 'offline');
  $('#ipInput').value = s.ip || '';
}

function onPrompt() {
  openSheet();
  $('#sheetMsg').textContent = 'Look at your TV — accept the connection request on screen.';
  $('#pairHint').textContent = 'Waiting for you to accept on the TV…';
}

// ---- command wiring ----------------------------------------------------------
function press(el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 90); }

document.querySelectorAll('[data-btn]').forEach((el) => {
  el.addEventListener('click', () => { press(el); send({ action: 'button', name: el.dataset.btn }); });
});
document.querySelectorAll('[data-act]').forEach((el) => {
  el.addEventListener('click', () => {
    press(el);
    const a = el.dataset.act;
    if (a === 'mute') { muted = !muted; reflectMute(); send({ action: 'mute', value: muted }); }
    else send({ action: a });
  });
});
document.querySelectorAll('[data-app]').forEach((el) => {
  el.addEventListener('click', () => { press(el); send({ action: 'launch', app: el.dataset.app }); });
});

function reflectMute() { $('#muteBtn').classList.toggle('active', muted); }

// ---- toggles -----------------------------------------------------------------
const PANELS = ['#numpad', '#touch', '#sources', '#channels'];
function showOnly(target) {
  const willOpen = $(target).classList.contains('hidden');
  PANELS.forEach((p) => $(p) && $(p).classList.add('hidden'));
  if (willOpen) $(target).classList.remove('hidden');
  return willOpen;
}
$('#padToggle').addEventListener('click', () => showOnly('#numpad'));
$('#touchToggle').addEventListener('click', () => showOnly('#touch'));
$('#srcToggle').addEventListener('click', () => { if (showOnly('#sources')) send({ action: 'getInputs' }); });
$('#chToggle').addEventListener('click', () => { if (showOnly('#channels')) send({ action: 'getChannels' }); });
function hide(sel) { $(sel).classList.add('hidden'); }

// ---- input sources -----------------------------------------------------------
let currentInputId = null;
function renderInputs(devices) {
  const grid = $('#sourcesGrid');
  if (!devices || !devices.length) { grid.innerHTML = '<div class="sources-loading">no inputs reported</div>'; return; }
  // connected first, then by label
  devices.sort((a, b) => (b.connected - a.connected) || String(a.label).localeCompare(b.label));
  grid.innerHTML = '';
  for (const d of devices) {
    const b = document.createElement('button');
    b.className = 'source' + (d.connected ? ' connected' : '') + (d.id === currentInputId ? ' active-input' : '');
    b.innerHTML = `<span class="src-dot"></span><span class="src-label"></span>`;
    b.querySelector('.src-label').textContent = d.label || d.id;
    b.addEventListener('click', () => {
      press(b);
      currentInputId = d.id;
      send({ action: 'switchInput', inputId: d.id });
      hide('#sources');
      toast(`→ ${d.label || d.id}`);
    });
    grid.appendChild(b);
  }
}

// ---- channel list ------------------------------------------------------------
let currentChannelId = null;
function renderChannels(list) {
  const box = $('#chList');
  if (!list || !list.length) {
    box.innerHTML = '<div class="sources-loading">no channels — TV must be on an antenna/cable input with a completed scan</div>';
    return;
  }
  // sort by numeric channel number when possible
  list.sort((a, b) => (parseFloat(a.channelNumber) || 0) - (parseFloat(b.channelNumber) || 0));
  box.innerHTML = '';
  for (const c of list) {
    const row = document.createElement('button');
    row.className = 'ch-row' + (c.channelId === currentChannelId ? ' active-channel' : '');
    row.innerHTML = `<span class="ch-num"></span><span class="ch-name"></span>`;
    row.querySelector('.ch-num').textContent = c.channelNumber || '';
    row.querySelector('.ch-name').textContent = c.channelName || c.channelId;
    row.addEventListener('click', () => {
      press(row);
      currentChannelId = c.channelId;
      send({ action: 'openChannel', channelId: c.channelId });
      hide('#channels');
      toast(`→ ${c.channelNumber ? c.channelNumber + ' ' : ''}${c.channelName || ''}`.trim());
    });
    box.appendChild(row);
  }
}

// ---- touchpad ----------------------------------------------------------------
(function touchpad() {
  const area = $('#touchArea');
  let last = null, moved = false, downAt = 0;
  const ACC = 2.2;
  area.addEventListener('pointerdown', (e) => { last = { x: e.clientX, y: e.clientY }; moved = false; downAt = Date.now(); area.setPointerCapture(e.pointerId); });
  area.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = Math.round((e.clientX - last.x) * ACC);
    const dy = Math.round((e.clientY - last.y) * ACC);
    if (Math.abs(dx) + Math.abs(dy) >= 2) { send({ action: 'move', dx, dy, drag: false }); last = { x: e.clientX, y: e.clientY }; moved = true; }
  });
  area.addEventListener('pointerup', () => { if (!moved && Date.now() - downAt < 250) send({ action: 'click' }); last = null; });
})();

// ---- settings sheet ----------------------------------------------------------
function openSheet() { $('#sheet').classList.remove('hidden'); }
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#statusDot').addEventListener('click', openSheet);
// ---- IP input: convert locale comma -> dot so IPs are typeable everywhere
const ipInput = $('#ipInput');
ipInput.addEventListener('input', () => {
  const fixed = ipInput.value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (fixed !== ipInput.value) {
    const pos = ipInput.selectionStart;
    ipInput.value = fixed;
    try { ipInput.setSelectionRange(pos, pos); } catch (_) {}
  }
});

$('#ipSave').addEventListener('click', () => {
  const ip = $('#ipInput').value.trim().replace(/,/g, '.');
  if (!/^[0-9.]+$/.test(ip)) { $('#pairHint').textContent = 'That doesn’t look like an IP.'; return; }
  STORE.ip = ip;
  $('#pairHint').textContent = 'Connecting… if the TV shows a prompt, accept it.';
  if (ip !== tv.ip) tv.setIp(ip);   // changing the TV re-pairs and reconnects
  else tv.start();                  // same TV: connect if not already
});

// ---- toast -------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---- keyboard (nice on the Mac) ---------------------------------------------
const KEYMAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  Enter: 'ENTER', Backspace: 'BACK', Escape: 'EXIT', Home: 'HOME'
};
window.addEventListener('keydown', (e) => {
  // Don't steal keys while the user is typing in a field (IP input, etc.)
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (KEYMAP[e.key]) { send({ action: 'button', name: KEYMAP[e.key] }); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') send({ action: 'volUp' });
  else if (e.key === '-') send({ action: 'volDown' });
});

// ---- service worker ----------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---- boot --------------------------------------------------------------------
if (STORE.ip) tv.start();
else { openSheet(); setStatus('off', 'no tv'); }
