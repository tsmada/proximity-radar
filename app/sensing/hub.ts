import type { CollectorStatus, Contact, StreamEvent } from './types.ts'

export type Hub = {
  /** Listen to every published event. Returns an unsubscribe function. */
  subscribe(fn: (event: StreamEvent) => void): () => void
  /** Current contacts (lost ones are already removed). */
  snapshot(): Contact[]
  /** Current collector statuses. */
  caps(): CollectorStatus[]
  /** Apply an event to hub state and fan it out to subscribers. */
  publish(event: StreamEvent): void
}

/**
 * The hub mirrors exactly what browsers see: it folds published events into
 * its own state so a new SSE connection can be sent a consistent snapshot.
 */
export function createHub(): Hub {
  let target = new EventTarget()
  let contacts = new Map<string, Contact>()
  let caps: CollectorStatus[] = []

  return {
    subscribe(fn) {
      // Node rethrows EventTarget listener errors as uncaught exceptions, so one
      // broken subscriber (e.g. a closed SSE stream) must not take the server down.
      let listener = (e: Event) => {
        try {
          fn((e as CustomEvent<StreamEvent>).detail)
        } catch (error) {
          console.error('hub subscriber failed', error)
        }
      }
      target.addEventListener('event', listener)
      return () => target.removeEventListener('event', listener)
    },
    snapshot: () => [...contacts.values()],
    caps: () => caps,
    publish(event) {
      switch (event.type) {
        case 'snapshot':
          contacts = new Map(event.contacts.map((c) => [c.id, c]))
          caps = event.caps
          break
        case 'upsert':
          contacts.set(event.contact.id, event.contact)
          break
        case 'lost':
          contacts.delete(event.id)
          break
        case 'caps':
          caps = event.caps
          break
      }
      target.dispatchEvent(new CustomEvent('event', { detail: event }))
    },
  }
}
