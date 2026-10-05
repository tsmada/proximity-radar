# PHOSPHOR

A retro proximity radar for your desk. A small local Node server listens with this machine's
radios (Bluetooth LE, plus ARP / mDNS / SSDP on your LAN) and streams what it hears to a
Cold War style PPI scope in your browser: a rotating sweep, P7 phosphor afterglow, and a
terminal readout of every contact.

Built on Remix v3 (`remix@3.0.0`) with no build step. The browser gets updates over
Server-Sent Events.

## What it is, honestly

- **The centre is this computer.** Each blip is a nearby device.
- **Distance is a guess.** BLE signal strength (RSSI) is smoothed (median of 5, then EMA) and
  put through a log-distance model. Walls, bodies, pockets and antennas easily throw it off by
  ±50% or more. The UI shows coarse rings (NEAR / MID / FAR) and only ever writes `~N m (±50%)`.
- **Bearing means nothing.** The angle comes from a hash of the device id, so the compass is
  labelled `ID°`, not N/E/S/W.
- **LAN devices have no distance.** ARP, mDNS and SSDP tell us *who* is on the network, not
  how far away. Those devices sit on the outer **ON-NET** ring.
- **Phones rotate their addresses.** iOS and Android randomise Wi-Fi MACs and rotate BLE
  addresses about every 15 minutes, so the same phone can show up as a new contact. Contacts
  age out: STALE after 15 s unheard, LOST after 60 s.
- **BLE and LAN can't be linked automatically.** Use **MERGE** in the readout to fold a BLE
  blip into its LAN entry (for example the TV's BLE beacon into the TV's mDNS entry).
- Every contact lists its sources (`BLE` / `LAN` / `WIFI` / `SIM`) and a confidence.
- **DEMO DATA** (the `SIM` source) is fake. By default it runs only while no live sensor is
  available, and the UI says `SIM RUNNING · CONTACTS ARE FAKE` while it does.

## Requirements

- **Node.js ≥ 24.3** (developed on v25.9). Check with `node -v`.
- **macOS** gets every sensor. Linux runs ARP, mDNS, SSDP and BLE, but not the station Wi-Fi
  readout.
- For BLE: a Bluetooth LE adapter. `@abandonware/noble` is a native module, so `npm install`
  needs build tools (Xcode Command Line Tools on macOS).

## Run

```sh
npm install
npm start           # production mode → http://127.0.0.1:4777
npm run dev         # restarts the server on change
npm run hmr         # live server + browser HMR (proxy on :4777)
npm test            # unit + router tests
npm run typecheck
```

`PORT=5000 npm start` changes the port. The host is always `127.0.0.1` (see Privacy below).
Stop the server with Ctrl-C. It stops every collector, closes its sockets and kills any child
processes before exiting.

## Sensors

Turn each one on or off in the **SENSORS** panel. Each reports ONLINE, NEEDS PERMISSION,
UNSUPPORTED, ERROR or OFF, and the panel shows what to do next.

| Tier | Sensor | Default | What it gives | Permissions / notes |
|---|---|---|---|---|
| T0 | **ARP** | on | Who's on the LAN: IP, MAC (hashed), vendor from the OUI table. Every 10 s it reads `arp -anl`; every 45 s it pings each host in your /24 once, as an "awake" check | None. Uses `arp` and `ping`. Networks bigger than a /24 are clamped to your /24 |
| T0 | **MDNS** | on | Bonjour names, models and device kinds (`Living Room`, `MacBook Pro`, printers, HomeKit…) | macOS may ask for **Local Network** access for your terminal. Allow it in System Settings › Privacy & Security › Local Network, then switch MDNS off and on |
| T0 | **SSDP** | on | UPnP TVs, speakers and routers. Fetches each device's description XML (≤ 64 KB, private LAN IPs only, at most once per 10 min) | Same Local Network permission as MDNS |
| T0 | **STATION** | on | Status only, not contacts: this Mac's own Wi-Fi link (`en0 · SSID · −57 dBm · SNR 36 · ch 149`) | macOS only. **The SSID needs Location Services** for your terminal (System Settings › Privacy & Security › Location Services). Without it macOS redacts the SSID and PHOSPHOR leaves it out |
| T1 | **BLE** | **off (opt-in)** | Per-device RSSI, the only real proximity signal. This is what fills the NEAR, MID and FAR rings | **macOS Bluetooth permission** for your terminal or Node (System Settings › Privacy & Security › Bluetooth). Nothing touches CoreBluetooth until you switch BLE on. If it shows NEEDS PERMISSION, grant access and toggle BLE again, or restart the server if it stays blocked |
| — | **DEMO DATA** | auto | Random-walk fake devices that use the same event schema | `AUTO` runs it only when no live sensor is available. `ON` / `OFF` force it |

