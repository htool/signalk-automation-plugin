'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { inZone, zoneDistanceM } = require('../lib/geo')

const home = { lat: 52.48759, lon: 5.06362, radius: 30 }

test('inZone accepts SK latitude/longitude and lat/lon', () => {
  const insideSk = { latitude: 52.4875866, longitude: 5.0636168 }
  const insideShort = { lat: 52.4875866, lon: 5.0636168 }
  assert.equal(inZone(insideSk, home), true)
  assert.equal(inZone(insideShort, home), true)
  assert.ok(zoneDistanceM(insideSk, home) < 5)
})

test('inZone is false outside radius', () => {
  assert.equal(inZone({ latitude: 52.49, longitude: 5.07 }, home), false)
  assert.equal(inZone(null, home), false)
})
