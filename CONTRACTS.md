# PHOSPHOR — shared contracts (final, M0–M5)

This file plus the code describes the module APIs. `README.md` is the user guide. `PLAN.md` is the product spec. Everything below was verified against the installed `remix@3.0.0` (pinned exactly in package.json) on Node v25.9.0.

## Commands

```sh
npm run dev        # node --watch, restarts the server on change
npm run hmr        # proxy on :4777, app on :4779, browser HMR channel on :4778
npm start          # production mode (minified assets), http://127.0.0.1:4777
npm test           # remix test → every **/*.test.ts(x) file (server runner)
npm run typecheck  # tsc --noEmit
npx remix doctor   # project health check (currently clean)
npx remix routes   # print the route tree
```

Load nvm first if `node -v` isn't 25: `source ~/.nvm/nvm.sh`.

## File layout

```
server.ts                       # registry.start(), then listen() from app/http-server.ts; SIGINT/SIGTERM → registry.stop()
hmr.ts                          # template HMR runner (default port 4777)
app/
  http-server.ts                # HOST = '127.0.0.1' (not configurable); listen(port, { trustProxy }) → Promise<http.Server>
  routes.ts                     # route map (browser-reachable, so keep it free of server imports)
  router.ts                     # middleware: loopbackOnly(), cop(), staticFiles('./public'), render({ assets })
  assets.ts                     # createAssetServer(...) + scriptEntry for app/actions/public/entry.ts
  actions/
    controller.tsx              # every action: assets, home, stream (SSE), status, settings, claim
    public/                     # BROWSER CODE (only files under **/public/** are served)
      entry.ts                  # run() — boots hydration
      stream-client.ts          # shared EventSource → in-memory store → subscribe()
      scope.tsx                 # <Scope/> island: canvas + tooltip + keyboard stepping
      readout.tsx               # <Readout/> island: contact table, claim buttons, merge form
      sensors.tsx               # <Sensors/> island: collector on/off forms + demo mode
      status-line.tsx           # <StatusLine/> island: MODE | CONTACTS | SWEEP | IFACE | AUDIO | LINK
      toggles.tsx               # <Toggles/> island: CRT FX / MOTION / AUDIO
      event-log.tsx, log-store.ts   # `+ CONTACT` / `x LOST` / `~ MERGED` / sensor lines + aria-live
      forms.ts                  # progressive enhancement: POST forms in the background
      highlight.ts              # shared blip ↔ row highlight
      prefs.ts                  # motion / crt / audio prefs (localStorage, prefers-reduced-motion)
      render/{phosphor,sprites,crt.glsl,audio,geometry}.ts
      styles/phosphor.css
  ui/                           # server-only components
    document.tsx, radar-page.tsx, status-bar.tsx (+ privacy disclosure), legend.tsx
  sensing/                      # SERVER ONLY
    types.ts, hub.ts, identity.ts, fusion.ts, registry.ts, kind.ts, oui.ts
    data/oui.txt (+ build-oui.ts)   # IEEE OUI → vendor table
    collectors/{sim,ble,arp,mdns,ssdp,station,lan-util}.ts
    collectors/__fixtures__/    # real captures for parser tests
public/favicon.svg              # static files served from /
```

## Types (`app/sensing/types.ts`)

