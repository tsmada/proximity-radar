// Shared sensing contracts. Server-only modules and browser code both import
// from here; browser code must use `import type` so nothing is fetched at runtime.

/** Where a reading came from. Also shown on every blip / readout row. */
export type Source = 'ble' | 'wifi' | 'lan' | 'sim'

/** Coarse proximity band. `onnet` = known to be on the LAN, distance unknown. */
export type Ring = 'near' | 'mid' | 'far' | 'onnet'

export type DeviceKind = 'phone' | 'laptop' | 'router' | 'media' | 'iot' | 'printer' | 'unknown'

/** `new` for the first few seconds after first sighting, `stale` after 15 s unseen. */
export type ContactState = 'new' | 'active' | 'stale' | 'lost'

/** A fused device as sent to the browser. Never contains raw MACs / BLE ids. */
export type Contact = {
  id: string // HMAC(salt, raw key) truncated to 12 hex chars
  label: string // mDNS name, BLE local name, vendor, or "UNKNOWN"
  vendor?: string // OUI lookup (skipped for randomized MACs)
  kind: DeviceKind
  ip?: string
  rssi?: number // smoothed dBm
  distanceM?: number // log-distance estimate; UI shows the ring, tooltip ~m
  ring: Ring
  confidence: number // 0..1
  sources: Source[]
  randomizedMac: boolean
  firstSeen: number // epoch ms
  lastSeen: number // epoch ms
  state: ContactState
  claimed?: boolean // user marked this as one of "my devices" (POST /claim)
}

/** 0 = LAN identity, 1 = BLE proximity, 2 = monitor mode, 'sim' = demo generator. */
export type Tier = 0 | 1 | 2 | 'sim'

/**
 * - available: running (or ready to run when enabled)
 * - needs-permission: OS permission / root required; `detail` says how to grant it
 * - unsupported: platform or binary missing
 * - disabled: turned off in settings (set by the registry, never by a collector)
 * - error: started but failed; `detail` has the message
 */
export type CollectorState = 'available' | 'needs-permission' | 'unsupported' | 'disabled' | 'error'

/** What a collector reports about itself. The registry adds id/tier/enabled. */
export type CollectorHealth = {
  state: Exclude<CollectorState, 'disabled'>
  detail?: string
}

/** Public per-collector status, as sent in `caps` and from GET /status. */
export type CollectorStatus = {
  id: string
  tier: Tier
  label: string
  state: CollectorState
  detail?: string
  enabled: boolean
}

/**
 * Server → browser SSE payloads (one JSON object per `data:` line).
 * The first event on every connection is always `snapshot`.
 */
export type StreamEvent =
  | { type: 'snapshot'; contacts: Contact[]; caps: CollectorStatus[] }
  | { type: 'upsert'; contact: Contact }
  | { type: 'lost'; id: string }
  | { type: 'caps'; caps: CollectorStatus[] }

/**
 * One raw reading from one collector. Server-only: contains raw identifiers.
 * Fusion hashes `key`/`mac` before anything reaches the hub.
 */
export type Observation = {
  source: Source
  collector: string // id of the emitting collector
  key: string // stable raw per-source identifier: MAC, BLE peripheral uuid, or IP
  at: number // epoch ms
  rssi?: number // raw dBm, unsmoothed
  txPower?: number // advertised dBm at 1 m (BLE txPowerLevel)
  ip?: string
  mac?: string // any case / separator; fusion normalises it
  name?: string // mDNS / BLE local name / SSDP friendlyName
  vendor?: string // collector-side OUI or manufacturer data, if known
  /** `vendor` was reported by the device itself (UPnP / AirPlay / mDNS TXT), not an OUI lookup, so keep it even for randomized MACs. */
  vendorFromDevice?: boolean
  kind?: DeviceKind
}

/** Handed to `Collector.start`. */
export type CollectorContext = {
  /** Report a reading. Cheap; call as often as the radio produces data. */
  emit(obs: Observation): void
  /** Change reported health at any time (e.g. permission revoked, scan failed). */
  setHealth(health: CollectorHealth): void
  /** Aborted when the collector is stopped; tie timers / child processes to it. */
  signal: AbortSignal
}

/**
 * A data source. Register it in `app/sensing/registry.ts`.
 * Lifecycle: probe() → (if enabled & available) start(ctx) → stop() → maybe start() again.
 */
export interface Collector {
  readonly id: string // unique, kebab-case, e.g. 'lan-arp'
  readonly tier: Tier
  readonly label: string // short human label for the status bar, e.g. 'ARP'
  /** Whether it runs without the user opting in. BLE / monitor mode must be false. */
  readonly defaultEnabled: boolean
  /** Reports status only (e.g. our own Wi-Fi link), never contacts: doesn't count as a live source for auto demo mode. */
  readonly statusOnly?: boolean
  /** Cheap capability check without side effects (binary present, platform ok…). */
  probe(): CollectorHealth | Promise<CollectorHealth>
  start(ctx: CollectorContext): void | Promise<void>
  /** Must be idempotent. `ctx.signal` is aborted right before this is called. */
  stop(): void
}
