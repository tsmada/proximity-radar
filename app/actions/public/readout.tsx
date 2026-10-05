import { clientEntry, on, type Handle } from 'remix/component'

import { enhanceSubmit } from './forms.ts'
import { highlight } from './highlight.ts'
import {
  KIND_GLYPH,
  RING_LABEL,
  SWEEP_MS,
  bearingDegrees,
  confidenceMeter,
  formatConfidence,
  formatDistance,
  sortContacts,
  sourceTag,
  type UiContact,
} from './render/geometry.ts'
import { streamStore } from './stream-client.ts'

const RENDER_MS = 500
// Lost rows linger as long as the ghost blip does (3 sweeps), then disappear.
const LOST_ROW_MS = SWEEP_MS * 3

type Row = { contact: UiContact; lostAt?: number }

export const Readout = clientEntry(
  import.meta.url,
  function Readout(handle: Handle<{ initial: UiContact[]; claimHref: string }>) {
    let contacts = new Map(handle.props.initial.map((c) => [c.id, c]))
    let lost = new Map<string, Row>()
    let live = false
    let hl: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    function scheduleRender() {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        let now = Date.now()
        for (let [id, row] of lost) if (now - (row.lostAt ?? 0) > LOST_ROW_MS) lost.delete(id)
        handle.update()
        if (lost.size) scheduleRender()
      }, RENDER_MS)
    }

    handle.queueTask(() => {
      let off = streamStore.subscribe((state, event) => {
        if (event?.type === 'lost' || (event?.type === 'upsert' && event.contact.state === 'lost')) {
          let id = event.type === 'lost' ? event.id : event.contact.id
          let last = contacts.get(id)
          if (last) lost.set(id, { contact: last, lostAt: Date.now() })
        }
        if (event?.type === 'upsert') lost.delete(event.contact.id)
        contacts = new Map(state.contacts)
        live = state.connected
        scheduleRender()
      })
      let offHl = highlight.subscribe((h) => {
        if (h.id === hl) return
        hl = h.id
        handle.update()
        if (h.id && h.origin === 'scope') {
          let id = h.id
          handle.queueTask(() => {
            document.querySelector(`#readout tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
          })
        }
      })
      handle.signal.addEventListener('abort', () => {
        off()
        offHl()
        clearTimeout(timer)
      })
    })

    function focusRow(from: HTMLElement, dir: 1 | -1) {
      let rows = [...(from.closest('tbody')?.querySelectorAll<HTMLElement>('tr[data-id]') ?? [])]
      let i = rows.indexOf(from)
      rows[i + dir]?.focus()
    }

    return () => {
      let { claimHref } = handle.props
      let rows: Row[] = sortContacts(contacts.values()).map((contact) => ({ contact }))
      for (let row of lost.values()) if (!contacts.has(row.contact.id)) rows.push(row)
      let liveRows = rows.filter((r) => r.lostAt === undefined)

      return (
        <div class="readout">
          <table id="readout" data-live={live ? 'true' : undefined} aria-describedby="readout-note">
            <caption>
              <span class="cap-title">CONTACTS</span> <span class="cap-count">{liveRows.length}</span>{' '}
              <span class="cap-link" data-live={live ? 'true' : undefined}>
                {live ? '● LIVE' : '○ LINK…'}
              </span>
            </caption>
            <thead>
              <tr>
                <th scope="col" class="c-glyph">
                  <span class="sr-only">Kind</span>
                  <span aria-hidden="true">⌖</span>
                </th>
                <th scope="col" class="c-label">LABEL</th>
                <th scope="col" class="c-range">RANGE</th>
                <th scope="col" class="c-conf">CONF</th>
                <th scope="col" class="c-src">SRC</th>
                <th scope="col" class="c-state">STATE</th>
                <th scope="col" class="c-id">ID°</th>
                <th scope="col" class="c-mine">
                  <span class="sr-only">Claim</span>MINE
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr class="empty">
                  <td colSpan={8}>NO CONTACTS · LISTENING…</td>
                </tr>
              ) : null}
              {rows.map(({ contact: c, lostAt }) => {
                let state = lostAt !== undefined ? 'lost' : c.state
                let distance = formatDistance(c)
                let rssi = c.rssi === undefined ? '' : ` · ${Math.round(c.rssi)} dBm`
                return (
                  <tr
                    key={c.id}
                    data-id={c.id}
                    data-state={state}
                    data-ring={c.ring}
                    data-hl={hl === c.id ? 'true' : undefined}
                    data-claimed={c.claimed ? 'true' : undefined}
                    tabIndex={lostAt === undefined ? 0 : -1}
                    mix={[
                      on('pointerenter', () => highlight.set(c.id, 'table')),
                      on('pointerleave', () => highlight.clear(c.id, 'table')),
                      on('focusin', () => highlight.set(c.id, 'table')),
                      on('focusout', (event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) highlight.clear(c.id, 'table')
                      }),
                      on('keydown', (event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key === 'ArrowDown') focusRow(event.currentTarget, 1)
                        else if (event.key === 'ArrowUp') focusRow(event.currentTarget, -1)
                        else if (event.key === 'Enter') {
                          // Jump to the scope with this blip still selected.
                          highlight.set(c.id, 'scope')
                          document.getElementById('scope-tube')?.focus()
                        } else return
                        event.preventDefault()
                      }),
                    ]}
                  >
                    <td class="c-glyph">
                      <span aria-hidden="true">{lostAt !== undefined ? '✕' : KIND_GLYPH[c.kind] ?? '?'}</span>
                      <span class="sr-only">{c.kind}</span>
                    </td>
                    <th scope="row" class="c-label">
                      <span class="label">{c.label}</span>
                      {c.claimed ? <span class="tag mine">★ MINE</span> : null}
                      {c.vendor && c.vendor !== c.label ? <span class="sub">{c.vendor}</span> : null}
                      {c.randomizedMac ? <span class="sub">RANDOMIZED ADDR</span> : null}
                    </th>
                    <td class="c-range" title={`${distance}${rssi}`}>
                      {RING_LABEL[c.ring]}
                      <span class="sub">{c.distanceM !== undefined ? distance : c.ring === 'onnet' ? 'NO RSSI' : '—'}</span>
                    </td>
                    <td class="c-conf" title={`Confidence ${formatConfidence(c.confidence)}`}>
                      <span aria-hidden="true" class="meter">
                        {confidenceMeter(c.confidence)}
                      </span>{' '}
                      {formatConfidence(c.confidence)}
                    </td>
                    <td class="c-src">{sourceTag(c.sources)}</td>
                    <td class="c-state">{state.toUpperCase()}</td>
                    <td class="c-id" title={`Hashed id ${c.id}. Bearing is derived from it and means nothing.`}>
                      {String(bearingDegrees(c.id)).padStart(3, '0')}
                    </td>
                    <td class="c-mine">
                      {lostAt === undefined ? (
                        <form method="post" action={claimHref} mix={on('submit', enhanceSubmit)}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="action" value={c.claimed ? 'unclaim' : 'claim'} />
                          <button
                            type="submit"
                            class="btn-mini"
                            aria-pressed={c.claimed ? 'true' : 'false'}
                            aria-label={`Claim ${c.label} as my device`}
                          >
                            {c.claimed ? '★' : '☆'}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p id="readout-note" class="note">
            RANGE = SIGNAL-STRENGTH BAND · DISTANCE ±50% AT BEST · ID° IS A HASH, NOT A DIRECTION
          </p>
          {liveRows.length > 1 ? (
            <form method="post" action={claimHref} class="merge" mix={on('submit', enhanceSubmit)}>
              <input type="hidden" name="action" value="merge" />
              <label>
                <span>MERGE</span>
                <select name="id" required>
                  {liveRows.map(({ contact: c }) => (
                    <option key={c.id} value={c.id}>
                      {c.label} · {sourceTag(c.sources)} · {c.id.slice(0, 4)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>INTO</span>
                <select name="into" required>
                  {liveRows.map(({ contact: c }) => (
                    <option key={c.id} value={c.id}>
                      {c.label} · {sourceTag(c.sources)} · {c.id.slice(0, 4)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" class="btn">
                MERGE
              </button>
            </form>
          ) : null}
        </div>
      )
    }
  },
)
