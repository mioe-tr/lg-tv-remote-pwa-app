'use strict';

/**
 * Minimal, robust LG webOS (SSAP) client.
 *
 * Why hand-rolled instead of a library: we need full control over three things
 * that consumer remote apps get wrong, and that cause the "takes forever to
 * change a channel" problem:
 *   1. TLS to a self-signed cert on wss://<tv>:3001  -> rejectUnauthorized:false
 *   2. Reusing the stored client-key so we NEVER re-prompt after first pair
 *   3. A persistent connection + heartbeat so the socket never goes idle/dead
 *
 * Navigation buttons (UP/DOWN/LEFT/RIGHT/ENTER/BACK/HOME/media/numbers) go over
 * a secondary "pointer input" socket. Everything else (volume, channel, launch,
 * power, toast) goes over the main SSAP request socket.
 */

const EventEmitter = require('events');
const WebSocket = require('ws');

// Standard webOS pairing handshake. The signature block is the well-known one
// used by open-source webOS clients; the TV mainly checks pairingType + manifest.
const HANDSHAKE = {
  forcePairing: false,
  pairingType: 'PROMPT',
  manifest: {
    manifestVersion: 1,
    appVersion: '1.1',
    signed: {
      created: '20140509',
      appId: 'com.lge.test',
      vendorId: 'com.lge',
      localizedAppNames: { '': 'LG Remote Bridge', 'ko-KR': '리모컨 브리지' },
      localizedVendorNames: { '': 'LG Electronics' },
      permissions: [
        'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD',
        'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
        'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER',
        'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO',
        'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'
      ],
      serial: '2f930e2d2cfe083771f68e4fe7bb07'
    },
    permissions: [
      'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN',
      'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
      'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING',
      'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER',
      'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
      'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST',
      'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO',
      'READ_SETTINGS', 'CONTROL_TV_SCREEN', 'CONTROL_TV_STANBY',
      'CONTROL_FAVORITE_GROUP', 'CONTROL_USER_INFO', 'CHECK_BLUETOOTH_DEVICE',
      'CONTROL_BLUETOOTH', 'CONTROL_TIMER_INFO', 'STB_INTERNAL_CONNECTION',
      'CONTROL_RECORDING', 'READ_RECORDING_STATE', 'WRITE_RECORDING_LIST',
      'READ_RECORDING_LIST', 'READ_RECORDING_SCHEDULE',
      'WRITE_RECORDING_SCHEDULE', 'READ_STORAGE_DEVICE_LIST',
      'READ_TV_PROGRAM_INFO', 'CONTROL_BOX_CHANNEL', 'READ_TV_ACR_AUTH_TOKEN',
      'READ_TV_CONTENT_STATE', 'READ_TV_CURRENT_TIME', 'ADD_LAUNCHER_CHANNEL',
      'SET_CHANNEL_SKIP', 'RELEASE_CHANNEL_SKIP', 'CONTROL_CHANNEL_BLOCK',
      'DELETE_SELECT_CHANNEL', 'CONTROL_CHANNEL_GROUP', 'SCAN_TV_CHANNELS',
      'CONTROL_TV_POWER', 'CONTROL_WOL'
    ],
    signatures: [{
      signatureVersion: 1,
      signature: 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrCAL8YsR/9blN4kFi9HM4HfuADAS4WxnVqs6KFNZk8RXqVk+vYO1G6gJpfqJ02bSqO02HJZNZ7yvN0scbe4XSdFvOMOyHbeR5xNvT3CMpRTAS3rGQ=='
    }]
  }
};