| Type | Purpose |
|---|---|
| `Source` | `'ble' \| 'wifi' \| 'lan' \| 'sim'` |
| `Ring` | `'near' \| 'mid' \| 'far' \| 'onnet'` |
| `DeviceKind` | `'phone' \| 'laptop' \| 'router' \| 'media' \| 'iot' \| 'printer' \| 'unknown'` |
| `ContactState` | `'new' \| 'active' \| 'stale' \| 'lost'` |
| `Contact` | The fused device sent to browsers, as in PLAN §3 plus `claimed?: boolean`. `id` is a 12-hex HMAC. It never holds a raw MAC or BLE UUID, and `label`/`vendor` pass through `scrubIdentifiers`. |
| `Tier` | `0 \| 1 \| 2 \| 'sim'` |
| `CollectorState` | `'available' \| 'needs-permission' \| 'unsupported' \| 'disabled' \| 'error'` |
| `CollectorHealth` | `{ state: CollectorState minus 'disabled'; detail? }`. What a collector says about itself. |
| `CollectorStatus` | `{ id, tier, label, state, detail?, enabled }`. The public status in `caps` and `/status`. `state` is `'disabled'` whenever `enabled` is false. |
| `StreamEvent` | `snapshot \| upsert \| lost \| caps` (PLAN §3). The first event on every SSE connection is `snapshot`. |
| `Observation` | One raw reading. Server-only. Fields: `source, collector, key, at, rssi?, txPower?, ip?, mac?, name?, vendor?, vendorFromDevice?, kind?` |
| `CollectorContext` | `{ emit(obs), setHealth(health), signal }`, passed to `start()` |
| `Collector` | `{ id, tier, label, defaultEnabled, statusOnly?, probe(), start(ctx), stop() }`. `statusOnly` collectors (station Wi-Fi) report health only and don't count as live for auto demo mode. |

`Contact`, `CollectorStatus` and the others are `type` aliases rather than `interface`s on purpose. `clientEntry` props are type-checked against `SerializableProps` (index-signature based), and plain `type` aliases satisfy it most directly. Keep new prop-crossing types as `type` aliases.

### Observation semantics
- `key`: the raw per-source identifier (MAC, BLE peripheral UUID, or IP when nothing better exists). Fusion hashes it.
- `mac`: if present, fusion uses the **normalised MAC** as identity. That way the same MAC seen by ARP and by Wi-Fi merges into one contact, and `randomizedMac` is set from it. Any case or separator works; macOS `arp -an` short octets (`a:b:c:…`) are handled.
- `rssi`: raw dBm. Leave it undefined for presence-only sources; those land on the `onnet` ring.
- `txPower`: the advertised BLE tx power. Fusion defaults to −59 (BLE) or −40 (other).
- `vendor`: dropped by fusion when the MAC is randomized, unless `vendorFromDevice` (UPnP / AirPlay / mDNS said so itself).
- `name` / `vendor`: MAC-, UUID- and serial-shaped substrings are stripped by fusion (`scrubIdentifiers`) before anything is published.
- `at`: epoch ms (`Date.now()`).

## Adding a collector

1. Create `app/sensing/collectors/<name>.ts` exporting a factory that returns a `Collector`:

```ts
import type { Collector } from '../types.ts'

export function createArpCollector(): Collector {
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    id: 'lan-arp', tier: 0, label: 'ARP', defaultEnabled: true,
    async probe() { /* binary present? platform? */ return { state: 'available' } },
    start(ctx) {
      // Return promptly: the registry awaits start() serially. Do long work in the background.
      timer = setInterval(async () => {
        try {
          for (let row of await readArp(ctx.signal)) ctx.emit({ source: 'lan', collector: 'lan-arp', key: row.mac, mac: row.mac, ip: row.ip, at: Date.now() })
        } catch (e) { ctx.setHealth({ state: 'error', detail: String(e) }) }
      }, 10_000)
      ctx.signal.addEventListener('abort', () => clearInterval(timer))
    },
    stop() { clearInterval(timer) },
  }
}
```

2. Register it with **one line** in `app/sensing/registry.ts`:

```ts
export const collectors: Collector[] = [
  createSimCollector(),
  createBleCollector(),
  createArpCollector(),
  createMdnsCollector(),
  createSsdpCollector(),
  createStationCollector(),
  // ← add new collectors here; order = status-bar order
]
```

Rules:
- `probe()` must have no side effects (no permission prompts). If it returns `unsupported`, the collector is never started.
- `defaultEnabled` must be `false` for BLE (tier 1) and monitor mode (tier 2). PLAN §6 requires opt-in.
- If `start()` throws or rejects, health becomes `error` and the collector is stopped. Call `ctx.setHealth(...)` at any time, e.g. `needs-permission` with instructions in `detail`. The registry republishes `caps`, and in `auto` demo mode it re-decides whether the sim runs.
- After `stop()`, or once `ctx.signal` aborts, `emit` and `setHealth` are ignored. On stop, the registry calls `fusion.forget(id)`, which drops contacts seen only by that collector.
- Put parsers in pure functions with fixture tests (`*.test.ts` next to the module).

