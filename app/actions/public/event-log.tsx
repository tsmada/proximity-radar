import { clientEntry, on, ref, type Handle } from 'remix/component'

import { logStore, type LogLine } from './log-store.ts'

// Terminal-style event log. Lines "type" in via a CSS steps() animation (off under reduced
// motion). Screen readers get a separate, throttled polite announcement instead of every line.
export const EventLog = clientEntry(import.meta.url, function EventLog(handle: Handle) {
  let lines: readonly LogLine[] = []
  let announcement = ''
  let list: HTMLOListElement | undefined
  let pinned = true

  handle.queueTask(() => {
    let off = logStore.subscribe((next, said) => {
      lines = next
      announcement = said
      handle.update()
      handle.queueTask(() => {
        if (list && pinned) list.scrollTop = list.scrollHeight
      })
    })
    handle.signal.addEventListener('abort', off)
  })

  return () => (
    <section class="panel log" aria-labelledby="log-title">
      <h2 id="log-title" class="panel-title">
        EVENT LOG
      </h2>
      <ol
        class="log-lines"
        tabIndex={0}
        aria-label="Event log, newest last"
        mix={[
          ref((node) => {
            list = node
          }),
          on('scroll', (event) => {
            let el = event.currentTarget
            pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 8
          }),
        ]}
      >
        {lines.length === 0 ? (
          <li class="log-line" data-kind="sys">
            <span class="t">--:--:--</span> <span class="x">&gt; AWAITING LINK…</span>
          </li>
        ) : null}
        {lines.map((l) => (
          <li key={l.seq} class="log-line" data-kind={l.kind}>
            <span class="t">{l.time}</span>{' '}
            <span class="x" style={{ '--n': String(l.text.length) }}>
              {l.text}
            </span>
          </li>
        ))}
      </ol>
      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  )
})
