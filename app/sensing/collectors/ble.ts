// Tier 1: BLE advertisement RSSI via @abandonware/noble — the per-device proximity source.
//
// Opt-in only (PLAN §6). noble is imported lazily inside start(), so a missing or broken
// native module can never break server boot, and nothing touches CoreBluetooth (which may
// show the macOS permission prompt) until the user enables the collector.
// Only RSSI, advertised tx power, local name and the manufacturer company id (→ vendor /
// kind hint) are read; no payload bytes are kept.

import type { Collector, CollectorHealth, DeviceKind, Observation } from '../types.ts'

export const BLE_ID = 'ble'

/** The slice of noble this collector uses (also what tests fake). */
export type NobleLike = {
  readonly _state?: string
  readonly state?: string
  on(event: 'stateChange', fn: (state: string) => void): unknown
  on(event: 'discover', fn: (p: PeripheralLike) => void): unknown
  removeListener(event: string, fn: (...args: any[]) => void): unknown
  startScanning(serviceUUIDs: string[], allowDuplicates: boolean, cb?: (error?: Error | null) => void): void
  stopScanning(cb?: () => void): void
}

export type PeripheralLike = {
  id: string // CoreBluetooth peripheral UUID on macOS (address is 'unknown' there)
  rssi: number
  advertisement: { localName?: string; txPowerLevel?: number; manufacturerData?: Uint8Array }
}

export type BleOptions = {
  /** Override the noble loader (tests). Defaults to a lazy dynamic import. */
  loadNoble?: () => Promise<NobleLike>
  /** Resolve the module without executing it (probe). Defaults to import.meta.resolve. */
  resolveNoble?: () => string
  platform?: NodeJS.Platform
}

export const PERMISSION_DETAIL =
  'Grant Bluetooth access to your terminal/Node in System Settings › Privacy & Security › Bluetooth, then re-enable BLE (restart the server if it stays blocked).'

/** noble adapter state → collector health. `undefined` = transient, keep the current health. */
export function healthForState(state: string): CollectorHealth | undefined {
  switch (state) {
    case 'poweredOn':
      return { state: 'available' }
    case 'unauthorized':
      return { state: 'needs-permission', detail: PERMISSION_DETAIL }
    case 'poweredOff':
      // Not 'unsupported': the registry would stop us, and we resume by ourselves once it's on.
      return { state: 'error', detail: 'Bluetooth is turned off. Turn it on and scanning resumes automatically.' }
    case 'unsupported':
      return { state: 'unsupported', detail: 'No usable Bluetooth LE adapter on this machine.' }
    default: // unknown, resetting
      return undefined
  }
}

// Bluetooth SIG company identifiers (little-endian first two bytes of manufacturer data).
const COMPANIES: Record<number, { vendor: string; kind?: DeviceKind }> = {
  0x0006: { vendor: 'Microsoft' },
  0x004c: { vendor: 'Apple' },
  0x0075: { vendor: 'Samsung' },
  0x0087: { vendor: 'Garmin', kind: 'iot' },
  0x00e0: { vendor: 'Google' },
  0x0171: { vendor: 'Amazon' },
  0x05a7: { vendor: 'Sonos', kind: 'media' },
  0x06d0: { vendor: 'VeSync', kind: 'iot' },
}

// Apple Continuity message type (byte after the company id) → kind hint.
const APPLE_TYPES: Record<number, DeviceKind> = {
  0x07: 'media', // proximity pairing: AirPods / Beats
  0x09: 'media', // AirPlay target
  0x12: 'iot', // Find My (AirTag, separated accessories)
}

const NAME_KINDS: Array<[RegExp, DeviceKind]> = [
  [/iphone|pixel|galaxy (s|z|a)\d|android|\bphone\b/i, 'phone'],
  [/macbook|laptop|thinkpad|surface/i, 'laptop'],
  [/airpods|buds|headphone|speaker|\btv\b|webos|sonos|bose|jbl|beats|soundbar/i, 'media'],
  [/printer|laserjet|officejet|deskjet|epson|brother/i, 'printer'],
  [/watch|band|tag|bulb|\bhue\b|sensor|plug|lock|thermostat|purifier/i, 'iot'],
]

/** Vendor and kind hints from the advertisement. Pure. Never returns payload bytes. */
export function hintsFor(adv: PeripheralLike['advertisement']): { vendor?: string; kind: DeviceKind } {
  let vendor: string | undefined
  let kind: DeviceKind = 'unknown'
  let data = adv.manufacturerData
  if (data && data.length >= 2) {
    let company = data[0] | (data[1] << 8)
    let known = COMPANIES[company]
    vendor = known?.vendor
    if (known?.kind) kind = known.kind
    if (company === 0x004c && data.length >= 3) kind = APPLE_TYPES[data[2]] ?? kind
  }
  let name = adv.localName?.trim()
  if (name) {
    let match = NAME_KINDS.find(([re]) => re.test(name))
    if (match) kind = match[1]
  }
  return { vendor, kind }
}

