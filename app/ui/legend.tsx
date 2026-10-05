import type { Handle } from 'remix/component'

import { KIND_GLYPH, RING_LABEL } from '../actions/public/render/geometry.ts'
import type { DeviceKind } from '../sensing/types.ts'

const KINDS: DeviceKind[] = ['phone', 'laptop', 'router', 'media', 'iot', 'printer', 'unknown']

const RING_HINT = {
  near: 'strong signal',
  mid: 'medium',
  far: 'weak',
  onnet: 'on LAN, no distance',
} as const

// Static key under the scope. Server-only: nothing here changes at runtime.
export function Legend(_handle: Handle) {
  return () => (
    <section class="legend" aria-label="Scope legend">
      <ul class="legend-kinds">
        {KINDS.map((k) => (
          <li key={k}>
            <span class="glyph" aria-hidden="true">
              {KIND_GLYPH[k]}
            </span>
            {k === 'iot' ? 'IoT' : k}
          </li>
        ))}
      </ul>
      <ul class="legend-rings">
        {(['near', 'mid', 'far', 'onnet'] as const).map((r) => (
          <li key={r}>
            <b>{RING_LABEL[r]}</b> {RING_HINT[r]}
          </li>
        ))}
        <li>
          <span class="swatch fresh" aria-hidden="true" /> new
        </li>
        <li>
          <span class="glyph" aria-hidden="true">
            ✕
          </span>{' '}
          lost
        </li>
      </ul>
      <p class="honesty">
        Rings are signal-strength bands, not metres; any distance is ±50% at best. Bearing (ID°) is a hash of the
        device id and points nowhere. Brightness and jitter show confidence.
      </p>
    </section>
  )
}
