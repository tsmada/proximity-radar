import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { CollectorStatus, Contact } from '../../sensing/types.ts'
import { apply, streamStore } from './stream-client.ts'

const contact = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  label: id,
  kind: 'phone',
  ring: 'near',
  confidence: 0.5,
  sources: ['ble'],
  randomizedMac: true,
  firstSeen: 0,
  lastSeen: 0,
  state: 'active',
  ...extra,
})

const cap: CollectorStatus = { id: 'ble', tier: 1, label: 'BLE', state: 'available', enabled: true }

describe('stream client store', () => {
  it('applies snapshot, upsert, lost and a re-upsert of the same id', () => {
    apply({ type: 'snapshot', contacts: [contact('aaaaaaaaaaaa')], caps: [] })
    assert.equal(streamStore.getState().contacts.size, 1)
    apply({ type: 'lost', id: 'aaaaaaaaaaaa' })
    assert.equal(streamStore.getState().contacts.has('aaaaaaaaaaaa'), false)
    apply({ type: 'upsert', contact: contact('aaaaaaaaaaaa', { ring: 'far' }) })
    assert.equal(streamStore.getState().contacts.get('aaaaaaaaaaaa')?.ring, 'far')
  })

  it('caps events replace the collector list', () => {
    apply({ type: 'caps', caps: [cap] })
    assert.deepEqual(streamStore.getState().caps, [cap])
    apply({ type: 'caps', caps: [{ ...cap, state: 'disabled', enabled: false }] })
    assert.equal(streamStore.getState().caps[0].state, 'disabled')
  })
})
