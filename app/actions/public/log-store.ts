// Terminal event log (`+ CONTACT`, `x LOST`, sensor changes) plus throttled screen-reader
// announcements. Fed by the shared stream; UI actions can push lines too.

import type { CollectorStatus, Contact, Source, StreamEvent } from '../../sensing/types.ts'
import { KIND_GLYPH, RING_LABEL, formatConfidence, sourceTag } from './render/geometry.ts'
import { streamStore, type StreamState } from './stream-client.ts'

export type LogKind = 'new' | 'lost' | 'sys' | 'warn'
export type LogLine = { seq: number; time: string; kind: LogKind; text: string }

const MAX_LINES = 80
const ANNOUNCE_MS = 5000

type Listener = (lines: readonly LogLine[], announcement: string) => void

/** What the log tracks between events, so `lost` (which only carries an id) can be named. */
export type LogMemory = {
  labels: Map<string, string>
  caps: Map<string, string>
  sources: Map<string, readonly Source[]>
  connected: boolean | undefined
  /** A `lost` held back for one event: if the next upsert grew a contact's sources, it was a merge. */
  pendingLost?: { id: string; label: string | undefined }
}

type Line = { kind: LogKind; text: string; announce?: string }

export function createLogMemory(): LogMemory {
  return { labels: new Map(), caps: new Map(), sources: new Map(), connected: undefined }
}

function lostLine(label: string | undefined, id: string): Line {
  return { kind: 'lost', text: `x LOST    ${(label ?? id).toUpperCase()}`, announce: `Lost ${label ?? 'contact'}` }
}

/** Emit a held-back `lost` as a plain LOST line (no merge followed). */
export function flushPending(memory: LogMemory): Line[] {
  let p = memory.pendingLost
  memory.pendingLost = undefined
  return p ? [lostLine(p.label, p.id)] : []
}

export function contactLine(c: Contact): string {
  return `${c.label.toUpperCase()} ${KIND_GLYPH[c.kind] ?? '?'} ${RING_LABEL[c.ring] ?? c.ring} · ${sourceTag(c.sources)} ${formatConfidence(c.confidence)}`
}

function capLine(c: CollectorStatus): string {
  return `${c.label} [T${c.tier}] ${c.state.toUpperCase()}${c.detail ? ` — ${c.detail}` : ''}`
}

/** Pure: turn one stream event into log lines, updating `memory`. Exported for tests. */
export function describeEvent(
  memory: LogMemory,
  event: StreamEvent,
): Line[] {
  let out: Line[] = []
  let pending = memory.pendingLost
  if (pending) {
    memory.pendingLost = undefined
    let c = event.type === 'upsert' ? event.contact : undefined
    let before = c ? memory.sources.get(c.id) : undefined
    let grew = c && c.state !== 'lost' && before && c.sources.some((s) => !before.includes(s))
    if (grew && c) {
      let from = (pending.label ?? pending.id).toUpperCase()
      out.push({
        kind: 'sys',
        text: `~ MERGED  ${from} → ${c.label.toUpperCase()} · ${sourceTag(c.sources)}`,
        announce: `Merged ${pending.label ?? 'contact'} into ${c.label}`,
      })
    } else {
      out.push(lostLine(pending.label, pending.id))
    }
  }
  let diffCaps = (caps: CollectorStatus[], quiet: boolean) => {
    for (let c of caps) {
      // Only state changes are news; detail strings (host counts, dBm) change constantly.
      let key = c.state
      let before = memory.caps.get(c.id)
      memory.caps.set(c.id, key)
      if (quiet || before === key) continue
      let warn = c.state === 'needs-permission' || c.state === 'error'
      out.push({ kind: warn ? 'warn' : 'sys', text: `* SENSOR ${capLine(c)}` })
    }
  }
  switch (event.type) {
    case 'snapshot': {
      let first = memory.labels.size === 0 && memory.caps.size === 0
      memory.labels = new Map(event.contacts.map((c) => [c.id, c.label]))
      memory.sources = new Map(event.contacts.map((c) => [c.id, c.sources]))
      diffCaps(event.caps, first)
      out.push({ kind: 'sys', text: `> LINK UP · SNAPSHOT ${event.contacts.length} CONTACTS` })
      if (first) {
        for (let c of event.caps) {
          if (c.state === 'needs-permission') out.push({ kind: 'warn', text: `! ${capLine(c)}` })
        }
      }
      break
    }
    case 'upsert': {
      let c = event.contact
      let known = memory.labels.has(c.id)
      if (c.state === 'lost') {
        if (known) {
          memory.labels.delete(c.id)
          memory.sources.delete(c.id)
          out.push(lostLine(c.label, c.id))
        }
        break
      }
      memory.labels.set(c.id, c.label)
      memory.sources.set(c.id, c.sources)
      if (!known) {
        out.push({ kind: 'new', text: `+ CONTACT ${contactLine(c)}`, announce: `New contact ${c.label}, ${RING_LABEL[c.ring]}` })
      }
      break
    }
    case 'lost': {
      // Held back: a merge publishes `lost` for the absorbed id, then the grown target.
      memory.pendingLost = { id: event.id, label: memory.labels.get(event.id) }
      memory.labels.delete(event.id)
      memory.sources.delete(event.id)
      break
    }
    case 'caps':
      diffCaps(event.caps, false)
      break
  }
  return out
}

