// Fusion engine: raw Observations → hashed, smoothed, ring-banded Contacts.
//
// Per contributing collector: median(5) → EMA (or 1-D Kalman) on dBm, never on
// distance. The contact's proximity comes from its best fresh RSSI source
// (BLE > Wi-Fi > SIM); presence-only sources (LAN) put it on the ON-NET ring.
// Contacts merge automatically on stable identity (same MAC, same mDNS name or
// LAN IP) and manually via merge(); claims are an in-memory allowlist.

import type { Hub } from './hub.ts'
import { hashId, isRandomizedMac, normalizeMac, scrubIdentifiers } from './identity.ts'
import type { Contact, Observation, Ring, Source } from './types.ts'

export type SmoothingFilter = 'ema' | 'kalman'

export type FusionOptions = {
  now?: () => number
  salt?: Uint8Array // defaults to the per-launch salt in identity.ts
  newMs?: number // state 'new' → 'active' after this long (default 5 s)
  staleMs?: number // unseen for this long → 'stale' (default 15 s)
  lostMs?: number // unseen for this long → `lost` event + removed (default 60 s)
  minPublishMs?: number // per-contact upsert throttle; tick() flushes the rest (default 250 ms)
  filter?: SmoothingFilter // default 'ema'
  emaAlpha?: number // default 0.25
  kalmanQ?: number // process noise, default 0.05
  kalmanR?: number // measurement noise, default 3
  medianWindow?: number // default 5
  pathLossN?: number // log-distance exponent, default 2.7 (indoors)
  hysteresisDb?: number // ring boundary hysteresis, default 3 dB
}

export type FusionResult = { ok: true } | { ok: false; error: string }

