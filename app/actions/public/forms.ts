// Progressive enhancement for the settings / claim forms: without JS they POST and the server
// redirects back to `/`. With JS we send the same FormData in the background and let the SSE
// stream deliver the result, so the scope keeps sweeping instead of reloading.

import { pushLog } from './log-store.ts'

export async function submitInBackground(form: HTMLFormElement, submitter?: HTMLElement | null) {
  let body = new FormData(form, submitter instanceof HTMLButtonElement ? submitter : undefined)
  let action = form.getAttribute('action') ?? form.action
  form.setAttribute('aria-busy', 'true')
  try {
    let response = await fetch(action, { method: 'POST', body, redirect: 'manual' })
    // 303 → `/` arrives as an opaque redirect (status 0) with redirect: 'manual'.
    let ok = response.type === 'opaqueredirect' || response.ok
    if (!ok) {
      let detail = response.status === 404 ? 'not available on this server yet' : (await response.text()).slice(0, 80)
      pushLog('warn', `! ${describe(body)} FAILED · ${response.status} ${detail}`)
    }
    return ok
  } catch (error) {
    pushLog('warn', `! ${describe(body)} FAILED · ${error instanceof Error ? error.message : 'network error'}`)
    return false
  } finally {
    form.removeAttribute('aria-busy')
  }
}

function describe(body: FormData): string {
  let action = body.get('action')
  if (action) return String(action).toUpperCase()
  if (body.has('collector')) return `SENSOR ${String(body.get('collector')).toUpperCase()}`
  if (body.has('demo')) return 'DEMO MODE'
  return 'REQUEST'
}

/** Use with `on('submit', …)`. */
export function enhanceSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault()
  void submitInBackground(event.currentTarget, event.submitter)
}
