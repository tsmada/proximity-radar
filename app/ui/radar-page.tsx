import type { Handle } from 'remix/component'

import { EventLog } from '../actions/public/event-log.tsx'
import { Readout } from '../actions/public/readout.tsx'
import { Scope, scopeSummary } from '../actions/public/scope.tsx'
import { Sensors } from '../actions/public/sensors.tsx'
import { Toggles } from '../actions/public/toggles.tsx'
import { routes } from '../routes.ts'
import type { DemoMode } from '../sensing/registry.ts'
import type { CollectorStatus, Contact } from '../sensing/types.ts'
import { Document } from './document.tsx'
import { Legend } from './legend.tsx'
import { StatusBar } from './status-bar.tsx'

export type RadarPageProps = {
  contacts: Contact[]
  caps: CollectorStatus[]
  demo: DemoMode
}

export function RadarPage(handle: Handle<RadarPageProps>) {
  return () => {
    let { contacts, caps, demo } = handle.props
    return (
      <Document title="PHOSPHOR · proximity radar">
        <a class="skip" href="#readout">
          Skip to contact table
        </a>
        <div class="app">
          <header class="masthead">
            <div class="brand">
              <h1>phosphor</h1>
              <p class="tagline">PROXIMITY RADAR · PPI · P7</p>
            </div>
            <Toggles />
          </header>
          <main id="radar" class="console">
            <section class="scope-col" aria-label="Radar scope">
              <Scope summary={scopeSummary(contacts)} />
              <Legend />
            </section>
            <section class="side-col" aria-label="Contact readout">
              <div class="panel table-panel">
                <Readout initial={contacts} claimHref={routes.claim.href()} />
              </div>
              <EventLog />
              <Sensors caps={caps} demo={demo} settingsHref={routes.settings.href()} />
            </section>
          </main>
          <StatusBar caps={caps} contactCount={contacts.length} />
        </div>
      </Document>
    )
  }
}
