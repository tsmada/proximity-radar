import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  confidenceFor,
  createFusion,
  createSmoother,
  estimateDistance,
  median,
  ringForRssi,
  ringWithHysteresis,
  type FusionOptions,
} from './fusion.ts'
import { createHub } from './hub.ts'
import type { Contact, Observation, StreamEvent } from './types.ts'

function setup(opts: FusionOptions = {}) {
  let t = 1_000_000
  let hub = createHub()
  let events: StreamEvent[] = []
  hub.subscribe((e) => events.push(e))
  let fusion = createFusion(hub, { now: () => t, salt: new Uint8Array(32), minPublishMs: 0, ...opts })
  let obs = (o: Partial<Observation> = {}): Observation => ({
    source: 'ble',
    collector: 'ble',
    key: 'dev-1',
    at: t,
    rssi: -55,
    ...o,
  })
  let only = (): Contact => {
    let cs = hub.snapshot()
    assert.equal(cs.length, 1)
    return cs[0]
  }
  return { hub, fusion, events, obs, only, advance: (ms: number) => (t += ms) }
}

describe('fusion maths', () => {
  it('maps rssi to rings at the exact boundaries and LAN-only to onnet', () => {
    assert.equal(ringForRssi(-50), 'near')
    assert.equal(ringForRssi(-59.9), 'near')
    assert.equal(ringForRssi(-60), 'mid')
    assert.equal(ringForRssi(-75), 'mid')
    assert.equal(ringForRssi(-75.1), 'far')
    assert.equal(ringForRssi(undefined), 'onnet')
  })

  it('applies 3 dB hysteresis in both directions at both boundaries', () => {
    // near ↔ mid at −60
    assert.equal(ringWithHysteresis(-62, 'near'), 'near')
    assert.equal(ringWithHysteresis(-63.1, 'near'), 'mid')
    assert.equal(ringWithHysteresis(-58, 'mid'), 'mid')
    assert.equal(ringWithHysteresis(-56.9, 'mid'), 'near')
    // mid ↔ far at −75
    assert.equal(ringWithHysteresis(-77, 'mid'), 'mid')
    assert.equal(ringWithHysteresis(-78.1, 'mid'), 'far')
    assert.equal(ringWithHysteresis(-73, 'far'), 'far')
    assert.equal(ringWithHysteresis(-71.9, 'far'), 'mid')
    // no previous ring, or coming from onnet → plain thresholds
    assert.equal(ringWithHysteresis(-61, undefined), 'mid')
    assert.equal(ringWithHysteresis(-61, 'onnet'), 'mid')
    assert.equal(ringWithHysteresis(undefined, 'near'), 'onnet')
    assert.equal(ringWithHysteresis(-62, 'near', 0), 'mid')
  })

  it('log-distance model', () => {
    assert.equal(estimateDistance(-59, -59), 1)
    assert.ok(Math.abs(estimateDistance(-86, -59, 2.7) - 10) < 1e-9)
    assert.ok(Math.abs(estimateDistance(-60, -40, 2) - 10) < 1e-9)
    assert.ok(estimateDistance(-80, -59) > estimateDistance(-70, -59))
  })

  it('median and smoothers', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 3, 2]), 2.5)
    let ema = createSmoother('ema', { alpha: 0.25 })
    ema.push(0)
    assert.equal(ema.push(10), 2.5)
    let kalman = createSmoother('kalman', { q: 0.05, r: 3 })
    kalman.push(-80)
    for (let i = 0; i < 50; i++) kalman.push(-60)
    assert.ok(Math.abs(kalman.value! + 60) < 1, `kalman converges, got ${kalman.value}`)
  })

  it('confidence rises with samples, falls with variance, scales with quality', () => {
    let bySamples = [1, 2, 5, 10, 30].map((n) => confidenceFor(n, 4, 1))
    for (let i = 1; i < bySamples.length; i++) assert.ok(bySamples[i] > bySamples[i - 1])
    let byVar = [0, 4, 16, 64].map((v) => confidenceFor(10, v, 1))
    for (let i = 1; i < byVar.length; i++) assert.ok(byVar[i] < byVar[i - 1])
    assert.ok(confidenceFor(10, 4, 1) > confidenceFor(10, 4, 0.5))
    assert.ok(confidenceFor(1000, 0, 1) <= 1)
  })
})

