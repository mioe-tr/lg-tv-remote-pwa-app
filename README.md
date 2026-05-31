# LG Remote Bridge

A fast, persistent remote for LG webOS TVs. A small Node process on your Mac holds **one** live connection to the TV (reusing the saved pairing key, with a heartbeat so it never goes idle), and serves an installable PWA. Because the browser only ever talks to the local bridge — not the TV — you avoid every browser-side wall that breaks pure-PWA remotes (self-signed cert, mixed content, invalid-origin rejection).

The payoff: a button press is one local round-trip with **no rediscovery and no re-pairing**, which is exactly the lag ThinQ pays on every cold start.

## Requirements
- Node.js 18+
- Mac and TV on the same LAN (DHCP-reserved TV IP recommended)
- On the TV: General → External Devices / Network → "LG Connect Apps" (or "Mobile TV On") enabled

## Run
```bash
npm install
npm start
```
Then open **http://localhost:3777** on the Mac.

First launch: enter the TV's IP in the sheet. The TV shows an "allow this device?" prompt — accept it once. The returned client-key is saved to `config.json` and reused forever after, so you never see the prompt again.

You can also preset the IP:
```bash
LG_TV_IP=192.168.1.42 npm start
```

## Install as a PWA
In Chrome/Edge on the Mac, open the URL and use the install icon in the address bar ("Install LG Remote"). It then launches as its own window. Service worker + manifest are wired up; the app shell is cached so it opens instantly.

## Using it from your iPhone (optional)
`localhost` is a "secure context" so the PWA installs cleanly **on the Mac**. iOS Safari pointed at `http://<mac-ip>:3777` will work as a remote but **won't register the service worker or install** as a PWA, because plain http over the LAN isn't a secure context. To get full PWA behaviour on the phone you'd need to serve the bridge over HTTPS (e.g. a self-signed cert you trust on the phone, or a local reverse proxy like Caddy with an internal CA). The remote functions either way.

## Power ON
`turnOff` works over the socket. Powering a TV **on** can't go over the same socket (the TV's network service is asleep) — it needs Wake-on-LAN. If you want that, enable "Mobile TV On" / "Turn on via Wi-Fi" on the TV and we can add a WoL magic-packet step keyed to the TV's MAC.

## Files
- `server.js` — bridge: serves the PWA, relays browser ⇄ TV
- `lib/lgclient.js` — SSAP client (pairing, requests, pointer/input socket, heartbeat, auto-reconnect)
- `public/` — the PWA (html/css/js, manifest, service worker, icons)
- `config.json` — created at runtime; stores TV IP + client-key

## App shortcut IDs
Defined in `server.js` (`APPS`). Some IDs vary by region/firmware. To find the exact IDs your TV uses, the client can call `ssap://com.webos.applicationManager/listLaunchPoints` — say the word and I'll wire a "discover apps" button.
