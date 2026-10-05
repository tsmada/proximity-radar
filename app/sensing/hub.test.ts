import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createHub } from './hub.ts'
import type { Contact } from './types.ts'

const contact = (id: string): Contact => ({
  id,
  label: id,
  kind: 'unknown',
  ring: 'onnet',
  confidence: 0,
  sources: ['lan'],
  randomizedMac: false,
  firstSeen: 0,
  lastSeen: 0,
  state: 'new',
})

describe('hub', () => {
  it('folds events into the snapshot, including a lost id coming back', () => {
    let hub = createHub()
    hub.publish({ type: 'upsert', contact: contact('aaaaaaaaaaaa') })
    hub.publish({ type: 'lost', id: 'aaaaaaaaaaaa' })
    assert.equal(hub.snapshot().length, 0)
    hub.publish({ type: 'upsert', contact: contact('aaaaaaaaaaaa') })
    assert.deepEqual(hub.snapshot().map((c) => c.id), ['aaaaaaaaaaaa'])
  })

  it('a throwing subscriber cannot break publishing or other subscribers', () => {
    let hub = createHub()
    let seen = 0
    let error = console.error
    console.error = () => {}
    try {
      hub.subscribe(() => {
        throw new Error('closed stream')
      })
      hub.subscribe(() => seen++)
      hub.publish({ type: 'caps', caps: [] })
    } finally {
      console.error = error
    }
    assert.equal(seen, 1)
  })

  it('unsubscribe stops delivery', () => {
    let hub = createHub()
    let seen = 0
    let off = hub.subscribe(() => seen++)
    off()
    hub.publish({ type: 'caps', caps: [] })
    assert.equal(seen, 0)
  })
})
