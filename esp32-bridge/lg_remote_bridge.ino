/*
 * LG Remote Bridge — ESP32-S2 firmware (Arduino)
 * ---------------------------------------------------------------------------
 * A self-contained bridge between an installable iOS PWA and an LG webOS TV.
 *
 *   iPhone PWA  ──wss://(this device):443──►  ESP32-S2  ──ws://TV:3000──►  LG TV
 *
 * The ESP32:
 *   - serves the PWA over HTTPS (files embedded in web_assets.h) so iOS can
 *     install it as a real home-screen app (you trust the cert once),
 *   - exposes a /ws endpoint the PWA talks to with a tiny JSON protocol,
 *   - holds ONE plaintext SSAP connection to the TV, reusing the stored
 *     pairing key (so the TV only prompts once) with ws-level heartbeat +
 *     auto-reconnect,
 *   - relays d-pad/media/number keys over the TV's pointer-input socket and
 *     everything else over the main SSAP socket.
 *
 * The TV link is plaintext on purpose: the ESP is not a browser, so it is not
 * subject to mixed-content or self-signed-cert rules, and keeping it plaintext
 * means we only ever run ONE TLS session (the phone side) — friendly to the
 * S2's limited RAM.
 *
 * Libraries (install via Arduino Library Manager):
 *   - esp32_https_server   (by Frank Hessel)        — HTTPS + WSS server
 *   - WebSockets           (by Markus Sattler)       — ws client to the TV
 *   - ArduinoJson 6.x      (by Benoit Blanchon)
 * Board: any ESP32-S2 dev board (ESP32 Arduino core 2.x/3.x).
 *
 * Before flashing: edit config.h, then run  tools/make_cert.sh <ip> <name>
 * with the same IP/name to produce cert.h. See README.md.
 */

#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include <HTTPSServer.hpp>
#include <SSLCert.hpp>
#include <HTTPRequest.hpp>
#include <HTTPResponse.hpp>
#include <ResourceNode.hpp>
#include <WebsocketHandler.hpp>

#include <vector>
#include <sstream>

#include "config.h"
#include "cert.h"          // CERT_DER / PKEY_DER (run tools/make_cert.sh)
#include "handshake.h"     // HANDSHAKE_JSON
#include "web_assets.h"    // WEB_ASSETS[] (run tools/gen_web_assets.py)

using namespace httpsserver;

// ─── global state ────────────────────────────────────────────────────────────
Preferences      prefs;
WebSocketsClient tvWs;        // main SSAP socket  -> TV:3000
WebSocketsClient ptrWs;       // pointer-input socket (d-pad/media/numbers)

String  tvIp;
String  clientKey;
bool     tvConnected = false; // socket to TV open
bool     paired      = false; // SSAP registration accepted
uint32_t cmdId       = 0;

// Pointer-input socket state machine. The TV hands us a separate socket for
// button/move/click/scroll; we lazily request it and queue keys until it opens.
enum PtrState { PTR_IDLE, PTR_REQUESTING, PTR_READY };
PtrState            ptrState = PTR_IDLE;
std::vector<String> ptrQueue;

// Parsed TV messages reuse one document to avoid heap churn next to the TLS
// session. (ArduinoJson 7 ignores the capacity and grows as needed.)
StaticJsonDocument<256> phoneDoc;       // phone commands are tiny
DynamicJsonDocument     tvDoc(TV_JSON_CAPACITY);

HTTPSServer *server = nullptr;
SSLCert     *cert   = nullptr;

// ─── forward declarations ────────────────────────────────────────────────────
class PhoneSocket;
std::vector<PhoneSocket *> phones;

void   broadcastPhones(const String &msg);
String currentStateJson();
void   handlePhoneCommand(const String &msg);
void   tvRegister();
String tvRequest(const char *kindPrefix, const char *uri, const String &payload);
void   queuePointer(const String &frame);
void   connectPointer(const char *socketPath);
const char *resolveApp(const char *name);

