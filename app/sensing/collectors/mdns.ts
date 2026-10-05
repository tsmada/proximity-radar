// Tier 0: Bonjour / mDNS discovery → names, models and kinds of LAN hosts.
//
// Every ~30 s we multicast PTR questions for `_services._dns-sd._udp` (service
// enumeration) plus a list of well-known service types, then listen to every
// response on 224.0.0.251:5353 (also unsolicited announcements). Records are
// grouped per IPv4 host; we keep only identity data (names, model, service
// types) and never anything else from TXT records.

import makeMdns from 'multicast-dns'

import { classify } from '../kind.ts'
import { lookupVendor } from '../oui.ts'
import type { Collector, CollectorContext, CollectorHealth } from '../types.ts'
import { macForIp } from './arp.ts'
import {
  errorMessage,
  every,
  isIPv4,
  isLocalNetworkDenied,
  isPrivateIPv4,
  linkedController,
  LOCAL_NETWORK_HINT,
  localAddresses,
  localNet,
  poolHints,
  type NameRank,
} from './lan-util.ts'

export const MDNS_ID = 'lan-mdns'

const ENUM_TYPE = '_services._dns-sd._udp.local'

/** Queried on every round, alongside whatever service enumeration turns up. */
export const KNOWN_SERVICES = [
  '_device-info._tcp.local',
  '_companion-link._tcp.local',
  '_airplay._tcp.local',
  '_raop._tcp.local',
  '_googlecast._tcp.local',
  '_sonos._tcp.local',
  '_spotify-connect._tcp.local',
  '_ipp._tcp.local',
  '_ipps._tcp.local',
  '_printer._tcp.local',
  '_pdl-datastream._tcp.local',
  '_hap._tcp.local',
  '_matter._tcp.local',
  '_smb._tcp.local',
  '_ssh._tcp.local',
  '_rfb._tcp.local',
  '_airport._tcp.local',
  '_http._tcp.local',
]

const MAX_SERVICE_TYPES = 64

/** The subset of a decoded DNS record we look at. `data` shape depends on `type`. */
export type MdnsRecord = { name: string; type: string; data?: unknown }

export type MdnsHost = {
  ip: string
  hostnames: string[]
  /** Service type → instance label, e.g. `_airplay._tcp` → `Living Room`. */
  instances: Array<{ service: string; label: string }>
  model?: string
  manufacturer?: string
  /** googlecast `fn`: the user-visible device name. */
  friendlyName?: string
}

export type ParsedResponse = {
  hosts: MdnsHost[]
  /** Service types advertised via `_services._dns-sd._udp` enumeration. */
  serviceTypes: string[]
}

function txtToMap(data: unknown): Record<string, string> {
  let items = Array.isArray(data) ? data : data === undefined ? [] : [data]
  let out: Record<string, string> = {}
  for (let item of items) {
    let s = typeof item === 'string' ? item : Buffer.isBuffer(item) ? item.toString('utf8') : ''
    let eq = s.indexOf('=')
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1)
  }
  return out
}

/** `Living Room._airplay._tcp.local` → { label: 'Living Room', service: '_airplay._tcp' } */
export function splitInstance(name: string): { label: string; service: string } | undefined {
  let m = /^(.*)\.(_[^.]+\._(?:tcp|udp))\.local\.?$/i.exec(name)
  if (!m || !m[1]) return undefined
  return { label: m[1], service: m[2].toLowerCase() }
}

/**
 * Group one response packet's records (answers + additionals) into hosts.
 * Instances are attributed via SRV target → A record; anything we can't place
 * is attributed to the packet's sender.
 */
