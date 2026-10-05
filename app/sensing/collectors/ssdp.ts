// Tier 0: UPnP / SSDP discovery → TVs, speakers, routers, printers.
//
// Every ~60 s we multicast one `M-SEARCH ssdp:all` to 239.255.255.250:1900
// and collect the unicast replies. For each host we fetch its device
// description XML at most once per 10 min, only from a private LAN IP that
// matches the replying host, with a short timeout and a size cap. Only the
// identity fields (friendlyName, manufacturer, modelName, deviceType) are kept.

import { createSocket, type Socket } from 'node:dgram'

import { classify } from '../kind.ts'
import { lookupVendor } from '../oui.ts'
import type { Collector, CollectorContext, CollectorHealth } from '../types.ts'
import { macForIp } from './arp.ts'
import {
  errorMessage,
  every,
  isLocalNetworkDenied,
  isPrivateIPv4,
  linkedController,
  LOCAL_NETWORK_HINT,
  localAddresses,
  localNet,
  poolHints,
} from './lan-util.ts'

export const SSDP_ID = 'lan-ssdp'

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const DESC_TTL_MS = 10 * 60_000
const DESC_TIMEOUT_MS = 2_500
const DESC_MAX_BYTES = 64 * 1024

export const M_SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 2',
  'ST: ssdp:all',
  'USER-AGENT: PHOSPHOR/1.0 UPnP/1.1',
  '',
  '',
].join('\r\n')

export type SsdpReply = {
  location?: string
  st?: string
  usn?: string
  server?: string
}

/** Parse an HTTP-over-UDP SSDP reply or NOTIFY. Header names are case-insensitive. */
export function parseSsdpMessage(text: string): SsdpReply | undefined {
  let lines = text.split(/\r?\n/)
  if (!/^(HTTP\/1\.[01] 200|NOTIFY \* HTTP)/i.test(lines[0] ?? '')) return undefined
  let headers: Record<string, string> = {}
  for (let line of lines.slice(1)) {
    let colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { location: headers.location, st: headers.st ?? headers.nt, usn: headers.usn, server: headers.server }
}

export type DeviceDescription = {
  deviceType?: string
  friendlyName?: string
  manufacturer?: string
  modelName?: string
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim()
}

/** Root `<device>` identity fields from a UPnP description document. */
export function parseDeviceDescription(xml: string): DeviceDescription {
  // Only look at the root device, before any nested <deviceList>/<serviceList>.
  let start = xml.search(/<device[\s>]/i)
  if (start < 0) return {}
  let rest = xml.slice(start)
  let end = rest.search(/<(deviceList|serviceList|iconList)[\s>]/i)
  let root = end > 0 ? rest.slice(0, end) : rest
  let field = (tag: string) => {
    let m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(root)
    let v = m ? decodeXml(m[1]) : ''
    return v || undefined
  }
  return {
    deviceType: field('deviceType'),
    friendlyName: field('friendlyName'),
    manufacturer: field('manufacturer'),
    modelName: field('modelName'),
  }
}

/** `192.168.1.73 - Sonos Arc - RINCON_804AF273819001400` → `Sonos Arc` */
export function cleanFriendlyName(name: string): string {
  return name
    .replace(/^\d{1,3}(\.\d{1,3}){3}\s*-\s*/, '')
    .replace(/\s*-\s*RINCON_[0-9A-F]+$/i, '')
    .trim()
}

/** Stock names from UPnP SDKs that say nothing about the device. */
export function isGenericName(name: string): boolean {
  return /^(linux )?internet gateway device$|^WAN(Connection)?Device$|^IGD\b|^UPnP |^MediaRenderer$|^MediaServer$/i.test(name.trim())
}

/** `Sonos, Inc.` → `Sonos`, `LG Electronics.` → `LG Electronics` */
export function cleanManufacturer(name: string): string {
  return name.replace(/[,.]?\s*(inc|corp|corporation|co|ltd|llc|gmbh)\.?$/i, '').replace(/[.,]+$/, '').trim()
}

/** Accept a description URL only if it points at the replying host on a private LAN address. */
export function safeLocation(location: string | undefined, fromIp: string): URL | undefined {
  if (!location) return undefined
  try {
    let url = new URL(location)
    if (url.protocol !== 'http:') return undefined
    if (url.hostname !== fromIp || !isPrivateIPv4(url.hostname)) return undefined
    return url
  } catch {
    return undefined
  }
}

async function fetchDescription(url: URL, signal: AbortSignal): Promise<DeviceDescription | undefined> {
  let res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(DESC_TIMEOUT_MS)]),
    headers: { accept: 'text/xml, application/xml' },
  })
  if (!res.ok || !res.body) return undefined
  // Read at most DESC_MAX_BYTES, then stop.
  let reader = res.body.getReader()
  let chunks: Uint8Array[] = []
  let size = 0
  while (size < DESC_MAX_BYTES) {
    let { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => {})
  return parseDeviceDescription(Buffer.concat(chunks).toString('utf8').slice(0, DESC_MAX_BYTES))
}

type HostState = {
  types: Set<string>
  servers: Set<string>
  locations: Set<string>
  desc?: DeviceDescription
  descAt: number
  descPending?: boolean
}

