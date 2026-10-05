// Shared "which contact is under the pointer / keyboard focus" state, linking scope blips and
// readout rows in both directions.

export type HighlightOrigin = 'scope' | 'table'
export type Highlight = { id: string | null; origin: HighlightOrigin | null }

type Listener = (h: Highlight) => void

let current: Highlight = { id: null, origin: null }
let listeners = new Set<Listener>()

export const highlight = {
  get(): Highlight {
    return current
  },
  set(id: string | null, origin: HighlightOrigin) {
    if (current.id === id && (id === null || current.origin === origin)) return
    current = { id, origin: id === null ? null : origin }
    for (let fn of listeners) fn(current)
  },
  /** Clear only if `id` is still the highlighted contact (avoids racing pointerleave/enter). */
  clear(id: string, origin: HighlightOrigin) {
    if (current.id === id && current.origin === origin) highlight.set(null, origin)
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