describe('fusion engine', () => {
  it('publishes a hashed upsert and never leaks the raw mac', () => {
    let { hub, fusion, events, obs } = setup()
    fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'DA:A1:19:00:00:01', mac: 'DA:A1:19:00:00:01', rssi: undefined, vendor: 'Apple' }))
    let e = events[0]
    assert.equal(e.type, 'upsert')
    if (e.type !== 'upsert') return
    assert.match(e.contact.id, /^[0-9a-f]{12}$/)
    assert.equal(e.contact.ring, 'onnet')
    assert.equal(e.contact.randomizedMac, true)
    assert.equal(e.contact.vendor, undefined) // OUI skipped for randomized MACs
    assert.doesNotMatch(JSON.stringify(hub.snapshot()), /da:a1|DA:A1/i)
  })

  it('median rejects a single outlier before the EMA', () => {
    let { fusion, obs, only } = setup()
    for (let i = 0; i < 4; i++) fusion.ingest(obs({ rssi: -55 }))
    fusion.ingest(obs({ rssi: -95 }))
    assert.equal(only().rssi, -55)
    assert.equal(only().ring, 'near')
  })

  it('smooths in dBm and holds the ring inside the hysteresis band', () => {
    let { fusion, obs, only } = setup()
    for (let i = 0; i < 10; i++) fusion.ingest(obs({ rssi: -55 }))
    assert.equal(only().ring, 'near')
    for (let i = 0; i < 30; i++) fusion.ingest(obs({ rssi: -62 }))
    assert.ok(fusion.contacts()[0].rssi! < -61.5)
    assert.equal(only().ring, 'near') // −62 is inside the 3 dB band
    for (let i = 0; i < 30; i++) fusion.ingest(obs({ rssi: -66 }))
    assert.equal(only().ring, 'mid')
    for (let i = 0; i < 30; i++) fusion.ingest(obs({ rssi: -58 }))
    assert.equal(only().ring, 'mid') // −58 is inside the band on the way back
    for (let i = 0; i < 30; i++) fusion.ingest(obs({ rssi: -52 }))
    assert.equal(only().ring, 'near')
  })

  it('supports the Kalman filter option', () => {
    let { fusion, obs, only } = setup({ filter: 'kalman' })
    for (let i = 0; i < 40; i++) fusion.ingest(obs({ rssi: i % 2 ? -70 : -72 }))
    assert.ok(Math.abs(only().rssi! + 71) < 1.5)
    assert.equal(only().ring, 'mid')
  })

  it('estimates distance from the advertised 1 m power or the −59 default', () => {
    let { fusion, obs, hub } = setup()
    fusion.ingest(obs({ key: 'a', rssi: -59 }))
    fusion.ingest(obs({ key: 'b', rssi: -59, txPower: -45 }))
    let [a, b] = hub.snapshot()
    assert.equal(a.distanceM, 1)
    assert.ok(b.distanceM! > 3)
  })

  it('confidence grows with samples and steadier signals score higher', () => {
    let { fusion, obs, hub } = setup()
    let seen: number[] = []
    for (let i = 0; i < 10; i++) {
      fusion.ingest(obs({ key: 'steady', rssi: -65 }))
      seen.push(hub.snapshot()[0].confidence)
    }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1])
    for (let i = 0; i < 10; i++) fusion.ingest(obs({ key: 'noisy', rssi: i % 2 ? -50 : -80 }))
    let [steady, noisy] = hub.snapshot()
    assert.ok(steady.confidence > noisy.confidence)
  })

  it('ages contacts to stale then lost', () => {
    let { hub, fusion, events, obs, advance } = setup()
    fusion.ingest(obs())
    advance(6_000)
    fusion.tick()
    assert.equal(hub.snapshot()[0].state, 'active')
    advance(10_000)
    fusion.tick()
    assert.equal(hub.snapshot()[0].state, 'stale')
    fusion.ingest(obs({ at: 1_016_000 }))
    assert.equal(hub.snapshot()[0].state, 'active')
    advance(61_000)
    fusion.tick()
    assert.equal(events.at(-1)?.type, 'lost')
    assert.equal(hub.snapshot().length, 0)
  })

  it('forget() drops contacts only seen by that collector', () => {
    let { hub, fusion, obs } = setup()
    fusion.ingest(obs({ collector: 'sim', key: 'a' }))
    fusion.ingest(obs({ collector: 'ble', key: 'b' }))
    fusion.forget('sim')
    assert.equal(hub.snapshot().length, 1)
  })
})