## Registry API (`app/sensing/registry.ts`)

```ts
export const collectors: Collector[]
export const hub: Hub           // app singleton
export const fusion: Fusion     // app singleton
export const registry: Registry // app singleton; server.ts calls registry.start()
export const SIM_ID = 'sim'
export type DemoMode = 'auto' | 'on' | 'off'   // default 'auto'
export type Settings = { demo: DemoMode; enabled: Record<string, boolean> }  // `enabled` excludes sim
export function createRegistry({ hub, fusion, collectors, tickMs? }): Registry

type Registry = {
  start(): Promise<void>                         // probe all, start ticker (fusion.tick each 1 s), reconcile
  stop(): Promise<void>
  setEnabled(id, enabled): Promise<void>         // re-probes on enable; setEnabled('sim', x) ≡ setDemo(x ? 'on' : 'off')
  setDemo(mode): Promise<void>
  statuses(): CollectorStatus[]
  settings(): Settings
}
```

Demo `auto` runs the sim only while **no non-sim collector is both enabled and `available`**. Reconciles are serialised and publish a `caps` event every time.

## Hub API (`app/sensing/hub.ts`)

```ts
createHub(): Hub
hub.subscribe(fn: (e: StreamEvent) => void): () => void   // errors in fn are caught and logged
hub.snapshot(): Contact[]        // current contacts; lost ones are removed
hub.caps(): CollectorStatus[]
hub.publish(e: StreamEvent)      // folds e into state, then fans it out
```

The hub mirrors what browsers see. Only fusion (contacts) and the registry (caps) publish to it.

## Fusion API (`app/sensing/fusion.ts`)

```ts
createFusion(hub, {
  now?, salt?, newMs=5000, staleMs=15000, lostMs=60000, minPublishMs=250,
  filter='ema' | 'kalman', emaAlpha=0.25, kalmanQ=0.05, kalmanR=3,
  medianWindow=5, pathLossN=2.7, hysteresisDb=3,
}): Fusion
fusion.ingest(obs)          // update or create a track; upsert published at once if new or ring changed,
                            // otherwise only when visibly changed and ≥ minPublishMs since the last one
fusion.tick()               // new→active, →stale, →lost (publishes `lost` and removes); flushes withheld upserts
fusion.forget(collectorId)  // drop that collector's readings; contacts left with none are `lost`
fusion.contacts()
fusion.claim(id, claimed)   // → { ok } | { ok: false, error }. In-memory allowlist; survives lost + re-seen
fusion.merge(id, into)      // fold `id` into `into`: `lost` for id, upsert for into; later readings for id land on into
// pure helpers, exported for tests:
ringForRssi(rssi?), ringWithHysteresis(rssi, prev, h=3), estimateDistance(rssi, txPower, n=2.7),
median, variance, createSmoother, confidenceFor(samples, variance, quality), visiblyChanged(prev, cur)
```

Behaviour:
- Per (collector, raw id) state: median(5) → EMA (or Kalman) **on dBm**. The contact's ring, rssi and distanceM come from its freshest best proximity source (BLE > Wi-Fi > SIM). With only fresh presence sources (LAN) it is `onnet`.
- Rings: > −60 near, −60…−75 mid, < −75 far, with 3 dB hysteresis.
- TX power: the observation's `txPower` (BLE collector: advertised TX − 59 dB) or −59 dBm (BLE) / −40 dBm (other).
- Confidence: noisy-OR across sources of `quality × (1 − e^(−n/4)) / (1 + var/50)`. Source quality: BLE 1, SIM 0.9, Wi-Fi 0.8, LAN 0.5.
- Identity: `hashId(normalisedMac ?? \`${source}:${key}\`)`. LAN readings also auto-merge on a shared mDNS/SSDP name or IP, but never across two different MACs.
- Label: best named source (LAN > Wi-Fi > BLE/SIM), then vendor, then `'UNKNOWN'`.
- **`lastSeen` is not republished on its own.** Upserts go out only when something visible changes, so browsers must not show "seen N s ago" from it. Use `state` (`stale` after 15 s).

## Identity (`app/sensing/identity.ts`)

