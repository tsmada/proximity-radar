// Tier 0 status: this machine's own Wi-Fi link (interface, SSID, RSSI, noise, channel).
//
// This is NOT a contact: RSSI to our own access point says nothing about other
// devices (PLAN §2). It never emits; it only reports `ctx.setHealth({ detail })`,
// which the status bar shows, e.g. `en0 · HomeNet · -57 dBm · SNR 37 · ch 149 (5GHz)`.
//
// macOS: `system_profiler SPAirPortDataType -json -detailLevel basic` (~1 s, no
// sudo; `basic` skips the nearby-network scan). The SSID comes back as
// `<redacted>` unless the calling app has Location Services access; we then omit it.

import type { Collector, CollectorContext, CollectorHealth } from '../types.ts'
import { errorMessage, every, hasBinary, linkedController, run } from './lan-util.ts'

export const STATION_ID = 'station-wifi'

export type StationInfo = {
  iface: string
  connected: boolean
  /** Raw `spairport_status_information`, e.g. `spairport_status_off`. */
  status?: string
  ssid?: string
  rssi?: number
  noise?: number
  channel?: string // e.g. `149 (5GHz, 40MHz)`
  phyMode?: string
  txRate?: number // Mbps
}

type SpInterface = {
  _name?: string
  spairport_status_information?: string
  spairport_current_network_information?: {
    _name?: string
    spairport_network_channel?: string | number
    spairport_network_phymode?: string
    spairport_network_rate?: number
    spairport_signal_noise?: string
  }
}

/** Parse `system_profiler SPAirPortDataType -json`. Returns the first Wi-Fi interface (en*), connected first. */
export function parseSystemProfiler(json: string): StationInfo | undefined {
  let data: { SPAirPortDataType?: Array<{ spairport_airport_interfaces?: SpInterface[] }> }
  try {
    data = JSON.parse(json)
  } catch {
    return undefined
  }
  let ifaces = (data.SPAirPortDataType ?? []).flatMap((d) => d.spairport_airport_interfaces ?? [])
  // awdl0 / llw0 are Apple peer-to-peer links, not the station interface.
  let candidates = ifaces.filter((i) => i._name && /^en\d+$/.test(i._name))
  let pick =
    candidates.find((i) => i.spairport_status_information === 'spairport_status_connected') ?? candidates[0]
  if (!pick?._name) return undefined

  let info: StationInfo = {
    iface: pick._name,
    connected: pick.spairport_status_information === 'spairport_status_connected',
    status: pick.spairport_status_information,
  }
  let net = pick.spairport_current_network_information
  if (info.connected && net) {
    if (net._name && net._name !== '<redacted>') info.ssid = net._name
    let sn = /(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/.exec(net.spairport_signal_noise ?? '')
    if (sn) {
      info.rssi = Number(sn[1])
      info.noise = Number(sn[2])
    }
    if (net.spairport_network_channel !== undefined) info.channel = String(net.spairport_network_channel)
    info.phyMode = net.spairport_network_phymode
    info.txRate = net.spairport_network_rate
  }
  return info
}

/** One status-bar line. */
export function formatStation(s: StationInfo): string {
  if (!s.connected) return `${s.iface} · ${s.status === 'spairport_status_off' ? 'Wi-Fi off' : 'not connected'}`
  let parts = [s.iface]
  if (s.ssid) parts.push(s.ssid)
  if (s.rssi !== undefined) parts.push(`${s.rssi} dBm`)
  if (s.rssi !== undefined && s.noise !== undefined) parts.push(`SNR ${s.rssi - s.noise}`)
  if (s.channel) parts.push(`ch ${s.channel.replace(/,\s*\d+MHz/, '')}`)
  return parts.join(' · ')
}

export function createStationCollector(opts: { refreshMs?: number } = {}): Collector {
  let refreshMs = opts.refreshMs ?? 10_000
  let ctrl: AbortController | undefined

  return {
    id: STATION_ID,
    tier: 0,
    label: 'STATION',
    defaultEnabled: true,
    statusOnly: true,

    async probe(): Promise<CollectorHealth> {
      if (process.platform !== 'darwin') return { state: 'unsupported', detail: 'Station Wi-Fi status is macOS-only for now' }
      if (!(await hasBinary('system_profiler', ['-listDataTypes']))) {
        return { state: 'unsupported', detail: '`system_profiler` not found' }
      }
      return { state: 'available' }
    },

    start(ctx: CollectorContext) {
      ctrl = linkedController(ctx.signal)
      let signal = ctrl.signal
      let refresh = async () => {
        let json = await run('system_profiler', ['SPAirPortDataType', '-json', '-detailLevel', 'basic'], {
          signal,
          timeoutMs: 15_000,
        })
        if (signal.aborted) return
        let info = parseSystemProfiler(json)
        if (!info) {
          ctx.setHealth({ state: 'available', detail: 'no Wi-Fi interface' })
          return
        }
        ctx.setHealth({ state: 'available', detail: formatStation(info) })
      }
      every(refreshMs, signal, refresh, (error) => ctx.setHealth({ state: 'error', detail: errorMessage(error) }))
    },

    stop() {
      ctrl?.abort()
      ctrl = undefined
    },
  }
}