export function parseMdnsResponse(records: MdnsRecord[], fromIp: string): ParsedResponse {
  let ipOfHost = new Map<string, string>() // lower-cased hostname → IPv4
  let displayHost = new Map<string, string>() // lower-cased → as advertised
  let srvTarget = new Map<string, string>()
  let txt = new Map<string, Record<string, string>>()
  let instanceNames = new Set<string>()
  let serviceTypes = new Set<string>()

  for (let r of records) {
    let name = r.name
    switch (r.type) {
      case 'A':
        if (typeof r.data === 'string' && isIPv4(r.data)) {
          ipOfHost.set(name.toLowerCase(), r.data)
          displayHost.set(name.toLowerCase(), name)
        }
        break
      case 'PTR':
        if (typeof r.data !== 'string') break
        if (name.toLowerCase() === ENUM_TYPE) serviceTypes.add(r.data.toLowerCase())
        else if (splitInstance(r.data)) instanceNames.add(r.data)
        break
      case 'SRV': {
        let target = (r.data as { target?: string } | undefined)?.target
        if (target) srvTarget.set(name, target.toLowerCase())
        if (splitInstance(name)) instanceNames.add(name)
        break
      }
      case 'TXT':
        txt.set(name, txtToMap(r.data))
        if (splitInstance(name)) instanceNames.add(name)
        break
    }
  }

  let hosts = new Map<string, MdnsHost>()
  let hostFor = (ip: string) => {
    let h = hosts.get(ip)
    if (!h) hosts.set(ip, (h = { ip, hostnames: [], instances: [] }))
    return h
  }

  for (let [key, ip] of ipOfHost) {
    let h = hostFor(ip)
    let hostname = displayHost.get(key) ?? key
    if (!h.hostnames.includes(hostname)) h.hostnames.push(hostname)
  }

  for (let inst of instanceNames) {
    let parts = splitInstance(inst)!
    let target = srvTarget.get(inst)
    let ip = (target && ipOfHost.get(target)) || fromIp
    let h = hostFor(ip)
    h.instances.push(parts)
    let kv = txt.get(inst) ?? {}
    switch (parts.service) {
      case '_device-info._tcp':
        h.model = kv.model ?? h.model
        break
      case '_airplay._tcp':
        h.model ??= kv.model
        h.manufacturer ??= kv.manufacturer
        break
      case '_raop._tcp':
        h.model ??= kv.am
        break
      case '_googlecast._tcp':
        h.friendlyName ??= kv.fn
        h.model ??= kv.md
        break
      case '_hap._tcp':
        h.model ??= kv.md
        break
      case '_ipp._tcp':
      case '_ipps._tcp':
      case '_printer._tcp':
        h.model ??= kv.ty ?? kv.product?.replace(/^\(|\)$/g, '')
        h.manufacturer ??= kv.usb_mfg
        break
    }
  }

  return { hosts: [...hosts.values()], serviceTypes: [...serviceTypes] }
}

/** Services whose instance label is the device's user-facing name. */
const DEVICE_NAME_SERVICES = new Set([
  '_device-info._tcp',
  '_companion-link._tcp',
  '_airplay._tcp',
  '_raop._tcp',
  '_sonos._tcp',
  '_ipp._tcp',
  '_ipps._tcp',
  '_printer._tcp',
  '_pdl-datastream._tcp',
  '_hap._tcp',
  '_smb._tcp',
  '_rfb._tcp',
])

/** Names that are identifiers rather than something a person would recognise. */
function looksLikeId(s: string): boolean {
  return (
    /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || // uuid
    /[0-9a-f]{12,}/i.test(s.replace(/[:-]/g, '')) || // MAC / serial
    /RINCON_/i.test(s) ||
    s.includes(':') || // MAC / IPv6 fragments, e.g. Apple `_apple-mobdev2` instances
    /^[a-z]{2,}\.[a-z0-9.]+$/i.test(s) || // reverse-DNS service ids, e.g. com.example.server
    /^(none|localhost|android|espressif)$/i.test(s)
  )
}

/** `804AF2738190@Living Room` / `RINCON_…@Living Room` → `Living Room` */
function cleanLabel(label: string): string {
  let at = label.lastIndexOf('@')
  return (at >= 0 ? label.slice(at + 1) : label).trim()
}

/** Best display name for a host, with how much to trust it. */
export function bestName(h: MdnsHost): { name?: string; rank: NameRank | 0 } {
  if (h.friendlyName && !looksLikeId(h.friendlyName)) return { name: h.friendlyName, rank: 4 }
  for (let { service, label } of h.instances) {
    let clean = cleanLabel(label)
    if (DEVICE_NAME_SERVICES.has(service) && clean && !looksLikeId(clean)) return { name: clean, rank: 4 }
  }
  for (let hn of h.hostnames) {
    let clean = hn.replace(/\.local\.?$/i, '')
    if (clean && !looksLikeId(clean)) return { name: clean, rank: 1 }
  }
  for (let { label } of h.instances) {
    let clean = cleanLabel(label)
    if (clean && !looksLikeId(clean) && !/^(spotifyconnect|printer)$/i.test(clean)) return { name: clean, rank: 2 }
  }
  return { rank: 0 }
}

