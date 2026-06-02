# LG Remote Bridge — ESP32-S2 firmware

A self-contained hardware bridge that lets an **installable iOS PWA** control an **LG webOS TV**. The ESP32 serves the PWA over HTTPS *and* holds the live connection to the TV, so your phone only ever talks to the ESP32 — which is the one device whose certificate you can actually make iOS trust.

```
iPhone PWA ──wss://lgbridge.local──► ESP32-S2 ──ws://TV:3000──► LG webOS TV
                                      • serves the PWA (embedded in flash)
                                      • keeps the SSAP pairing key
                                      • heartbeat + auto-reconnect
```

Why a device at all? An installed HTTPS PWA can't reach the TV directly: Safari blocks the TV's plaintext socket (mixed content) and rejects its self-signed cert. The ESP32 isn't a browser, so it talks to the TV in the clear with no such limits, and it presents the phone a *single* TLS origin you trust once. The TV link is deliberately plaintext so only **one** TLS session runs — which keeps the memory-limited S2 happy.

## What you need
- An ESP32-S2 dev board (PSRAM helps but isn't required)
- Arduino IDE 2.x with the **ESP32 boards** package (Boards Manager → "esp32" by Espressif)
- These libraries (Library Manager):
  - **esp32_https_server** by Frank Hessel
  - **WebSockets** by Markus Sattler
  - **ArduinoJson** (6.x recommended)
- `openssl` on your computer (for the cert script)
- TV setting enabled: General → External Devices / Network → **"LG Connect Apps" / "Mobile TV On"**

## Build & flash — step by step

### 1. Configure
Edit **`config.h`**: your Wi-Fi, a **fixed** IP for the ESP32 (static IP or a DHCP reservation), an mDNS name, and your TV's IP. The ESP32's address must not change, because the cert is bound to it.

### 2. Generate the TLS cert (must match config.h)
```bash
cd esp32-bridge
./tools/make_cert.sh 192.168.1.60 lgbridge      # use YOUR ip + mDNS name
```
This writes:
- `cert.h` — embedded in the sketch (git-ignored; holds the private key)
- `lg-bridge.crt` — the cert to install on your iPhone

### 3. Flash
Open `lg_remote_bridge.ino` in Arduino IDE, select your ESP32-S2 board + port, and Upload. Open Serial Monitor at 115200 — you should see the IP, the mDNS URL, "HTTPS up", and the TV connection line.

> The web UI is embedded via `web_assets.h` (already generated). If you tweak anything in `web/`, regenerate it: `python3 tools/gen_web_assets.py`.

### 4. Trust the cert on your iPhone (one time)
1. AirDrop or email **`lg-bridge.crt`** to the iPhone and open it.
2. Settings → General → VPN & Device Management → install the **profile**.
3. Settings → General → About → **Certificate Trust Settings** → enable full trust for **"LG Remote Bridge"**.

This step is mandatory — without it iOS won't load the HTTPS page or open the secure WebSocket.

### 5. Install the PWA
On the same Wi-Fi, open **`https://lgbridge.local`** (or `https://<esp32-ip>`) in Safari. It should load with no certificate warning. Share → **Add to Home Screen**. Launch it from the home screen — it now runs as a standalone app.

### 6. Pair with the TV (one time)
Open the app, enter the TV's IP if prompted (it's stored on the ESP32), and accept the **"allow this device?"** prompt on the TV. The pairing key is saved in the ESP32's flash and reused forever, so you won't be prompted again.

## Notes & limits
- **Power ON** isn't possible over this link (the TV's network service is asleep); `turnOff` and everything else works. Wake-on-LAN would need the TV's MAC and a separate magic-packet step.
- **Large channel lists** are parsed within `TV_JSON_CAPACITY` (config.h). If channels truncate on a no-PSRAM board, raise it or rely on CH+/CH−.
- **Cert expiry**: the cert lasts ~397 days (iOS caps trust at ~398). Re-run `make_cert.sh`, re-flash, and re-trust when it expires.
- **IP changes** break the cert. Keep the ESP32 on a fixed address.
- The TV link uses plaintext port **3000**. If your TV's firmware disabled it, the bridge would need TLS to port 3001 (a second TLS session) — open an issue and we can add it, but it's heavier on the S2.

## Files
- `lg_remote_bridge.ino` — the firmware (HTTPS + WSS server, SSAP client, pointer socket, pairing, reconnect)
- `config.h` — your settings (**edit this**)
- `cert.h` — generated TLS cert/key (**git-ignored**); `cert.h.example` shows the expected symbols
- `handshake.h` — embedded webOS SSAP pairing payload
- `web_assets.h` — the PWA embedded as PROGMEM (generated from `web/`)
- `web/` — PWA source (bridge-style UI; talks to `/ws` with a small JSON protocol)
- `tools/make_cert.sh` — iOS-compatible self-signed cert generator
- `tools/gen_web_assets.py` — regenerates `web_assets.h` from `web/`
