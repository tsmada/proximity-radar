import { createArpCollector } from './collectors/arp.ts'
import { createBleCollector } from './collectors/ble.ts'
import { createMdnsCollector } from './collectors/mdns.ts'
import { createSimCollector } from './collectors/sim.ts'
import { createSsdpCollector } from './collectors/ssdp.ts'
import { createStationCollector } from './collectors/station.ts'
import { createFusion, type Fusion } from './fusion.ts'
import { createHub, type Hub } from './hub.ts'
import type { Collector, CollectorHealth, CollectorStatus } from './types.ts'

// ── Collectors ────────────────────────────────────────────────────────────
// To add a data source, append one line here. Order = status-bar order.
export const collectors: Collector[] = [
  createSimCollector(),
  createBleCollector(),
  createArpCollector(),
  createMdnsCollector(),
  createSsdpCollector(),
  createStationCollector(),
]

/** 'auto' runs the sim collector only while no live collector is enabled and available. */
export type DemoMode = 'auto' | 'on' | 'off'

export type Settings = {
  demo: DemoMode
  /** User on/off per collector id (the sim collector is driven by `demo` instead). */
  enabled: Record<string, boolean>
}

export type Registry = {
  /** Probe every collector and start the ones that should run. Idempotent. */
  start(): Promise<void>
  /** Stop everything (server shutdown, tests). */
  stop(): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  setDemo(mode: DemoMode): Promise<void>
  statuses(): CollectorStatus[]
  settings(): Settings
}

export const SIM_ID = 'sim'

type Entry = {
  collector: Collector
  enabled: boolean
  health: CollectorHealth
  running?: AbortController
}

export function createRegistry(opts: {
  hub: Hub
  fusion: Fusion
  collectors: Collector[]
  tickMs?: number
}): Registry {
  let { hub, fusion } = opts
  let demo: DemoMode = 'auto'
  let started = false
  let ticker: ReturnType<typeof setInterval> | undefined
  let entries = new Map<string, Entry>(
    opts.collectors.map((c) => [
      c.id,
      { collector: c, enabled: c.defaultEnabled, health: { state: 'available' } },
    ]),
  )

  // Serialise reconciles so concurrent setting changes can't double-start a collector.
  let queue: Promise<void> = Promise.resolve()
  function schedule(): Promise<void> {
    queue = queue.then(reconcile).catch((error) => console.error('registry reconcile failed', error))
    return queue
  }

  function liveAvailable() {
    for (let e of entries.values()) {
      if (e.collector.id === SIM_ID || e.collector.statusOnly) continue
      if (e.enabled && e.health.state === 'available') return true
    }
    return false
  }

  function effectiveEnabled(e: Entry) {
    if (e.collector.id !== SIM_ID) return e.enabled
    return demo === 'on' || (demo === 'auto' && !liveAvailable())
  }

  async function startEntry(e: Entry) {
    let ctrl = new AbortController()
    e.running = ctrl
    let { collector } = e
    try {
      await collector.start({
        signal: ctrl.signal,
        emit(obs) {
          if (!ctrl.signal.aborted) fusion.ingest(obs)
        },
        setHealth(health) {
          if (ctrl.signal.aborted) return
          if (health.state === e.health.state && health.detail === e.health.detail) return
          e.health = health
          schedule()
        },
      })
    } catch (error) {
      e.health = { state: 'error', detail: error instanceof Error ? error.message : String(error) }
      stopEntry(e)
    }
  }

  function stopEntry(e: Entry) {
    if (!e.running) return
    e.running.abort()
    e.running = undefined
    try {
      e.collector.stop()
    } catch (error) {
      console.error(`collector ${e.collector.id} stop failed`, error)
    }
    fusion.forget(e.collector.id)
  }

  async function reconcile() {
    if (!started) return
    // Live collectors first, so `auto` demo mode sees their current health.
    let ordered = [...entries.values()].sort(
      (a, b) => Number(a.collector.id === SIM_ID) - Number(b.collector.id === SIM_ID),
    )
    for (let e of ordered) {
      let shouldRun = effectiveEnabled(e) && e.health.state !== 'unsupported'
      if (shouldRun && !e.running) await startEntry(e)
      else if (!shouldRun && e.running) stopEntry(e)
    }
    hub.publish({ type: 'caps', caps: statuses() })
  }

  function statuses(): CollectorStatus[] {
    return [...entries.values()].map((e) => {
      let enabled = effectiveEnabled(e)
      return {
        id: e.collector.id,
        tier: e.collector.tier,
        label: e.collector.label,
        state: enabled ? e.health.state : 'disabled',
        detail: e.health.detail,
        enabled,
      }
    })
  }

  return {
    async start() {
      if (started) return
      started = true
      await Promise.all(
        [...entries.values()].map(async (e) => {
          try {
            e.health = await e.collector.probe()
          } catch (error) {
            e.health = { state: 'error', detail: error instanceof Error ? error.message : String(error) }
          }
        }),
      )
      ticker = setInterval(() => fusion.tick(), opts.tickMs ?? 1000)
      ticker.unref?.()
      await schedule()
    },
    async stop() {
      started = false
      clearInterval(ticker)
      await queue
      for (let e of entries.values()) stopEntry(e)
    },
    async setEnabled(id, enabled) {
      if (id === SIM_ID) return this.setDemo(enabled ? 'on' : 'off')
      let e = entries.get(id)
      if (!e) throw new Error(`Unknown collector: ${id}`)
      e.enabled = enabled
      // Re-probe on enable so a fixed permission / installed binary is picked up.
      if (enabled && !e.running) {
        try {
          e.health = await e.collector.probe()
        } catch (error) {
          e.health = { state: 'error', detail: error instanceof Error ? error.message : String(error) }
        }
      }
      await schedule()
    },
    async setDemo(mode) {
      demo = mode
      await schedule()
    },
    statuses,
    settings: () => ({
      demo,
      enabled: Object.fromEntries(
        [...entries].filter(([id]) => id !== SIM_ID).map(([id, e]) => [id, e.enabled]),
      ),
    }),
  }
}

// ── App singletons ────────────────────────────────────────────────────────
// server.ts calls `registry.start()`; routes read from `hub`.
export const hub = createHub()
export const fusion = createFusion(hub)
export const registry = createRegistry({ hub, fusion, collectors })