export function createMdnsCollector(opts: { queryMs?: number } = {}): Collector {
  let queryMs = opts.queryMs ?? 30_000
  let ctrl: AbortController | undefined
  let socket: ReturnType<typeof makeMdns> | undefined

  return {
    id: MDNS_ID,
    tier: 0,
    label: 'MDNS',
    defaultEnabled: true,

    async probe(): Promise<CollectorHealth> {
      if (!(await localNet())) return { state: 'error', detail: 'No private IPv4 network interface' }
      return { state: 'available' }
    },

    start(ctx: CollectorContext) {
      ctrl = linkedController(ctx.signal)
      let signal = ctrl.signal
      let serviceTypes = new Set(KNOWN_SERVICES)
      let seen = new Set<string>()
      let denied = false

      let report = () => {
        if (denied) return
        ctx.setHealth({ state: 'available', detail: `${seen.size} hosts · ${serviceTypes.size} service types` })
      }
      let onSendError = (error: unknown) => {
        if (!error || signal.aborted) return
        if (isLocalNetworkDenied(error)) {
          denied = true
          ctx.setHealth({ state: 'needs-permission', detail: LOCAL_NETWORK_HINT })
        } else {
          ctx.setHealth({ state: 'error', detail: errorMessage(error) })
        }
      }

      let handle = async (records: MdnsRecord[], fromIp: string) => {
        let self = localAddresses()
        if (self.has(fromIp)) return
        let parsed = parseMdnsResponse(records, fromIp)
        for (let t of parsed.serviceTypes) {
          if (serviceTypes.size < MAX_SERVICE_TYPES && /^_[a-z0-9-]+\._(tcp|udp)\.local$/.test(t)) serviceTypes.add(t)
        }
        for (let h of parsed.hosts) {
          if (self.has(h.ip) || !isPrivateIPv4(h.ip)) continue
          if (!h.instances.length && !h.hostnames.length) continue
          let mac = await macForIp(h.ip, signal)
          if (signal.aborted) return
          let { name, rank } = bestName(h)
          let vendor = h.manufacturer ?? (mac ? lookupVendor(mac) : undefined)
          let { kind, strength } = classify({
            model: h.model,
            services: h.instances.map((i) => i.service + '.'),
            names: [name, ...h.hostnames],
            vendor,
          })
          let pooled = poolHints(h.ip, {
            mac,
            name,
            nameRank: rank,
            kind,
            kindStrength: strength,
            vendor,
            vendorRank: h.manufacturer ? 2 : 1,
          })
          seen.add(h.ip)
          ctx.emit({
            source: 'lan',
            collector: MDNS_ID,
            key: mac ?? h.ip,
            mac,
            ip: h.ip,
            name: pooled.name,
            vendor: pooled.vendor,
            vendorFromDevice: pooled.vendorRank === 2,
            kind: pooled.kind,
            at: Date.now(),
          })
        }
        report()
      }

      // Socket setup is synchronous; binding happens in the background.
      localNet(signal)
        .then((net) => {
          if (signal.aborted) return
          let mdns = makeMdns({ interface: net?.address, bind: '0.0.0.0', loopback: false })
          socket = mdns
          mdns.on('response', (packet, rinfo) => {
            let records = [...(packet.answers ?? []), ...(packet.additionals ?? [])] as MdnsRecord[]
            handle(records, rinfo.address).catch((error) => console.error('mdns: handle failed', error))
          })
          mdns.on('error', (error) => onSendError(error))
          mdns.on('warning', () => {
            // Membership / decode warnings are routine (other interfaces, malformed packets).
          })

          let query = () => {
            let names = [ENUM_TYPE, ...serviceTypes]
            // Several questions per packet, ~12 at a time to stay well under the MTU.
            for (let i = 0; i < names.length; i += 12) {
              mdns.query(
                names.slice(i, i + 12).map((name) => ({ name, type: 'PTR' as const })),
                onSendError,
              )
            }
            report()
          }
          every(queryMs, signal, query, onSendError)
          signal.addEventListener('abort', () => mdns.destroy(), { once: true })
        })
        .catch(onSendError)
    },

    stop() {
      ctrl?.abort()
      ctrl = undefined
      socket?.destroy()
      socket = undefined
    },
  }
}
