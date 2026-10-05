import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { classify } from '../kind.ts'
import {
  cleanFriendlyName,
  cleanManufacturer,
  isGenericName,
  M_SEARCH,
  parseDeviceDescription,
  parseSsdpMessage,
  safeLocation,
} from './ssdp.ts'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const replies: Array<{ from: string; text: string }> = JSON.parse(fixture('ssdp-replies.json'))

describe('parseSsdpMessage', () => {
  it('parses every captured reply', () => {
    for (let r of replies) {
      let parsed = parseSsdpMessage(r.text)
      assert.ok(parsed, r.text)
      assert.match(parsed!.location ?? '', /^http:\/\//)
      assert.ok(parsed!.st)
    }
  })

  it('handles mixed-case headers (LG uses `Location:`)', () => {
    let lg = replies.find((r) => r.from === '192.168.1.232')!
    assert.match(parseSsdpMessage(lg.text)!.location!, /^http:\/\/192\.168\.1\.232:/)
  })

  it('reads NOTIFY announcements (NT header)', () => {
    let n = parseSsdpMessage('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nLOCATION: http://10.0.0.2/d.xml\r\n\r\n')
    assert.equal(n?.st, 'upnp:rootdevice')
  })

  it('ignores M-SEARCH requests and junk', () => {
    assert.equal(parseSsdpMessage(M_SEARCH), undefined)
    assert.equal(parseSsdpMessage('garbage'), undefined)
  })
})

describe('parseDeviceDescription', () => {
  it('router: root device only, not the nested WANDevice', () => {
    let d = parseDeviceDescription(fixture('upnp-router.xml'))
    assert.deepEqual(d, {
      deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      friendlyName: 'ERLite-3',
      manufacturer: 'Ubiquiti Networks, Inc.',
      modelName: 'Debian router',
    })
    assert.equal(classify({ model: d.modelName, upnpTypes: [d.deviceType!] }).kind, 'router')
  })

  it('Sonos: cleans the IP/RINCON decorated friendlyName', () => {
    let d = parseDeviceDescription(fixture('upnp-sonos.xml'))
    assert.equal(cleanFriendlyName(d.friendlyName!), 'Sonos Arc')
    assert.equal(cleanManufacturer(d.manufacturer!), 'Sonos')
    assert.equal(classify({ model: d.modelName, upnpTypes: [d.deviceType!] }).kind, 'media')
  })

  it('LG TV', () => {
    let d = parseDeviceDescription(fixture('upnp-lg-tv.xml'))
    assert.equal(d.friendlyName, '[LG] webOS TV OLED83G4WUA')
    assert.equal(d.deviceType, 'urn:lge:device:tv:1')
    assert.equal(classify({ model: d.modelName, upnpTypes: [d.deviceType!] }).kind, 'media')
  })

  it('decodes entities and tolerates missing fields', () => {
    let d = parseDeviceDescription('<root><device><friendlyName>Tom &amp; Jerry&#39;s TV</friendlyName></device></root>')
    assert.deepEqual(d, {
      deviceType: undefined,
      friendlyName: "Tom & Jerry's TV",
      manufacturer: undefined,
      modelName: undefined,
    })
    assert.deepEqual(parseDeviceDescription('not xml'), {})
  })
})

describe('safeLocation', () => {
  it('only allows http URLs on the replying private host', () => {
    assert.ok(safeLocation('http://192.168.1.73:1400/xml/device_description.xml', '192.168.1.73'))
    assert.equal(safeLocation('http://192.168.1.99:1400/x.xml', '192.168.1.73'), undefined)
    assert.equal(safeLocation('http://example.com/x.xml', '192.168.1.73'), undefined)
    assert.equal(safeLocation('https://192.168.1.73/x.xml', '192.168.1.73'), undefined)
    assert.equal(safeLocation('http://8.8.8.8/x.xml', '8.8.8.8'), undefined)
    assert.equal(safeLocation('not a url', '192.168.1.73'), undefined)
  })
})

describe('isGenericName', () => {
  it('flags SDK stock names, keeps real ones', () => {
    assert.ok(isGenericName('Linux Internet Gateway Device'))
    assert.ok(isGenericName('WANDevice'))
    assert.ok(!isGenericName('ERLite-3'))
    assert.ok(!isGenericName('[LG] webOS TV OLED83G4WUA'))
  })
})
