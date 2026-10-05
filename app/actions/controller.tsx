import { createRedirectResponse } from 'remix/response/redirect'
import { createController } from 'remix/router'

import { assets } from '../assets.ts'
import { routes } from '../routes.ts'
import { fusion, hub, registry, type DemoMode } from '../sensing/registry.ts'
import type { StreamEvent } from '../sensing/types.ts'
import { RadarPage } from '../ui/radar-page.tsx'

const KEEPALIVE_MS = 15_000
const DEMO_MODES: DemoMode[] = ['auto', 'on', 'off']
const CONTACT_ID = /^[0-9a-f]{12}$/

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },

    home(context) {
      return context.render(
        <RadarPage contacts={hub.snapshot()} caps={hub.caps()} demo={registry.settings().demo} />,
      )
    },

    // SSE: snapshot first, then every hub event, plus a comment keepalive.
    stream({ request }) {
      let encoder = new TextEncoder()
      let cleanup = () => {}
      let body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          let write = (chunk: string) => {
            if (!closed) controller.enqueue(encoder.encode(chunk))
          }
          let send = (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`)

          write('retry: 2000\n\n')
          send({ type: 'snapshot', contacts: hub.snapshot(), caps: hub.caps() })
          let off = hub.subscribe(send)
          let keepalive = setInterval(() => write(': ka\n\n'), KEEPALIVE_MS)

          cleanup = () => {
            if (closed) return
            closed = true
            off()
            clearInterval(keepalive)
            try {
              controller.close()
            } catch {}
          }
          if (request.signal.aborted) cleanup()
          else request.signal.addEventListener('abort', cleanup, { once: true })
        },
        cancel() {
          cleanup()
        },
      })

      return new Response(body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    },

    status() {
      return Response.json({
        caps: hub.caps(),
        settings: registry.settings(),
        contacts: hub.snapshot().length,
      })
    },

    // Form fields: `demo=auto|on|off`, and/or `collector=<id>` + `enabled=on|off`.
    async settings({ request }) {
      let form = await request.formData()
      let demo = form.get('demo')
      let collector = form.get('collector')
      let enabled = form.get('enabled')

      if (demo !== null) {
        if (!DEMO_MODES.includes(demo as DemoMode)) {
          return new Response('Invalid demo mode', { status: 400 })
        }
        await registry.setDemo(demo as DemoMode)
      }
      if (collector !== null) {
        if (typeof collector !== 'string' || !registry.statuses().some((c) => c.id === collector)) {
          return new Response('Unknown collector', { status: 400 })
        }
        if (enabled !== 'on' && enabled !== 'off') {
          return new Response('enabled must be on|off', { status: 400 })
        }
        await registry.setEnabled(collector, enabled === 'on')
      }
      return createRedirectResponse(routes.home.href(), 303)
    },

    // Form fields: `id` (contact id), `action=claim|unclaim|merge`, and `into` (target id) for merge.
    async claim({ request }) {
      let form = await request.formData()
      let id = form.get('id')
      let action = form.get('action')
      let into = form.get('into')

      if (typeof id !== 'string' || !CONTACT_ID.test(id)) {
        return new Response('id must be a contact id', { status: 400 })
      }
      let result
      if (action === 'claim' || action === 'unclaim') {
        result = fusion.claim(id, action === 'claim')
      } else if (action === 'merge') {
        if (typeof into !== 'string' || !CONTACT_ID.test(into)) {
          return new Response('into must be a contact id', { status: 400 })
        }
        result = fusion.merge(id, into)
      } else {
        return new Response('action must be claim|unclaim|merge', { status: 400 })
      }
      if (!result.ok) return new Response(result.error, { status: 400 })
      return createRedirectResponse(routes.home.href(), 303)
    },
  },
})
