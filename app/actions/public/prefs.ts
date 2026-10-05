// Per-browser display preferences (MOTION / CRT FX / AUDIO). SSR-safe: islands render the
// defaults on first paint and only read storage / media queries after hydration (init()).

export type Prefs = {
  motion: boolean
  crt: boolean
  audio: boolean
}

export const DEFAULT_PREFS: Prefs = { motion: true, crt: true, audio: false }

const KEY = 'phosphor.prefs'

type Listener = (prefs: Prefs) => void

let current: Prefs = { ...DEFAULT_PREFS }
// Only explicit user choices are stored, so the OS reduced-motion setting keeps working.
let explicit: Partial<Prefs> = {}
let listeners = new Set<Listener>()
let initialised = false
let reduceQuery: MediaQueryList | undefined

function compute(): Prefs {
  let systemReduce = reduceQuery?.matches ?? false
  return {
    motion: explicit.motion ?? !systemReduce,
    crt: explicit.crt ?? DEFAULT_PREFS.crt,
    // Audio is never restored from storage: it needs a fresh user gesture each visit.
    audio: explicit.audio ?? false,
  }
}

function publish() {
  current = compute()
  let root = document.documentElement
  // CSS keys animations off this (the Scope island owns data-crt, since only it knows about WebGL).
  root.dataset.motion = current.motion ? 'on' : 'off'
  for (let fn of listeners) {
    try {
      fn(current)
    } catch (error) {
      console.error('prefs listener failed', error)
    }
  }
}

function init() {
  if (initialised || typeof window === 'undefined') return
  initialised = true
  try {
    let raw = window.localStorage.getItem(KEY)
    if (raw) {
      let parsed = JSON.parse(raw) as Partial<Prefs>
      if (typeof parsed.motion === 'boolean') explicit.motion = parsed.motion
      if (typeof parsed.crt === 'boolean') explicit.crt = parsed.crt
    }
  } catch {}
  reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  reduceQuery?.addEventListener('change', publish)
  current = compute()
}

export const prefs = {
  get(): Prefs {
    return current
  },
  /** Call from a user gesture when turning audio on (AudioContext needs one). */
  set(patch: Partial<Prefs>) {
    init()
    explicit = { ...explicit, ...patch }
    try {
      let { motion, crt } = explicit
      window.localStorage.setItem(KEY, JSON.stringify({ motion, crt }))
    } catch {}
    publish()
  },
  /** Browser only. Called immediately with the current prefs. */
  subscribe(fn: Listener): () => void {
    let first = !initialised
    init()
    listeners.add(fn)
    if (first) publish()
    else fn(current)
    return () => listeners.delete(fn)
  },
  /** True when the OS asks for reduced motion (regardless of the MOTION toggle). */
  systemReducedMotion(): boolean {
    return reduceQuery?.matches ?? false
  },
}
