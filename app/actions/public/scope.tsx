import { clientEntry, on, ref, type Handle } from 'remix/component'

import type { Contact } from '../../sensing/types.ts'
import { highlight } from './highlight.ts'
import { prefs } from './prefs.ts'
import { createPinger } from './render/audio.ts'
import { createCrt, type Crt } from './render/crt.glsl.ts'
import {
  KIND_GLYPH,
  RING_LABEL,
  bearingDegrees,
  closeness,
  formatConfidence,
  formatDistance,
  sourceTag,
  type UiContact,
} from './render/geometry.ts'
import { createPhosphor, type Phosphor } from './render/phosphor.ts'
import { streamStore } from './stream-client.ts'

type CrtMode = 'gl' | 'css' | 'off'

const SUMMARY_MS = 5000

export function scopeSummary(contacts: Iterable<Contact>): string {
  let counts = { near: 0, mid: 0, far: 0, onnet: 0 }
  let n = 0
  for (let c of contacts) {
    counts[c.ring]++
    n++
  }
  return (
    `Proximity radar, ${n} contact${n === 1 ? '' : 's'}: ${counts.near} near, ${counts.mid} mid, ` +
    `${counts.far} far, ${counts.onnet} on network only. Rings are rough signal-strength bands; ` +
    `bearing is arbitrary. The contact table has the same information.`
  )
}

export function describeContact(c: UiContact): string {
  return `${c.label}, ${c.kind}, ${RING_LABEL[c.ring]}, ${formatDistance(c)}, source ${sourceTag(c.sources)}, confidence ${formatConfidence(c.confidence)}${c.state === 'stale' ? ', stale' : ''}${c.claimed ? ', claimed as mine' : ''}`
}

