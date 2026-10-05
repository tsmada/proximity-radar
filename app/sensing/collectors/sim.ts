// Demo collector: a random walk over ~10 fake devices using the real Observation schema,
// so the UI behaves identically in demo and live modes.

import type { Collector, DeviceKind, Source } from '../types.ts'

type SimDevice = {
  key: string
  mac?: string
  source: Exclude<Source, 'sim'> // what the device pretends to be; emitted as source 'sim'
  name: string
  vendor?: string
  kind: DeviceKind
  ip?: string
  rssi?: number // undefined → LAN-only (ON-NET ring)
  drift: number
  present: boolean
}

const SEED: Array<Omit<SimDevice, 'key' | 'mac' | 'drift' | 'present'> & { randomized?: boolean }> = [
  { source: 'ble', name: 'iPhone', kind: 'phone', rssi: -52, randomized: true },
  { source: 'ble', name: 'Pixel 9', kind: 'phone', rssi: -68, randomized: true },
  { source: 'ble', name: 'AirPods Pro', kind: 'media', rssi: -58, randomized: true },
  { source: 'ble', name: 'Hue Bulb', vendor: 'Signify', kind: 'iot', rssi: -80 },
  { source: 'ble', name: 'Galaxy Watch', kind: 'iot', rssi: -74, randomized: true },
  { source: 'wifi', name: 'MacBook Air', vendor: 'Apple', kind: 'laptop', rssi: -63 },
  { source: 'lan', name: 'gateway.lan', vendor: 'Ubiquiti', kind: 'router', ip: '192.168.1.1' },
  { source: 'lan', name: 'Living-Room-TV', vendor: 'LG Electronics', kind: 'media', ip: '192.168.1.23' },
  { source: 'lan', name: 'HP LaserJet', vendor: 'HP', kind: 'printer', ip: '192.168.1.40' },
  { source: 'lan', name: 'thermostat', vendor: 'Google', kind: 'iot', ip: '192.168.1.57' },
  { source: 'ble', name: '', kind: 'unknown', rssi: -86, randomized: true },
]

export type SimOptions = {
  intervalMs?: number
  random?: () => number
}

export function createSimCollector(opts: SimOptions = {}): Collector {
  let random = opts.random ?? Math.random
  let intervalMs = opts.intervalMs ?? 1000
  let timer: ReturnType<typeof setInterval> | undefined

  function randomMac(locallyAdministered: boolean) {
    let bytes = Array.from({ length: 6 }, () => Math.floor(random() * 256))
    bytes[0] = locallyAdministered ? (bytes[0] | 0x02) & 0xfe : bytes[0] & 0xfc
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':')
  }

  return {
    id: 'sim',
    tier: 'sim',
    label: 'SIM',
    defaultEnabled: true,
    probe: () => ({ state: 'available' }),

    start(ctx) {
      let devices: SimDevice[] = SEED.map(({ randomized, ...d }, i) => {
        let mac = randomMac(Boolean(randomized))
        return {
          ...d,
          key: d.source === 'ble' ? `sim-ble-${i}-${mac}` : mac,
          mac,
          drift: 0,
          present: i < 9 || random() < 0.5,
        }
      })

      let step = () => {
        let at = Date.now()
        for (let d of devices) {
          // ~1 in 40 steps a device toggles presence, so contacts come and go.
          if (random() < 0.025) d.present = !d.present
          if (!d.present) continue
          if (d.rssi !== undefined) {
            d.drift = Math.max(-1.5, Math.min(1.5, d.drift + (random() - 0.5) * 0.6))
            d.rssi = Math.max(-95, Math.min(-40, d.rssi + d.drift + (random() - 0.5) * 4))
          }
          // LAN devices are only "seen" occasionally, like ARP/mDNS refreshes.
          if (d.source === 'lan' && random() > 0.3) continue
          ctx.emit({
            source: 'sim',
            collector: 'sim',
            key: d.key,
            at,
            rssi: d.rssi === undefined ? undefined : Math.round(d.rssi),
            mac: d.mac,
            ip: d.ip,
            name: d.name || undefined,
            vendor: d.vendor,
            kind: d.kind,
          })
        }
      }

      step()
      timer = setInterval(step, intervalMs)
      timer.unref?.()
      ctx.signal.addEventListener('abort', () => clearInterval(timer))
    },

    stop() {
      clearInterval(timer)
      timer = undefined
    },
  }
}
