import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { router } from '../router.ts'
import { routes } from '../routes.ts'
import { fusion, hub } from '../sensing/registry.ts'

const origin = 'http://127.0.0.1:4777'

function post(fields: Record<string, string>) {
  let body = new FormData()
  for (let [k, v] of Object.entries(fields)) body.set(k, v)
  return router.fetch(new Request(new URL(routes.claim.href(), origin), { method: 'POST', body }))
}

describe('POST /claim', () => {
  it('claims, unclaims and merges contacts, then redirects home', async () => {
    let at = Date.now()
    fusion.ingest({ source: 'lan', collector: 'test-lan', key: 'host.local', name: 'host.local', at })
    fusion.ingest({ source: 'ble', collector: 'test-ble', key: 'uuid-1', rssi: -55, at })
    let [lan, ble] = hub.snapshot().filter((c) => c.label === 'host.local' || c.sources.includes('ble'))

    let res = await post({ id: lan.id, action: 'claim' })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('Location'), '/')
    assert.equal(hub.snapshot().find((c) => c.id === lan.id)?.claimed, true)

    assert.equal((await post({ id: lan.id, action: 'unclaim' })).status, 303)
    assert.equal(hub.snapshot().find((c) => c.id === lan.id)?.claimed, undefined)

    assert.equal((await post({ id: ble.id, action: 'merge', into: lan.id })).status, 303)
    assert.equal(hub.snapshot().some((c) => c.id === ble.id), false)
    assert.deepEqual(hub.snapshot().find((c) => c.id === lan.id)?.sources, ['lan', 'ble'])

    fusion.forget('test-lan')
    fusion.forget('test-ble')
  })

  it('rejects bad input with 400', async () => {
    assert.equal((await post({ action: 'claim' })).status, 400)
    assert.equal((await post({ id: 'not-an-id', action: 'claim' })).status, 400)
    assert.equal((await post({ id: 'abcdefabcdef', action: 'steal' })).status, 400)
    assert.equal((await post({ id: 'abcdefabcdef', action: 'claim' })).status, 400) // unknown contact
    assert.equal((await post({ id: 'abcdefabcdef', action: 'merge' })).status, 400)
    assert.equal((await post({ id: 'abcdefabcdef', action: 'merge', into: 'abcdefabcdef' })).status, 400)
  })
})
