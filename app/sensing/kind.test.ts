import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { classify, inferKind } from './kind.ts'
import { lookupVendor, parseOuiTable } from './oui.ts'

describe('inferKind', () => {
  it('model strings', () => {
    assert.equal(inferKind({ model: 'iPhone15,2' }), 'phone')
    assert.equal(inferKind({ model: 'iPad13,4' }), 'phone')
    assert.equal(inferKind({ model: 'MacBookPro18,4' }), 'laptop')
    assert.equal(inferKind({ model: 'Mac14,2' }), 'laptop')
    assert.equal(inferKind({ model: 'AppleTV11,1' }), 'media')
    assert.equal(inferKind({ model: 'AudioAccessory5,1' }), 'media')
    assert.equal(inferKind({ model: 'Sonos Arc' }), 'media')
    assert.equal(inferKind({ model: 'HP OfficeJet Pro 9010 series' }), 'printer')
  })

  it('mDNS services', () => {
    assert.equal(inferKind({ services: ['_ipp._tcp'] }), 'printer')
    assert.equal(inferKind({ services: ['_googlecast._tcp.local'] }), 'media')
    assert.equal(inferKind({ services: ['Bridge._hap._tcp.local'] }), 'iot')
    assert.equal(inferKind({ services: ['_smb._tcp'] }), 'laptop')
    // A Mac advertises AirPlay too, but its model wins.
    assert.equal(inferKind({ model: 'MacBookAir10,1', services: ['_airplay._tcp'] }), 'laptop')
  })

  it('UPnP types', () => {
    assert.equal(inferKind({ upnpTypes: ['urn:schemas-upnp-org:device:InternetGatewayDevice:1'] }), 'router')
    assert.equal(inferKind({ upnpTypes: ['urn:schemas-upnp-org:device:MediaRenderer:1'] }), 'media')
    assert.equal(inferKind({ upnpTypes: ['urn:schemas-upnp-org:device:MediaServer:1'] }), 'unknown')
  })

  it('names and hostnames', () => {
    assert.equal(inferKind({ names: ['Example-iPhone'] }), 'phone')
    assert.equal(inferKind({ names: ['jdoe-mac'] }), 'laptop')
    assert.equal(inferKind({ names: ['LGwebOSTV'] }), 'media')
    assert.equal(inferKind({ names: ['Linux/3.10.107-UBNT, UPnP/1.0'] }), 'router')
    assert.equal(inferKind({ names: ['Lutron-0271d31e'] }), 'iot')
    assert.equal(inferKind({ names: ['Bring it on'] }), 'unknown')
  })

  it('vendor is the weakest signal', () => {
    assert.deepEqual(classify({ vendor: 'Ubiquiti' }), { kind: 'router', strength: 1 })
    assert.deepEqual(classify({ vendor: 'Espressif' }), { kind: 'iot', strength: 1 })
    assert.equal(inferKind({ vendor: 'Apple' }), 'unknown')
    assert.equal(inferKind({ vendor: 'Sonos', names: ['Example-iPhone'] }), 'phone')
  })

  it('unknown when nothing matches', () => {
    assert.deepEqual(classify({}), { kind: 'unknown', strength: 0 })
  })
})

describe('OUI lookup', () => {
  it('parses the grouped table format', () => {
    let t = parseOuiTable('Acme\tAABBCC 112233\nOther Co\tDDEEFF\n\n')
    assert.equal(t.get('AABBCC'), 'Acme')
    assert.equal(t.get('112233'), 'Acme')
    assert.equal(t.get('DDEEFF'), 'Other Co')
  })

  it('looks up real vendors from the bundled table, any MAC format', () => {
    assert.equal(lookupVendor('80:4a:f2:00:00:30'), 'Sonos')
    assert.equal(lookupVendor('74-83-C2-00-00-10'), 'Ubiquiti')
    assert.equal(lookupVendor('dc:6:75:0:0:e0'), 'Espressif')
    assert.equal(lookupVendor('00:1b:63:00:00:01'), 'Apple')
  })

  it('skips randomized, multicast and malformed MACs', () => {
    assert.equal(lookupVendor('3a:00:00:00:00:07'), undefined) // locally administered
    assert.equal(lookupVendor('01:00:5e:00:00:fb'), undefined) // multicast
    assert.equal(lookupVendor('ff:ff:ff:ff:ff:ff'), undefined)
    assert.equal(lookupVendor('nope'), undefined)
  })
})
