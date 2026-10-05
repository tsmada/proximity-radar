import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { router } from '../router.ts'
import { routes } from '../routes.ts'
import type { StreamEvent } from '../sensing/types.ts'

const origin = 'http://127.0.0.1:4777'

describe('root controller', () => {
  it('GET / renders the radar shell', async () => {
    let response = await router.fetch(new URL(routes.home.href(), origin))

    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /text\/html/)
    let html = await response.text()
    assert.match(html, /<canvas[^>]*id="scope"/)
    assert.match(html, /<table[^>]*id="readout"/)
  })

  it('GET /stream is text/event-stream and starts with a snapshot', async () => {
    let controller = new AbortController()
    let response = await router.fetch(
      new Request(new URL(routes.stream.href(), origin), { signal: controller.signal }),
    )

    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type') ?? '', /^text\/event-stream/)

    let reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    while (!text.includes('data: ')) {
      let { value, done } = await reader.read()
      if (done) break
      text += value
    }
    let firstData = text.split('\n').find((line) => line.startsWith('data: '))!
    let event = JSON.parse(firstData.slice('data: '.length)) as StreamEvent
    assert.equal(event.type, 'snapshot')
    if (event.type === 'snapshot') {
      assert.ok(Array.isArray(event.contacts))
      assert.ok(Array.isArray(event.caps))
    }
    controller.abort()
    await reader.cancel()
  })

  it('GET /status returns collector caps as JSON', async () => {
    let response = await router.fetch(new URL(routes.status.href(), origin))
    assert.equal(response.status, 200)
    let body = (await response.json()) as { caps: unknown[]; settings: { demo: string } }
    assert.ok(Array.isArray(body.caps))
    assert.equal(body.settings.demo, 'auto')
  })

  it('POST /settings redirects back and rejects bad input', async () => {
    let ok = new FormData()
    ok.set('demo', 'auto')
    let response = await router.fetch(
      new Request(new URL(routes.settings.href(), origin), { method: 'POST', body: ok }),
    )
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/')

    let bad = new FormData()
    bad.set('demo', 'maybe')
    let rejected = await router.fetch(
      new Request(new URL(routes.settings.href(), origin), { method: 'POST', body: bad }),
    )
    assert.equal(rejected.status, 400)
  })
})
