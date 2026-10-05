// Canvas 2D P7 phosphor PPI renderer. Runs its own requestAnimationFrame loop outside the
// component render path; the Scope island only feeds it contacts and preferences.
//
// Phosphor model: P7 has a fast blue-white fluorescence and a slow yellow-green afterglow.
// Each time the beam crosses a blip we record a "paint" (position + time + gain); every frame
// draws all live paints with two exponential decays. Computing the decay analytically (instead
// of repeatedly fading a persistent bitmap) avoids the 8-bit rounding residue that leaves
// permanent smears, and lets moving contacts leave a short trail of older, dimmer paints.

import type { Contact } from '../../../sensing/types.ts'
import {
  RING_BANDS,
  RING_LABEL,
  SWEEP_MS,
  beamAngle,
  bearingFor,
  brightnessFor,
  clamp01,
  crossed,
  polar,
  radiusFor,
  type UiContact,
} from './geometry.ts'
import { createSpriteCache, withAlpha, type SpriteKind } from './sprites.ts'

export const PALETTE = {
  bg: '#050A06',
  bezel: '#11160F',
  ring: '#1F4D2B',
  glow: '#7CFF4F',
  trail: '#3FA34D',
  flash: '#D8FFF0',
  fresh: '#C4E4FF', // blue-white for new contacts
  warn: '#FFB000',
  text: '#9DFFB0',
  dim: '#4F7F5A',
} as const

const TAU_FLASH = 110 // ms, blue-white fluorescence
const TAU_GLOW = 650 // ms, bright green
const TAU_TRAIL = 2600 // ms, long green afterglow (still faintly visible a full sweep later)
const NEW_RING_MS = 1600
const NEW_HOT_MS = 6000
const GHOST_PASSES = [0.55, 0.32, 0.14] // lost contacts: decays over 3 sweeps
const STATIC_GHOST_MS = 12_000
const MAX_PAINTS = 3
const DPR_CAP = 2

type Paint = { x: number; y: number; t: number; gain: number; hot: boolean }

type Blip = {
  id: string
  contact: UiContact
  theta: number
  frac: number
  paints: Paint[]
  newAt?: number
  ghost?: { at: number; passes: number }
}

export type PhosphorOptions = {
  motion: boolean
  sweepMs?: number
  /** Beam crossed a live contact. */
  onHit?: (c: Contact) => void
  /** Beam passed ID° 000. */
  onSweep?: () => void
  /** Called after each frame is drawn (CRT post-pass hook). */
  onFrame?: (now: number, animating: boolean) => void
}

export type Phosphor = ReturnType<typeof createPhosphor>

