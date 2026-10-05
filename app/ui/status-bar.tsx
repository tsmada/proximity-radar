import type { Handle } from 'remix/component'

import { StatusLine } from '../actions/public/status-line.tsx'
import type { CollectorStatus } from '../sensing/types.ts'

// Bottom bar: live status line (island) plus the scanning disclosure (PLAN §6).
export function StatusBar(handle: Handle<{ caps: CollectorStatus[]; contactCount: number }>) {
  return () => {
    let { caps, contactCount } = handle.props
    return (
      <footer id="status-bar" class="status-bar">
        <StatusLine caps={caps} contactCount={contactCount} />
        <details class="disclosure">
          <summary>
            <span class="warn">!</span> THIS SCREEN SHOWS OTHER PEOPLE'S DEVICES · PRIVACY
          </summary>
          <div class="disclosure-body">
            <p>
              PHOSPHOR listens for radio and network announcements from devices around this computer. Most of them
              belong to other people. Only scan networks and spaces you own or have permission to scan.
            </p>
            <ul>
              <li>The server only listens on 127.0.0.1. Nothing is uploaded, logged to disk or kept after it stops.</li>
              <li>
                MAC addresses and Bluetooth ids are hashed with a random per-launch key before they reach this page.
                Raw identifiers are never shown.
              </li>
              <li>No traffic or payloads are captured. LAN discovery only sees what devices announce.</li>
              <li>Bluetooth and monitor-mode scanning are off until you turn them on.</li>
              <li>
                Device addresses can be personal data (for example under GDPR). Get legal advice before running this
                anywhere but your own home.
              </li>
            </ul>
          </div>
        </details>
      </footer>
    )
  }
}
