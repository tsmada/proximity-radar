import { createHmac, randomBytes } from 'node:crypto'

/** Per-launch salt. Kept in memory only, so ids are not linkable across restarts. */
const launchSalt = randomBytes(32)

/** HMAC-SHA256(salt, raw) truncated to 12 hex chars. */
export function hashId(raw: string, salt: Uint8Array = launchSalt): string {
  return createHmac('sha256', salt).update(raw).digest('hex').slice(0, 12)
}

/** `AA-bb:cc…` / `aabb.cc…` → `aa:bb:cc:dd:ee:ff`; undefined if not a 48-bit MAC. */
export function normalizeMac(mac: string): string | undefined {
  let hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '')
  // `arp -an` on macOS drops leading zeros (`a:b:c:…`), so pad per octet first.
  if (hex.length !== 12 && /^[0-9a-f]{1,2}([:-][0-9a-f]{1,2}){5}$/i.test(mac)) {
    hex = mac
      .toLowerCase()
      .split(/[:-]/)
      .map((o) => o.padStart(2, '0'))
      .join('')
  }
  if (hex.length !== 12) return undefined
  return hex.match(/../g)!.join(':')
}

/**
 * True when the MAC is locally administered (bit 1 of the first octet), which
 * is how iOS/Android/Windows private addresses and BLE random addresses look.
 * OUI lookup is meaningless for these.
 */
export function isRandomizedMac(mac: string): boolean {
  let norm = normalizeMac(mac)
  if (!norm) return false
  return (Number.parseInt(norm.slice(0, 2), 16) & 0x02) !== 0
}

// Device-supplied names sometimes embed hardware ids: HP printers append the last three MAC
// octets (`OfficeJet [F65D06]`), ESP/Shelly/Tasmota gear uses `-A1B2C3`, some BLE names carry
// the whole address. Names go to the browser, so strip anything shaped like one.
const ID_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUID
  /\b[0-9a-f]{1,2}([:-])[0-9a-f]{1,2}(?:\1[0-9a-f]{1,2}){4}\b/gi, // aa:bb:cc:dd:ee:ff
  /\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, // aabb.ccdd.eeff
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi, // bare MAC / serial / peripheral id
  /\s*[[(](?=[0-9a-f]*[a-f])[0-9a-f]{4,6}[\])]/gi, // `[F65D06]`, `(A1B2)` MAC tails
  /[-_](?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{6}\b/gi, // `ESP_A1B2C3`, `shelly-1a2b3c`
]

/** Remove MAC / UUID / serial-shaped substrings from a display name. undefined if nothing is left. */
export function scrubIdentifiers(text: string | undefined): string | undefined {
  if (!text) return undefined
  let out = text
  for (let re of ID_PATTERNS) out = out.replace(re, '')
  out = out.replace(/\s{2,}/g, ' ').replace(/[\s\-_·:]+$/, '').trim()
  return out || undefined
}
