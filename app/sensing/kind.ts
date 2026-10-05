// Device-kind inference from whatever identity hints the LAN collectors have.
// Signals are checked strongest first: model string → advertised services /
// UPnP device types → names → OUI vendor. The first tier that matches wins.

import type { DeviceKind } from './types.ts'

export type KindHints = {
  /** Model identifier, e.g. `MacBookPro18,4`, `iPhone15,2`, `Sonos Arc`. */
  model?: string
  /** mDNS service types, e.g. `_airplay._tcp`, or full `_ipp._tcp.local`. */
  services?: Iterable<string>
  /** UPnP deviceType / ST URNs, e.g. `urn:schemas-upnp-org:device:MediaRenderer:1`. */
  upnpTypes?: Iterable<string>
  /** Friendly names and hostnames. */
  names?: Iterable<string | undefined>
  /** OUI or advertised manufacturer. */
  vendor?: string
}

type Rule = [DeviceKind, RegExp]

const MODEL_RULES: Rule[] = [
  ['phone', /^(iPhone|iPad|iPod)|\b(pixel \d|galaxy|SM-[A-Z]\d)/i],
  ['laptop', /^(MacBook|iMac|Mac(mini|Pro|Studio)?\d|Mac\d+,)|thinkpad|surface|laptop/i],
  ['media', /^(AppleTV|AudioAccessory)|sonos|roku|chromecast|fire ?tv|shield|homepod|soundbar|\btv\b|OLED|bravia|webos|tizen|\b(arc|beam|amp|sub|era|five|move|roam)\b/i],
  ['printer', /printer|laserjet|officejet|deskjet|pixma|ecotank|imageclass|\b(HL|MFC|DCP)-/i],
  ['router', /router|gateway|\bap\b|access point|erlite|edgerouter|unifi|airport/i],
]

const SERVICE_RULES: Rule[] = [
  ['printer', /^_(ipps?|printer|pdl-datastream|scanner|uscans?|fax-ipp)\./],
  ['router', /^_(airport|ubnt|unifi)\./],
  ['media', /^_(googlecast|sonos|spotify-connect|raop|airplay|display|roku|amzn-wplay|androidtvremote2?|mediaremotetv|nvstream|dial)\./],
  ['iot', /^_(hap|homekit|matterc?|meshcop|trel|lutron|leap|hue|esphomelib|nanoleafapi|shelly|tuya|ewelink|wled|miio)\./],
  ['laptop', /^_(smb|ssh|sftp-ssh|rfb|workstation|adisk|afpovertcp|rdp)\./],
]

const UPNP_RULES: Rule[] = [
  ['printer', /:device:Printer:|:service:PrintBasic:/i],
  ['router', /:device:(InternetGatewayDevice|WANDevice|WANConnectionDevice|WFADevice):/i],
  ['media', /:device:(MediaRenderer|ZonePlayer|tv|dial):|dial-multiscreen|urn:lge:device:tv|samsung\.com:device:RemoteControlReceiver|roku/i],
  ['iot', /:device:(Basic|HVAC|BinaryLight|DimmableLight|Sensor|Belkin):/i],
]

const NAME_RULES: Rule[] = [
  ['printer', /printer|laserjet|officejet|deskjet|envy|pixma|epson|brother|canon|xerox|kyocera/i],
  ['router', /router|gateway|\bubnt\b|unifi|erlite|edgerouter|orbi|eero|netgear|linksys|fritz|\bap\b|access point|mesh/i],
  ['media', /\btv\b|-tv\b|webos|tizen|roku|chromecast|apple ?tv|sonos|homepod|echo|soundbar|speaker|shield|bravia|vizio/i],
  ['phone', /iphone|ipad|pixel|galaxy|android|phone/i],
  ['laptop', /macbook|imac|mac-?mini|mac-?studio|laptop|desktop|thinkpad|surface|-pc\b|^pc-|\bmac\b/i],
  ['iot', /lutron|smart bridge|hue|nest|ecobee|thermostat|bulb|plug|esp[-_]|esp32|esp8266|shelly|tasmota|tuya|wemo|\bring\b|camera|doorbell|sensor|myq|switchbot|wled/i],
]

const VENDOR_RULES: Rule[] = [
  ['router', /^(ubiquiti|eero|netgear|linksys|arris|sagemcom|technicolor|zyxel|mikrotik|ruckus|aruba|cisco meraki|avm|commscope)/i],
  ['media', /^(sonos|roku|vizio|bose|lg electronics|tcl|hisense|nvidia)/i],
  ['printer', /^(brother|seiko epson|canon|xerox|kyocera|lexmark|ricoh)/i],
  ['iot', /^(espressif|tuya|shelly|lutron|signify|philips lighting|nest labs|ecobee|itead|wiz|belkin|chamberlain|ring|wyze|tp-link systems|lifx|ikea)/i],
]

function first(rules: Rule[], values: string[]): DeviceKind | undefined {
  for (let [kind, re] of rules) if (values.some((v) => re.test(v))) return kind
  return undefined
}

function serviceType(s: string): string {
  // `Living Room._airplay._tcp.local` or `_airplay._tcp.local` → `_airplay._tcp.`
  let m = /(_[a-z0-9-]+\._(?:tcp|udp))(?:\.|$)/i.exec(s)
  return m ? `${m[1].toLowerCase()}.` : s
}

/** 4 = model, 3 = service / UPnP type, 2 = name, 1 = vendor, 0 = nothing matched. */
export type KindStrength = 0 | 1 | 2 | 3 | 4

export function classify(hints: KindHints): { kind: DeviceKind; strength: KindStrength } {
  let model = hints.model?.trim()
  if (model) {
    let k = first(MODEL_RULES, [model])
    if (k) return { kind: k, strength: 4 }
  }

  // A Mac or iPhone also advertises AirPlay receivers; the model check above
  // catches that when a model is known. Without one, prefer the strongest service.
  let k = first(SERVICE_RULES, [...(hints.services ?? [])].map(serviceType))
  if (k) return { kind: k, strength: 3 }

  k = first(UPNP_RULES, [...(hints.upnpTypes ?? [])])
  if (k) return { kind: k, strength: 3 }

  let names = [...(hints.names ?? [])].filter((n): n is string => Boolean(n))
  k = first(NAME_RULES, names)
  if (k) return { kind: k, strength: 2 }

  if (hints.vendor) {
    k = first(VENDOR_RULES, [hints.vendor])
    if (k) return { kind: k, strength: 1 }
  }
  return { kind: 'unknown', strength: 0 }
}

export function inferKind(hints: KindHints): DeviceKind {
  return classify(hints).kind
}
