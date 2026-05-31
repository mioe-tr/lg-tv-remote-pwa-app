'use strict';

// ---- bridge connection (local, same-origin WS — no cert/mixed-content issues)
let ws = null;
let muted = false;
const $ = (s) => document.querySelector(s);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setStatus('wait', 'linking');
  ws.onclose = () => { setStatus('off', 'bridge'); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.type === 'state') onState(m);
    else if (m.type === 'prompt') onPrompt();
    else if (m.type === 'volume') { muted = !!m.muted; reflectMute(); }
    else if (m.type === 'err') toast(m.error || 'command failed');
  };
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else toast('bridge offline');
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
$('#padToggle').addEventListener('click', () => { $('#numpad').classList.toggle('hidden'); $('#touch').classList.add('hidden'); });
$('#touchToggle').addEventListener('click', () => { $('#touch').classList.toggle('hidden'); $('#numpad').classList.add('hidden'); });

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
$('#ipSave').addEventListener('click', async () => {
  const ip = $('#ipInput').value.trim();
  if (!/^[0-9.]+$/.test(ip)) { $('#pairHint').textContent = 'That doesn\u2019t look like an IP.'; return; }
  $('#pairHint').textContent = 'Connecting…';
  try {
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
    const j = await r.json();
    if (j.error) $('#pairHint').textContent = 'Error: ' + j.error;
    else $('#pairHint').textContent = 'Saved. If the TV shows a prompt, accept it.';
  } catch (_) { $('#pairHint').textContent = 'Could not reach the bridge.'; }
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
  if (KEYMAP[e.key]) { send({ action: 'button', name: KEYMAP[e.key] }); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') send({ action: 'volUp' });
  else if (e.key === '-') send({ action: 'volDown' });
});

// ---- service worker ----------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

connect();
