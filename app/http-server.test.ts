import * as net from 'node:net'
import { networkInterfaces } from 'node:os'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { HOST, listen } from './http-server.ts'
import { router } from './router.ts'
import { routes } from './routes.ts'

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket = net.connect({ host, port, timeout: 1000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address)
}

describe('http server', () => {
  it('binds to 127.0.0.1 only', async () => {
    let server = await listen(0)
    try {
      let addr = server.address() as net.AddressInfo
      assert.equal(HOST, '127.0.0.1')
      assert.equal(addr.address, '127.0.0.1')
      assert.equal(await canConnect('127.0.0.1', addr.port), true)
      // Every LAN-facing address of this machine must refuse the connection.
      for (let ip of lanAddresses()) assert.equal(await canConnect(ip, addr.port), false, `reachable on ${ip}`)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('rejects requests addressed to a non-loopback host (DNS rebinding)', async () => {
    let ok = await router.fetch(new URL(routes.status.href(), 'http://localhost:4777'))
    assert.equal(ok.status, 200)
    let rebound = await router.fetch(new URL(routes.status.href(), 'http://evil.example:4777'))
    assert.equal(rebound.status, 403)
  })

  it('rejects cross-site form POSTs', async () => {
    let body = new FormData()
    body.set('collector', 'ble')
    body.set('enabled', 'on')
    let response = await router.fetch(
      new Request(new URL(routes.settings.href(), 'http://127.0.0.1:4777'), {
        method: 'POST',
        body,
        headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
      }),
    )
    assert.equal(response.status, 403)
  })
})
