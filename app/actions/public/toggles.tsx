import { clientEntry, on, type Handle } from 'remix/component'

import { DEFAULT_PREFS, prefs, type Prefs } from './prefs.ts'

const TOGGLES: Array<{ key: keyof Prefs; label: string; hint: string }> = [
  { key: 'crt', label: 'CRT FX', hint: 'Scanlines, bloom, barrel distortion and grain' },
  { key: 'motion', label: 'MOTION', hint: 'Rotating sweep and animations. Off gives a still scope.' },
  { key: 'audio', label: 'AUDIO', hint: 'Sonar ping when the beam crosses a nearby contact' },
]

// Display preferences. They live in this browser only (localStorage), never on the server.
export const Toggles = clientEntry(import.meta.url, function Toggles(handle: Handle) {
  let current: Prefs = DEFAULT_PREFS
  let ready = false

  handle.queueTask(() => {
    let off = prefs.subscribe((p) => {
      current = p
      ready = true
      handle.update()
    })
    handle.signal.addEventListener('abort', off)
  })

  return () => (
    <div class="toggles" role="group" aria-label="Display options">
      {TOGGLES.map((t) => (
        <button
          key={t.key}
          type="button"
          class="toggle"
          title={t.hint}
          aria-pressed={current[t.key] ? 'true' : 'false'}
          disabled={!ready}
          mix={on('click', () => prefs.set({ [t.key]: !current[t.key] }))}
        >
          <span class="lamp" aria-hidden="true" />
          {t.label}
          <span class="state" aria-hidden="true">
            {current[t.key] ? 'ON' : 'OFF'}
          </span>
        </button>
      ))}
    </div>
  )
})