// ─── the PWA <-> bridge WebSocket (served over TLS at /ws) ───────────────────
class PhoneSocket : public WebsocketHandler {
public:
  static WebsocketHandler *create() {
    PhoneSocket *p = new PhoneSocket();
    phones.push_back(p);
    p->send(std::string(currentStateJson().c_str()));   // greet with state (text)
    return p;
  }

  void onMessage(WebsocketInputStreambuf *inbuf) override {
    std::ostringstream ss;
    ss << inbuf;
    handlePhoneCommand(String(ss.str().c_str()));
  }

  void onClose() override {
    for (size_t i = 0; i < phones.size(); i++) {
      if (phones[i] == this) { phones.erase(phones.begin() + i); break; }
    }
  }
};

void broadcastPhones(const String &msg) {
  std::string s(msg.c_str());
  for (PhoneSocket *p : phones) p->send(s);   // defaults to text frame
}

// ─── state / status messages to the phone ────────────────────────────────────
String currentStateJson() {
  String s = "{\"type\":\"state\",\"ip\":\"" + tvIp + "\",\"connected\":";
  s += tvConnected ? "true" : "false";
  s += ",\"paired\":";
  s += paired ? "true" : "false";
  s += "}";
  return s;
}
void broadcastState()  { broadcastPhones(currentStateJson()); }
void broadcastPrompt() { broadcastPhones("{\"type\":\"prompt\"}"); }
void phoneErr(const char *e) {
  broadcastPhones(String("{\"type\":\"err\",\"error\":\"") + e + "\"}");
}

// ─── static file serving (PROGMEM -> TLS, chunked) ───────────────────────────
void serveAsset(HTTPResponse *res, const WebAsset &a) {
  res->setHeader("Content-Type", a.mime);
  const size_t CH = 512;
  uint8_t buf[CH];
  for (size_t off = 0; off < a.len; off += CH) {
    size_t n = (a.len - off < CH) ? (a.len - off) : CH;
    memcpy_P(buf, a.data + off, n);
    res->write(buf, n);
  }
}
void handleRoot(HTTPRequest *, HTTPResponse *res) { serveAsset(res, WEB_ASSETS[0]); }
void handleAsset(HTTPRequest *req, HTTPResponse *res) {
  std::string p = req->getRequestString();
  for (size_t i = 0; i < WEB_ASSETS_COUNT; i++) {
    if (p == WEB_ASSETS[i].path) { serveAsset(res, WEB_ASSETS[i]); return; }
  }
  res->setStatusCode(404);
  res->print("not found");
}
void handle404(HTTPRequest *, HTTPResponse *res) {
  res->setStatusCode(404);
  res->print("not found");
}

// ─── /api/config (set TV IP from the app's settings sheet) ───────────────────
void handleConfigGet(HTTPRequest *, HTTPResponse *res) {
  res->setHeader("Content-Type", "application/json");
  String out = "{\"ip\":\"" + tvIp + "\",\"connected\":";
  out += tvConnected ? "true" : "false";
  out += ",\"paired\":";
  out += paired ? "true" : "false";
  out += "}";
  res->print(out.c_str());
}
void handleConfigPost(HTTPRequest *req, HTTPResponse *res) {
  String body;
  char buf[257];
  int guard = 0;
  while (!req->requestComplete() && guard++ < 64) {
    size_t n = req->readBytes((byte *)buf, 256);
    if (!n) break;
    buf[n] = 0;
    body += buf;
  }
  res->setHeader("Content-Type", "application/json");
  StaticJsonDocument<256> d;
  if (deserializeJson(d, body)) { res->setStatusCode(400); res->print("{\"error\":\"bad json\"}"); return; }
  const char *ip = d["ip"] | "";
  // very light validation: digits + dots only, has at least 3 dots
  int dots = 0; bool ok = strlen(ip) >= 7;
  for (const char *c = ip; *c && ok; c++) { if (*c == '.') dots++; else if (*c < '0' || *c > '9') ok = false; }
  if (!ok || dots != 3) { res->setStatusCode(400); res->print("{\"error\":\"bad ip\"}"); return; }

  tvIp = ip;
  prefs.putString("tvip", tvIp);
  // changing the TV invalidates the stored key; re-pair from scratch
  clientKey = "";
  prefs.remove("ckey");
  paired = false; tvConnected = false;
  ptrState = PTR_IDLE; ptrQueue.clear();
  if (ptrWs.isConnected()) ptrWs.disconnect();
  tvWs.disconnect();
  tvWs.begin(tvIp.c_str(), TV_PORT, "/");
  res->print((String("{\"ok\":true,\"ip\":\"") + tvIp + "\"}").c_str());
}