/**
 * Expected loss from the advertised TX power to the RSSI we see at 1 m. The textbook
 * free-space figure is ~41 dB, but with real antenna and body losses a 0 dBm phone reads
 * nearer −59 dBm at 1 m; using 41 put advertisers 5–20× further out than non-advertisers
 * in a live scan. So an advertiser at 0 dBm matches the −59 default.
 */
export const ONE_METRE_LOSS_DB = 59

/**
 * The TX Power Level AD field is radiated power at the antenna (typically −20…+10 dBm),
 * while the distance model wants the expected RSSI at 1 m. Values that already look like
 * a 1 m reference (≤ −30, iBeacon style) pass through.
 */
export function referencePower(txPowerLevel: number | undefined): number | undefined {
  if (txPowerLevel === undefined || !Number.isFinite(txPowerLevel)) return undefined
  return txPowerLevel > -30 ? txPowerLevel - ONE_METRE_LOSS_DB : txPowerLevel
}

export function observationFor(p: PeripheralLike, at: number): Observation | undefined {
  // noble reports 127 when RSSI is unavailable.
  if (!Number.isFinite(p.rssi) || p.rssi >= 20) return undefined
  let { vendor, kind } = hintsFor(p.advertisement)
  return {
    source: 'ble',
    collector: BLE_ID,
    key: p.id,
    at,
    rssi: p.rssi,
    txPower: referencePower(p.advertisement.txPowerLevel),
    name: p.advertisement.localName?.trim() || undefined,
    vendor,
    kind,
  }
}

export function createBleCollector(opts: BleOptions = {}): Collector {
  let loadNoble =
    opts.loadNoble ??
    (async () => {
      let mod: any = await import('@abandonware/noble')
      return (mod.default ?? mod) as NobleLike
    })
  let resolveNoble = opts.resolveNoble ?? (() => import.meta.resolve('@abandonware/noble'))
  let platform = opts.platform ?? process.platform
  let detach: (() => void) | undefined

  return {
    id: BLE_ID,
    tier: 1,
    label: 'BLE',
    defaultEnabled: false,

    probe() {
      if (!['darwin', 'linux', 'win32'].includes(platform)) {
        return { state: 'unsupported', detail: `BLE scanning is not supported on ${platform}.` }
      }
      try {
        resolveNoble() // resolution only: no native code runs, no permission prompt
      } catch {
        return { state: 'unsupported', detail: '@abandonware/noble is not installed (npm install).' }
      }
      return { state: 'available' }
    },

    start(ctx) {
      // Return immediately: waiting for poweredOn here would stall the registry queue.
      ctx.setHealth({ state: 'available', detail: 'Waiting for the Bluetooth adapter…' })
      void (async () => {
        let noble: NobleLike
        try {
          noble = await loadNoble()
        } catch (error) {
          let msg = error instanceof Error ? error.message : String(error)
          ctx.setHealth({ state: 'unsupported', detail: `Could not load the BLE driver (noble): ${msg}` })
          return
        }
        if (ctx.signal.aborted) return

        let scanning = false
        let onDiscover = (p: PeripheralLike) => {
          let obs = observationFor(p, Date.now())
          if (obs) ctx.emit(obs)
        }
        let onState = (state: string) => {
          let health = healthForState(state)
          if (health) ctx.setHealth(health)
          if (state === 'poweredOn' && !scanning) {
            scanning = true
            // allowDuplicates: every advertisement, so RSSI keeps updating.
            noble.startScanning([], true, (error) => {
              if (error) {
                scanning = false
                ctx.setHealth({ state: 'error', detail: `BLE scan failed: ${error.message}` })
              }
            })
          } else if (state !== 'poweredOn') {
            scanning = false
          }
        }

        noble.on('discover', onDiscover)
        noble.on('stateChange', onState)
        detach = () => {
          noble.removeListener('discover', onDiscover)
          noble.removeListener('stateChange', onState)
          if (scanning) {
            scanning = false
            try {
              noble.stopScanning()
            } catch {}
          }
        }
        // noble is a singleton: on a re-enable the adapter is already up and no
        // stateChange will fire, so act on the current state now.
        let current = noble.state ?? noble._state
        if (current && current !== 'unknown') onState(current)
      })()
      ctx.signal.addEventListener('abort', () => detach?.(), { once: true })
    },

    stop() {
      detach?.()
      detach = undefined
    },
  }
}
