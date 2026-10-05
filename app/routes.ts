import { get, post, route } from 'remix/routes'

export const routes = route({
  assets: get('/assets/*path'),
  home: get('/'),
  stream: get('/stream'),
  status: get('/status'),
  settings: post('/settings'),
  claim: post('/claim'),
})