class LGClient extends EventEmitter {
  constructor({ ip, clientKey = null, onKey = () => {} } = {}) {
    super();
    this.ip = ip;
    this.clientKey = clientKey;
    this.onKey = onKey;

    this.ws = null;
    this.pointerWs = null;
    this.cmdId = 0;
    this.pending = new Map();      // id -> {resolve, reject}
    this.paired = false;
    this.connected = false;

    this._reconnectDelay = 1000;   // backoff start
    this._maxDelay = 15000;
    this._stopped = false;
    this._heartbeat = null;
    this._reconnectTimer = null;
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._heartbeat);
    if (this.pointerWs) try { this.pointerWs.close(); } catch (_) {}
    if (this.ws) try { this.ws.close(); } catch (_) {}
  }

  setIp(ip) {
    if (ip === this.ip) return;
    this.ip = ip;
    this.clientKey = null;        // new TV -> must re-pair
    this.paired = false;
    this._restart();
  }

  _restart() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) try { this.ws.terminate(); } catch (_) {}
    this._reconnectDelay = 1000;
    if (!this._stopped) this._connect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._maxDelay, this._reconnectDelay * 2);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  // ---- main SSAP socket --------------------------------------------------

  _connect() {
    if (!this.ip) return;
    const url = `wss://${this.ip}:3001`;
    this.emit('log', `connecting ${url}`);

    // rejectUnauthorized:false -> accept the TV's self-signed certificate.
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 8000 });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this._reconnectDelay = 1000;
      this._register();
      this._startHeartbeat();
      this._emitState();
    });

    ws.on('message', (data) => this._onMessage(data));

    ws.on('close', () => {
      this.connected = false;
      this.paired = false;
      clearInterval(this._heartbeat);
      if (this.pointerWs) { try { this.pointerWs.close(); } catch (_) {} this.pointerWs = null; }
      this._rejectAllPending(new Error('socket closed'));
      this._emitState();
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.emit('log', `ws error: ${err.message}`);
      // 'close' will follow and handle reconnect.
    });
  }

  _register() {
    const payload = JSON.parse(JSON.stringify(HANDSHAKE));
    if (this.clientKey) payload['client-key'] = this.clientKey;
    this._sendRaw({ type: 'register', id: 'register_0', payload });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.type === 'registered') {
      this.paired = true;
      const key = msg.payload && msg.payload['client-key'];
      if (key && key !== this.clientKey) {
        this.clientKey = key;
        this.onKey(key);          // persist it -> never prompt again
      }
      this.emit('log', 'paired');
      this._emitState();
      this._refreshStatus();
      return;
    }

    if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
      // TV is showing the on-screen "allow this device?" prompt.
      this.emit('prompt');
      this._emitState();
      return;
    }

    if (msg.type === 'error' && msg.id === 'register_0') {
      // Stored key was rejected (e.g. TV factory reset) -> drop it and re-prompt.
      this.clientKey = null;
      this.onKey(null);
      this._register();
      return;
    }

    const p = this.pending.get(msg.id);
    if (p) {
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.error || 'tv error'));
      else p.resolve(msg.payload || {});
    }
  }

  // ---- requests ----------------------------------------------------------

  _sendRaw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  request(uri, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.paired) return reject(new Error('not paired'));
      const id = `req_${++this.cmdId}`;
      this.pending.set(id, { resolve, reject });
      const ok = this._sendRaw({ type: 'request', id, uri, payload });
      if (!ok) { this.pending.delete(id); return reject(new Error('not connected')); }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout'));
        }
      }, 6000);
    });
  }

  // ---- pointer / input socket (d-pad, media, number keys) ---------------

  async _ensurePointer() {
    if (this.pointerWs && this.pointerWs.readyState === WebSocket.OPEN) return this.pointerWs;
    const res = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    const path = res.socketPath;
    if (!path) throw new Error('no pointer socket');
    await new Promise((resolve, reject) => {
      const pws = new WebSocket(path, { rejectUnauthorized: false, handshakeTimeout: 8000 });
      this.pointerWs = pws;
      pws.on('open', resolve);
      pws.on('error', reject);
      pws.on('close', () => { if (this.pointerWs === pws) this.pointerWs = null; });
    });
    return this.pointerWs;
  }

  async button(name) {
    const pws = await this._ensurePointer();
    pws.send(`type:button\nname:${name}\n\n`);
  }

  async click() {
    const pws = await this._ensurePointer();
    pws.send('type:click\n\n');
  }

  async move(dx, dy, drag = false) {
    const pws = await this._ensurePointer();
    pws.send(`type:move\ndx:${dx}\ndy:${dy}\ndown:${drag ? 1 : 0}\n\n`);
  }

  async scroll(dx, dy) {
    const pws = await this._ensurePointer();
    pws.send(`type:scroll\ndx:${dx}\ndy:${dy}\n\n`);
  }

  // ---- convenience commands ---------------------------------------------

  volumeUp()    { return this.request('ssap://audio/volumeUp'); }
  volumeDown()  { return this.request('ssap://audio/volumeDown'); }
  setMute(m)    { return this.request('ssap://audio/setMute', { mute: !!m }); }
  channelUp()   { return this.request('ssap://tv/channelUp'); }
  channelDown() { return this.request('ssap://tv/channelDown'); }
  turnOff()     { return this.request('ssap://system/turnOff'); }
  launch(id)    { return this.request('ssap://system.launcher/launch', { id }); }
  toast(message){ return this.request('ssap://system.notifications/createToast', { message }); }
  getVolume()   { return this.request('ssap://audio/getVolume'); }
  getForegroundApp() { return this.request('ssap://com.webos.applicationManager/getForegroundAppInfo'); }
  getInputs()        { return this.request('ssap://tv/getExternalInputList'); }
  switchInput(id)    { return this.request('ssap://tv/switchInput', { inputId: id }); }

  // ---- status + heartbeat ------------------------------------------------

  async _refreshStatus() {
    try {
      const v = await this.getVolume();
      this.emit('volume', { volume: v.volume, muted: v.muted });
    } catch (_) {}
  }

  _startHeartbeat() {
    clearInterval(this._heartbeat);
    // ws-level ping keeps NAT/socket alive; if the pong never comes the TV is
    // gone and we terminate to trigger a fast reconnect rather than hanging.
    let awaitingPong = false;
    this._heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) { try { this.ws.terminate(); } catch (_) {} return; }
      awaitingPong = true;
      try { this.ws.ping(); } catch (_) {}
    }, 10000);
    this.ws.on('pong', () => { awaitingPong = false; });
  }

  _rejectAllPending(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  state() {
    return { ip: this.ip, connected: this.connected, paired: this.paired };
  }

  _emitState() { this.emit('state', this.state()); }
}

module.exports = { LGClient };