export function createPhosphor(canvas: HTMLCanvasElement, options: PhosphorOptions) {
  let ctx = canvas.getContext('2d', { alpha: false })!
  let sprites = createSpriteCache()
  let blips = new Map<string, Blip>()
  let motion = options.motion
  let sweepMs = options.sweepMs ?? SWEEP_MS
  let highlighted: string | null = null

  // Geometry in backing-store pixels.
  let dpr = 1
  let size = 0
  let cx = 0
  let cy = 0
  let R = 0
  let blipPx = 5

  let staticLayer: HTMLCanvasElement | OffscreenCanvas | undefined
  let litLayer: HTMLCanvasElement | OffscreenCanvas | undefined
  let beamLayer: HTMLCanvasElement | OffscreenCanvas | undefined

  let t0 = performance.now()
  let prevAngle = 0
  let raf = 0
  let dirty = true
  let destroyed = false
  let staticTimer: ReturnType<typeof setTimeout> | undefined

  // ── Layers ────────────────────────────────────────────────────────────────

  function layer(): HTMLCanvasElement | OffscreenCanvas {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size)
    let c = document.createElement('canvas')
    c.width = c.height = size
    return c
  }

  function font(px: number, family = '"Share Tech Mono", ui-monospace, monospace') {
    return `${Math.round(px)}px ${family}`
  }

  function graticule(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, color: string, lit: boolean) {
    g.save()
    g.translate(cx, cy)
    g.strokeStyle = color
    g.lineWidth = Math.max(1, dpr * (lit ? 1.4 : 1))

    // Range rings at the outer edge of each band; ON-NET is a dashed band centre line.
    for (let ring of ['near', 'mid', 'far'] as const) {
      g.beginPath()
      g.arc(0, 0, RING_BANDS[ring][1] * R, 0, Math.PI * 2)
      g.stroke()
    }
    g.save()
    g.setLineDash([3 * dpr, 5 * dpr])
    g.beginPath()
    g.arc(0, 0, ((RING_BANDS.onnet[0] + RING_BANDS.onnet[1]) / 2) * R, 0, Math.PI * 2)
    g.stroke()
    g.restore()
    g.beginPath()
    g.arc(0, 0, R, 0, Math.PI * 2)
    g.lineWidth = Math.max(1, dpr * 1.5)
    g.stroke()

    // Spokes every 30° ID.
    g.lineWidth = Math.max(1, dpr * 0.8)
    g.globalAlpha = lit ? 0.7 : 0.55
    for (let a = 0; a < 360; a += 30) {
      let r = (a * Math.PI) / 180
      let s = Math.sin(r)
      let c = -Math.cos(r)
      g.beginPath()
      g.moveTo(s * R * RING_BANDS.near[0], c * R * RING_BANDS.near[0])
      g.lineTo(s * R, c * R)
      g.stroke()
    }
    g.globalAlpha = 1

    // Bearing ticks: 2° minor, 10° medium, 30° major.
    for (let a = 0; a < 360; a += 2) {
      let len = a % 30 === 0 ? 0.06 : a % 10 === 0 ? 0.035 : 0.016
      let r = (a * Math.PI) / 180
      let s = Math.sin(r)
      let c = -Math.cos(r)
      g.lineWidth = Math.max(1, dpr * (a % 10 === 0 ? 1.1 : 0.8))
      g.beginPath()
      g.moveTo(s * R * (1 - len), c * R * (1 - len))
      g.lineTo(s * R, c * R)
      g.stroke()
    }
    g.restore()
  }

  function buildLayers() {
    staticLayer = layer()
    litLayer = layer()
    beamLayer = layer()
    let s = staticLayer.getContext('2d') as CanvasRenderingContext2D
    let half = size / 2

    // Page background everywhere (the canvas is opaque so the CRT pass can sample it directly).
    s.fillStyle = PALETTE.bg
    s.fillRect(0, 0, size, size)

    // Bezel: a dark metal annulus with a lip.
    let bezelR = half * 0.985
    let bezel = s.createRadialGradient(cx, cy, R, cx, cy, bezelR)
    bezel.addColorStop(0, '#0b0f0a')
    bezel.addColorStop(0.35, PALETTE.bezel)
    bezel.addColorStop(1, '#0a0d09')
    s.fillStyle = bezel
    s.beginPath()
    s.arc(cx, cy, bezelR, 0, Math.PI * 2)
    s.fill()
    s.strokeStyle = 'rgba(157,255,176,0.06)'
    s.lineWidth = dpr
    s.stroke()

    // Tube face: slightly lighter, greenish-grey centre like an unlit P7 screen.
    let face = s.createRadialGradient(cx, cy, 0, cx, cy, R)
    face.addColorStop(0, '#0b170d')
    face.addColorStop(0.7, '#071009')
    face.addColorStop(1, '#040805')
    s.fillStyle = face
    s.beginPath()
    s.arc(cx, cy, R + dpr, 0, Math.PI * 2)
    s.fill()

    graticule(s, PALETTE.ring, false)

    // Bearing labels in the bezel. Bearing is a hash of the device id, so ticks read ID°.
    let fpx = Math.max(9 * dpr, Math.min(13 * dpr, half * 0.034))
    s.font = font(fpx)
    s.textAlign = 'center'
    s.textBaseline = 'middle'
    for (let a = 0; a < 360; a += 30) {
      let r = (a * Math.PI) / 180
      let lr = (R + bezelR) / 2
      s.fillStyle = a === 0 ? PALETTE.text : PALETTE.dim
      s.fillText(a === 0 ? '000 ID°' : String(a).padStart(3, '0'), cx + Math.sin(r) * lr, cy - Math.cos(r) * lr)
    }

    // Ring labels just above each ring, right of the 000 spoke.
    s.textAlign = 'left'
    s.textBaseline = 'bottom'
    s.font = font(fpx * 0.92)
    s.fillStyle = PALETTE.dim
    for (let ring of ['near', 'mid', 'far', 'onnet'] as const) {
      let fr = ring === 'onnet' ? (RING_BANDS.onnet[0] + RING_BANDS.onnet[1]) / 2 : RING_BANDS[ring][1]
      s.fillText(RING_LABEL[ring], cx + 4 * dpr, cy - fr * R - 2 * dpr)
    }

    // Corner captions (outside the tube): what the axes really mean.
    s.font = font(fpx * 0.9)
    s.fillStyle = PALETTE.dim
    let m = 8 * dpr
    s.textBaseline = 'top'
    s.textAlign = 'left'
    s.fillText('PPI · P7', m, m)
    s.textAlign = 'right'
    s.fillText('BRG ID° = HASH', size - m, m)
    s.textBaseline = 'bottom'
    s.textAlign = 'left'
    s.fillText('RNG = SIGNAL', m, size - m)
    s.textAlign = 'right'
    s.fillText('NOT TO SCALE', size - m, size - m)

    // This device at the centre.
    s.strokeStyle = withAlpha(PALETTE.glow, 0.75)
    s.lineWidth = Math.max(1, dpr * 1.2)
    s.beginPath()
    s.arc(cx, cy, 3.5 * dpr, 0, Math.PI * 2)
    s.moveTo(cx - 9 * dpr, cy)
    s.lineTo(cx - 5 * dpr, cy)
    s.moveTo(cx + 5 * dpr, cy)
    s.lineTo(cx + 9 * dpr, cy)
    s.moveTo(cx, cy - 9 * dpr)
    s.lineTo(cx, cy - 5 * dpr)
    s.moveTo(cx, cy + 5 * dpr)
    s.lineTo(cx, cy + 9 * dpr)
    s.stroke()
    s.textAlign = 'center'
    s.textBaseline = 'top'
    s.font = font(fpx * 0.8)
    s.fillStyle = PALETTE.dim
    s.fillText('THIS DEVICE', cx, cy + 11 * dpr)

    let l = litLayer.getContext('2d') as CanvasRenderingContext2D
    graticule(l, PALETTE.glow, true)
  }

  function resize() {
    let rect = canvas.getBoundingClientRect()
    let css = Math.max(1, Math.floor(Math.min(rect.width, rect.height || rect.width)))
    let nextDpr = Math.min(DPR_CAP, window.devicePixelRatio || 1)
    let nextSize = Math.round(css * nextDpr)
    if (nextSize === size && nextDpr === dpr && staticLayer) return
    dpr = nextDpr
    size = nextSize
    canvas.width = canvas.height = size
    cx = cy = size / 2
    R = (size / 2) * 0.86
    blipPx = Math.max(3.5 * dpr, Math.min(7 * dpr, R / 55))
    sprites.clear()
    buildLayers()
    dirty = true
    if (!motion) drawStatic()
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  function place(b: Blip, c: UiContact) {
    b.contact = c
    b.theta = bearingFor(c.id)
    b.frac = radiusFor(c)
  }

  function paint(b: Blip, now: number, gain: number, hot: boolean, jitter: boolean) {
    let p = polar(b.theta, b.frac)
    if (jitter) {
      // Low confidence → the blip lands somewhere slightly different each sweep.
      let j = (1 - clamp01(b.contact.confidence)) * 0.022
      p.x += (Math.random() - 0.5) * 2 * j
      p.y += (Math.random() - 0.5) * 2 * j
    }
    b.paints.push({ x: p.x, y: p.y, t: now, gain, hot })
    if (b.paints.length > MAX_PAINTS) b.paints.shift()
  }

  /** Initial snapshot / reconnect: contacts that vanished become ghosts, none flash. */
  function setAll(contacts: Iterable<UiContact>) {
    let now = performance.now()
    let seen = new Set<string>()
    for (let c of contacts) {
      seen.add(c.id)
      upsert(c, false)
    }
    for (let [id, b] of blips) if (!seen.has(id) && !b.ghost) b.ghost = { at: now, passes: 0 }
    dirty = true
  }

  function upsert(c: UiContact, announce = true) {
    if (c.state === 'lost') return markLost(c.id)
    let now = performance.now()
    let b = blips.get(c.id)
    if (!b || b.ghost) {
      b = { id: c.id, contact: c, theta: 0, frac: 0, paints: b?.paints ?? [] }
      place(b, c)
      blips.set(c.id, b)
      if (announce || c.state === 'new') {
        b.newAt = now
        // Flash immediately rather than waiting up to a full sweep for the beam.
        paint(b, now, 1.25, true, false)
      } else if (motion) {
        paint(b, now - beamLagMs(b.theta), brightnessFor(c), false, false)
      }
    } else {
      place(b, c)
    }
    dirty = true
  }

  /** How long ago the beam last crossed `theta` (so first paint looks like it's been decaying). */
  function beamLagMs(theta: number): number {
    let a = beamAngle(performance.now() - t0, sweepMs)
    let lag = a - theta
    if (lag < 0) lag += Math.PI * 2
    return (lag / (Math.PI * 2)) * sweepMs
  }

  function markLost(id: string) {
    let b = blips.get(id)
    if (!b || b.ghost) return
    b.ghost = { at: performance.now(), passes: 0 }
    b.newAt = undefined
    dirty = true
    if (!motion) scheduleStatic()
  }

  // ── Frame ─────────────────────────────────────────────────────────────────

  function drawSprite(kind: SpriteKind, color: string, x: number, y: number, alpha: number, px = blipPx) {
    if (alpha <= 0.004) return
    let sp = sprites.get(kind, color, px)
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.drawImage(sp.canvas, x - sp.half, y - sp.half)
  }

  function drawBeam(angle: number) {
    let tail = 0.42
    let start = angle - Math.PI / 2 - tail * Math.PI * 2
    let stops: Array<[number, number]> = [
      [0, 0],
      [tail * 0.45, 0.012],
      [tail - 0.085, 0.06],
      [tail - 0.02, 0.15],
      [tail, 0.32],
      [tail + 0.0008, 0],
      [1, 0],
    ]

    // Lit graticule: the beam excites the range rings and ticks as it passes.
    let bl = beamLayer!.getContext('2d') as CanvasRenderingContext2D
    bl.globalCompositeOperation = 'source-over'
    bl.clearRect(0, 0, size, size)
    let mask = bl.createConicGradient(start, cx, cy)
    for (let [f, a] of stops) mask.addColorStop(f, `rgba(0,0,0,${Math.min(1, a * 2.6)})`)
    bl.fillStyle = mask
    bl.beginPath()
    bl.arc(cx, cy, R + dpr, 0, Math.PI * 2)
    bl.fill()
    bl.globalCompositeOperation = 'source-in'
    bl.drawImage(litLayer!, 0, 0)

    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 1
    ctx.drawImage(beamLayer!, 0, 0)

    // Phosphor glow of the wedge itself.
    let glow = ctx.createConicGradient(start, cx, cy)
    for (let [f, a] of stops) glow.addColorStop(f, withAlpha(PALETTE.glow, a * 0.55))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    // Leading edge.
    let ex = cx + Math.sin(angle) * R
    let ey = cy - Math.cos(angle) * R
    ctx.lineCap = 'round'
    ctx.strokeStyle = withAlpha(PALETTE.glow, 0.22)
    ctx.lineWidth = 5 * dpr
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(ex, ey)
    ctx.stroke()
    ctx.strokeStyle = withAlpha(PALETTE.flash, 0.75)
    ctx.lineWidth = 1.3 * dpr
    ctx.stroke()
  }

  function drawPaint(b: Blip, p: Paint, now: number) {
    let age = now - p.t
    if (age < 0) return true
    let flash = p.gain * Math.exp(-age / TAU_FLASH) * (p.hot ? 1.5 : 0.85)
    let glow = p.gain * Math.exp(-age / TAU_GLOW)
    let trail = p.gain * Math.exp(-age / TAU_TRAIL) * 0.85
    if (trail < 0.01 && flash < 0.01) return false
    let x = cx + p.x * R
    let y = cy + p.y * R
    let kind: SpriteKind = b.ghost ? 'cross' : b.contact.kind
    drawSprite('halo', PALETTE.glow, x, y, glow * 0.22 + trail * 0.08)
    drawSprite(kind, PALETTE.trail, x, y, trail)
    drawSprite(kind, PALETTE.glow, x, y, glow)
    drawSprite(kind, p.hot ? PALETTE.fresh : PALETTE.flash, x, y, flash)
    return true
  }

  function drawNewRing(b: Blip, now: number) {
    if (b.newAt === undefined) return
    let k = (now - b.newAt) / NEW_RING_MS
    if (!motion) k = 0.45
    if (k > 1.3) return
    let p = polar(b.theta, b.frac)
    let x = cx + p.x * R
    let y = cy + p.y * R
    ctx.lineWidth = 1.4 * dpr
    for (let lag of [0, 0.28]) {
      let kk = k - lag
      if (kk < 0 || kk > 1) continue
      ctx.globalAlpha = Math.pow(1 - kk, 1.6) * 0.9
      ctx.strokeStyle = PALETTE.fresh
      ctx.beginPath()
      ctx.arc(x, y, blipPx * (1.2 + kk * 6), 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  function drawOverlay(b: Blip) {
    let p = polar(b.theta, b.frac)
    let x = cx + p.x * R
    let y = cy + p.y * R
    ctx.globalCompositeOperation = 'source-over'
    if (b.contact.claimed && !b.ghost) {
      ctx.globalAlpha = 0.55
      ctx.strokeStyle = PALETTE.text
      ctx.lineWidth = dpr
      ctx.setLineDash([2 * dpr, 2 * dpr])
      ctx.beginPath()
      ctx.arc(x, y, blipPx * 2.1, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (b.id === highlighted) {
      let s = blipPx * 2.6
      let c = s * 0.45
      ctx.globalAlpha = 1
      ctx.strokeStyle = PALETTE.text
      ctx.lineWidth = 1.4 * dpr
      ctx.beginPath()
      for (let [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(x + sx * s, y + sy * (s - c))
        ctx.lineTo(x + sx * s, y + sy * s)
        ctx.lineTo(x + sx * (s - c), y + sy * s)
      }
      ctx.stroke()
    }
  }

  function frame(now: number) {
    raf = 0
    if (destroyed) return
    if (!size) resize()
    let angle = beamAngle(now - t0, sweepMs)
    if (angle < prevAngle) options.onSweep?.()

    for (let b of blips.values()) {
      if (!crossed(prevAngle, angle, b.theta)) continue
      if (b.ghost) {
        let gain = GHOST_PASSES[b.ghost.passes++]
        if (gain === undefined) blips.delete(b.id)
        else paint(b, now, gain, false, false)
        continue
      }
      paint(b, now, brightnessFor(b.contact), b.newAt !== undefined && now - b.newAt < NEW_HOT_MS, true)
      if (b.contact.state !== 'stale') options.onHit?.(b.contact)
    }
    prevAngle = angle

    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.drawImage(staticLayer!, 0, 0)
    drawBeam(angle)

    ctx.globalCompositeOperation = 'lighter'
    for (let b of blips.values()) {
      b.paints = b.paints.filter((p) => drawPaint(b, p, now))
      drawNewRing(b, now)
      if (b.newAt !== undefined && now - b.newAt > NEW_HOT_MS) b.newAt = undefined
    }
    for (let b of blips.values()) drawOverlay(b)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    options.onFrame?.(now, true)
    schedule()
  }

  /** Reduced motion: a still image of every contact at constant brightness. Redrawn on change. */
  function drawStatic() {
    if (destroyed || !staticLayer) return
    let now = performance.now()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.drawImage(staticLayer, 0, 0)
    ctx.globalCompositeOperation = 'lighter'
    for (let b of blips.values()) {
      if (b.ghost && now - b.ghost.at > STATIC_GHOST_MS) {
        blips.delete(b.id)
        continue
      }
      let p = polar(b.theta, b.frac)
      let x = cx + p.x * R
      let y = cy + p.y * R
      if (b.ghost) {
        drawSprite('cross', PALETTE.trail, x, y, 0.45)
        continue
      }
      let gain = brightnessFor(b.contact)
      drawSprite('halo', PALETTE.glow, x, y, gain * 0.18)
      drawSprite(b.contact.kind, PALETTE.trail, x, y, gain * 0.6)
      drawSprite(b.contact.kind, b.newAt !== undefined ? PALETTE.fresh : PALETTE.glow, x, y, gain * 0.85)
      drawNewRing(b, now)
    }
    for (let b of blips.values()) drawOverlay(b)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    dirty = false
    options.onFrame?.(now, false)
  }

  function scheduleStatic() {
    // Ghosts and "new" markers expire on a timer when nothing animates.
    clearTimeout(staticTimer)
    staticTimer = setTimeout(() => {
      for (let b of blips.values()) if (b.newAt !== undefined && performance.now() - b.newAt > NEW_HOT_MS) b.newAt = undefined
      invalidate()
      if ([...blips.values()].some((b) => b.ghost || b.newAt !== undefined)) scheduleStatic()
    }, 2000)
  }

  function schedule() {
    if (destroyed || raf || document.hidden) return
    if (motion) raf = requestAnimationFrame(frame)
  }

  let pendingStatic = 0
  function invalidate() {
    dirty = true
    if (motion || destroyed || pendingStatic) return
    pendingStatic = requestAnimationFrame(() => {
      pendingStatic = 0
      drawStatic()
    })
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      raf = 0
    } else {
      // Don't fire a burst of hits for the time we were hidden.
      prevAngle = beamAngle(performance.now() - t0, sweepMs)
      if (motion) schedule()
      else invalidate()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  let observer = new ResizeObserver(() => {
    resize()
    invalidate()
  })
  observer.observe(canvas)
  resize()
  prevAngle = beamAngle(performance.now() - t0, sweepMs)
  if (motion) schedule()
  else invalidate()

  // Fonts arrive after first paint; rebuild labels and the '?' sprite once they're ready.
  document.fonts?.ready.then(() => {
    if (destroyed) return
    sprites.clear()
    if (size) buildLayers()
    invalidate()
  })

  function displayPos(b: Blip): { x: number; y: number } {
    let p = polar(b.theta, b.frac)
    return { x: (cx + p.x * R) / dpr, y: (cy + p.y * R) / dpr }
  }

  return {
    setAll,
    upsert(c: UiContact) {
      upsert(c, true)
      if (!motion) {
        invalidate()
        if (blips.get(c.id)?.newAt !== undefined) scheduleStatic()
      }
    },
    markLost(id: string) {
      markLost(id)
      invalidate()
    },
    setHighlight(id: string | null) {
      highlighted = id
      invalidate()
    },
    setMotion(on: boolean) {
      if (on === motion) return
      motion = on
      if (motion) {
        prevAngle = beamAngle(performance.now() - t0, sweepMs)
        schedule()
      } else {
        cancelAnimationFrame(raf)
        raf = 0
        invalidate()
        scheduleStatic()
      }
    },
    /** Force a redraw (e.g. CRT toggled while static). */
    invalidate,
    /** Nearest live contact within `radius` CSS px of a point in canvas CSS coordinates. */
    pick(x: number, y: number, radius = 16): string | null {
      let best: string | null = null
      let bestD = radius * radius
      for (let b of blips.values()) {
        if (b.ghost) continue
        let p = displayPos(b)
        let d = (p.x - x) ** 2 + (p.y - y) ** 2
        if (d <= bestD) {
          bestD = d
          best = b.id
        }
      }
      return best
    },
    /** Blip position in canvas CSS pixels. */
    positionOf(id: string): { x: number; y: number } | null {
      let b = blips.get(id)
      return b ? displayPos(b) : null
    },
    /** Live contact ids in bearing order (keyboard navigation goes clockwise). */
    orderedIds(): string[] {
      return [...blips.values()]
        .filter((b) => !b.ghost)
        .sort((a, b) => a.theta - b.theta || a.frac - b.frac)
        .map((b) => b.id)
    },
    contact(id: string): UiContact | undefined {
      let b = blips.get(id)
      return b && !b.ghost ? b.contact : undefined
    },
    get canvas() {
      return canvas
    },
    get dirty() {
      return dirty
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pendingStatic)
      clearTimeout(staticTimer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
