# LG Remote (direct PWA)

An installable PWA remote for LG webOS TVs that connects **directly to the TV from the browser** — the page speaks the webOS SSAP protocol itself over a WebSocket. There is no bridge/relay process and no runtime dependencies; `server.js` is just a static file host so your phone can load the app over Wi-Fi.

The pairing key is stored in the browser's `localStorage`, so you accept the on-screen prompt once and never again on that device.

## How the connection works

The browser opens a WebSocket straight to the TV:

- `ws://<TV-IP>:3000` — plaintext SSAP (works from an **http** page)
- `wss://<TV-IP>:3001` — TLS SSAP, but the TV uses a **self-signed** cert

The client (`public/lgtv.js`) tries the best port for the current page protocol first and falls back to the other.

### ⚠️ Important hosting constraint (read this)

A *fully direct* browser→TV connection is limited by browser security, and these limits apply to **iOS Safari and installed PWAs too**:

| You open the app over… | `ws://:3000` | `wss://:3001` (self-signed) | Works? |
|---|---|---|---|
| **http** on the LAN / localhost | ✅ allowed | ❌ cert rejected | ✅ **yes — use this** |
| **https** (installed PWA) | ❌ mixed content blocked | ❌ cert rejected | ❌ no |

So:
- **To actually control the TV directly, open the app over plain HTTP** on the same Wi-Fi, e.g. `http://192.168.1.50:3777`. This works in iOS Safari as a tab.
- An **installed HTTPS home-screen PWA cannot reach the TV directly** — Safari blocks the insecure socket (mixed content) and rejects the TV's self-signed certificate, with no way to override either from JavaScript. This isn't a bug in the app; it's the browser security model. (The old version shipped a Node "bridge" specifically to work around this — that's the trade-off you give up for "no bridge".)

If you need both an installed HTTPS PWA **and** TV control, the only options are: (a) put a small relay/bridge back in, or (b) install a TV-trusted certificate — neither is possible from the PWA alone.

## Requirements
- Phone/computer and TV on the same LAN (a DHCP-reserved TV IP is recommended)
- On the TV: General → External Devices / Network → **"LG Connect Apps"** (or "Mobile TV On") enabled
- Node.js 18+ *only if* you use the bundled `server.js` to host the files (any static server works)

## Run / host the files
```bash
npm start          # serves ./public over http on port 3777, no npm install needed
```
Then, on the **same Wi-Fi**, open `http://<this-machine-ip>:3777` on your phone.

(Any static file host works — `python3 -m http.server`, nginx, etc. The app is pure static files in `public/`.)

## First launch
1. Open the app over http on your phone.
2. Tap the status pill / the sheet appears → enter the TV's IP → **Save & connect**.
3. The TV shows an "allow this device?" prompt — accept it once.
4. The pairing key is saved in the browser and reused forever after on that device.

## Power ON
`turnOff` works over the socket. Powering a TV **on** can't go over the same socket (the TV's network service is asleep) — that needs Wake-on-LAN, which a browser can't send. Power-off, all other controls, inputs, channels, apps, and the touchpad work directly.

## Files
- `public/lgtv.js` — in-browser SSAP client (pairing, requests, pointer/input socket, heartbeat, auto-reconnect, port fallback)
- `public/app.js` — UI wiring; routes every button straight to the TV
- `public/` — the rest of the PWA (html/css, manifest, service worker, icons)
- `server.js` — optional static file host (zero dependencies)

## App shortcut IDs
Defined in `public/app.js` (`APPS`). Some IDs vary by region/firmware. To discover the exact IDs your TV uses, the client can call `ssap://com.webos.applicationManager/listLaunchPoints` — easy to wire into a "discover apps" button if you want it.