// ─── TV (SSAP) side ──────────────────────────────────────────────────────────
String tvRequest(const char *kindPrefix, const char *uri, const String &payload) {
  String id = String(kindPrefix) + "_" + String(++cmdId);
  String msg = "{\"type\":\"request\",\"id\":\"" + id + "\",\"uri\":\"" + uri + "\"";
  if (payload.length()) msg += ",\"payload\":" + payload;
  msg += "}";
  tvWs.sendTXT(msg);
  return id;
}

void tvRegister() {
  String payload((const __FlashStringHelper *)HANDSHAKE_JSON);
  if (clientKey.length()) {
    // inject "client-key" right after the opening '{'
    payload = "{\"client-key\":\"" + clientKey + "\"," + payload.substring(1);
  }
  String msg = "{\"type\":\"register\",\"id\":\"register_0\",\"payload\":" + payload + "}";
  tvWs.sendTXT(msg);
}

void queuePointer(const String &frame) {
  if (!paired) { phoneErr("not connected"); return; }
  if (ptrState == PTR_READY && ptrWs.isConnected()) { ptrWs.sendTXT(frame); return; }
  ptrQueue.push_back(frame);
  if (ptrState == PTR_IDLE) {
    ptrState = PTR_REQUESTING;
    tvRequest("ptr", "ssap://com.webos.service.networkinput/getPointerInputSocket", "");
  }
}

void flushPointerQueue() {
  for (const String &f : ptrQueue) ptrWs.sendTXT(f);
  ptrQueue.clear();
}

void connectPointer(const char *socketPath) {
  String sp(socketPath);
  if (sp.startsWith("wss://"))      sp = sp.substring(6);
  else if (sp.startsWith("ws://"))  sp = sp.substring(5);
  int slash = sp.indexOf('/');
  String hostport = slash < 0 ? sp : sp.substring(0, slash);
  String path     = slash < 0 ? "/" : sp.substring(slash);
  int colon = hostport.indexOf(':');
  String host = colon < 0 ? hostport : hostport.substring(0, colon);
  int port    = colon < 0 ? TV_PORT  : hostport.substring(colon + 1).toInt();
  ptrWs.begin(host.c_str(), port, path.c_str());
}

