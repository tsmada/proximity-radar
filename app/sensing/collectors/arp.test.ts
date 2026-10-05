import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { isDeviceEntry, parseArpTable, pingArgs } from './arp.ts'
import { parseDefaultRoute, sweepTargets } from './lan-util.ts'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
const SELF = new Set(['127.0.0.1', '192.168.1.116'])

describe('parseArpTable (`arp -an`)', () => {
  let rows = parseArpTable(fixture('arp-an.txt'))

  it('parses every complete entry and pads short macOS octets', () => {
    let gw = rows.find((r) => r.ip === '192.168.1.1')
    assert.deepEqual(gw, { ip: '192.168.1.1', mac: '74:83:c2:00:00:10', iface: 'en0', permanent: false })
    assert.equal(rows.find((r) => r.ip === '192.168.1.217')?.mac, 'dc:06:75:00:00:e0')
  })

  it('drops incomplete entries', () => {
    assert.equal(rows.find((r) => r.ip === '192.168.1.99'), undefined)
  })

  it('marks permanent entries (our own interface, multicast groups)', () => {
    assert.equal(rows.find((r) => r.ip === '192.168.1.116')?.permanent, true)
    assert.equal(rows.find((r) => r.ip === '224.0.0.251')?.permanent, true)
  })

  it('isDeviceEntry keeps real neighbours only', () => {
    let devices = rows.filter((r) => isDeviceEntry(r, SELF)).map((r) => r.ip)
    assert.equal(devices.length, 16)
    for (let skip of ['192.168.1.116', '192.168.1.255', '224.0.0.251', '239.255.255.250']) {
      assert.ok(!devices.includes(skip), skip)
    }
  })

  it('parses Linux net-tools output', () => {
    let linux = parseArpTable(
      '? (10.0.0.1) at 74:83:c2:00:00:10 [ether] on eth0\n? (10.0.0.9) at <incomplete> on eth0\n',
    )
    assert.deepEqual(linux, [{ ip: '10.0.0.1', mac: '74:83:c2:00:00:10', iface: 'eth0', permanent: false }])
  })
})

describe('parseArpTable (`arp -anl`, macOS)', () => {
  let rows = parseArpTable(fixture('arp-anl.txt'))

  it('reads freshness from the expiry columns', () => {
    assert.equal(rows.find((r) => r.ip === '192.168.1.1')?.fresh, true)
    assert.equal(rows.find((r) => r.ip === '192.168.1.73')?.fresh, false)
  })

  it('treats (none)/(none) as a permanent entry', () => {
    let self = rows.find((r) => r.ip === '192.168.1.116')
    assert.equal(self?.permanent, true)
    assert.ok(!isDeviceEntry(self!, new Set()))
  })

  it('skips the header line and incomplete rows', () => {
    assert.ok(rows.every((r) => /^\d+\.\d+\.\d+\.\d+$/.test(r.ip)))
    assert.equal(rows.find((r) => r.ip === '192.168.1.99'), undefined)
  })
})

describe('sweep helpers', () => {
  it('sweeps a /24 minus network, broadcast and ourselves', () => {
    let t = sweepTargets({ address: '192.168.1.116', prefix: 24 }, SELF)
    assert.equal(t.length, 253)
    assert.equal(t[0], '192.168.1.1')
    assert.equal(t.at(-1), '192.168.1.254')
    assert.ok(!t.includes('192.168.1.116'))
  })

  it('clamps bigger networks to our /24', () => {
    let t = sweepTargets({ address: '10.20.30.40', prefix: 16 })
    assert.equal(t.length, 254)
    assert.equal(t[0], '10.20.30.1')
  })

  it('honours smaller subnets', () => {
    assert.deepEqual(sweepTargets({ address: '192.168.5.9', prefix: 29 }), [
      '192.168.5.9',
      '192.168.5.10',
      '192.168.5.11',
      '192.168.5.12',
      '192.168.5.13',
      '192.168.5.14',
    ])
  })

  it('sends a single echo with a short timeout', () => {
    let args = pingArgs('192.168.1.1')
    assert.deepEqual(args.slice(-1), ['192.168.1.1'])
    assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === '1')
  })

  it('reads the default route interface', () => {
    assert.equal(parseDefaultRoute('   route to: default\n  gateway: 192.168.1.1\n  interface: en0\n'), 'en0')
  })
})
