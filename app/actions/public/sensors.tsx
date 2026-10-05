import { clientEntry, on, type Handle } from 'remix/component'

import type { CollectorStatus } from '../../sensing/types.ts'
import { submitInBackground } from './forms.ts'
import { streamStore } from './stream-client.ts'

type DemoMode = 'auto' | 'on' | 'off'

const STATE_TEXT: Record<CollectorStatus['state'], string> = {
  available: 'ONLINE',
  'needs-permission': 'NEEDS PERMISSION',
  unsupported: 'UNSUPPORTED',
  disabled: 'OFF',
  error: 'ERROR',
}

const TIER_TEXT: Record<string, string> = {
  '0': 'T0 · LAN IDENTITY',
  '1': 'T1 · BLE PROXIMITY',
  '2': 'T2 · MONITOR MODE',
  sim: 'DEMO',
}

// Collector list with on/off forms (POST /settings) and the demo-mode selector. Works without
// JS (forms post and the server redirects back); with JS the forms submit in the background and
// the SSE `caps` event updates the list.
export const Sensors = clientEntry(
  import.meta.url,
  function Sensors(handle: Handle<{ caps: CollectorStatus[]; demo: DemoMode; settingsHref: string }>) {
    let caps = handle.props.caps
    let demo = handle.props.demo

    handle.queueTask(() => {
      let off = streamStore.subscribe((state) => {
        if (state.caps.length && state.caps !== caps) {
          caps = state.caps
          handle.update()
        }
      })
      handle.signal.addEventListener('abort', off)
    })

    return () => {
      let { settingsHref } = handle.props
      let sensors = caps.filter((c) => c.tier !== 'sim')
      let sim = caps.find((c) => c.tier === 'sim')
      return (
        <section class="panel sensors" aria-labelledby="sensors-title">
          <h2 id="sensors-title" class="panel-title">
            SENSORS
          </h2>
          <ul class="sensor-list">
            {sensors.length === 0 ? <li class="sensor empty">NO LIVE COLLECTORS REGISTERED · DEMO ONLY</li> : null}
            {sensors.map((c) => (
              <li key={c.id} class="sensor" data-collector={c.id} data-state={c.state} data-enabled={c.enabled ? 'true' : 'false'}>
                <span class="led" aria-hidden="true" />
                <span class="sensor-name">
                  {c.label} <span class="sub">{TIER_TEXT[String(c.tier)] ?? `T${c.tier}`}</span>
                </span>
                <span class="sensor-state">{STATE_TEXT[c.state] ?? c.state.toUpperCase()}</span>
                <form
                  method="post"
                  action={settingsHref}
                  mix={on('submit', (event) => {
                    event.preventDefault()
                    void submitInBackground(event.currentTarget, event.submitter)
                  })}
                >
                  <input type="hidden" name="collector" value={c.id} />
                  <input type="hidden" name="enabled" value={c.enabled ? 'off' : 'on'} />
                  <button
                    type="submit"
                    class="btn-mini"
                    aria-pressed={c.enabled ? 'true' : 'false'}
                    aria-label={`${c.label} collector`}
                    disabled={c.state === 'unsupported' && !c.enabled}
                  >
                    {c.enabled ? 'ON' : 'OFF'}
                  </button>
                </form>
                {c.detail ? (
                  <p class="sensor-detail" data-kind={c.state === 'needs-permission' ? 'action' : c.state === 'error' ? 'error' : undefined}>
                    {c.state === 'needs-permission' ? 'ACTION: ' : ''}
                    {c.detail}
                  </p>
                ) : null}
                {c.tier === 1 && !c.enabled ? (
                  <p class="sensor-detail">OPT-IN · macOS will ask for Bluetooth permission</p>
                ) : null}
                {c.tier === 2 && !c.enabled ? (
                  <p class="sensor-detail" data-kind="action">
                    OPT-IN · needs root, may drop your Wi-Fi connection
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <form
            method="post"
            action={settingsHref}
            class="demo-form"
            mix={on('submit', (event) => {
              event.preventDefault()
              let form = event.currentTarget
              let next = new FormData(form).get('demo')
              void submitInBackground(form, event.submitter).then((ok) => {
                if (ok && (next === 'auto' || next === 'on' || next === 'off')) {
                  demo = next
                  handle.update()
                }
              })
            })}
          >
            <span class="led" data-on={sim?.enabled ? 'true' : 'false'} aria-hidden="true" />
            <label>
              DEMO DATA{' '}
              <select name="demo">
                {(['auto', 'on', 'off'] as const).map((m) => (
                  <option key={m} value={m} selected={m === demo}>
                    {m === 'auto' ? 'AUTO (WHEN NO LIVE SENSOR)' : m.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" class="btn-mini">
              SET
            </button>
            <span class="sub">{sim?.enabled ? 'SIM RUNNING · CONTACTS ARE FAKE' : 'SIM IDLE'}</span>
          </form>
        </section>
      )
    }
  },
)
