# PHOSPHOR — a retro proximity radar on Remix v3

> Plan put together from three research agents (Remix v3, network/proximity sensing, retro design), 2026-10-05.

## 1. Concept

A local web app that turns this machine's radios into a Cold War radar screen. **This device sits at the centre.** Every nearby client device is a **blip**. Its distance from the centre is an *approximate* proximity, estimated from signal strength. A rotating sweep beam lights up blips as it passes, and they fade with real P7-phosphor afterglow. A terminal-style readout lists every contact.

**Honesty rules, shown in the UI:**
- Distance is shown as rough rings (NEAR / MID / FAR / ON-NET), never as exact metres.
- Bearing is arbitrary: the angle comes from a hash of the device ID. The compass ticks are labelled `ID°`, not N/E/S/W.
- Each blip carries its data source (BLE / WIFI / LAN / SIM) and a confidence level.

## 2. Hard constraints found during research

| Constraint | Impact |
|---|---|
| Browsers can't reach the network card (no raw sockets, ARP, mDNS or RSSI; Web Bluetooth scanning only behind a Chrome flag) | A **local Node server** collects the data and **streams it to the browser over SSE** |
| Wi-Fi RSSI to our own access point says nothing about other devices | Use it only as a "this station" status reading |
| Per-device Wi-Fi RSSI needs monitor mode: root, drops the Wi-Fi connection, unreliable on macOS 26 | Optional Tier 2, Linux preferred, off by default |
| **BLE RSSI is the best per-device proximity signal** (no sudo on macOS, one Bluetooth permission prompt) | Primary distance source (Tier 1) |
| ARP, mDNS and SSDP give *who* is on the network (names, vendors), not *how far* | Tier 0 identity layer; these devices go on the outer "ON-NET" ring |
| RTT/latency is useless for distance (power-save wake-up dominates) | Used only as an "awake" indicator |
| MAC randomization (iOS, Android, Windows); BLE addresses rotate about every 15 min | Flag locally administered MACs, skip OUI lookup for them, age devices out |
| Remix 3.0.0 has **no first-class WebSocket support** (node-serve was removed in beta); **SSE is the officially demonstrated pattern** (`demos/sse`) | SSE for server→client, plain form POSTs and actions for client→server |
| Remix template requires **Node ≥ 24.3.0**; this machine has **v23.11.1** | Upgrade Node first (`brew upgrade node` / `fnm install 24`) |
| Unverified: noble running under Bun | Use Node, the runtime the Remix template uses |

## 3. Architecture

```
┌──────────────────────── local machine ──────────────────────────────┐
│                                                                      │
│  Collectors (each reports: available | needs-permission | unsupported)│
│   T0  lan-arp      `arp -an` + ping sweep    → presence, IP, MAC      │
│   T0  lan-mdns     multicast-dns / bonjour   → hostname, model        │
│   T0  lan-ssdp     M-SEARCH 239.255.255.250  → TVs, speakers, routers │
│   T0  station-wifi system_profiler / wdutil  → our AP RSSI (status)   │
│   T1  ble          @abandonware/noble        → per-device RSSI ★      │
│   T2  wifi-monitor tcpdump -I radiotap (opt) → probe-request RSSI     │
│   SIM demo         random-walk generator     → same event schema      │
│                │                                                     │
│                ▼                                                     │
│  Fusion engine: median(5) → EMA/Kalman on dBm → log-distance model   │
│     → ring + 3 dB hysteresis → confidence → stale/lost ageing        │
│     → HMAC-SHA256(salt, MAC) ids · in-memory only                    │
│                │  ContactEvent stream                                │
│                ▼                                                     │
│  Remix 3 server (node:http + createRequestListener(router.fetch))    │
│    GET  /            → SSR shell (static chrome, readout table)      │
│    GET  /stream      → text/event-stream (snapshot + deltas)         │
│    GET  /status      → collector capabilities JSON                   │
│    POST /settings    → toggle tiers / demo / claim device            │
│    GET  /assets/*    → remix/assets on-demand TS/CSS compile         │
│    bound to 127.0.0.1 only                                           │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ SSE (EventSource)
┌────────────────────────────▼─────────────────────────────────────────┐
│ Browser                                                              │
│  <Scope> clientEntry  → Canvas 2D phosphor layer (+ optional WebGL CRT)│
│  <Readout> clientEntry → live table, aria-live announcements         │
│  <StatusBar>, <Legend> → mostly static SSR; small toggles hydrate    │
└──────────────────────────────────────────────────────────────────────┘
```

### Event schema (shared by every collector, so the UI never changes between modes)

