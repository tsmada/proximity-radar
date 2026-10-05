// Pure scope maths shared by the canvas renderer, the readout and tests. No DOM access.

import type { CollectorStatus, Contact, DeviceKind, Ring, Source } from '../../../sensing/types.ts'

/** Contact fields that the fusion agent may add; optional so older servers still type-check. */
export type UiContact = Contact & { claimed?: boolean }

export const SWEEP_MS = 4000

/** Radial band per ring, as a fraction of the scope radius. Ring lines are drawn at the outer edges. */
export const RING_BANDS: Record<Ring, readonly [number, number]> = {
  near: [0.07, 0.3],
  mid: [0.3, 0.52],
  far: [0.52, 0.74],
  onnet: [0.79, 0.92],
}

export const RING_LABEL: Record<Ring, string> = {
  near: 'NEAR',
  mid: 'MID',
  far: 'FAR',
  onnet: 'ON-NET',
}

export const RING_ORDER: Record<Ring, number> = { near: 0, mid: 1, far: 2, onnet: 3 }

/** dBm window per ring (strongest → weakest). dBm is linear in log-distance, so this is a log scale. */
const RSSI_WINDOWS: Record<Exclude<Ring, 'onnet'>, readonly [number, number]> = {
  near: [-40, -60],
  mid: [-60, -75],
  far: [-75, -95],
}

export const KIND_GLYPH: Record<DeviceKind, string> = {
  phone: '◆',
  laptop: '■',
  router: '✚',
  media: '▲',
  iot: '●',
  printer: '▬',
  unknown: '?',
}

/** FNV-1a, 32-bit. Stable across server and browser. */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Arbitrary bearing in radians, clockwise from the top (ID°). It comes from a hash of the
 * contact id, so it is stable per contact and carries no directional meaning.
 */
export function bearingFor(id: string): number {
  return (hash32(id) / 0x100000000) * Math.PI * 2
}

/** Bearing in whole ID° (0..359), for labels. */
export function bearingDegrees(id: string): number {
  return Math.floor((bearingFor(id) / (Math.PI * 2)) * 360) % 360
}

/**
 * Radius as a fraction of the scope radius. Inside its ring band the blip is placed by smoothed
 * RSSI (log-distance). Contacts without RSSI get a stable hash spread across their band.
 */
export function radiusFor(c: Pick<Contact, 'id' | 'ring' | 'rssi'>): number {
  let [inner, outer] = RING_BANDS[c.ring] ?? RING_BANDS.onnet
  let t: number
  if (c.ring !== 'onnet' && c.rssi !== undefined && Number.isFinite(c.rssi)) {
    let [strong, weak] = RSSI_WINDOWS[c.ring]
    t = (strong - c.rssi) / (strong - weak)
  } else {
    t = (hash32(`${c.id}:r`) % 1000) / 1000
  }
  // Keep blips off the ring lines themselves.
  let pad = (outer - inner) * 0.08
  return inner + pad + clamp01(t) * (outer - inner - pad * 2)
}

/** Beam bearing (radians clockwise from top, 0..2π) at `elapsedMs` since the sweep started. */
export function beamAngle(elapsedMs: number, sweepMs = SWEEP_MS): number {
  let turns = elapsedMs / sweepMs
  return (turns - Math.floor(turns)) * Math.PI * 2
}

/** True if the beam moved past `theta` going clockwise from `prev` to `cur` (handles wrap). */
export function crossed(prev: number, cur: number, theta: number): boolean {
  if (prev === cur) return false
  if (prev < cur) return theta > prev && theta <= cur
  return theta > prev || theta <= cur
}

/** Unit-circle offset for a bearing (clockwise from top) and radius fraction. y grows downward. */
export function polar(theta: number, frac: number): { x: number; y: number } {
  return { x: Math.sin(theta) * frac, y: -Math.cos(theta) * frac }
}

/** Display brightness 0.5..1 from confidence; stale contacts are dimmed further. */
export function brightnessFor(c: Pick<Contact, 'confidence' | 'state'>): number {
  let conf = clamp01(Number.isFinite(c.confidence) ? c.confidence : 0)
  let b = 0.5 + 0.5 * conf
  return c.state === 'stale' ? b * 0.45 : b
}

/** Honest distance string: always approximate, always with the error band. */
export function formatDistance(c: Pick<Contact, 'distanceM' | 'ring'>): string {
  let d = c.distanceM
  if (d === undefined || !Number.isFinite(d) || d <= 0) {
    return c.ring === 'onnet' ? 'on network · distance unknown' : 'distance unknown'
  }
  let shown = d < 1 ? d.toFixed(1) : d < 10 ? String(Math.round(d)) : String(Math.round(d / 5) * 5)
  return `~${shown} m (±50%)`
}

export function formatConfidence(conf: number): string {
  return `${Math.round(clamp01(Number.isFinite(conf) ? conf : 0) * 100)}%`
}

/** Five-cell meter, e.g. ▮▮▮▯▯. */
export function confidenceMeter(conf: number): string {
  let filled = Math.round(clamp01(Number.isFinite(conf) ? conf : 0) * 5)
  return '▮'.repeat(filled) + '▯'.repeat(5 - filled)
}

const SOURCE_ORDER: Source[] = ['ble', 'wifi', 'lan', 'sim']

export function sourceTag(sources: readonly Source[]): string {
  let sorted = SOURCE_ORDER.filter((s) => sources.includes(s))
  return sorted.length ? sorted.join('+').toUpperCase() : '—'
}

/** 0 (far / unknown) .. 1 (touching) — used for audio pitch and loudness. */
export function closeness(c: Pick<Contact, 'id' | 'ring' | 'rssi'>): number {
  if (c.ring === 'onnet') return 0
  return clamp01(1 - (radiusFor(c) - RING_BANDS.near[0]) / (RING_BANDS.far[1] - RING_BANDS.near[0]))
}

export function sortContacts<T extends Contact>(contacts: Iterable<T>): T[] {
  return [...contacts].sort(
    (a, b) =>
      RING_ORDER[a.ring] - RING_ORDER[b.ring] ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  )
}

// ── Status bar ──────────────────────────────────────────────────────────────

const TIER_MODE: Array<[CollectorStatus['tier'], string]> = [
  [1, 'BLE'],
  [0, 'LAN'],
  [2, 'MON'],
  ['sim', 'SIM'],
]

/** `BLE+LAN`, `SIM`, or `IDLE` from the collectors that are enabled and available. */
export function modeString(caps: readonly CollectorStatus[]): string {
  let live = caps.filter((c) => c.enabled && c.state === 'available')
  let parts = TIER_MODE.filter(([tier]) => live.some((c) => c.tier === tier)).map(([, n]) => n)
  return parts.length ? parts.join('+') : 'IDLE'
}

/** The station Wi-Fi collector (our own link to the AP), if registered. */
export function stationCap(caps: readonly CollectorStatus[]): CollectorStatus | undefined {
  return caps.find((c) => c.id === 'station-wifi') ?? caps.find((c) => /station/i.test(c.id))
}

/** Interface name from a detail like `en0 · SSID · -54 dBm`. */
export function ifaceFrom(caps: readonly CollectorStatus[]): string | undefined {
  let detail = stationCap(caps)?.detail
  let first = detail?.split('·')[0]?.trim()
  return first && /^[a-z][a-z0-9]{0,15}$/i.test(first) ? first : undefined
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}
