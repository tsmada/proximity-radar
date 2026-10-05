import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { CollectorStatus, Contact } from '../../../sensing/types.ts'
import { MAX_PER_SWEEP, pingParams } from './audio.ts'
import {
  RING_BANDS,
  beamAngle,
  bearingFor,
  brightnessFor,
  closeness,
  confidenceMeter,
  crossed,
  formatDistance,
  ifaceFrom,
  modeString,
  radiusFor,
  sourceTag,
} from './geometry.ts'

const TAU = Math.PI * 2

function cap(partial: Partial<CollectorStatus> & Pick<CollectorStatus, 'id' | 'tier'>): CollectorStatus {
  return { label: partial.id.toUpperCase(), state: 'available', enabled: true, ...partial }
}

describe('scope geometry', () => {
  it('bearing is stable per id and within 0..2π', () => {
    for (let id of ['a1b2c3d4e5f6', '000000000000', 'ffffffffffff', 'x']) {
      let b = bearingFor(id)
      assert.ok(b >= 0 && b < TAU)
      assert.equal(bearingFor(id), b)
    }
    assert.notEqual(bearingFor('a1b2c3d4e5f6'), bearingFor('a1b2c3d4e5f7'))
  })

  it('radius stays inside the ring band and is monotonic in RSSI', () => {
    for (let ring of ['near', 'mid', 'far'] as const) {
      let [inner, outer] = RING_BANDS[ring]
      for (let rssi of [-30, -55, -62, -70, -80, -99]) {
        let r = radiusFor({ id: 'abc', ring, rssi })
        assert.ok(r > inner && r < outer, `${ring} ${rssi} → ${r}`)
      }
    }
    assert.ok(radiusFor({ id: 'a', ring: 'mid', rssi: -61 }) < radiusFor({ id: 'a', ring: 'mid', rssi: -74 }))
    let onnet = radiusFor({ id: 'lan-device', ring: 'onnet' })
    assert.ok(onnet > RING_BANDS.onnet[0] && onnet < RING_BANDS.onnet[1])
  })

  it('beam crossing handles wrap-around', () => {
    assert.equal(beamAngle(0), 0)
    assert.ok(Math.abs(beamAngle(1000) - TAU / 4) < 1e-9)
    assert.ok(Math.abs(beamAngle(5000) - TAU / 4) < 1e-9)
    assert.equal(crossed(0.1, 0.5, 0.3), true)
    assert.equal(crossed(0.1, 0.5, 0.6), false)
    assert.equal(crossed(6.2, 0.1, 6.25), true)
    assert.equal(crossed(6.2, 0.1, 0.05), true)
    assert.equal(crossed(6.2, 0.1, 3), false)
    assert.equal(crossed(1, 1, 1), false)
  })

  it('distance is always approximate with the ±50% band', () => {
    assert.equal(formatDistance({ distanceM: 0.42, ring: 'near' }), '~0.4 m (±50%)')
    assert.equal(formatDistance({ distanceM: 3.4, ring: 'mid' }), '~3 m (±50%)')
    assert.equal(formatDistance({ distanceM: 23, ring: 'far' }), '~25 m (±50%)')
    assert.match(formatDistance({ ring: 'onnet' }), /unknown/)
    assert.match(formatDistance({ distanceM: Number.NaN, ring: 'far' }), /unknown/)
  })

  it('confidence drives brightness; stale dims it', () => {
    let hi = brightnessFor({ confidence: 1, state: 'active' })
    let lo = brightnessFor({ confidence: 0, state: 'active' })
    assert.equal(hi, 1)
    assert.ok(lo > 0 && lo < hi)
    assert.ok(brightnessFor({ confidence: 1, state: 'stale' }) < hi)
    assert.equal(confidenceMeter(0.6), '▮▮▮▯▯')
    assert.equal(confidenceMeter(Number.NaN), '▯▯▯▯▯')
  })

  it('closeness is 0 for on-net and higher when nearer', () => {
    assert.equal(closeness({ id: 'a', ring: 'onnet' }), 0)
    assert.ok(closeness({ id: 'a', ring: 'near', rssi: -45 }) > closeness({ id: 'a', ring: 'far', rssi: -85 }))
  })

  it('source tags are ordered and upper-case', () => {
    assert.equal(sourceTag(['lan', 'ble'] as Contact['sources']), 'BLE+LAN')
    assert.equal(sourceTag([]), '—')
  })
})

describe('status bar', () => {
  it('MODE lists live tiers in BLE, LAN, MON, SIM order', () => {
    let caps = [
      cap({ id: 'sim', tier: 'sim' }),
      cap({ id: 'lan-arp', tier: 0 }),
      cap({ id: 'ble', tier: 1 }),
      cap({ id: 'monitor', tier: 2, enabled: false, state: 'disabled' }),
    ]
    assert.equal(modeString(caps), 'BLE+LAN+SIM')
    assert.equal(modeString([cap({ id: 'ble', tier: 1, state: 'needs-permission' })]), 'IDLE')
  })

  it('IFACE comes from the station collector detail', () => {
    assert.equal(ifaceFrom([cap({ id: 'station-wifi', tier: 0, detail: 'en0 · HomeNet · -54 dBm' })]), 'en0')
    assert.equal(ifaceFrom([cap({ id: 'station-wifi', tier: 0, detail: 'Wi-Fi is off' })]), undefined)
    assert.equal(ifaceFrom([]), undefined)
  })
})

describe('audio ping', () => {
  it('is higher and louder for closer contacts, ~300 ms decay', () => {
    let far = pingParams(0)
    let near = pingParams(1)
    assert.equal(far.freq, 1200)
    assert.ok(near.freq > far.freq && near.gain > far.gain)
    assert.equal(near.decay, 0.3)
    assert.equal(MAX_PER_SWEEP, 6)
  })
})
