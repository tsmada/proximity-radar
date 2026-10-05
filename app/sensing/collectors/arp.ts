// Tier 0: who is on the LAN, from the kernel ARP table plus a gentle ping sweep.
//
// - Every ~10 s: `arp -anl` (macOS) / `arp -an` → emit entries that look present.
// - Every ~45 s: one ICMP echo to each host of our /24 (capped concurrency),
//   which also makes the kernel refresh ARP for anything that answers ARP.
// Ping replies are only an "awake" indicator. RTT is never used as distance.
// ARP gives no RSSI, so these contacts land on the ON-NET ring.

import { lookupVendor } from '../oui.ts'
import { classify } from '../kind.ts'
import { normalizeMac } from '../identity.ts'
import type { Collector, CollectorContext, CollectorHealth } from '../types.ts'
import {
  errorMessage,
  every,
  hasBinary,
  isIPv4,
  linkedController,
  localAddresses,
  localNet,
  mapLimit,
  poolHints,
  run,
  sweepTargets,
  type LocalNet,
} from './lan-util.ts'

export const ARP_ID = 'lan-arp'

export type ArpEntry = {
  ip: string
  mac: string // normalised aa:bb:cc:dd:ee:ff
  iface?: string
  permanent: boolean
  /** macOS `arp -l` only: false when both expiry columns say `expired`. */
  fresh?: boolean
}

/**
 * Parse `arp -an` (macOS / BSD / Linux net-tools) or macOS `arp -anl` output.
 * Incomplete entries are dropped; multicast/broadcast entries are kept here and
 * filtered by `isDeviceEntry`.
 */
export function parseArpTable(text: string): ArpEntry[] {
  let out: ArpEntry[] = []
  for (let line of text.split('\n')) {
    // `? (192.168.1.1) at 74:83:c2:1b:a1:fd on en0 ifscope [ethernet]`
    let m = /\((\d{1,3}(?:\.\d{1,3}){3})\) at (\S+)(?:.*? on (\S+))?/.exec(line)
    if (m) {
      let mac = normalizeMac(m[2])
      if (!mac) continue
      out.push({ ip: m[1], mac, iface: m[3], permanent: /\bpermanent\b|\bPERM\b/.test(line) })
      continue
    }
    // `192.168.1.1   74:83:c2:1b:a1:fd 2m25s     1m59s          en0    1`
    let l = /^(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line)
    if (l) {
      let mac = normalizeMac(l[2])
      if (!mac) continue
      let [expO, expI] = [l[3], l[4]]
      let permanent = expO === '(none)' && expI === '(none)'
      out.push({
        ip: l[1],
        mac,
        iface: l[5],
        permanent,
        fresh: permanent || !(expO === 'expired' && expI === 'expired'),
      })
    }
  }
  return out
}

/** A real neighbour: unicast MAC, not one of our own addresses, not a static/self entry. */
export function isDeviceEntry(e: ArpEntry, self: Set<string>): boolean {
  if (self.has(e.ip) || e.permanent) return false
  if (!isIPv4(e.ip) || e.ip.endsWith('.255') || Number(e.ip.split('.')[0]) >= 224) return false
  let first = Number.parseInt(e.mac.slice(0, 2), 16)
  if (first & 0x01) return false // multicast / broadcast MAC
  return e.mac !== '00:00:00:00:00:00'
}

// ── Shared ARP cache (also used by mdns/ssdp to attach MACs to IPs) ─────────

const CACHE_MS = 5_000
let cache: { at: number; entries: ArpEntry[] } | undefined
let inflight: Promise<ArpEntry[]> | undefined
const pinged = new Map<string, number>() // ip → last on-demand ping (ms)

function arpArgs(): string[] {
  return process.platform === 'darwin' ? ['-anl'] : ['-an']
}