export function createSsdpCollector(opts: { searchMs?: number } = {}): Collector {
  let searchMs = opts.searchMs ?? 60_000
  let ctrl: AbortController | undefined
  let socket: Socket | undefined

  return {
    id: SSDP_ID,
    tier: 0,
    label: 'SSDP',
    defaultEnabled: true,

    async probe(): Promise<CollectorHealth> {
      if (!(await localNet())) return { state: 'error', detail: 'No private IPv4 network interface' }
      return { state: 'available' }
    },

    start(ctx: CollectorContext) {
      ctrl = linkedController(ctx.signal)
      let signal = ctrl.signal
      let hosts = new Map<string, HostState>()
      let denied = false

      let fail = (error: unknown) => {
        if (signal.aborted) return
        if (isLocalNetworkDenied(error)) {
          denied = true
          ctx.setHealth({ state: 'needs-permission', detail: LOCAL_NETWORK_HINT })
        } else {
          ctx.setHealth({ state: 'error', detail: errorMessage(error) })
        }
      }
      let report = () => {
        if (!denied) ctx.setHealth({ state: 'available', detail: `${hosts.size} UPnP hosts` })
      }

      let emit = async (ip: string, h: HostState) => {
        let mac = await macForIp(ip, signal)
        if (signal.aborted) return
        let d = h.desc ?? {}
        let name = d.friendlyName && !isGenericName(d.friendlyName) ? cleanFriendlyName(d.friendlyName) : undefined
        let manufacturer = d.manufacturer ? cleanManufacturer(d.manufacturer) : undefined
        let vendor = manufacturer ?? (mac ? lookupVendor(mac) : undefined)
        let { kind, strength } = classify({
          model: d.modelName,
          upnpTypes: [...(d.deviceType ? [d.deviceType] : []), ...h.types],
          names: [name, ...h.servers],
          vendor,
        })
        let pooled = poolHints(ip, {
          mac,
          name,
          nameRank: name ? 3 : undefined,
          kind,
          kindStrength: strength,
          vendor,
          vendorRank: manufacturer ? 2 : 1,
        })
        ctx.emit({
          source: 'lan',
          collector: SSDP_ID,
          key: mac ?? ip,
          mac,
          ip,
          name: pooled.name,
          vendor: pooled.vendor,
          vendorFromDevice: pooled.vendorRank === 2,
          kind: pooled.kind,
          at: Date.now(),
        })
      }

      let describe = async (ip: string, h: HostState) => {
        if (h.descPending || Date.now() - h.descAt < DESC_TTL_MS) return
        h.descPending = true
        try {
          // Hosts often expose several descriptions (a router's stock IGD stub next to
          // miniupnpd). Stop at the first one with a real name; else keep any we got.
          for (let loc of h.locations) {
            let url = safeLocation(loc, ip)
            if (!url) continue
            try {
              let desc = await fetchDescription(url, signal)
              if (!desc?.friendlyName && !desc?.deviceType) continue
              if (!h.desc || isGenericName(h.desc.friendlyName ?? '')) h.desc = desc
              if (desc.friendlyName && !isGenericName(desc.friendlyName)) break
            } catch {
              // Timeout / refused / not XML: try the next location.
            }
          }
          h.descAt = Date.now()
        } finally {
          h.descPending = false
        }
      }

      // Replies for one search arrive over ~MX seconds; batch them per host.
      let flushTimer: ReturnType<typeof setTimeout> | undefined
      let dirty = new Set<string>()
      let flush = async () => {
        flushTimer = undefined
        let ips = [...dirty]
        dirty.clear()
        for (let ip of ips) {
          let h = hosts.get(ip)
          if (!h || signal.aborted) continue
          await describe(ip, h)
          if (signal.aborted) return
          await emit(ip, h)
        }
        report()
      }

      let onMessage = (msg: Buffer, rinfo: { address: string }) => {
        let ip = rinfo.address
        if (!isPrivateIPv4(ip) || localAddresses().has(ip)) return
        let reply = parseSsdpMessage(msg.toString('utf8', 0, Math.min(msg.length, 4096)))
        if (!reply) return
        let h = hosts.get(ip)
        if (!h) hosts.set(ip, (h = { types: new Set(), servers: new Set(), locations: new Set(), descAt: 0 }))
        if (reply.st && h.types.size < 64) h.types.add(reply.st)
        if (reply.server && h.servers.size < 8) h.servers.add(reply.server)
        if (reply.location && h.locations.size < 8) h.locations.add(reply.location)
        dirty.add(ip)
        if (!flushTimer) {
          flushTimer = setTimeout(() => flush().catch(fail), 3_000)
          flushTimer.unref?.()
        }
      }

      localNet(signal)
        .then((net) => {
          if (signal.aborted) return
          let sock = createSocket({ type: 'udp4', reuseAddr: true })
          socket = sock
          sock.on('message', onMessage)
          sock.on('error', fail)
          sock.bind(0, () => {
            if (signal.aborted) return
            if (net) {
              try {
                sock.setMulticastInterface(net.address)
              } catch {
                // Fall back to the OS default route.
              }
            }
            sock.setMulticastTTL(2)
            let search = () => {
              let buf = Buffer.from(M_SEARCH)
              sock.send(buf, SSDP_PORT, SSDP_ADDR, (error) => error && fail(error))
            }
            every(searchMs, signal, search, fail)
          })
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(flushTimer)
              try {
                sock.close()
              } catch {
                // Already closed.
              }
            },
            { once: true },
          )
        })
        .catch(fail)
    },

    stop() {
      ctrl?.abort()
      ctrl = undefined
      socket = undefined
    },
  }
}
