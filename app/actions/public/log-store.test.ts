import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { Contact } from '../../sensing/types.ts'
import { createLogMemory, describeEvent, flushPending } from './log-store.ts'

function contact(id: string, label: string, extra: Partial<Contact> = {}): Contact {
  return {
    id,
    label,
    kind: 'phone',
    ring: 'near',
    confidence: 0.72,
    sources: ['ble'],
    randomizedMac: true,
    firstSeen: 0,
    lastSeen: 0,
    state: 'new',
    ...extra,
  }
}

describe('event log', () => {
  it('logs + CONTACT once per new id and x LOST with the remembered label', () => {
    let mem = createLogMemory()
    describeEvent(mem, { type: 'snapshot', contacts: [contact('a', 'iPhone')], caps: [] })

    assert.equal(describeEvent(mem, { type: 'upsert', contact: contact('a', 'iPhone') }).length, 0)
    let added = describeEvent(mem, { type: 'upsert', contact: contact('b', 'Pixel') })
    assert.equal(added.length, 1)
    assert.equal(added[0].kind, 'new')
    assert.match(added[0].text, /^\+ CONTACT PIXEL ◆ NEAR · BLE 72%/)
    assert.ok(added[0].announce)

    // A lost is held back one event (it might be a merge), then released as LOST.
    assert.equal(describeEvent(mem, { type: 'lost', id: 'b' }).length, 0)
    let lost = describeEvent(mem, { type: 'upsert', contact: contact('a', 'iPhone') })
    assert.equal(lost.length, 1)
    assert.equal(lost[0].kind, 'lost')
    assert.match(lost[0].text, /^x LOST\s+PIXEL/)

    describeEvent(mem, { type: 'lost', id: 'a' })
    let flushed = flushPending(mem)
    assert.match(flushed[0].text, /^x LOST\s+IPHONE/)
    assert.equal(flushPending(mem).length, 0)
  })

  it('reports a merge (lost, then the target upserted with more sources) as MERGED', () => {
    let mem = createLogMemory()
    describeEvent(mem, {
      type: 'snapshot',
      contacts: [
        contact('lan1', 'adams-iphone', { sources: ['lan'], ring: 'onnet' }),
        contact('ble1', 'iPhone', { sources: ['ble'] }),
      ],
      caps: [],
    })
    assert.equal(describeEvent(mem, { type: 'lost', id: 'ble1' }).length, 0)
    let merged = describeEvent(mem, {
      type: 'upsert',
      contact: contact('lan1', 'adams-iphone', { sources: ['lan', 'ble'] }),
    })
    assert.equal(merged.length, 1)
    assert.equal(merged[0].text, '~ MERGED  IPHONE → ADAMS-IPHONE · BLE+LAN')
    assert.ok(!merged.some((l) => l.kind === 'lost'))
    assert.equal(flushPending(mem).length, 0)

    // Same sources afterwards → an ordinary LOST, not a merge.
    describeEvent(mem, { type: 'lost', id: 'lan1' })
    let plain = describeEvent(mem, { type: 'upsert', contact: contact('x', 'Other', { sources: ['ble'] }) })
    assert.equal(plain[0].kind, 'lost')
  })

  it('reports sensor state changes but not detail churn', () => {
    let mem = createLogMemory()
    let base = { id: 'ble', tier: 1 as const, label: 'BLE', enabled: true }
    assert.ok(
      describeEvent(mem, { type: 'snapshot', contacts: [], caps: [{ ...base, state: 'needs-permission', detail: 'Allow Bluetooth' }] }).some(
        (l) => l.kind === 'warn' && /Allow Bluetooth/.test(l.text),
      ),
    )
    let changed = describeEvent(mem, { type: 'caps', caps: [{ ...base, state: 'available', detail: '3 devices' }] })
    assert.equal(changed.length, 1)
    assert.match(changed[0].text, /SENSOR BLE \[T1\] AVAILABLE/)
    assert.equal(describeEvent(mem, { type: 'caps', caps: [{ ...base, state: 'available', detail: '4 devices' }] }).length, 0)
  })
})
