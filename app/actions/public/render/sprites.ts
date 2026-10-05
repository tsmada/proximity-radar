// Pre-rendered glow sprites for blip glyphs. Drawing shadowBlur'd paths every frame is the
// expensive part of a phosphor scope, so each (kind, colour, size) is rasterised once.

import type { DeviceKind } from '../../../sensing/types.ts'

export type Sprite = { canvas: HTMLCanvasElement | OffscreenCanvas; half: number }

export type SpriteKind = DeviceKind | 'halo' | 'cross'

function makeCanvas(size: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size)
  let c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

function glyphPath(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, kind: SpriteKind, s: number) {
  ctx.beginPath()
  switch (kind) {
    case 'phone': // ◆
      ctx.moveTo(0, -s)
      ctx.lineTo(s * 0.8, 0)
      ctx.lineTo(0, s)
      ctx.lineTo(-s * 0.8, 0)
      ctx.closePath()
      break
    case 'laptop': // ■
      ctx.rect(-s * 0.72, -s * 0.72, s * 1.44, s * 1.44)
      break
    case 'router': {
      // ✚
      let t = s * 0.34
      ctx.rect(-s, -t, s * 2, t * 2)
      ctx.rect(-t, -s, t * 2, s * 2)
      break
    }
    case 'media': // ▲
      ctx.moveTo(0, -s)
      ctx.lineTo(s * 0.95, s * 0.75)
      ctx.lineTo(-s * 0.95, s * 0.75)
      ctx.closePath()
      break
    case 'iot': // ●
      ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2)
      break
    case 'printer': // ▬
      ctx.rect(-s * 1.05, -s * 0.42, s * 2.1, s * 0.84)
      break
    case 'cross': {
      // ✕ for lost ghosts
      let t = s * 0.22
      ctx.save()
      ctx.rotate(Math.PI / 4)
      ctx.rect(-s * 1.1, -t, s * 2.2, t * 2)
      ctx.rect(-t, -s * 1.1, t * 2, s * 2.2)
      ctx.restore()
      break
    }
    default:
      break
  }
}

export function createSpriteCache() {
  let cache = new Map<string, Sprite>()

  function build(kind: SpriteKind, color: string, px: number): Sprite {
    let s = Math.max(2, px)
    let half = Math.ceil(s * 3.2)
    let canvas = makeCanvas(half * 2)
    let ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) return { canvas, half }
    ctx.translate(half, half)
    if (kind === 'halo') {
      let g = ctx.createRadialGradient(0, 0, 0, 0, 0, half)
      g.addColorStop(0, color)
      g.addColorStop(0.25, withAlpha(color, 0.35))
      g.addColorStop(1, withAlpha(color, 0))
      ctx.fillStyle = g
      ctx.fillRect(-half, -half, half * 2, half * 2)
      return { canvas, half }
    }
    ctx.fillStyle = color
    ctx.shadowColor = color
    if (kind === 'unknown') {
      ctx.font = `bold ${Math.round(s * 2.3)}px "Share Tech Mono", ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowBlur = s * 1.4
      ctx.fillText('?', 0, s * 0.08)
      ctx.shadowBlur = 0
      ctx.fillText('?', 0, s * 0.08)
      return { canvas, half }
    }
    glyphPath(ctx, kind, s)
    ctx.shadowBlur = s * 1.4
    ctx.fill('nonzero')
    ctx.shadowBlur = s * 0.5
    ctx.fill('nonzero')
    ctx.shadowBlur = 0
    ctx.fill('nonzero')
    return { canvas, half }
  }

  return {
    get(kind: SpriteKind, color: string, px: number): Sprite {
      let key = `${kind}|${color}|${px.toFixed(1)}`
      let sprite = cache.get(key)
      if (!sprite) cache.set(key, (sprite = build(kind, color, px)))
      return sprite
    },
    clear() {
      cache.clear()
    },
  }
}

/** `#RRGGBB` + alpha → `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  let n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
