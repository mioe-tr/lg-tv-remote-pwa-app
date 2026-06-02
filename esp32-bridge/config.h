// ─── EDIT THIS FILE ──────────────────────────────────────────────────────────
// Your Wi-Fi, the ESP32's address, and the TV. Then (re)run tools/make_cert.sh
// with the SAME ip/name you set here so the TLS cert matches.
#pragma once

// Wi-Fi the ESP32 (and your iPhone) are on.
#define WIFI_SSID   "your-wifi"
#define WIFI_PASS   "your-wifi-password"

// mDNS name -> the bridge is reachable at https://<MDNS_NAME>.local
// (must match the name you pass to make_cert.sh).
#define MDNS_NAME   "lgbridge"

// Give the ESP32 a FIXED address. iOS trusts the cert by IP/name, so the
// address must not change. Either set a static IP here, or make a DHCP
// reservation on your router for the ESP32's MAC and set USE_STATIC_IP to 0.
#define USE_STATIC_IP 1
#define STATIC_IP   192,168,1,60      // must match the IP given to make_cert.sh
#define GATEWAY_IP  192,168,1,1
#define SUBNET_IP   255,255,255,0
#define DNS_IP      192,168,1,1

// Your LG TV's IP. You can also change it later from the app's settings sheet
// (it is stored in the ESP32's flash and survives reboots).
#define TV_IP_DEFAULT "192.168.1.42"

// LG SSAP plaintext port. The ESP talks to the TV in the clear (it is not a
// browser, so no mixed-content/cert rules apply). Leave at 3000 unless your
// firmware disabled it, in which case see the README about port 3001.
#define TV_PORT 3000

// HTTPS port the iPhone connects to. 443 lets you use https://<name>.local
// with no port suffix.
#define HTTPS_PORT 443

// Max JSON we parse from the TV. Input lists are tiny; very large channel
// lists may need more. Raise if your board has PSRAM and channels truncate.
#define TV_JSON_CAPACITY 20480
