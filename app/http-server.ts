import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'

import { router } from './router.ts'

// Localhost only: this app scans the neighbourhood and must never be reachable from the LAN.
// Not configurable on purpose.
export const HOST = '127.0.0.1'

/** Create the HTTP server and start listening on 127.0.0.1. Resolves once bound; rejects on e.g. EADDRINUSE. */
export function listen(port: number, opts: { trustProxy?: boolean } = {}): Promise<http.Server> {
  let server = http.createServer(createRequestListener(router.fetch, { trustProxy: opts.trustProxy }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