Monitor-mode Wi-Fi (Tier 2) is **not implemented**; see below.

Ring thresholds use smoothed BLE RSSI with 3 dB hysteresis: NEAR > −60 dBm,
MID −60…−75, FAR < −75. Distance is `d = 10^((TxPower − RSSI) / (10·2.7))`, where
TxPower is the advertised TX power minus 59 dB, or −59 dBm when the device doesn't advertise one.

## Using it

- **Hover** a blip or a table row to link them. Hovering a blip shows its ring, `~m`, sources and
  confidence.
- **Keyboard:** focus the scope and use the arrow keys to step through contacts clockwise.
  **Enter** jumps between a blip and its table row, and **Esc** clears the selection.
  ↑/↓ move between table rows.
- **☆ / ★ MINE** claims a contact as one of your devices. Claims survive the contact being
  lost and seen again, but not a server restart.
- **MERGE … INTO …** folds one contact into another. Later readings from the merged-in
  source keep landing on the target.
- **CRT FX** (WebGL post-pass, with a CSS fallback), **MOTION** (static scope when off;
  `prefers-reduced-motion` is honoured by default) and **AUDIO** (sonar ping, muted by
  default). These preferences are stored in `localStorage`.

## Privacy

- **The server listens on `127.0.0.1` only.** It can't be reached from the LAN. This isn't
  configurable, and a test checks the bind.
- **It refuses requests that aren't addressed to a loopback hostname**, which blocks DNS
  rebinding. It also rejects **cross-site POSTs** (`cop()` middleware), so another web page
  can't turn on BLE or claim devices.
- **Raw identifiers never leave the fusion engine.** MACs and BLE peripheral UUIDs are hashed
  with HMAC-SHA256 under a random per-launch salt and cut to 12 hex chars. Ids therefore can't
  be linked across restarts.
- **Device names are scrubbed.** Some devices put hardware ids in their own names, such as an
  HP printer's `[F65D06]` MAC suffix, `ESP_A1B2C3`, or a full MAC or UUID. Those parts are
  stripped before a name reaches the browser.
- Vendor lookups are skipped for randomized (locally administered) MACs.
- **Nothing is persisted.** No database, no log files and no telemetry. Restarting forgets
  everything, including claims and merges.
- No packet payloads are captured. BLE reads only RSSI, TX power, the local name and the
  manufacturer company id. mDNS keeps only names, models and service types from TXT records.
- The footer has a disclosure (**THIS SCREEN SHOWS OTHER PEOPLE'S DEVICES**). Device names
  and MAC addresses can be personal data (e.g. under GDPR). Get legal advice before you
  distribute or demo this anywhere public.

## Not done yet / known limits

- **M6 isn't built:** no Tier 2 monitor-mode Wi-Fi collector (Linux `iw` + `tshark`), and no
  extra themes ("Tektronix bench", "Demoscene 8-bit").
- **No merge undo.** A wrong merge sticks until the server restarts.
- **No "collapse unknowns" setting.** PLAN §6 has an option to show unknown devices as
  "N unknown contacts nearby", but it isn't implemented. There's also no "show raw
  identifiers" mode; raw ids are never sent.
- **The TX-power calibration needs a real walk test.** Advertised TX power minus 59 dB
  assumes a typical phone's 1 m loss. Walk a phone toward and away from the Mac, as in the
  PLAN §7 manual check: it should cross rings within about 2 sweeps (~8 s) and land in NEAR
  at ~1 m. Adjust `ONE_METRE_LOSS_DB` in `app/sensing/collectors/ble.ts` or `pathLossN` in
  fusion if it doesn't.
- In a busy place, BLE address rotation means one phone can appear as several contacts
  over time.
- A merged-away contact shows briefly as a fading LOST row before it disappears. The event
  log calls it `~ MERGED` only when the target gained a new source.

## Layout

See `CONTRACTS.md` for module APIs and `PLAN.md` for the product spec.

```
server.ts                 # starts collectors, then app/http-server.ts listen()
app/http-server.ts        # 127.0.0.1-only HTTP server
app/router.ts             # loopback-host guard, cop(), static files, render
app/actions/controller.tsx# /, /stream (SSE), /status, /settings, /claim
app/actions/public/       # browser islands: scope, readout, sensors, toggles, event log
app/sensing/              # server only: collectors, fusion, hub, identity, registry
```
