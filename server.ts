import { HOST, listen } from './app/http-server.ts'
import { registry } from './app/sensing/registry.ts'

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4777
const hmrProxyPort = process.env.HMR_PROXY_PORT
  ? Number.parseInt(process.env.HMR_PROXY_PORT, 10)
  : null
const isHmr = process.env.REMIX_NODE_HMR === '1'

await registry.start()

let server: Awaited<ReturnType<typeof listen>>
try {
  server = await listen(port, { trustProxy: isHmr })
} catch (error) {
  console.error(`PHOSPHOR could not listen on ${HOST}:${port}: ${error instanceof Error ? error.message : error}`)
  await registry.stop()
  process.exit(1)
}

if (isHmr) {
  import('remix/node-hmr/runtime').then((nodeHmr) => nodeHmr.emitServerReady())
}
console.log(`PHOSPHOR listening on http://${HOST}:${hmrProxyPort ?? port}`)

let shuttingDown = false

function shutdown() {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  registry.stop().finally(() => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