```ts
type Source = 'ble' | 'wifi' | 'lan' | 'sim'
type Ring = 'near' | 'mid' | 'far' | 'onnet'

interface Contact {
  id: string            // HMAC(salt, mac|bleUuid) truncated to 12 hex chars
  label: string         // mDNS name, BLE local name, vendor, or "UNKNOWN"
  vendor?: string       // OUI lookup (skipped for randomized MACs)
  kind: 'phone' | 'laptop' | 'router' | 'media' | 'iot' | 'printer' | 'unknown'
  ip?: string
  rssi?: number         // smoothed dBm
  distanceM?: number    // log-distance estimate (UI shows ring, tooltip shows ~m)
  ring: Ring
  confidence: number    // 0..1
  sources: Source[]
  randomizedMac: boolean
  firstSeen: number
  lastSeen: number
  state: 'new' | 'active' | 'stale' | 'lost'
}

type StreamEvent =
  | { type: 'snapshot'; contacts: Contact[]; caps: CollectorStatus[] }
  | { type: 'upsert'; contact: Contact }
  | { type: 'lost'; id: string }
  | { type: 'caps'; caps: CollectorStatus[] }
```

### Proximity maths
- `d = 10 ^ ((TxPower − RSSI) / (10·n))`. BLE TxPower is the advertised `txPowerLevel`, or −59 dBm if absent. Wi-Fi uses −40 dBm. n = 2.7 indoors, configurable.
- Smooth RSSI in dBm, never distance: median over 5 samples → EMA with α = 0.25 (or a 1-D Kalman filter, Q = 0.05, R = 3).
- BLE rings: NEAR > −60 dBm, MID −60…−75, FAR < −75, with 3 dB hysteresis. LAN-only devices go on ON-NET.
- Confidence = f(sample count, variance, source quality). Stale after 15 s unseen, lost after 60 s.
- Fusion keys on stable identity (mDNS name, user-claimed device), otherwise per source. BLE and LAN devices can't be linked automatically; the user can "claim" and merge them.

## 4. Remix v3 implementation details (verified against remix@3.0.0, repo commit 27bd7a4)

**Scaffold:** `npx remix new proximity-radar`. No Vite and no build step; `remix/assets` compiles TS/JSX/CSS on demand.

```
proximity-radar/
  server.ts                 # http.createServer(createRequestListener(router.fetch)); listen 127.0.0.1:4777
  app/
    routes.ts               # route({ assets: '/assets/*path', home: get('/'), stream: get('/stream'), status: get('/status'), settings: post('/settings') })
    router.ts               # createRouter({ middleware: [logger, render({assets}), ...] }) + map controllers
    actions/
      controller.tsx        # home → context.render(<RadarPage/>); stream → SSE Response
      public/               # browser code (clientEntry components)
        scope.tsx           # canvas radar island
        readout.tsx         # live contact table island
        toggles.tsx         # motion / CRT FX / audio / demo toggles
        stream-client.ts    # shared EventSource → in-memory store → subscribers
        render/
          phosphor.ts       # Canvas 2D persistence + sweep + blips
          crt.glsl.ts       # optional WebGL2 post-pass
          audio.ts          # Web Audio ping (muted by default)
    sensing/
      collectors/{arp,mdns,ssdp,station,ble,monitor,sim}.ts
      fusion.ts             # smoothing, distance, rings, ageing
      hub.ts                # EventTarget fan-out to SSE subscribers
      identity.ts           # HMAC salt (in memory, per launch), OUI lookup, randomized-MAC flag
    ui/layout.tsx, legend.tsx, status-bar.tsx
```

**SSE action** (based on `demos/sse`):
```tsx
stream({ request }) {
  let enc = new TextEncoder()
  let body = new ReadableStream({
    start(c) {
      let send = (e: StreamEvent) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      send({ type: 'snapshot', contacts: hub.snapshot(), caps: hub.caps() })
      let off = hub.subscribe(send)
      let ka = setInterval(() => c.enqueue(enc.encode(': ka\n\n')), 15000)
      request.signal.addEventListener('abort', () => { off(); clearInterval(ka); c.close() })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
```

**Island pattern:**
```tsx
export const Scope = clientEntry(import.meta.url, function Scope(handle: Handle<{}>) {
  handle.queueTask(() => {
    let canvas = document.getElementById('scope') as HTMLCanvasElement
    let radar = createPhosphor(canvas)
    let off = streamStore.subscribe(cs => radar.setContacts(cs))
    handle.signal.addEventListener('abort', () => { off(); radar.destroy() })
  })
  return () => <canvas id="scope" role="img" aria-label="Proximity radar" />
})
```
The canvas animation runs on its own `requestAnimationFrame` loop outside the component re-render path. `handle.update()` is only used for the readout table and toggles.

## 5. Visual design: "P7 PPI" phosphor radar

- **Palette:** bg `#050A06`, bezel `#11160F`, rings `#1F4D2B`, afterglow `#7CFF4F`, trail `#3FA34D`, hit flash `#D8FFF0`, warning `#FFB000`, text `#9DFFB0`, dim `#4F7F5A`.
- **Type:** VT323 (readout), Share Tech Mono (labels and numbers), Major Mono Display (title).
- **Rendering:**
  - Persistent offscreen phosphor canvas, faded each frame with `rgba(5,10,6,0.06)`.
  - Conic-gradient beam wedge (~30°), 4 s sweep driven by `performance.now()`.
  - Blips are drawn onto the phosphor layer when the beam crosses them, so they decay naturally.
  - Pre-rendered glyph sprites, DPR capped at 2, rendering paused when the tab is hidden.
