// Small helpers shared by the Tier 0 LAN collectors (arp, mdns, ssdp, station).

import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'

import type { DeviceKind } from '../types.ts'

/** Run a binary (never through a shell) and resolve with stdout. Rejects on non-zero exit. */
export function run(
  file: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { signal: opts.signal, timeout: opts.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

/** True when the binary can be executed (ENOENT → false; a non-zero exit still counts as present). */
export async function hasBinary(file: string, args: string[] = []): Promise<boolean> {
  try {
    await run(file, args, { timeoutMs: 3000 })
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Call `fn` now and then every `ms` until `signal` aborts. Runs never overlap
 * (the next one is scheduled after the previous finishes) and errors go to `onError`.
 */
export function every(
  ms: number,
  signal: AbortSignal,
  fn: () => Promise<void> | void,
  onError: (error: unknown) => void,
  initialDelayMs = 0,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let tick = async () => {
    if (signal.aborted) return
    try {
      await fn()
    } catch (error) {
      if (!signal.aborted) onError(error)
    }
    if (signal.aborted) return
    timer = setTimeout(tick, ms)
    timer.unref?.()
  }
  timer = setTimeout(tick, initialDelayMs)
  timer.unref?.()
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
}

/** An AbortController that also aborts when `parent` does. */
export function linkedController(parent: AbortSignal): AbortController {
  let ctrl = new AbortController()
  if (parent.aborted) ctrl.abort()
  else parent.addEventListener('abort', () => ctrl.abort(), { once: true })
  return ctrl
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function isIPv4(ip: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split('.').every((o) => Number(o) <= 255)
}

/** RFC 1918 private, or 169.254/16 link-local. */
export function isPrivateIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  let [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export type LocalNet = {
  iface: string
  address: string
  netmask: string
  prefix: number
}

/** Every non-internal IPv4 address of this machine (used to skip ourselves). */
export function localAddresses(): Set<string> {
  let out = new Set<string>(['127.0.0.1'])
  for (let list of Object.values(networkInterfaces())) {
    for (let a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
  }
  return out
}

/** Parse `route -n get default` for the outgoing interface name. */
export function parseDefaultRoute(text: string): string | undefined {
  return /^\s*interface:\s*(\S+)/m.exec(text)?.[1]
}

/**
 * The LAN we're on: the default route's interface (macOS `route`, Linux `ip route`),
 * else the first non-internal private IPv4 interface.
 */
export async function localNet(signal?: AbortSignal): Promise<LocalNet | undefined> {
  let preferred: string | undefined
  try {
    if (process.platform === 'darwin') {
      preferred = parseDefaultRoute(await run('route', ['-n', 'get', 'default'], { signal, timeoutMs: 3000 }))
    } else if (process.platform === 'linux') {
      preferred = / dev (\S+)/.exec(await run('ip', ['route', 'show', 'default'], { signal, timeoutMs: 3000 }))?.[1]
    }
  } catch {
    // No default route (offline) or binary missing: fall through to the interface scan.
  }
  let ifaces = networkInterfaces()
  let names = preferred ? [preferred, ...Object.keys(ifaces)] : Object.keys(ifaces)
  for (let name of names) {
    for (let a of ifaces[name] ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateIPv4(a.address)) continue
      let prefix = Number(a.cidr?.split('/')[1] ?? 24)
      return { iface: name, address: a.address, netmask: a.netmask, prefix }
    }
  }
  return undefined
}

/**
 * Host addresses to sweep. Networks larger than a /24 are clamped to the /24
 * containing our address so a sweep stays small and polite.
 */
export function sweepTargets(net: Pick<LocalNet, 'address' | 'prefix'>, exclude: Set<string> = new Set()): string[] {
  let prefix = Math.max(24, Math.min(30, net.prefix))
  let mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  let base = (ipToInt(net.address) & mask) >>> 0
  let size = 2 ** (32 - prefix)
  let out: string[] = []
  for (let i = 1; i < size - 1; i++) {
    let ip = intToIp(base + i)
    if (!exclude.has(ip)) out.push(ip)
  }
  return out
}

/** Map over items with at most `limit` in flight. Stops starting new work once `signal` aborts. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  let results: R[] = []
  let next = 0
  let worker = async () => {
    while (next < items.length && !signal.aborted) {
      let i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** macOS Local Network privacy denials surface as EHOSTUNREACH on LAN sends. */
export function isLocalNetworkDenied(error: unknown): boolean {
  let code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EHOSTUNREACH' || code === 'EPERM' || code === 'EACCES'
}

export const LOCAL_NETWORK_HINT =
  'Allow Local Network access for your terminal (or node) in System Settings → Privacy & Security → Local Network, then re-enable'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Shared LAN identity hints ───────────────────────────────────────────────
// ARP, mDNS and SSDP all describe the same LAN hosts. Fusion keeps the last
// name/kind it was given, so the three collectors pool their best guesses here
// (keyed by IP) and each emits the pooled best. That stops labels flip-flopping
// between "Living Room" (mDNS) and "Sonos Arc" (SSDP) on every refresh.

export type NameRank = 1 | 2 | 3 | 4 // 1 hostname · 2 generic instance · 3 SSDP friendlyName · 4 mDNS device name

export type LanHints = {
  mac?: string
  name?: string
  nameRank?: number
  kind?: DeviceKind
  kindStrength?: number
  vendor?: string
  vendorRank?: number
  at: number
}

const HINT_TTL_MS = 60 * 60_000
const hints = new Map<string, LanHints>()

/** Merge a collector's guesses for `ip` into the pool and return the pooled best. */
export function poolHints(
  ip: string,
  next: {
    mac?: string
    name?: string
    nameRank?: number
    kind?: DeviceKind
    kindStrength?: number
    vendor?: string
    /** 1 = OUI lookup, 2 = advertised by the device (e.g. UPnP manufacturer). */
    vendorRank?: number
  },
): LanHints {
  let now = Date.now()
  let cur = hints.get(ip)
  // A different MAC on the same IP means DHCP handed it to another device: start over.
  if (!cur || now - cur.at > HINT_TTL_MS || (cur.mac && next.mac && cur.mac !== next.mac)) {
    cur = { at: now }
  }
  let merged: LanHints = { ...cur, at: now, mac: next.mac ?? cur.mac }
  if (next.name && (next.nameRank ?? 0) >= (cur.nameRank ?? 0)) {
    merged.name = next.name
    merged.nameRank = next.nameRank ?? 0
  }
  if (next.kind && next.kind !== 'unknown' && (next.kindStrength ?? 0) >= (cur.kindStrength ?? 0)) {
    merged.kind = next.kind
    merged.kindStrength = next.kindStrength ?? 0
  }
  if (next.vendor && (next.vendorRank ?? 1) >= (cur.vendorRank ?? 0)) {
    merged.vendor = next.vendor
    merged.vendorRank = next.vendorRank ?? 1
  }
  hints.set(ip, merged)
  if (hints.size > 1024) {
    for (let [k, v] of hints) if (now - v.at > HINT_TTL_MS) hints.delete(k)
  }
  return merged
}

/** Pooled hints for `ip`, if any (and if they belong to `mac` when given). */
export function getHints(ip: string, mac?: string): LanHints | undefined {
  let h = hints.get(ip)
  if (!h || Date.now() - h.at > HINT_TTL_MS) return undefined
  if (mac && h.mac && h.mac !== mac) return undefined
  return h
}

/** Test helper. */
export function clearHints() {
  hints.clear()
}
