'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const store = require('../lib/store')

test('state roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-store-'))
  const state = store.emptyState()
  state.helpers.manual = true
  state.enabled.a = false
  state.verbose.a = true
  state.activeSha = 'abc'
  store.saveState(dir, state)
  const loaded = store.loadState(dir)
  assert.equal(loaded.helpers.manual, true)
  assert.equal(loaded.enabled.a, false)
  assert.equal(loaded.verbose.a, true)
  assert.equal(loaded.activeSha, 'abc')
})

test('traces keep newest first up to max', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-store-'))
  store.appendTrace(dir, 'a', { ts: '1', result: 'ok' }, 2)
  store.appendTrace(dir, 'a', { ts: '2', result: 'failure' }, 2)
  store.appendTrace(dir, 'a', { ts: '3', result: 'ok' }, 2)
  const traces = store.loadTraces(dir, 'a')
  assert.equal(traces.length, 2)
  assert.equal(traces[0].ts, '3')
  assert.equal(traces[1].ts, '2')
})

test('deadlines roundtrip and drop corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-dead-'))
  assert.deepEqual(store.loadDeadlines(dir), [])
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'deadlines.json'), '{', 'utf8')
  assert.deepEqual(store.loadDeadlines(dir), [])
  const item = {
    id: 'a',
    automationId: 'vhf_charge',
    deadline: 1000,
    actions: [{ put: 'electrical.switches.smartplugVHF.state', value: 0 }]
  }
  store.upsertDeadline(dir, item)
  store.upsertDeadline(dir, {
    id: 'b',
    automationId: 'other',
    deadline: 2000,
    actions: []
  })
  store.upsertDeadline(dir, Object.assign({}, item, { deadline: 1500 }))
  let rows = store.loadDeadlines(dir)
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.id === 'a').deadline, 1500)
  assert.equal(store.removeDeadline(dir, 'a'), true)
  assert.equal(store.removeDeadline(dir, 'a'), false)
  rows = store.loadDeadlines(dir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'b')
})

test('switch log keeps newest first up to max', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sw-'))
  store.appendSwitchLog(dir, { ts: '1', path: 'a' }, 2)
  store.appendSwitchLog(dir, { ts: '2', path: 'b' }, 2)
  store.appendSwitchLog(dir, { ts: '3', path: 'c' }, 2)
  const log = store.loadSwitchLog(dir)
  assert.equal(log.length, 2)
  assert.equal(log[0].ts, '3')
  assert.equal(log[1].path, 'b')
})