/** Current ARP table, at most CACHE_MS old. Single-flight. Never throws (empty on failure). */
export async function readArpTable(opts: { maxAgeMs?: number } = {}): Promise<ArpEntry[]> {
  let maxAge = opts.maxAgeMs ?? CACHE_MS
  if (cache && Date.now() - cache.at <= maxAge) return cache.entries
  inflight ??= run('arp', arpArgs(), { timeoutMs: 5000 })
    .then((text) => {
      let entries = parseArpTable(text)
      cache = { at: Date.now(), entries }
      return entries
    })
    .catch(() => cache?.entries ?? [])
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

export function pingArgs(ip: string): string[] {
  // macOS: -W is milliseconds; Linux iputils: -W is seconds.
  return process.platform === 'darwin' ? ['-n', '-q', '-c', '1', '-W', '1000', ip] : ['-n', '-q', '-c', '1', '-W', '1', ip]
}

/** One echo request. True on reply. Never throws. */
export async function ping(ip: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await run('ping', pingArgs(ip), { signal, timeoutMs: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * MAC for a LAN IP via the ARP table. When missing, pings the host once (at most
 * once a minute per IP) so the kernel resolves it, then re-reads the table.
 */
export async function macForIp(ip: string, signal?: AbortSignal): Promise<string | undefined> {
  let hit = (await readArpTable()).find((e) => e.ip === ip && !e.permanent)
  if (hit || signal?.aborted) return hit?.mac
  let last = pinged.get(ip) ?? 0
  if (Date.now() - last < 60_000) return undefined
  pinged.set(ip, Date.now())
  await ping(ip, signal)
  return (await readArpTable({ maxAgeMs: 0 })).find((e) => e.ip === ip && !e.permanent)?.mac
}

// ── Collector ───────────────────────────────────────────────────────────────

export type ArpOptions = {
  readMs?: number
  sweepMs?: number
  concurrency?: number
}

export function createArpCollector(opts: ArpOptions = {}): Collector {
  let readMs = opts.readMs ?? 10_000
  let sweepMs = opts.sweepMs ?? 45_000
  let concurrency = opts.concurrency ?? 16
  let ctrl: AbortController | undefined

  return {
    id: ARP_ID,
    tier: 0,
    label: 'ARP',
    defaultEnabled: true,

    async probe(): Promise<CollectorHealth> {
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return { state: 'unsupported', detail: `arp/ping not supported on ${process.platform}` }
      }
      if (!(await hasBinary('arp', ['-an']))) return { state: 'unsupported', detail: '`arp` not found' }
      if (!(await localNet())) return { state: 'error', detail: 'No private IPv4 network interface' }
      return { state: 'available' }
    },

    start(ctx: CollectorContext) {
      ctrl = linkedController(ctx.signal)
      let signal = ctrl.signal
      let net: LocalNet | undefined
      let awake = new Map<string, number>() // ip → last ping reply (ms)
      let sweeping = false
      let lastSweep = 0

      let report = (present: number) => {
        let awakeNow = [...awake.values()].filter((t) => Date.now() - t < sweepMs * 2).length
        let where = net ? `${net.iface} ${net.address}/${Math.max(24, net.prefix)}` : 'no network'
        ctx.setHealth({
          state: 'available',
          detail: `${where} · ${present} hosts · ${awakeNow} awake${sweeping && !lastSweep ? ' · sweeping…' : ''}`,
        })
      }

      let read = async () => {
        net ??= await localNet(signal)
        let entries = await readArpTable({ maxAgeMs: 1000 })
        if (signal.aborted) return
        let self = localAddresses()
        let at = Date.now()
        let present = 0
        for (let e of entries) {
          if (!isDeviceEntry(e, self)) continue
          if (net && e.iface && e.iface !== net.iface) continue
          let recentlyAwake = at - (awake.get(e.ip) ?? 0) < sweepMs * 2
          // Without expiry info (non-macOS) we trust the table only after a sweep refreshed it.
          let isPresent = e.fresh ?? (recentlyAwake || lastSweep > 0)
          if (!isPresent && !recentlyAwake) continue
          present++
          let vendor = lookupVendor(e.mac)
          let { kind, strength } = classify({ vendor })
          let h = poolHints(e.ip, { mac: e.mac, kind, kindStrength: strength, vendor })
          ctx.emit({
            source: 'lan',
            collector: ARP_ID,
            key: e.mac,
            mac: e.mac,
            ip: e.ip,
            name: h.name,
            vendor: h.vendor,
            kind: h.kind,
            at,
          })
        }
        report(present)
      }

      let sweep = async () => {
        if (sweeping) return
        sweeping = true
        try {
          net = await localNet(signal)
          if (!net || signal.aborted) return
          let targets = sweepTargets(net, localAddresses())
          await mapLimit(targets, concurrency, signal, async (ip) => {
            if (await ping(ip, signal)) awake.set(ip, Date.now())
          })
          lastSweep = Date.now()
        } finally {
          sweeping = false
        }
        // Expire old awake marks so the map can't grow without bound.
        for (let [ip, t] of awake) if (Date.now() - t > sweepMs * 4) awake.delete(ip)
        await read()
      }

      let onError = (error: unknown) => ctx.setHealth({ state: 'error', detail: errorMessage(error) })
      // Return immediately (CONTRACTS gotcha 5): all work runs on timers.
      every(readMs, signal, read, onError)
      every(sweepMs, signal, sweep, onError, 500)
    },

    stop() {
      ctrl?.abort()
      ctrl = undefined
    },
  }
}
