'use strict';

/**
 * Browser-side LG webOS (SSAP) client — talks DIRECTLY to the TV, no Node bridge.
 *
 * This is the in-browser port of the old lib/lgclient.js. It opens a WebSocket
 * straight to the TV and speaks the SSAP protocol itself, so the PWA needs no
 * server other than something to serve these static files.
 *
 * Important browser limitations (these are the reason the old bridge existed):
 *   - A page served over HTTPS cannot open an insecure ws:// socket (mixed
 *     content), which rules out the TV's plaintext SSAP port 3000.
 *   - The TV's secure port 3001 uses a self-signed certificate, which the
 *     browser rejects for wss:// with no way to override from JavaScript.
 *   So a *fully* direct connection only works when this app is opened over
 *   plain HTTP (or localhost) on the same LAN as the TV. We try the best port
 *   for the current page protocol first, fall back to the other, and surface a
 *   clear error if the browser blocks both.
 *
 * The pairing client-key is stored in localStorage so you only ever accept the
 * on-screen prompt once.
 */

(function (global) {
  // Standard webOS pairing handshake. Identical to the one the Node bridge used;
  // the TV mainly checks pairingType + manifest.
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
        localizedAppNames: { '': 'LG Remote PWA', 'ko-KR': '리모컨' },
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

  // Build the list of candidate TV socket URLs to try, best-first for the
  // current page protocol. On an http page ws://:3000 works; wss://:3001 will
  // fail in the browser because of the TV's self-signed cert, but we still try.
  function candidateUrls(ip) {
    const secure = `wss://${ip}:3001`;
    const plain = `ws://${ip}:3000`;
    return location.protocol === 'https:' ? [secure, plain] : [plain, secure];
  }

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    emit(ev) {
      const a = Array.prototype.slice.call(arguments, 1);
      (this._h[ev] || []).forEach((fn) => { try { fn.apply(null, a); } catch (_) {} });
    }
  }

  class LGTV extends Emitter {
    constructor(opts) {
      super();
      opts = opts || {};
      this.ip = opts.ip || null;
      this.clientKey = opts.clientKey || null;
      this.onKey = opts.onKey || function () {};

      this.ws = null;
      this.pointerWs = null;
      this.cmdId = 0;
      this.pending = new Map();     // id -> {resolve, reject, timer}
      this.paired = false;
      this.connected = false;

      this._urls = [];
      this._urlIndex = 0;
      this._reconnectDelay = 1000;
      this._maxDelay = 15000;
      this._stopped = false;
      this._heartbeat = null;
      this._reconnectTimer = null;
    }

    // ---- lifecycle --------------------------------------------------------

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
      this.onKey(null);
      this.paired = false;
      this._restart();
    }

    _restart() {
      clearTimeout(this._reconnectTimer);
      if (this.ws) try { this.ws.close(); } catch (_) {}
      this._reconnectDelay = 1000;
      this._urlIndex = 0;
      if (!this._stopped) this._connect();
    }

    _scheduleReconnect() {
      if (this._stopped) return;
      clearTimeout(this._reconnectTimer);
      const delay = this._reconnectDelay;
      this._reconnectDelay = Math.min(this._maxDelay, this._reconnectDelay * 2);
      this._reconnectTimer = setTimeout(() => { this._urlIndex = 0; this._connect(); }, delay);
    }

    // ---- main SSAP socket -------------------------------------------------

    _connect() {
      if (!this.ip) return;
      // Don't stack sockets if we're already opening/connected.
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
      if (this._urlIndex === 0) this._urls = candidateUrls(this.ip);
      const url = this._urls[this._urlIndex];
      if (!url) { this._onAllUrlsFailed(); return; }

      this.emit('log', 'connecting ' + url);
      let ws;
      try { ws = new WebSocket(url); }
      catch (e) { this._tryNextUrl(); return; }
      this.ws = ws;
      let settled = false;        // did this socket ever open?

      ws.onopen = () => {
        settled = true;
        this.connected = true;
        this._reconnectDelay = 1000;
        this._register();
        this._startHeartbeat();
        this._emitState();
      };

      ws.onmessage = (e) => this._onMessage(e.data);

      ws.onerror = () => { /* close fires next; handled there */ };

      ws.onclose = () => {
        clearInterval(this._heartbeat);
        if (this.pointerWs) { try { this.pointerWs.close(); } catch (_) {} this.pointerWs = null; }
        this._rejectAllPending(new Error('socket closed'));

        if (!settled) {
          // Never opened on this URL — the browser likely blocked it
          // (mixed content or self-signed cert). Try the next candidate.
          this._tryNextUrl();
          return;
        }
        this.connected = false;
        this.paired = false;
        this._emitState();
        this._scheduleReconnect();
      };
    }

    _tryNextUrl() {
      this._urlIndex += 1;
      if (this._urlIndex >= this._urls.length) { this._onAllUrlsFailed(); return; }
      this._connect();
    }

    _onAllUrlsFailed() {
      this.connected = false;
      this.paired = false;
      this._emitState();
      const hint = location.protocol === 'https:'
        ? 'This HTTPS page is blocked from reaching the TV (self-signed cert / mixed content). Open the app over http://<host>:port on your Wi-Fi instead.'
        : 'Could not reach the TV. Check the IP and that the TV is on the same Wi-Fi.';
      this.emit('error', hint);
      this._scheduleReconnect();
    }

    _register() {
      const payload = JSON.parse(JSON.stringify(HANDSHAKE));
      if (this.clientKey) payload['client-key'] = this.clientKey;
      this._sendRaw({ type: 'register', id: 'register_0', payload });
    }

    _onMessage(data) {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

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
        clearTimeout(p.timer);
        if (msg.type === 'error') p.reject(new Error(msg.error || 'tv error'));
        else p.resolve(msg.payload || {});
      }
    }

    // ---- requests ---------------------------------------------------------

    _sendRaw(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    request(uri, payload) {
      payload = payload || {};
      return new Promise((resolve, reject) => {
        if (!this.paired) return reject(new Error('not connected'));
        const id = 'req_' + (++this.cmdId);
        const timer = setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); }
        }, 6000);
        this.pending.set(id, { resolve, reject, timer });
        const ok = this._sendRaw({ type: 'request', id, uri, payload });
        if (!ok) { this.pending.delete(id); clearTimeout(timer); reject(new Error('not connected')); }
      });
    }

    // ---- pointer / input socket (d-pad, media, number keys) ---------------

    async _ensurePointer() {
      if (this.pointerWs && this.pointerWs.readyState === WebSocket.OPEN) return this.pointerWs;
      const res = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
      const path = res.socketPath;
      if (!path) throw new Error('no pointer socket');
      await new Promise((resolve, reject) => {
        const pws = new WebSocket(path);
        this.pointerWs = pws;
        const to = setTimeout(() => reject(new Error('pointer timeout')), 8000);
        pws.onopen = () => { clearTimeout(to); resolve(); };
        pws.onerror = () => { clearTimeout(to); reject(new Error('pointer error')); };
        pws.onclose = () => { if (this.pointerWs === pws) this.pointerWs = null; };
      });
      return this.pointerWs;
    }

    async button(name) {
      const pws = await this._ensurePointer();
      pws.send('type:button\nname:' + name + '\n\n');
    }

    async click() {
      const pws = await this._ensurePointer();
      pws.send('type:click\n\n');
    }

    async move(dx, dy, drag) {
      const pws = await this._ensurePointer();
      pws.send('type:move\ndx:' + dx + '\ndy:' + dy + '\ndown:' + (drag ? 1 : 0) + '\n\n');
    }

    async scroll(dx, dy) {
      const pws = await this._ensurePointer();
      pws.send('type:scroll\ndx:' + dx + '\ndy:' + dy + '\n\n');
    }

    // ---- convenience commands --------------------------------------------

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
    getChannelList()   { return this.request('ssap://tv/getChannelList'); }
    openChannel(id)    { return this.request('ssap://tv/openChannel', { channelId: id }); }
    getCurrentChannel(){ return this.request('ssap://tv/getCurrentChannel'); }

    // ---- status + heartbeat ----------------------------------------------

    async _refreshStatus() {
      try {
        const v = await this.getVolume();
        this.emit('volume', { volume: v.volume, muted: v.muted });
      } catch (_) {}
    }

    _startHeartbeat() {
      clearInterval(this._heartbeat);
      // The browser WebSocket API has no ping frame, so we keep the socket warm
      // with a cheap SSAP request. If it times out the socket is dead and we
      // close it to trigger a fast reconnect rather than hanging.
      this._heartbeat = setInterval(() => {
        if (!this.paired) return;
        this.request('ssap://api/getServiceList').catch(() => {
          try { this.ws && this.ws.close(); } catch (_) {}
        });
      }, 10000);
    }

    _rejectAllPending(err) {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    }

    state() {
      return { ip: this.ip, connected: this.connected, paired: this.paired };
    }

    _emitState() { this.emit('state', this.state()); }
  }

  global.LGTV = LGTV;
})(window);
