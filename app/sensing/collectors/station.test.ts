import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { formatStation, parseSystemProfiler } from './station.ts'

const fixture = readFileSync(new URL('./__fixtures__/system-profiler-airport.json', import.meta.url), 'utf8')

describe('parseSystemProfiler', () => {
  it('reads the connected en* interface and ignores awdl0', () => {
    let s = parseSystemProfiler(fixture)!
    assert.equal(s.iface, 'en0')
    assert.equal(s.connected, true)
    assert.equal(s.rssi, -58)
    assert.equal(s.noise, -94)
    assert.equal(s.channel, '149 (5GHz, 40MHz)')
  })

  it('omits the SSID when macOS redacts it (no Location Services access)', () => {
    let s = parseSystemProfiler(fixture)!
    assert.equal(s.ssid, undefined)
    assert.equal(formatStation(s), 'en0 · -58 dBm · SNR 36 · ch 149 (5GHz)')
  })

  it('includes the SSID when available', () => {
    let s = parseSystemProfiler(fixture.replace('"_name" : "<redacted>"', '"_name" : "HomeNet"'))!
    assert.equal(formatStation(s), 'en0 · HomeNet · -58 dBm · SNR 36 · ch 149 (5GHz)')
  })

  it('reports Wi-Fi off / disconnected', () => {
    let off = JSON.stringify({
      SPAirPortDataType: [
        { spairport_airport_interfaces: [{ _name: 'en0', spairport_status_information: 'spairport_status_off' }] },
      ],
    })
    assert.equal(formatStation(parseSystemProfiler(off)!), 'en0 · Wi-Fi off')
    let disc = off.replace('spairport_status_off', 'spairport_status_disconnected')
    assert.equal(formatStation(parseSystemProfiler(disc)!), 'en0 · not connected')
  })

  it('returns undefined for junk or no Wi-Fi hardware', () => {
    assert.equal(parseSystemProfiler('nope'), undefined)
    assert.equal(parseSystemProfiler('{"SPAirPortDataType":[]}'), undefined)
  })
})
