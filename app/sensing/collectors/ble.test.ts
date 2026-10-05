import { EventEmitter } from 'node:events'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { CollectorHealth, Observation } from '../types.ts'
import {
  createBleCollector,
  healthForState,
  hintsFor,
  observationFor,
  referencePower,
  type NobleLike,
  type PeripheralLike,
} from './ble.ts'

class FakeNoble extends EventEmitter {
  _state = 'unknown'
  scans: boolean[] = []
  stopped = 0
  startScanning(_uuids: string[], allowDuplicates: boolean) {
    this.scans.push(allowDuplicates)
  }
  stopScanning() {
    this.stopped++
  }
  setState(s: string) {
    this._state = s
    this.emit('stateChange', s)
  }
}

function harness(noble: FakeNoble | (() => Promise<NobleLike>)) {
  let collector = createBleCollector({
    loadNoble: typeof noble === 'function' ? noble : async () => noble as unknown as NobleLike,
  })
  let ctrl = new AbortController()
  let emitted: Observation[] = []
  let health: CollectorHealth[] = []
  collector.start({ signal: ctrl.signal, emit: (o) => emitted.push(o), setHealth: (h) => health.push(h) })
  let stop = () => {
    ctrl.abort()
    collector.stop()
  }
  return { collector, emitted, health, stop }
}

const tick = () => new Promise((r) => setImmediate(r))

const iphone: PeripheralLike = {
  id: 'f00dfeed1234',
  rssi: -58,
  advertisement: { localName: "Someone's iPhone", txPowerLevel: 0, manufacturerData: Uint8Array.of(0x4c, 0x00, 0x10, 0x05) },
}

describe('ble parsers', () => {
  it('maps noble states to health', () => {
    assert.equal(healthForState('poweredOn')?.state, 'available')
    let perm = healthForState('unauthorized')
    assert.equal(perm?.state, 'needs-permission')
    assert.match(perm?.detail ?? '', /Privacy & Security › Bluetooth/)
    assert.equal(healthForState('poweredOff')?.state, 'error')
    assert.equal(healthForState('unsupported')?.state, 'unsupported')
    assert.equal(healthForState('resetting'), undefined)
    assert.equal(healthForState('unknown'), undefined)
  })

  it('derives vendor and kind hints without keeping payload bytes', () => {
    assert.deepEqual(hintsFor({ manufacturerData: Uint8Array.of(0x4c, 0x00, 0x07, 0x19) }), { vendor: 'Apple', kind: 'media' })
    assert.deepEqual(hintsFor({ manufacturerData: Uint8Array.of(0x4c, 0x00, 0x12) }), { vendor: 'Apple', kind: 'iot' })
    assert.deepEqual(hintsFor({ manufacturerData: Uint8Array.of(0xa7, 0x05) }), { vendor: 'Sonos', kind: 'media' })
    assert.deepEqual(hintsFor({ localName: 'Pixel 9' }), { vendor: undefined, kind: 'phone' })
    assert.deepEqual(hintsFor({ manufacturerData: Uint8Array.of(0xff, 0xff, 1, 2, 3) }), { vendor: undefined, kind: 'unknown' })

    let obs = observationFor(iphone, 123)!
    assert.equal(obs.source, 'ble')
    assert.equal(obs.key, 'f00dfeed1234')
    assert.equal(obs.rssi, -58)
    assert.equal(obs.vendor, 'Apple')
    assert.equal(obs.kind, 'phone')
    assert.equal(obs.txPower, -59)
    assert.doesNotMatch(JSON.stringify(obs), /manufacturer/i)
  })

  it('converts advertised TX power to a 1 m reference and drops unusable RSSI', () => {
    assert.equal(referencePower(undefined), undefined)
    assert.equal(referencePower(8), -51)
    assert.equal(referencePower(-59), -59)
    assert.equal(observationFor({ ...iphone, rssi: 127 }, 0), undefined)
  })
})

describe('ble collector', () => {
  it('is opt-in and tier 1', () => {
    let c = createBleCollector()
    assert.equal(c.defaultEnabled, false)
    assert.equal(c.tier, 1)
  })

  it('probe has no side effects and reports a missing driver as unsupported', async () => {
    let loaded = false
    let c = createBleCollector({
      loadNoble: async () => {
        loaded = true
        throw new Error('nope')
      },
      resolveNoble: () => {
        throw new Error('not found')
      },
    })
    assert.equal((await c.probe()).state, 'unsupported')
    assert.equal(loaded, false)
    assert.equal((await createBleCollector({ platform: 'aix' }).probe()).state, 'unsupported')
  })

  it('returns before poweredOn, then scans with duplicates and emits observations', async () => {
    let noble = new FakeNoble()
    let h = harness(noble)
    await tick()
    assert.equal(noble.scans.length, 0)
    noble.setState('poweredOn')
    assert.deepEqual(noble.scans, [true])
    assert.equal(h.health.at(-1)?.state, 'available')
    noble.emit('discover', iphone)
    assert.equal(h.emitted.length, 1)
    h.stop()
    assert.equal(noble.stopped, 1)
    noble.emit('discover', iphone)
    assert.equal(h.emitted.length, 1)
    assert.equal(noble.listenerCount('discover'), 0)
  })

  it('reports needs-permission when unauthorized and resumes on a restart if already powered on', async () => {
    let noble = new FakeNoble()
    let a = harness(noble)
    await tick()
    noble.setState('unauthorized')
    assert.equal(a.health.at(-1)?.state, 'needs-permission')
    a.stop()

    noble._state = 'poweredOn'
    let b = harness(noble)
    await tick()
    assert.deepEqual(noble.scans, [true])
    b.stop()
  })

  it('a broken native module degrades to unsupported instead of throwing', async () => {
    let h = harness(async () => {
      throw new Error('dlopen failed')
    })
    await tick()
    await tick()
    assert.equal(h.health.at(-1)?.state, 'unsupported')
    assert.match(h.health.at(-1)?.detail ?? '', /dlopen failed/)
    h.stop()
  })
})