let lines: LogLine[] = []
let seq = 0
let announcement = ''
let pendingAnnounce: string[] = []
let announceTimer: ReturnType<typeof setTimeout> | undefined
let lastAnnounceAt = 0
let memory = createLogMemory()
let pendingTimer: ReturnType<typeof setTimeout> | undefined
const PENDING_LOST_MS = 300
let listeners = new Set<Listener>()
let offStream: (() => void) | undefined

function clock(): string {
  let d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

// SSE messages often arrive in bursts; coalesce listener calls to one per frame.
let emitQueued = false
function emit() {
  if (emitQueued) return
  emitQueued = true
  requestAnimationFrame(() => {
    emitQueued = false
    for (let fn of listeners) fn(lines, announcement)
  })
}

function flushAnnouncements() {
  announceTimer = undefined
  if (pendingAnnounce.length === 0) return
  let items = pendingAnnounce
  pendingAnnounce = []
  announcement = items.length > 4 ? `${items.slice(0, 3).join('. ')}. And ${items.length - 3} more changes.` : items.join('. ')
  lastAnnounceAt = Date.now()
  emit()
}

function queueAnnouncement(text: string) {
  pendingAnnounce.push(text)
  if (announceTimer) return
  let wait = Math.max(0, ANNOUNCE_MS - (Date.now() - lastAnnounceAt))
  announceTimer = setTimeout(flushAnnouncements, wait)
}

export function pushLog(kind: LogKind, text: string, announce?: string) {
  lines = [...lines.slice(-(MAX_LINES - 1)), { seq: ++seq, time: clock(), kind, text }]
  if (announce) queueAnnouncement(announce)
  emit()
}

function onStream(state: StreamState, event?: StreamEvent) {
  if (!event) {
    if (memory.connected === true && !state.connected) {
      pushLog('warn', '! LINK LOST · RETRYING', 'Connection to sensor server lost, retrying')
    }
    memory.connected = state.connected
    return
  }
  clearTimeout(pendingTimer)
  for (let line of describeEvent(memory, event)) pushLog(line.kind, line.text, line.announce)
  // No follow-up upsert soon after a `lost` → it really was lost.
  if (memory.pendingLost) {
    pendingTimer = setTimeout(() => {
      for (let line of flushPending(memory)) pushLog(line.kind, line.text, line.announce)
    }, PENDING_LOST_MS)
  }
}

export const logStore = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    if (!offStream) offStream = streamStore.subscribe(onStream)
    fn(lines, announcement)
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0) {
        offStream?.()
        offStream = undefined
      }
    }
  },
}
