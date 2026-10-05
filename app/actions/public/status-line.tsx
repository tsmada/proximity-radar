import { clientEntry, type Handle } from 'remix/component'

import type { CollectorStatus } from '../../sensing/types.ts'
import { DEFAULT_PREFS, prefs, type Prefs } from './prefs.ts'
import { SWEEP_MS, ifaceFrom, modeString, stationCap } from './render/geometry.ts'
import { streamStore } from './stream-client.ts'

/** `-54 dBm` from a station detail like `en0 · SSID · -54 dBm`. */
function stationRssi(caps: readonly CollectorStatus[]): string | undefined {
  return stationCap(caps)?.detail?.match(/-?\d+(?:\.\d+)?\s*dBm/i)?.[0]
}

// MODE: BLE+LAN | CONTACTS: 12 | SWEEP 4.0s | IFACE en0 | AUDIO: MUTED
export const StatusLine = clientEntry(
  import.meta.url,
  function StatusLine(handle: Handle<{ caps: CollectorStatus[]; contactCount: number }>) {
    let caps = handle.props.caps
    let count = handle.props.contactCount
    let live: boolean | undefined
    let p: Prefs = DEFAULT_PREFS

    let timer: ReturnType<typeof setTimeout> | undefined
    let scheduleUpdate = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        handle.update()
      }, 250)
    }

    handle.queueTask(() => {
      let off = streamStore.subscribe((state) => {
        caps = state.caps.length ? state.caps : caps
        count = state.contacts.size
        live = state.connected
        scheduleUpdate()
      })
      let offPrefs = prefs.subscribe((next) => {
        p = next
        handle.update()
      })
      handle.signal.addEventListener('abort', () => {
        off()
        offPrefs()
        clearTimeout(timer)
      })
    })

    return () => {
      let iface = ifaceFrom(caps)
      let rssi = stationRssi(caps)
      let attention = caps.filter((c) => c.enabled && (c.state === 'needs-permission' || c.state === 'error'))
      let mode = modeString(caps)
      let items: Array<[string, string, string?]> = [
        ['MODE', `MODE: ${mode}`, mode.includes('SIM') ? 'demo' : undefined],
        ['CONTACTS', `CONTACTS: ${count}`],
        ['SWEEP', p.motion ? `SWEEP ${(SWEEP_MS / 1000).toFixed(1)}s` : 'SWEEP HOLD'],
        ['IFACE', `IFACE ${iface ?? '—'}${rssi ? ` ${rssi}` : ''}`],
        ['AUDIO', `AUDIO: ${p.audio ? 'ON' : 'MUTED'}`],
        ['LINK', live === false ? 'LINK: RETRY' : live ? 'LINK: LIVE' : 'LINK: …', live === false ? 'warn' : undefined],
      ]
      if (attention.length) items.push(['ATTN', `! ${attention.length} SENSOR${attention.length > 1 ? 'S' : ''} NEED ATTENTION`, 'warn'])
      return (
        <p class="status-line" aria-label="Status">
          {items.map(([key, text, flag], i) => (
            <span key={key} class="seg" data-flag={flag}>
              {i > 0 ? (
                <span class="sep" aria-hidden="true">
                  |
                </span>
              ) : null}
              {text}
            </span>
          ))}
        </p>
      )
    }
  },
)
