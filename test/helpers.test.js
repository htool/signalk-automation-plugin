'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const helpers = require('../lib/helpers')

const defs = {
  manual: { id: 'manual', type: 'boolean', default: false, on_start: 'restore' },
  hold: { id: 'hold', type: 'boolean', default: true, on_start: 'default' },
  scratch: { id: 'scratch', type: 'string', default: 'x', on_start: 'none' }
}

test('restore uses persisted value, else default', () => {
  const a = helpers.initHelpers(defs, { manual: true })
  assert.equal(a.manual, true)
  const b = helpers.initHelpers(defs, {})
  assert.equal(b.manual, false)
})

test('default on start ignores persisted value', () => {
  const a = helpers.initHelpers(defs, { hold: false })
  assert.equal(a.hold, true)
})

test('none does not set a value', () => {
  const a = helpers.initHelpers(defs, { scratch: 'saved' })
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'scratch'), false)
})

test('only restore helpers are persistable', () => {
  const values = { manual: true, hold: false, scratch: 'z' }
  const saved = helpers.persistableHelpers(defs, values)
  assert.deepEqual(saved, { manual: true })
})

test('coerce select rejects unknown option', () => {
  const def = { id: 'mode', type: 'select', options: ['auto', 'manual'] }
  assert.equal(helpers.coerce(def, 'auto'), 'auto')
  assert.throws(() => helpers.coerce(def, 'nope'))
})