describe('fusion identity, claiming and merging', () => {
  it('merges the same MAC seen by two collectors', () => {
    let { fusion, obs, only } = setup()
    fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'x', mac: '00:11:22:33:44:55', rssi: undefined }))
    fusion.ingest(obs({ source: 'wifi', collector: 'wifi-mon', key: 'y', mac: '00-11-22-33-44-55', rssi: -50 }))
    assert.deepEqual(only().sources, ['lan', 'wifi'])
    assert.equal(only().ring, 'near')
  })

  it('auto-merges LAN readings on a shared mDNS name / IP, but never two different MACs', () => {
    let { fusion, obs, only, hub } = setup()
    let lan = { source: 'lan' as const, rssi: undefined }
    fusion.ingest(obs({ ...lan, collector: 'lan-mdns', key: 'nas.local', name: 'nas.local', ip: '10.0.0.5' }))
    fusion.ingest(obs({ ...lan, collector: 'lan-arp', key: '00:11:22:33:44:55', mac: '00:11:22:33:44:55', ip: '10.0.0.5' }))
    fusion.ingest(obs({ ...lan, collector: 'lan-mdns', key: 'nas.local', name: 'nas.local', ip: '10.0.0.5' }))
    assert.equal(only().label, 'nas.local')
    fusion.ingest(obs({ ...lan, collector: 'lan-arp', key: '00:11:22:33:44:66', mac: '00:11:22:33:44:66', ip: '10.0.0.5' }))
    assert.equal(hub.snapshot().length, 2)
  })

  it('claims survive the contact being lost and re-seen', () => {
    let { fusion, obs, only, advance, hub } = setup()
    fusion.ingest(obs())
    let id = only().id
    assert.equal(only().claimed, undefined)
    assert.deepEqual(fusion.claim(id, true), { ok: true })
    assert.equal(only().claimed, true)
    advance(61_000)
    fusion.tick()
    assert.equal(hub.snapshot().length, 0)
    fusion.ingest(obs({ at: 1_061_000 }))
    assert.equal(only().claimed, true)
    fusion.claim(id, false)
    assert.equal(only().claimed, undefined)
    assert.equal(fusion.claim('000000000000', true).ok, false)
  })

  it('merge folds a BLE contact into a LAN contact and keeps routing BLE readings there', () => {
    let { fusion, obs, hub, events } = setup()
    fusion.ingest(obs({ source: 'lan', collector: 'lan-mdns', key: 'phone.local', name: 'phone.local', rssi: undefined }))
    fusion.ingest(obs({ key: 'ble-uuid', name: 'iPhone', rssi: -55 }))
    let [lan, ble] = hub.snapshot()
    assert.equal(lan.ring, 'onnet')

    assert.equal(fusion.merge(lan.id, lan.id).ok, false)
    assert.equal(fusion.merge(ble.id, 'ffffffffffff').ok, false)
    assert.deepEqual(fusion.merge(ble.id, lan.id), { ok: true })

    assert.ok(events.some((e) => e.type === 'lost' && e.id === ble.id))
    let merged = hub.snapshot()
    assert.equal(merged.length, 1)
    assert.equal(merged[0].id, lan.id)
    assert.deepEqual(merged[0].sources, ['lan', 'ble'])
    assert.equal(merged[0].ring, 'near') // proximity comes from BLE
    assert.equal(merged[0].label, 'phone.local') // LAN name outranks BLE local name

    for (let i = 0; i < 20; i++) fusion.ingest(obs({ key: 'ble-uuid', rssi: -80 }))
    assert.equal(hub.snapshot().length, 1)
    assert.equal(hub.snapshot()[0].ring, 'far')
    // A claim on the absorbed id lands on the merged contact.
    fusion.claim(ble.id, true)
    assert.equal(hub.snapshot()[0].claimed, true)
  })

  it('falls back to ON-NET when the merged BLE source goes quiet but LAN is still present', () => {
    let { fusion, obs, hub, advance } = setup()
    let t0 = 1_000_000
    fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'aa', mac: '00:11:22:33:44:55', rssi: undefined }))
    fusion.ingest(obs({ key: 'ble-uuid', rssi: -55 }))
    let [lan, ble] = hub.snapshot()
    fusion.merge(ble.id, lan.id)
    assert.equal(hub.snapshot()[0].ring, 'near')
    advance(20_000)
    fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'aa', mac: '00:11:22:33:44:55', rssi: undefined, at: t0 + 20_000 }))
    let c = hub.snapshot()[0]
    assert.equal(c.ring, 'onnet')
    assert.equal(c.rssi, undefined)
    advance(50_000)
    fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'aa', mac: '00:11:22:33:44:55', rssi: undefined, at: t0 + 70_000 }))
    assert.deepEqual(hub.snapshot()[0].sources, ['lan']) // BLE unseen > 60 s
  })

  it('merges an IP-keyed LAN reading (no MAC resolved) with the ARP entry for that IP, in either order', () => {
    for (let order of [0, 1]) {
      let { fusion, obs, hub } = setup()
      let mdns = () => fusion.ingest(obs({ source: 'lan', collector: 'lan-mdns', key: '10.0.0.9', ip: '10.0.0.9', name: 'tv.local', rssi: undefined }))
      let arp = () => fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: '00:11:22:33:44:99', mac: '00:11:22:33:44:99', ip: '10.0.0.9', rssi: undefined }))
      if (order) { arp(); mdns() } else { mdns(); arp() }
      mdns()
      arp()
      assert.equal(hub.snapshot().length, 1, `order ${order}`)
      assert.equal(hub.snapshot()[0].label, 'tv.local')
    }
  })

  it('keeps a device-reported vendor even for a randomized MAC', () => {
    let { fusion, obs, only } = setup()
    let base = { source: 'lan' as const, collector: 'lan-ssdp', key: 'da:a1:19:00:00:02', mac: 'da:a1:19:00:00:02', rssi: undefined }
    fusion.ingest(obs({ ...base, vendor: 'Apple' }))
    assert.equal(only().vendor, undefined)
    fusion.ingest(obs({ ...base, vendor: 'Sonos', vendorFromDevice: true }))
    assert.equal(only().vendor, 'Sonos')
  })
})