export type Fusion = {
  /** Feed one raw observation. May publish an `upsert` to the hub. */
  ingest(obs: Observation): void
  /** Age contacts and flush throttled updates. The registry calls this every second. */
  tick(): void
  /** Drop every contact only seen by this collector (publishes `lost`). Used when a collector is disabled. */
  forget(collectorId: string): void
  contacts(): Contact[]
  /** Mark a contact as one of "my devices" (or not). Survives the contact being lost and re-seen. */
  claim(id: string, claimed: boolean): FusionResult
  /**
   * Fold contact `id` into contact `into` (e.g. a BLE blip into its LAN entry). Publishes
   * `lost` for `id` and an upsert for `into`; later readings for `id` keep landing on `into`.
   */
  merge(id: string, into: string): FusionResult
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

const NEAR_DBM = -60
const FAR_DBM = -75

/** >−60 near, −60…−75 mid, <−75 far, undefined → onnet. No hysteresis. */
export function ringForRssi(rssi: number | undefined): Ring {
  if (rssi === undefined) return 'onnet'
  if (rssi > NEAR_DBM) return 'near'
  if (rssi >= FAR_DBM) return 'mid'
  return 'far'
}

const RING_ORDER: Record<Ring, number> = { near: 0, mid: 1, far: 2, onnet: 3 }

/**
 * Ring with hysteresis: leaving `prev` requires crossing the boundary by `h` dB,
 * so a reading wobbling around −60 doesn't flap between NEAR and MID.
 */
export function ringWithHysteresis(rssi: number | undefined, prev: Ring | undefined, h = 3): Ring {
  let raw = ringForRssi(rssi)
  if (rssi === undefined || !prev || prev === 'onnet' || raw === prev) return raw
  // Moving outwards: judge the reading as if it were h dB stronger, and vice versa.
  return RING_ORDER[raw] > RING_ORDER[prev] ? ringForRssi(rssi + h) : ringForRssi(rssi - h)
}

/** Log-distance model: d = 10 ^ ((TxPower − RSSI) / (10·n)). TxPower is dBm at 1 m. */
export function estimateDistance(rssi: number, txPower: number, n = 2.7): number {
  return 10 ** ((txPower - rssi) / (10 * n))
}

export function median(values: readonly number[]): number {
  let s = [...values].sort((a, b) => a - b)
  let mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0
  let mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
}

export type Smoother = { push(z: number): number; readonly value: number | undefined }

export function createSmoother(
  filter: SmoothingFilter = 'ema',
  { alpha = 0.25, q = 0.05, r = 3 }: { alpha?: number; q?: number; r?: number } = {},
): Smoother {
  let x: number | undefined
  let p = r
  return {
    push(z) {
      if (x === undefined) x = z
      else if (filter === 'ema') x += alpha * (z - x)
      else {
        p += q
        let k = p / (p + r)
        x += k * (z - x)
        p *= 1 - k
      }
      return x
    },
    get value() {
      return x
    },
  }
}

/** How much a reading from this source says about proximity, 0..1. */
export const SOURCE_QUALITY: Record<Source, number> = { ble: 1, wifi: 0.8, sim: 0.9, lan: 0.5 }

/**
 * Confidence in 0..1: rises with sample count, falls with RSSI variance (dB²),
 * scaled by source quality. Presence-only readings pass variance 0.
 */
export function confidenceFor(samples: number, rssiVariance: number, quality: number): number {
  let count = 1 - Math.exp(-samples / 4)
  let spread = 1 / (1 + rssiVariance / 50)
  return quality * count * spread
}

// ── Engine ────────────────────────────────────────────────────────────────

/** Per (collector, raw identity) reading history inside a track. */
type SourceState = {
  collector: string
  source: Source
  lastAt: number
  samples: number
  name?: string
  window: number[] // last `medianWindow` raw dBm readings
  smoother?: Smoother
  rssiAt?: number
  rssiSamples: number
  txPower?: number
}

type Track = {
  contact: Contact
  states: Map<string, SourceState>
  mac?: string
  /** What browsers last saw; upserts are skipped unless something visible moved. */
  published?: Contact
  lastPublished: number
}

// Which source drives a merged contact's ring / label, highest first.
const PROXIMITY_RANK: Record<Source, number> = { ble: 3, wifi: 2, sim: 1, lan: 0 }
const LABEL_RANK: Record<Source, number> = { lan: 3, wifi: 2, ble: 1, sim: 1 }

/**
 * True when `cur` differs from what was last published in a way the UI would show.
 * lastSeen alone doesn't count: ARP re-confirms every host every 10 s.
 */
export function visiblyChanged(prev: Contact | undefined, cur: Contact): boolean {
  if (!prev) return true
  return (
    prev.ring !== cur.ring ||
    prev.state !== cur.state ||
    prev.label !== cur.label ||
    prev.kind !== cur.kind ||
    prev.vendor !== cur.vendor ||
    prev.ip !== cur.ip ||
    prev.claimed !== cur.claimed ||
    prev.randomizedMac !== cur.randomizedMac ||
    prev.sources.join() !== cur.sources.join() ||
    Math.abs(prev.confidence - cur.confidence) > 0.05 ||
    (prev.rssi === undefined) !== (cur.rssi === undefined) ||
    Math.abs((prev.rssi ?? 0) - (cur.rssi ?? 0)) >= 1
  )
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function defaultTxPower(source: Source): number {
  return source === 'ble' ? -59 : -40
}

export function createFusion(hub: Hub, opts: FusionOptions = {}): Fusion {
  let now = opts.now ?? Date.now
  let newMs = opts.newMs ?? 5_000
  let staleMs = opts.staleMs ?? 15_000
  let lostMs = opts.lostMs ?? 60_000
  let minPublishMs = opts.minPublishMs ?? 250
  let windowSize = opts.medianWindow ?? 5
  let pathLossN = opts.pathLossN ?? 2.7
  let hysteresisDb = opts.hysteresisDb ?? 3
  let makeSmoother = () =>
    createSmoother(opts.filter ?? 'ema', { alpha: opts.emaAlpha, q: opts.kalmanQ, r: opts.kalmanR })

  let tracks = new Map<string, Track>()
  /** Absorbed contact id → the contact it was merged into. */
  let links = new Map<string, string>()
  /** Stable LAN identity (`name:…` / `ip:…`) → contact id. Server-side only. */
  let aliases = new Map<string, string>()
  let claimed = new Set<string>()

  function resolve(id: string): string {
    let seen = new Set<string>()
    while (links.has(id) && !seen.has(id)) {
      seen.add(id)
      id = links.get(id)!
    }
    return id
  }

  function publish(track: Track) {
    let contact = { ...track.contact, sources: [...track.contact.sources] }
    track.published = contact
    track.lastPublished = now()
    hub.publish({ type: 'upsert', contact })
  }

  function drop(id: string) {
    tracks.delete(id)
    hub.publish({ type: 'lost', id })
  }

  function newTrack(id: string, at: number, mac?: string): Track {
    let track: Track = {
      contact: {
        id,
        label: 'UNKNOWN',
        kind: 'unknown',
        ring: 'onnet',
        confidence: 0,
        sources: [],
        randomizedMac: mac ? isRandomizedMac(mac) : false,
        firstSeen: at,
        lastSeen: at,
        state: 'new',
      },
      states: new Map(),
      mac,
      lastPublished: 0,
    }
    if (claimed.has(id)) track.contact.claimed = true
    tracks.set(id, track)
    return track
  }

  /** Recompute ring / rssi / confidence / label / sources from the per-source states. */
  function derive(track: Track) {
    let t = now()
    let c = track.contact
    let states = [...track.states.values()]

    let fresh = states.filter((s) => t - s.lastAt <= staleMs)
    let prox = states
      .filter((s) => s.smoother?.value !== undefined && t - s.rssiAt! <= staleMs)
      .sort((a, b) => PROXIMITY_RANK[b.source] - PROXIMITY_RANK[a.source] || b.rssiAt! - a.rssiAt!)[0]

    if (prox) {
      let rssi = prox.smoother!.value!
      c.rssi = Math.round(rssi * 10) / 10
      c.distanceM = round2(estimateDistance(rssi, prox.txPower ?? defaultTxPower(prox.source), pathLossN))
      c.ring = ringWithHysteresis(rssi, c.ring, hysteresisDb)
    } else if (fresh.length > 0) {
      // Still present (e.g. LAN keeps answering) but no fresh signal strength.
      c.ring = 'onnet'
      delete c.rssi
      delete c.distanceM
    } // else: everything is stale; keep the last known reading while it ages out.

    let named = states.filter((s) => s.name).sort((a, b) => LABEL_RANK[b.source] - LABEL_RANK[a.source])
    c.label = named[0]?.name ?? c.vendor ?? 'UNKNOWN'

    let sources: Source[] = []
    for (let s of states) {
      if (t - s.lastAt <= lostMs && !sources.includes(s.source)) sources.push(s.source)
    }
    c.sources = sources

    // Noisy-OR: independent sources each add evidence. A stale RSSI source counts half;
    // presence-only LAN sources refresh slower than staleMs (mDNS/SSDP), so discounting
    // them would make confidence flap. Contact `state` covers their ageing.
    let doubt = 1
    for (let s of states) {
      let conf = s.rssiSamples
        ? confidenceFor(s.rssiSamples, variance(s.window), SOURCE_QUALITY[s.source])
        : confidenceFor(s.samples, 0, SOURCE_QUALITY.lan)
      let fresh = !s.rssiSamples || t - s.lastAt <= staleMs
      doubt *= 1 - conf * (fresh ? 1 : 0.5)
    }
    c.confidence = round2(1 - doubt)
    c.lastSeen = Math.max(c.lastSeen, ...states.map((s) => s.lastAt))
  }

  /** Move everything from `gone` into `keep`, link the ids, and announce the removal. */
  function absorb(gone: Track, keep: Track) {
    let from = gone.contact
    let to = keep.contact
    for (let [k, s] of gone.states) keep.states.set(k, s)
    to.firstSeen = Math.min(to.firstSeen, from.firstSeen)
    to.lastSeen = Math.max(to.lastSeen, from.lastSeen)
    to.vendor ??= from.vendor
    to.ip ??= from.ip
    if (to.kind === 'unknown') to.kind = from.kind
    to.randomizedMac ||= from.randomizedMac
    keep.mac ??= gone.mac
    if (from.claimed) {
      claimed.add(to.id)
      to.claimed = true
    }

    links.set(from.id, to.id)
    for (let [k, v] of links) if (v === from.id) links.set(k, to.id)
    for (let [k, v] of aliases) if (v === from.id) aliases.set(k, to.id)

    drop(from.id)
    derive(keep)
    publish(keep)
  }

  function aliasesFor(obs: Observation): string[] {
    // Only LAN names / addresses are stable enough to merge on; BLE local names
    // ("iPhone") and sim data are not.
    if (obs.source !== 'lan') return []
    let out: string[] = []
    if (obs.name) out.push(`name:${obs.name.toLowerCase()}`)
    if (obs.ip) out.push(`ip:${obs.ip}`)
    return out
  }

  function compatible(mac: string | undefined, other: Track) {
    return !(mac && other.mac && mac !== other.mac)
  }

  return {
    ingest(raw) {
      // Names and vendors are shown to the browser: never let a raw id ride along in them.
      let obs: Observation = { ...raw, name: scrubIdentifiers(raw.name), vendor: scrubIdentifiers(raw.vendor) }
      let mac = obs.mac ? normalizeMac(obs.mac) : undefined
      let baseId = hashId(mac ?? `${obs.source}:${obs.key}`, opts.salt)
      let id = resolve(baseId)
      let track = tracks.get(id)

      for (let alias of aliasesFor(obs)) {
        let otherId = aliases.get(alias)
        let other = otherId ? tracks.get(resolve(otherId)) : undefined
        if (other && other !== track && compatible(track?.mac ?? mac, other)) {
          if (!track) {
            links.set(id, other.contact.id)
            track = other
          } else {
            let olderFirst = track.contact.firstSeen <= other.contact.firstSeen
            let [keep, gone] = olderFirst ? [track, other] : [other, track]
            absorb(gone, keep)
            track = keep
          }
          id = track.contact.id
        }
        aliases.set(alias, id)
      }

      let isNew = !track
      track ??= newTrack(id, obs.at, mac)
      if (mac) track.mac ??= mac

      let stateKey = `${obs.collector}|${baseId}`
      let state = track.states.get(stateKey)
      if (!state) {
        state = { collector: obs.collector, source: obs.source, lastAt: obs.at, samples: 0, window: [], rssiSamples: 0 }
        track.states.set(stateKey, state)
      }
      state.lastAt = Math.max(state.lastAt, obs.at)
      state.samples++
      if (obs.name) state.name = obs.name
      if (obs.rssi !== undefined) {
        state.window.push(obs.rssi)
        if (state.window.length > windowSize) state.window.shift()
        state.smoother ??= makeSmoother()
        state.smoother.push(median(state.window))
        state.rssiAt = now()
        state.rssiSamples++
        if (obs.txPower !== undefined) state.txPower = obs.txPower
      }

      let c = track.contact
      let prevRing = c.ring
      let randomized = mac ? isRandomizedMac(mac) : false
      if (c.state === 'stale') c.state = 'active'
      if (obs.vendor && (!randomized || obs.vendorFromDevice)) c.vendor = obs.vendor
      if (obs.kind && obs.kind !== 'unknown') c.kind = obs.kind
      if (obs.ip) c.ip = obs.ip
      c.randomizedMac ||= randomized
      derive(track)

      // Ring changes go out at once; other visible changes are throttled and tick() flushes them.
      if (isNew || c.ring !== prevRing) publish(track)
      else if (visiblyChanged(track.published, c) && now() - track.lastPublished >= minPublishMs) publish(track)
    },

    tick() {
      let t = now()
      for (let track of [...tracks.values()]) {
        let c = track.contact
        let age = t - c.lastSeen
        if (age > lostMs) {
          drop(c.id)
          continue
        }
        derive(track)
        if (age > staleMs) c.state = 'stale'
        else if (c.state === 'new' && t - c.firstSeen > newMs) c.state = 'active'
        if (visiblyChanged(track.published, c)) publish(track)
      }
    },

    forget(collectorId) {
      for (let track of [...tracks.values()]) {
        let removed = false
        for (let [k, s] of track.states) {
          if (s.collector === collectorId) {
            track.states.delete(k)
            removed = true
          }
        }
        if (!removed) continue
        if (track.states.size === 0) drop(track.contact.id)
        else {
          derive(track)
          publish(track)
        }
      }
    },

    contacts: () => [...tracks.values()].map((t) => t.contact),

    claim(id, isClaimed) {
      let track = tracks.get(resolve(id))
      if (!track) return { ok: false, error: 'Unknown contact' }
      let target = track.contact.id
      if (isClaimed) {
        claimed.add(target)
        track.contact.claimed = true
      } else {
        claimed.delete(target)
        delete track.contact.claimed
      }
      publish(track)
      return { ok: true }
    },

    merge(id, into) {
      let gone = tracks.get(resolve(id))
      let keep = tracks.get(resolve(into))
      if (!gone || !keep) return { ok: false, error: 'Unknown contact' }
      if (gone === keep) return { ok: false, error: 'Cannot merge a contact into itself' }
      absorb(gone, keep)
      return { ok: true }
    },
  }
}
