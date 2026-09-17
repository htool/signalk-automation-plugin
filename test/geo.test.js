'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { inZone, zoneDistanceM } = require('../lib/geo')

const home = { lat: 52.1, lon: 4.9, radius: 30 }

test('inZone accepts SK latitude/longitude and lat/lon', () => {
  const insideSk = { latitude: 52.10001, longitude: 4.90001 }
  const insideShort = { lat: 52.10001, lon: 4.90001 }
  assert.equal(inZone(insideSk, home), true)
  assert.equal(inZone(insideShort, home), true)
  assert.ok(zoneDistanceM(insideSk, home) < 5)
})

test('inZone is false outside radius', () => {
  assert.equal(inZone({ latitude: 52.12, longitude: 5.0 }, home), false)
  assert.equal(inZone(null, home), false)
})
