// Browser-side mirror of the server hub. One shared EventSource for every island.
// Safe to import during SSR: nothing touches `window` until the first subscribe().

import type { CollectorStatus, Contact, StreamEvent } from '../../sensing/types.ts'

export type StreamState = {
  contacts: ReadonlyMap<string, Contact>
  caps: CollectorStatus[]
  connected: boolean
}

/** `event` is the event that caused this notification (undefined for the initial call). */
export type StreamListener = (state: StreamState, event?: StreamEvent) => void

let contacts = new Map<string, Contact>()
let caps: CollectorStatus[] = []
let connected = false
let source: EventSource | undefined
let listeners = new Set<StreamListener>()
let url = '/stream'

function getState(): StreamState {
  return { contacts, caps, connected }
}

function notify(event?: StreamEvent) {
  let state = getState()
  for (let fn of listeners) {
    try {
      fn(state, event)
    } catch (error) {
      console.error('stream listener failed', error)
    }
  }
}

export function apply(event: StreamEvent) {
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
  notify(event)
}

function connect() {
  if (source) return
  source = new EventSource(url)
  source.onopen = () => {
    connected = true
    notify()
  }
  source.onerror = () => {
    // EventSource reconnects by itself; the server re-sends a snapshot on reconnect.
    connected = false
    notify()
  }
  source.onmessage = (e: MessageEvent<string>) => {
    try {
      apply(JSON.parse(e.data) as StreamEvent)
    } catch (error) {
      console.error('bad stream event', error)
    }
  }
}

function disconnect() {
  source?.close()
  source = undefined
  connected = false
}

export const streamStore = {
  /** Override the endpoint (call before the first subscribe). Pass `routes.stream.href()`. */
  configure(opts: { url?: string }) {
    if (opts.url) url = opts.url
  },
  /**
   * Called immediately with the current state, then once per stream event.
   * Upserts can arrive in bursts; batch expensive work (e.g. via requestAnimationFrame).
   */
  subscribe(fn: StreamListener): () => void {
    listeners.add(fn)
    connect()
    fn(getState())
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0) disconnect()
    }
  },
  getState,
}