describe('fusion publishing', () => {
  it('skips upserts when nothing visible changed, but still ages contacts', () => {
    let { fusion, obs, events, advance } = setup()
    let arp = (o: Partial<Observation> = {}) =>
      fusion.ingest(obs({ source: 'lan', collector: 'lan-arp', key: 'aa', mac: '00:11:22:33:44:55', ip: '10.0.0.2', rssi: undefined, ...o }))
    let upserts = () => events.filter((e) => e.type === 'upsert').length
    arp()
    for (let i = 0; i < 5; i++) {
      advance(1_000)
      arp()
    }
    // Confidence climbs from presence samples, so allow those, but not one per reading.
    let afterRepeats = upserts()
    assert.ok(afterRepeats < 6, `got ${afterRepeats} upserts`)
    for (let i = 0; i < 20; i++) arp()
    let steady = upserts()
    for (let i = 0; i < 20; i++) arp()
    assert.equal(upserts(), steady)
    arp({ ip: '10.0.0.3' })
    assert.equal(upserts(), steady + 1)

    advance(16_000)
    fusion.tick()
    let last = events.at(-1)
    assert.ok(last?.type === 'upsert' && last.contact.state === 'stale')
    advance(45_000)
    fusion.tick()
    assert.equal(events.at(-1)?.type, 'lost')
  })

  it('withholds sub-1 dB RSSI wobble', () => {
    let { fusion, obs, events } = setup()
    for (let i = 0; i < 20; i++) fusion.ingest(obs({ rssi: -70 }))
    let n = events.length
    for (let i = 0; i < 20; i++) fusion.ingest(obs({ rssi: i % 2 ? -70 : -71 }))
    assert.equal(events.length, n)
    for (let i = 0; i < 20; i++) fusion.ingest(obs({ rssi: -66 }))
    assert.ok(events.length > n)
  })
})

describe('fusion privacy', () => {
  it('scrubs MAC fragments out of names before they reach the hub', () => {
    let { fusion, obs, only } = setup()
    fusion.ingest(obs({ source: 'lan', collector: 'lan-ssdp', rssi: undefined, name: 'HP OfficeJet [F65D06]', mac: 'f4:39:09:f6:5d:06' }))
    assert.equal(only().label, 'HP OfficeJet')
    assert.doesNotMatch(JSON.stringify(only()), /f6:?5d:?06/i)
  })
})
