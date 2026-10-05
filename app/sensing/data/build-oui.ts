// Regenerates `oui.txt` from Wireshark's `manuf` file, which is built from the
// IEEE MA-L/MA-M/MA-S public registries.
//
//   curl -sSLo /tmp/manuf https://www.wireshark.org/download/automated/data/manuf
//   node app/sensing/data/build-oui.ts /tmp/manuf
//
// Only 24-bit (MA-L) blocks are kept. Output format, one vendor per line:
//   <vendor name>\t<OUI hex> <OUI hex> …
// Grouping by vendor keeps the file at roughly half the size of a flat table.

import { readFileSync, writeFileSync } from 'node:fs'

const SUFFIX =
  /[\s,.]+(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|l\.l\.c|gmbh|ag|s\.?a|s\.?p\.?a|b\.?v|n\.?v|oy|ab|as|a\/s|pty|pte|plc|kg|srl|s\.r\.l|sas|kk|k\.k|co\.?,?\s*ltd)\.?$/i

export function cleanVendor(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim()
  // Strip trailing legal-entity suffixes repeatedly ("Foo Co., Ltd." → "Foo").
  for (let i = 0; i < 4; i++) {
    let next = name.replace(SUFFIX, '').replace(/[\s,.]+$/, '')
    if (next === name || next.length < 2) break
    name = next
  }
  return name.length > 40 ? name.slice(0, 40).trimEnd() : name
}

if (import.meta.main) {
  let src = process.argv[2]
  if (!src) throw new Error('usage: node build-oui.ts <path to wireshark manuf>')
  let byVendor = new Map<string, string[]>()
  let count = 0
  for (let line of readFileSync(src, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    let [block, , full] = line.split('\t').map((s) => s.trim())
    if (!block || !/^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/i.test(block)) continue
    if (!full || /^IEEE Registration Authority/i.test(full) || /^Private$/i.test(full)) continue
    let vendor = cleanVendor(full)
    let list = byVendor.get(vendor) ?? []
    list.push(block.replace(/:/g, '').toUpperCase())
    byVendor.set(vendor, list)
    count++
  }
  let out = [...byVendor]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, ouis]) => `${vendor}\t${ouis.join(' ')}`)
    .join('\n')
  let dest = new URL('./oui.txt', import.meta.url)
  writeFileSync(dest, out + '\n')
  console.log(`wrote ${count} OUIs, ${byVendor.size} vendors → ${dest.pathname}`)
}
