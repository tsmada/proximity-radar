import type { Handle, RemixNode } from 'remix/component'
import { ImportMap } from 'remix/component/server'

import { assets, scriptEntry } from '../assets.ts'

export interface DocumentProps {
  children?: RemixNode
  head?: RemixNode
  title?: string
}

const DEFAULT_TITLE = readAppDisplayName('PHOSPHOR')
const STYLESHEET = await assets.getHref('app/actions/public/styles/phosphor.css')
const FONTS =
  'https://fonts.googleapis.com/css2?family=Major+Mono+Display&family=Share+Tech+Mono&family=VT323&display=swap'

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    let { children, head, title = DEFAULT_TITLE } = handle.props
    let { href, importMap, preloads } = scriptEntry

    return (
      // data-motion is owned by browser code (prefs.ts); keep it across frame reloads.
      <html lang="en" data-rmx-preserve-attrs="data-motion">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="dark" />
          <meta name="theme-color" content="#050A06" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <title>{title}</title>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link rel="stylesheet" href={FONTS} />
          <link rel="stylesheet" href={STYLESHEET} />
          {head}
          <ImportMap value={importMap} />
          {preloads.map((preloadHref) => (
            <link key={preloadHref} rel="modulepreload" href={preloadHref} />
          ))}
          <script type="module" src={href}></script>
        </head>
        <body>{children}</body>
      </html>
    )
  }
}

function readAppDisplayName(value: string): string {
  return value.startsWith('%%') ? 'Remix App' : decodeURIComponent(value)
}