export const Scope = clientEntry(
  import.meta.url,
  function Scope(handle: Handle<{ summary: string }>) {
    let summary = handle.props.summary
    let crtMode: CrtMode = 'css'
    let tip: { contact: UiContact; x: number; y: number; flip: boolean } | null = null
    let said = ''
    let radar: Phosphor | undefined
    let tube: HTMLElement | undefined

    function refreshTip() {
      let { id } = highlight.get()
      let c = id ? radar?.contact(id) : undefined
      let pos = id ? radar?.positionOf(id) : null
      let next = c && pos && tube ? { contact: c, x: pos.x, y: pos.y, flip: pos.x > tube.clientWidth / 2 } : null
      if (tip?.contact !== next?.contact || tip?.x !== next?.x || tip?.y !== next?.y) {
        tip = next
        handle.update()
      }
    }

    function step(dir: 1 | -1 | 'first' | 'last') {
      if (!radar) return
      let ids = radar.orderedIds()
      if (ids.length === 0) return
      let cur = highlight.get().id
      let i = cur ? ids.indexOf(cur) : -1
      let next =
        dir === 'first' ? 0 : dir === 'last' ? ids.length - 1 : i < 0 ? (dir === 1 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length
      highlight.set(ids[next], 'scope')
      let c = radar.contact(ids[next])
      if (c) {
        said = `${next + 1} of ${ids.length}: ${describeContact(c)}`
        handle.update()
      }
    }

    handle.queueTask(() => {
      let canvas = document.getElementById('scope') as HTMLCanvasElement | null
      let glCanvas = document.getElementById('scope-crt') as HTMLCanvasElement | null
      if (!canvas || !glCanvas) return
      let pinger = createPinger()
      let crt: Crt | null | undefined
      let audio = false

      let r = createPhosphor(canvas, {
        motion: prefs.get().motion,
        onHit(c) {
          if (audio && c.ring !== 'onnet') pinger.ping(closeness(c))
        },
        onSweep() {
          pinger.newSweep()
        },
        onFrame(now, animating) {
          if (crtMode === 'gl') crt?.render(now, animating)
        },
      })
      radar = r

      let lastSummaryAt = 0
      let summaryTimer: ReturnType<typeof setTimeout> | undefined
      let updateSummary = () => {
        summaryTimer = undefined
        lastSummaryAt = performance.now()
        let next = scopeSummary(streamStore.getState().contacts.values())
        if (next !== summary) {
          summary = next
          handle.update()
        }
      }

      let offStream = streamStore.subscribe((state, event) => {
        if (!event) {
          if (state.contacts.size) r.setAll(state.contacts.values())
        } else if (event.type === 'snapshot') r.setAll(event.contacts)
        else if (event.type === 'upsert') r.upsert(event.contact)
        else if (event.type === 'lost') {
          r.markLost(event.id)
          if (highlight.get().id === event.id) highlight.set(null, 'scope')
        }
        if (!summaryTimer) summaryTimer = setTimeout(updateSummary, Math.max(0, SUMMARY_MS - (performance.now() - lastSummaryAt)))
        if (event?.type === 'upsert' && event.contact.id === highlight.get().id) refreshTip()
      })

      let offPrefs = prefs.subscribe((p) => {
        r.setMotion(p.motion)
        audio = p.audio
        if (audio) pinger.enable()
        else pinger.disable()
        let mode: CrtMode = 'off'
        if (p.crt) {
          if (crt === undefined) crt = createCrt(glCanvas, canvas)
          mode = crt ? 'gl' : 'css'
        }
        if (mode !== crtMode) {
          crtMode = mode
          handle.update()
          r.invalidate()
        }
      })

      let offHighlight = highlight.subscribe((h) => {
        r.setHighlight(h.id)
        refreshTip()
      })

      // The tip is placed in pixels; re-place it when the layout changes (rotation, resize).
      let tipObserver = new ResizeObserver(() => refreshTip())
      let tubeEl = document.getElementById('scope-tube')
      if (tubeEl) tipObserver.observe(tubeEl)

      handle.signal.addEventListener('abort', () => {
        offStream()
        offPrefs()
        offHighlight()
        tipObserver.disconnect()
        clearTimeout(summaryTimer)
        r.destroy()
        crt?.destroy()
        pinger.destroy()
        radar = undefined
      })
    })

    return () => {
      let t = tip
      return (
        <div class="scope">
          <div
            id="scope-tube"
            class="scope-tube"
            data-crt={crtMode}
            tabIndex={0}
            role="group"
            aria-roledescription="radar scope"
            aria-label="Radar scope. Arrow keys step through contacts clockwise, Enter jumps to the table row, Escape clears."
            mix={[
              ref((node) => {
                tube = node
              }),
              on('pointermove', (event) => {
                if (!radar) return
                let rect = event.currentTarget.getBoundingClientRect()
                let id = radar.pick(event.clientX - rect.left, event.clientY - rect.top)
                let cur = highlight.get()
                if (id) highlight.set(id, 'scope')
                else if (cur.id && cur.origin === 'scope') highlight.clear(cur.id, 'scope')
              }),
              on('pointerleave', () => {
                let cur = highlight.get()
                if (cur.id && cur.origin === 'scope') highlight.clear(cur.id, 'scope')
              }),
              on('keydown', (event) => {
                let key = event.key
                if (key === 'ArrowRight' || key === 'ArrowDown') step(1)
                else if (key === 'ArrowLeft' || key === 'ArrowUp') step(-1)
                else if (key === 'Home') step('first')
                else if (key === 'End') step('last')
                else if (key === 'Escape') highlight.set(null, 'scope')
                else if (key === 'Enter') {
                  let id = highlight.get().id
                  let row = id ? document.querySelector<HTMLElement>(`#readout tr[data-id="${CSS.escape(id)}"]`) : null
                  row?.focus()
                } else return
                event.preventDefault()
              }),
            ]}
          >
            <canvas id="scope" role="img" aria-label={summary} />
            <canvas id="scope-crt" aria-hidden="true" />
            <div class="scope-glass" aria-hidden="true" />
            {t ? (
              <div
                class="scope-tip"
                data-flip={t.flip ? 'true' : undefined}
                style={{ left: `${t.x}px`, top: `${t.y}px` }}
                aria-hidden="true"
              >
                <strong>
                  {KIND_GLYPH[t.contact.kind]} {t.contact.label}
                  {t.contact.claimed ? ' ★' : ''}
                </strong>
                <span>
                  {RING_LABEL[t.contact.ring]} · {formatDistance(t.contact)}
                </span>
                <span>
                  {sourceTag(t.contact.sources)} · CONF {formatConfidence(t.contact.confidence)} · {String(bearingDegrees(t.contact.id)).padStart(3, '0')} ID°
                </span>
                {t.contact.state === 'stale' ? <span class="warn">STALE · NOT HEARD RECENTLY</span> : null}
              </div>
            ) : null}
          </div>
          <p class="sr-only" aria-live="polite">
            {said}
          </p>
        </div>
      )
    }
  },
)