- **CRT pass (optional WebGL2):** barrel distortion, scanlines, cheap bloom, grain, flicker ≤ 2%. CSS fallback: scanline gradient and vignette.
- **Encoding:**
  - Radius: log scale over distance, so near devices aren't crammed in the centre.
  - Brightness and jitter: confidence.
  - Glyph: device kind (◆ phone, ■ laptop, ✚ router, ▲ media, ● IoT, ▬ printer, ? unknown).
  - New contact: blue-white flash, an expanding ring, and a `+ CONTACT` line typed into the readout.
  - Lost contact: a ghost blip that decays over 3 sweeps, plus an `x LOST` log line.
- **Layout:** scope on the left (~60%), readout table on the right, status bar at the bottom: `MODE: BLE+LAN | CONTACTS: 12 | SWEEP 4.0s | IFACE en0 | AUDIO: MUTED`. Stacked layout on mobile.
- **Audio (opt-in):** 1200 Hz sine ping, 300 ms decay, louder and higher for closer devices, at most ~6 pings per sweep.
- **Themes later:** "Tektronix bench" and "Demoscene 8-bit", using the same data mapping.
- **Accessibility:**
  - Readout is a real `<table>`, which is the non-visual equivalent of the scope.
  - The canvas has `role="img"` and a summary label.
  - Throttled `aria-live` announcements for new and lost contacts.
  - Keyboard navigation syncs focus between the table and the blips.
  - `prefers-reduced-motion` gives a static scope. MOTION and CRT FX toggles let users turn effects off.

## 6. Privacy and safety defaults
- Server binds to `127.0.0.1` only. No persistence and no telemetry.
- Tier 0 (active LAN discovery) is on by default. BLE needs explicit opt-in, plus the macOS Bluetooth permission. Monitor mode needs opt-in, root, and a warning.
- MACs and BLE IDs are hashed with a per-launch salt before leaving the fusion engine. Raw MACs are never sent to the browser unless the user turns on "show raw identifiers".
- "Claim my devices" allowlist. Optionally collapse unknown devices into "N unknown contacts nearby".
- Never capture payloads. Monitor mode uses a BPF filter for management frames only.
- An in-app disclosure about scanning other people's devices. Get a legal review before any distribution, since MACs count as personal data under GDPR.

## 7. Milestones

1. **M0 – Foundation:**
   - Upgrade Node to ≥ 24.3.
   - `npx remix new`, then strip the template.
   - Routes, layout, and the `/stream` SSE endpoint fed by the **SIM collector**.
2. **M1 – Scope:**
   - Canvas phosphor renderer: sweep, rings, blips, afterglow, glyphs.
   - Readout table island and status bar.
   - Reduced-motion support. *Demo mode is fully usable after this milestone.*
3. **M2 – LAN identity (Tier 0):**
   - ARP plus ping sweep, mDNS, SSDP, and OUI lookup.
   - Randomized-MAC flag.
   - Station Wi-Fi RSSI in the status bar. Devices show on the ON-NET ring.
4. **M3 – BLE proximity (Tier 1):**
   - noble collector, smoothing, distance, rings with hysteresis, confidence.
   - Permission UX (`needs-permission` state with instructions).
5. **M4 – Fusion and UX:**
   - Device claiming and merging, stale/lost ageing animations, hover links between blip and row, ping audio.
6. **M5 – CRT polish:**
   - WebGL post-pass, CSS fallback, CRT FX toggle, performance pass, accessibility audit.
7. **M6 – Optional Tier 2:**
   - Linux monitor-mode collector (`iw` + `tshark` radiotap). Experimental on macOS.
   - Extra themes.

### Test plan
- Unit tests (`remix test`): fusion maths (smoothing, hysteresis, ring boundaries), identity hashing, the randomized-MAC check, and the collector output parsers (fixture outputs from `arp -an`, `system_profiler`, `dns-sd`).
- Router tests: `/stream` returns `text/event-stream` and sends a snapshot first; the server binds only to localhost.
- Manual checks: a phone walked toward and away from the Mac should move between rings within about 2 sweeps, and reduced motion should be honoured.

## 8. Open questions and risks
- Remix 3.0.0 is days old, so expect API churn. Pin `remix@3.0.0`.
- Whether noble on Node 24 / macOS 26 needs a Swift CoreBluetooth sidecar fallback.
- Whether monitor mode works at all on Apple silicon with macOS 26. That's why Tier 2 is Linux-first.
- Linking BLE devices to LAN devices is impossible automatically; only user claiming can merge them.
- Distance accuracy is ±50% at best. The UI must keep saying so.