void onTvText(uint8_t *payload, size_t len) {
  tvDoc.clear();
  if (deserializeJson(tvDoc, payload, len)) return;
  const char *type = tvDoc["type"] | "";
  const char *id   = tvDoc["id"]   | "";

  if (!strcmp(type, "registered")) {
    paired = true;
    const char *key = tvDoc["payload"]["client-key"] | "";
    if (strlen(key) && clientKey != key) {
      clientKey = key;
      prefs.putString("ckey", clientKey);   // persist -> never prompt again
    }
    broadcastState();
    tvRequest("vol", "ssap://audio/getVolume", "");
    return;
  }
  if (!strcmp(type, "response") &&
      tvDoc["payload"]["pairingType"] == "PROMPT") {
    broadcastPrompt();
    return;
  }
  if (!strcmp(type, "error") && !strcmp(id, "register_0")) {
    // stored key rejected (e.g. TV was reset) -> drop and re-prompt
    clientKey = ""; prefs.remove("ckey");
    tvRegister();
    return;
  }

  // responses, dispatched by id prefix
  if (!strncmp(id, "vol_", 4)) {
    int  vol   = tvDoc["payload"]["volume"] | 0;
    bool muted = tvDoc["payload"]["muted"]  | false;
    String out = "{\"type\":\"volume\",\"volume\":" + String(vol) +
                 ",\"muted\":" + (muted ? "true" : "false") + "}";
    broadcastPhones(out);
  } else if (!strncmp(id, "inp_", 4)) {
    String devices; serializeJson(tvDoc["payload"]["devices"], devices);
    broadcastPhones("{\"type\":\"inputs\",\"devices\":" + devices + "}");
  } else if (!strncmp(id, "chn_", 4)) {
    String list; serializeJson(tvDoc["payload"]["channelList"], list);
    broadcastPhones("{\"type\":\"channels\",\"list\":" + list + "}");
  } else if (!strncmp(id, "ptr_", 4)) {
    const char *sp = tvDoc["payload"]["socketPath"] | "";
    if (strlen(sp)) connectPointer(sp);
    else { ptrState = PTR_IDLE; ptrQueue.clear(); }
  }
}

void onTvEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      tvConnected = true;
      tvRegister();
      broadcastState();
      break;
    case WStype_DISCONNECTED:
      tvConnected = false;
      paired = false;
      ptrState = PTR_IDLE;
      ptrQueue.clear();
      broadcastState();
      break;
    case WStype_TEXT:
      onTvText(payload, len);
      break;
    default:
      break;
  }
}

void onPtrEvent(WStype_t type, uint8_t *, size_t) {
  if (type == WStype_CONNECTED) {
    ptrState = PTR_READY;
    flushPointerQueue();
  } else if (type == WStype_DISCONNECTED) {
    if (ptrState == PTR_READY) ptrState = PTR_IDLE;
  }
}

// ─── phone command dispatch (mirrors the old Node bridge relay) ──────────────
const char *resolveApp(const char *name) {
  struct { const char *k; const char *id; } APPS[] = {
    {"netflix", "netflix"},
    {"youtube", "youtube.leanback.v4"},
    {"disney", "com.disney.disneyplus-prod"},
    {"primevideo", "amazon"},
    {"spotify", "spotify-beehive"},
    {"appletv", "com.apple.appletv"},
    {"browser", "com.webos.app.browser"},
    {"livetv", "com.webos.app.livetv"},
  };
  for (auto &a : APPS) if (!strcmp(a.k, name)) return a.id;
  return name;   // already a full app id
}

