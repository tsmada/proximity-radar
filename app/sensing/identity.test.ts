import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { hashId, isRandomizedMac, normalizeMac, scrubIdentifiers } from './identity.ts'

describe('hashId', () => {
  it('is 12 hex chars and stable for the same salt', () => {
    let salt = new Uint8Array(32).fill(7)
    let a = hashId('aa:bb:cc:dd:ee:ff', salt)
    assert.match(a, /^[0-9a-f]{12}$/)
    assert.equal(hashId('aa:bb:cc:dd:ee:ff', salt), a)
  })

  it('differs across salts and inputs', () => {
    let s1 = new Uint8Array(32).fill(1)
    let s2 = new Uint8Array(32).fill(2)
    assert.notEqual(hashId('x', s1), hashId('x', s2))
    assert.notEqual(hashId('x', s1), hashId('y', s1))
  })

  it('uses a per-launch salt by default, not a plain hash', () => {
    assert.equal(hashId('x'), hashId('x'))
    assert.notEqual(hashId('x'), hashId('x', new Uint8Array(32)))
  })
})

describe('normalizeMac', () => {
  it('normalises separators, case and macOS arp short octets', () => {
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff')
    assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff')
    assert.equal(normalizeMac('a:b:c:d:e:f'), '0a:0b:0c:0d:0e:0f')
    assert.equal(normalizeMac('(incomplete)'), undefined)
  })
})

describe('isRandomizedMac', () => {
  it('detects the locally-administered bit', () => {
    assert.equal(isRandomizedMac('02:00:00:00:00:01'), true)
    assert.equal(isRandomizedMac('DA:A1:19:00:00:01'), true) // typical iOS private address
    assert.equal(isRandomizedMac('a6:1:2:3:4:5'), true)
    assert.equal(isRandomizedMac('00:1A:2B:3C:4D:5E'), false)
    assert.equal(isRandomizedMac('f0:18:98:00:00:01'), false) // Apple OUI
    assert.equal(isRandomizedMac('nonsense'), false)
  })
})

describe('scrubIdentifiers', () => {
  it('strips MAC, UUID and serial shaped parts of device names', () => {
    assert.equal(scrubIdentifiers('HP OfficeJet Pro 9010 series [F65D06]'), 'HP OfficeJet Pro 9010 series')
    assert.equal(scrubIdentifiers('LE-Bose a4:c1:38:0b:12:3f'), 'LE-Bose')
    assert.equal(scrubIdentifiers('shelly1-A4CF12F8B1'), 'shelly1-A4CF12F8B1') // 10 hex: not a MAC shape
    assert.equal(scrubIdentifiers('ESP_A1B2C3'), 'ESP')
    assert.equal(scrubIdentifiers('Tag 1C2B3A4D5E6F'), 'Tag')
    assert.equal(scrubIdentifiers('0F3D5B8E-1C2D-4E5F-8A9B-112233445566'), undefined)
    assert.equal(scrubIdentifiers(undefined), undefined)
  })

  it('leaves ordinary names alone', () => {
    for (let name of ['Living Room', 'Lindsey’s MacBook Pro', '[LG] webOS TV OLED83G4WUA', 'Smart Bridge 2', 'ERLite-3', 'Pixel 9', 'Room 2024']) {
      assert.equal(scrubIdentifiers(name), name)
    }
  })
})
