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
  state.activeSha = 'abc'
  store.saveState(dir, state)
  const loaded = store.loadState(dir)
  assert.equal(loaded.helpers.manual, true)
  assert.equal(loaded.enabled.a, false)
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