void handlePhoneCommand(const String &msg) {
  phoneDoc.clear();
  if (deserializeJson(phoneDoc, msg)) return;
  const char *a = phoneDoc["action"] | "";
  if (!a[0]) return;

  if (!strcmp(a, "button")) {
    queuePointer(String("type:button\nname:") + (const char *)(phoneDoc["name"] | "") + "\n\n");
  } else if (!strcmp(a, "click")) {
    queuePointer("type:click\n\n");
  } else if (!strcmp(a, "move")) {
    int dx = phoneDoc["dx"] | 0, dy = phoneDoc["dy"] | 0;
    bool drag = phoneDoc["drag"] | false;
    queuePointer("type:move\ndx:" + String(dx) + "\ndy:" + String(dy) +
                 "\ndown:" + (drag ? "1" : "0") + "\n\n");
  } else if (!strcmp(a, "scroll")) {
    int dx = phoneDoc["dx"] | 0, dy = phoneDoc["dy"] | 0;
    queuePointer("type:scroll\ndx:" + String(dx) + "\ndy:" + String(dy) + "\n\n");
  } else if (!paired) {
    phoneErr("not connected");
  } else if (!strcmp(a, "volUp")) {
    tvRequest("req", "ssap://audio/volumeUp", "");
  } else if (!strcmp(a, "volDown")) {
    tvRequest("req", "ssap://audio/volumeDown", "");
  } else if (!strcmp(a, "mute")) {
    bool v = phoneDoc["value"] | false;
    tvRequest("req", "ssap://audio/setMute", String("{\"mute\":") + (v ? "true" : "false") + "}");
  } else if (!strcmp(a, "chUp")) {
    tvRequest("req", "ssap://tv/channelUp", "");
  } else if (!strcmp(a, "chDown")) {
    tvRequest("req", "ssap://tv/channelDown", "");
  } else if (!strcmp(a, "power")) {
    tvRequest("req", "ssap://system/turnOff", "");
  } else if (!strcmp(a, "launch")) {
    const char *id = resolveApp(phoneDoc["app"] | "");
    tvRequest("req", "ssap://system.launcher/launch", String("{\"id\":\"") + id + "\"}");
  } else if (!strcmp(a, "switchInput")) {
    tvRequest("req", "ssap://tv/switchInput",
              String("{\"inputId\":\"") + (const char *)(phoneDoc["inputId"] | "") + "\"}");
  } else if (!strcmp(a, "openChannel")) {
    tvRequest("req", "ssap://tv/openChannel",
              String("{\"channelId\":\"") + (const char *)(phoneDoc["channelId"] | "") + "\"}");
  } else if (!strcmp(a, "getInputs")) {
    tvRequest("inp", "ssap://tv/getExternalInputList", "");
  } else if (!strcmp(a, "getChannels")) {
    tvRequest("chn", "ssap://tv/getChannelList", "");
  }
}

// ─── setup / loop ────────────────────────────────────────────────────────────
void connectWifi() {
#if USE_STATIC_IP
  IPAddress ip(STATIC_IP), gw(GATEWAY_IP), sn(SUBNET_IP), dns(DNS_IP);
  WiFi.config(ip, gw, sn, dns);
#endif
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                 // keep latency low
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\n  IP   https://%s\n", WiFi.localIP().toString().c_str());
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("https", "tcp", HTTPS_PORT);
    Serial.printf("  mDNS https://%s.local\n", MDNS_NAME);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nLG Remote Bridge (ESP32-S2)");

  prefs.begin("lgbridge", false);
  tvIp      = prefs.getString("tvip", TV_IP_DEFAULT);
  clientKey = prefs.getString("ckey", "");

  connectWifi();

  // TLS server: serves the PWA + the /ws bridge endpoint on one origin.
  cert = new SSLCert((unsigned char *)CERT_DER, CERT_DER_len,
                     (unsigned char *)PKEY_DER, PKEY_DER_len);
  server = new HTTPSServer(cert, HTTPS_PORT, 4);

  server->registerNode(new ResourceNode("/", "GET", &handleRoot));
  for (size_t i = 0; i < WEB_ASSETS_COUNT; i++)
    server->registerNode(new ResourceNode(WEB_ASSETS[i].path, "GET", &handleAsset));
  server->registerNode(new ResourceNode("/api/config", "GET",  &handleConfigGet));
  server->registerNode(new ResourceNode("/api/config", "POST", &handleConfigPost));
  server->registerNode(new WebsocketNode("/ws", &PhoneSocket::create));
  server->setDefaultNode(new ResourceNode("", "GET", &handle404));
  server->start();
  Serial.println(server->isRunning() ? "  HTTPS up" : "  HTTPS FAILED");

  // TV connection (plaintext SSAP, persistent, with heartbeat + reconnect).
  tvWs.onEvent(onTvEvent);
  tvWs.setReconnectInterval(3000);
  tvWs.enableHeartbeat(15000, 3000, 2);
  tvWs.begin(tvIp.c_str(), TV_PORT, "/");

  ptrWs.onEvent(onPtrEvent);
  ptrWs.setReconnectInterval(3000);

  Serial.printf("  TV   ws://%s:%d\n", tvIp.c_str(), TV_PORT);
}

void loop() {
  server->loop();
  tvWs.loop();
  ptrWs.loop();
}
