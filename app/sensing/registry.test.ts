import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createFusion } from './fusion.ts'
import { createHub } from './hub.ts'
import { createRegistry } from './registry.ts'
import type { Collector, CollectorHealth } from './types.ts'

function fakeCollector(id: string, health: CollectorHealth = { state: 'available' }) {
  let running = false
  let collector: Collector = {
    id,
    tier: id === 'sim' ? 'sim' : 0,
    label: id.toUpperCase(),
    defaultEnabled: id === 'sim',
    probe: () => health,
    start(ctx) {
      running = true
      ctx.emit({ source: id === 'sim' ? 'sim' : 'lan', collector: id, key: `${id}-dev`, at: Date.now() })
    },
    stop() {
      running = false
    },
  }
  return { collector, isRunning: () => running }
}

function setup(live: CollectorHealth = { state: 'available' }) {
  let hub = createHub()
  let fusion = createFusion(hub)
  let sim = fakeCollector('sim')
  let lan = fakeCollector('lan-test', live)
  let registry = createRegistry({ hub, fusion, collectors: [sim.collector, lan.collector] })
  return { hub, registry, sim, lan }
}

describe('registry', () => {
  it('runs demo by default when no live collector is enabled', async () => {
    let { hub, registry, sim, lan } = setup()
    await registry.start()
    assert.equal(sim.isRunning(), true)
    assert.equal(lan.isRunning(), false)
    assert.equal(hub.caps().find((c) => c.id === 'lan-test')?.state, 'disabled')
    await registry.stop()
  })

  it('auto demo switches off when a live collector is enabled, and its contacts are dropped', async () => {
    let { hub, registry, sim, lan } = setup()
    await registry.start()
    await registry.setEnabled('lan-test', true)
    assert.equal(lan.isRunning(), true)
    assert.equal(sim.isRunning(), false)
    assert.deepEqual(hub.snapshot().map((c) => c.sources), [['lan']])
    await registry.stop()
  })

  it('keeps demo on when the live collector is unsupported', async () => {
    let { registry, sim, lan } = setup({ state: 'unsupported', detail: 'no arp' })
    await registry.start()
    await registry.setEnabled('lan-test', true)
    assert.equal(lan.isRunning(), false)
    assert.equal(sim.isRunning(), true)
    let status = registry.statuses().find((c) => c.id === 'lan-test')
    assert.equal(status?.state, 'unsupported')
    assert.equal(status?.detail, 'no arp')
    await registry.stop()
  })

  it('demo=on forces sim alongside live collectors; demo=off stops it', async () => {
    let { registry, sim } = setup()
    await registry.start()
    await registry.setEnabled('lan-test', true)
    await registry.setDemo('on')
    assert.equal(sim.isRunning(), true)
    await registry.setDemo('off')
    assert.equal(sim.isRunning(), false)
    await registry.stop()
  })

  it('ignores statusOnly collectors when deciding auto demo', async () => {
    let hub = createHub()
    let fusion = createFusion(hub)
    let sim = fakeCollector('sim')
    let station = fakeCollector('station-test')
    let collector: Collector = { ...station.collector, statusOnly: true, defaultEnabled: true }
    let registry = createRegistry({ hub, fusion, collectors: [sim.collector, collector] })
    await registry.start()
    assert.equal(station.isRunning(), true)
    assert.equal(sim.isRunning(), true)
    await registry.stop()
  })
})

describe('registry toggling', () => {
  it('repeated enable/disable leaves exactly one live run and aborts every old signal', async () => {
    let hub = createHub()
    let fusion = createFusion(hub)
    let signals: AbortSignal[] = []
    let starts = 0
    let stops = 0
    let collector: Collector = {
      id: 'ble',
      tier: 1,
      label: 'BLE',
      defaultEnabled: false,
      probe: () => ({ state: 'available' }),
      start(ctx) {
        starts++
        signals.push(ctx.signal)
        ctx.emit({ source: 'ble', collector: 'ble', key: `p-${starts}`, at: Date.now(), rssi: -60 })
      },
      stop() {
        stops++
      },
    }
    let registry = createRegistry({ hub, fusion, collectors: [collector] })
    await registry.start()
    // Fire toggles concurrently, as fast double-clicks would.
    await Promise.all(Array.from({ length: 10 }, (_, i) => registry.setEnabled('ble', i % 2 === 0)))
    await registry.setEnabled('ble', true)
    assert.equal(starts - stops, 1)
    assert.equal(signals.filter((s) => !s.aborted).length, 1)
    await registry.setEnabled('ble', false)
    assert.equal(signals.every((s) => s.aborted), true)
    assert.equal(hub.snapshot().length, 0, 'contacts from a disabled collector are dropped')
    await registry.stop()
  })
})
