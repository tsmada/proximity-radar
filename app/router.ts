import { createRouter, type Middleware, type MiddlewareContext } from 'remix/router'
import { cop } from 'remix/middleware/cop'
import { render } from 'remix/middleware/render'
import { staticFiles } from 'remix/middleware/static'

import controller from './actions/controller.tsx'
import { assets } from './assets.ts'
import { routes } from './routes.ts'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Binding to 127.0.0.1 keeps the LAN out, but a web page in this browser could still reach us
 * via DNS rebinding (attacker.example → 127.0.0.1). Its requests carry the attacker's Host, so
 * only answer requests addressed to a loopback name.
 */
export function loopbackOnly(): Middleware {
  return (context, next) => {
    if (!LOCAL_HOSTNAMES.has(context.url.hostname)) {
      return new Response('Forbidden: PHOSPHOR only answers on 127.0.0.1', { status: 403 })
    }
    return next()
  }
}

const renderMiddleware = render({ assets })
type AppContext = MiddlewareContext<[typeof renderMiddleware]>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

export const router = createRouter<AppContext>({
  // cop(): no cross-site form POSTs to /settings or /claim (e.g. a page silently enabling BLE).
  middleware: [loopbackOnly(), cop(), staticFiles('./public', { index: false }), renderMiddleware],
})

router.map(routes, controller)
