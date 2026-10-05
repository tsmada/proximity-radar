import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { classify } from '../kind.ts'
import { bestName, parseMdnsResponse, splitInstance, type MdnsHost, type MdnsRecord } from './mdns.ts'

type Packet = { from: string; records: MdnsRecord[] }
const packets: Packet[] = JSON.parse(
  readFileSync(new URL('./__fixtures__/mdns-responses.json', import.meta.url), 'utf8'),
)

/** Parse every fixture packet and merge hosts by IP, like the collector's pooled view. */
function allHosts(): Map<string, MdnsHost[]> {
  let out = new Map<string, MdnsHost[]>()
  for (let p of packets) {
    for (let h of parseMdnsResponse(p.records, p.from).hosts) out.set(h.ip, [...(out.get(h.ip) ?? []), h])
  }
  return out
}

function hostFrom(ip: string): MdnsHost {
  let hs = allHosts().get(ip) ?? []
  // Prefer the richest packet for that host.
  return hs.sort((a, b) => b.instances.length - a.instances.length)[0]
}

describe('splitInstance', () => {
  it('splits instance label from service type', () => {
    assert.deepEqual(splitInstance('Living Room._airplay._tcp.local'), { label: 'Living Room', service: '_airplay._tcp' })
    assert.deepEqual(splitInstance('a.b._ipp._tcp.local'), { label: 'a.b', service: '_ipp._tcp' })
    assert.equal(splitInstance('_airplay._tcp.local'), undefined)
    assert.equal(splitInstance('LGwebOSTV.local'), undefined)
  })
})

describe('parseMdnsResponse (real captures)', () => {
  it('collects service types from _services enumeration', () => {
    let types = new Set(packets.flatMap((p) => parseMdnsResponse(p.records, p.from).serviceTypes))
    assert.ok(types.has('_sonos._tcp.local'))
    assert.ok(types.has('_hap._tcp.local'))
  })

  it('Sonos: room name, model and media kind', () => {
    let h = hostFrom('192.168.1.73')
    assert.equal(h.model, 'Arc')
    assert.equal(h.manufacturer, 'Sonos')
    assert.deepEqual(bestName(h), { name: 'Living Room', rank: 4 })
    assert.equal(classify({ model: h.model, services: h.instances.map((i) => i.service) }).kind, 'media')
  })

  it('LG TV via googlecast: friendly name from TXT fn', () => {
    let h = allHosts().get('192.168.1.232')!.find((x) => x.friendlyName)!
    assert.equal(h.friendlyName, '[LG] webOS TV OLED83G4WUA')
    assert.equal(bestName(h).name, '[LG] webOS TV OLED83G4WUA')
    assert.equal(classify({ model: h.model, services: h.instances.map((i) => i.service) }).kind, 'media')
  })

  it('Mac: device-info model → laptop, even though it also offers AirPlay', () => {
    let h = hostFrom('192.168.1.208')
    assert.match(h.model ?? '', /^MacBook/)
    assert.equal(bestName(h).name, 'Guest’s MacBook Pro')
    assert.equal(classify({ model: h.model, services: h.instances.map((i) => i.service) }).kind, 'laptop')
  })

  it('HP printer: instance name and printer kind', () => {
    let h = hostFrom('192.168.1.164')
    assert.equal(bestName(h).name, 'HP OfficeJet Pro 9010 series [000000]')
    assert.equal(classify({ model: h.model, services: h.instances.map((i) => i.service) }).kind, 'printer')
  })

  it('Lutron bridge: HomeKit → iot', () => {
    let h = hostFrom('192.168.1.156')
    assert.equal(h.model, 'Smart Bridge 2')
    assert.equal(bestName(h).name, 'Smart Bridge 2')
    assert.equal(classify({ model: h.model, services: h.instances.map((i) => i.service) }).kind, 'iot')
  })

  it('falls back to the hostname and skips id-like names', () => {
    // An iPhone that only advertises uuid-named instances.
    let phone = hostFrom('192.168.1.115')
    assert.deepEqual(bestName(phone), { name: 'Example-iPhone', rank: 1 })
    assert.equal(classify({ names: [bestName(phone).name] }).kind, 'phone')
    // `none.local` + a generic SpotifyConnect instance → nothing usable.
    assert.equal(bestName(hostFrom('192.168.1.42')).name, undefined)
    // Reverse-DNS service instance is not a name; the hostname is.
    assert.equal(bestName(hostFrom('192.168.1.210')).name, 'jdoe-mac')
  })

  it('attributes instances to the SRV target address', () => {
    let records: MdnsRecord[] = [
      { name: '_airplay._tcp.local', type: 'PTR', data: 'Den._airplay._tcp.local' },
      { name: 'Den._airplay._tcp.local', type: 'SRV', data: { port: 7000, target: 'den-tv.local' } },
      { name: 'Den._airplay._tcp.local', type: 'TXT', data: [Buffer.from('model=AppleTV14,1')] },
      { name: 'den-tv.local', type: 'A', data: '192.168.1.50' },
    ]
    // Sent by a sleep proxy at .2 on behalf of .50.
    let { hosts } = parseMdnsResponse(records, '192.168.1.2')
    assert.equal(hosts.length, 1)
    assert.equal(hosts[0].ip, '192.168.1.50')
    assert.equal(hosts[0].model, 'AppleTV14,1')
    assert.equal(classify({ model: hosts[0].model }).kind, 'media')
  })
})