- `hashId(raw, salt = per-launch 32 random bytes)` returns 12 hex chars (HMAC-SHA256).
- `normalizeMac(mac)` returns `'aa:bb:cc:dd:ee:ff'`, or `undefined` if the input isn't a MAC.
- `isRandomizedMac(mac)` returns true when the locally-administered bit (0x02 of the first octet) is set.
- `scrubIdentifiers(text)` strips MAC (`aa:bb:…`, `aabb.ccdd.eeff`, bare 12-hex), UUID, `[F65D06]`-style MAC tails and `ESP_A1B2C3`-style suffixes from a name. Returns `undefined` if nothing is left.

## HTTP routes (`app/routes.ts`, `app/actions/controller.tsx`)

Every request first passes `loopbackOnly()`, which returns 403 unless the URL hostname is `127.0.0.1`, `localhost` or `::1` (DNS-rebinding guard). Then `cop()` returns 403 for cross-site unsafe requests (`Sec-Fetch-Site` / `Origin`). Requests with neither header, such as curl, pass.

| Route | Behaviour |
|---|---|
| `GET /` | SSR `RadarPage` from `hub.snapshot()` and `hub.caps()`. Contains `<canvas id="scope">`, `<table id="readout">` and `<footer id="status-bar">`. |
| `GET /stream` | `text/event-stream`. Sends `retry: 2000`, then a `snapshot`, then every hub event as `data: <json>\n\n`, plus `: ka` every 15 s. Cleanup runs on `request.signal` abort **and** on stream `cancel()`. |
| `GET /status` | JSON `{ caps, settings, contacts: <count> }` |
| `POST /claim` | Form fields: `id` (12-hex contact id), `action=claim\|unclaim\|merge`, and `into` for merge. Replies **303 → /**, or 400 (bad id, unknown contact, merge into itself). |
| `POST /settings` | Form fields: `demo=auto\|on\|off`, and/or `collector=<id>` with `enabled=on\|off`. Replies **303 → /**, or 400 on bad input. Reads the body with `request.formData()` (no form-data middleware installed). |
| `GET /assets/*path` | `assets.fetch(request)` |

Use `routes.<name>.href()` for URLs, including in browser code (`app/routes.ts` is allowed by the asset server).

## Remix 3 component, island and asset facts (verified)

Imports:
- `import { clientEntry, css, on, ref, type Handle, type RemixNode } from 'remix/component'`
- `import { ImportMap } from 'remix/component/server'`
- `import { createRouter, createController, type MiddlewareContext } from 'remix/router'`
- `import { get, post, route } from 'remix/routes'`
- `import { render } from 'remix/middleware/render'`
- `import { staticFiles } from 'remix/middleware/static'`
- `import { createAssetServer } from 'remix/assets'`
- `import { createRequestListener } from 'remix/node-fetch-server'`
- `import { createRedirectResponse } from 'remix/response/redirect'`
- Tests: `import * as assert from 'remix/assert'` and `import { describe, it } from 'remix/test'`

Components:
- A component is a setup function `(handle: Handle<Props>) => () => JSX`. Setup runs once; read **current** props inside the render function via `handle.props`.
- Styling uses `mix={css({...})}`. Nested selectors and `@media` work inside `css`, and `style={{...}}` works for dynamic values.

Islands:
- An island is `export const X = clientEntry(import.meta.url, function X(handle: Handle<P>) {...})`.
- It must live under an `app/**/public/**` directory, otherwise the asset server returns 404 for it.
- Props must be serializable: primitives, plain objects, arrays, or JSX. Prefer `type` aliases (see above).
- The page imports the island like a normal component. The render middleware (`render({ assets })`) resolves `import.meta.url` to `/assets/app/...` and adds the import map and preloads.
- `entry.ts` (`run({ loadModule })`) hydrates every island on the page.

Lifecycle and cleanup:
- **`handle.queueTask(fn)` does not run during SSR**, so use it in setup for browser-only work (DOM, `EventSource`, rAF).
- The **signal passed to a queued task aborts on the next re-render**. Use `handle.signal` (aborts when the component disconnects) for long-lived listeners, subscriptions and rAF loops.
- `handle.update()` is allowed from queued tasks and event handlers, but not during setup or render.
- To start work when an element is inserted, use `mix={ref((node, signal) => …)}`.

Hydration mismatches:
- Don't render values that differ between server and first client render, such as `typeof window` checks or `Date.now()`. A mismatch logs `Hydration mismatch:` in the console.
- Change state after hydration instead. `Readout` does this with `data-live`.

Browser code and server modules:
- Browser code may only `import type` from `app/sensing/*`. `verbatimModuleSyntax` erases type-only imports, so the browser never requests those files.
- A value import from `app/sensing` would 404 in the browser, because the asset server denies anything outside `app/**/public/**` (plus `app/routes.ts` and the `remix` package).
- Test files are denied too.

Asset server:
- It compiles TS, TSX and CSS on demand, and minifies when `NODE_ENV=production`.
- CSS files under `public/` can be referenced with `assets.getHref('app/.../public/x.css')`. Relative `@import`/`url()` are rewritten.
- For fonts and images, add `files: { extensions: ['.woff2', ...] }` to `createAssetServer` in `app/assets.ts`.
- Google Fonts `<link>`s can go in `Document`'s `head` prop. The template did this.

`stream-client.ts`:
- `streamStore.subscribe((state, event?) => …)` returns an unsubscribe function.
- `state` is `{ contacts: ReadonlyMap<string, Contact>, caps, connected }`. `event` is the `StreamEvent` that triggered the call, so it can drive "+ CONTACT" or "x LOST" animations. It is undefined on the initial call and on connection changes.
- One `EventSource` is shared by all subscribers. It closes when the last subscriber leaves, and EventSource auto-reconnects, receiving a fresh snapshot.
- `streamStore.getState()` returns the current state. `apply(event)` is exported for tests.
- Importing the module is SSR-safe.

## Testing

- `remix test` discovers `**/*.test.{ts,tsx}` (server runner), `*.test.browser.tsx` (Playwright in-browser) and `*.test.e2e.ts`.
- Router tests: `await router.fetch(new Request(new URL(routes.x.href(), 'http://127.0.0.1:4777'), init))`.
- **Router tests import the registry singletons but never call `registry.start()`**, so the hub is empty and no timers run. Unit-test the registry with `createRegistry` and fake collectors (see `registry.test.ts`).
- Fusion tests inject `now` and `salt`.
- SSE test pattern: read the body until the first `data:` line, then `abort()` and `reader.cancel()` (see `controller.test.ts`).
- `app/http-server.test.ts` listens on port 0 and asserts the bind is 127.0.0.1 and that every LAN address refuses the connection.
- Current suite: 117 passing tests across 16 files (identity + scrubbing, fusion, hub, registry incl. toggle churn, every collector parser on real fixtures, geometry, event log, stream store, routes, claim/merge, localhost bind, host/cross-site guards).

## Gotchas hit

1. The template's `server.ts` listened on all interfaces at port 44100. It now listens on `127.0.0.1:4777` (via `app/http-server.ts`). `hmr.ts`'s default proxy port is also 4777 (app 4779, HMR channel 4778).
2. **Node's `EventTarget` rethrows listener exceptions as uncaught errors, which crashes the process.** `hub.subscribe` wraps listeners in try/catch. Keep that if you rewrite the hub.
3. SSE: `controller.enqueue` after `close()` throws. The stream action guards it with a `closed` flag and cleans up from both abort and `cancel()`.
4. `createRedirectResponse(url, 303)`: the second argument is a status or a `ResponseInit`.
5. Collector `start()` is awaited inside the serialised reconcile queue. A `start()` that blocks (e.g. waiting for BLE `poweredOn`) stalls every settings change, so kick off async work and return.
6. Timers in sensing code call `.unref()` so tests and shutdown don't hang.
7. The template's `home-page.tsx` and `prompt-button.tsx` demo files were deleted, and `document.tsx` moved to `app/ui/`.
8. In production (`npm start`) the asset server caches compiled CSS/TS, so restart after editing browser code. `npm run dev` / `hmr` watch.
9. Under `remix test`, `localStorage`/`window` are absent: browser modules must stay SSR-safe at import time (`stream-client.ts`, `prefs.ts` are).
