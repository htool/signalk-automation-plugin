'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const scripts = require('../lib/scripts')

test('stdout is the value when stderr is empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scripts-'))
  fs.writeFileSync(path.join(dir, 'ok.sh'), '#!/bin/sh\nprintf hi\n')
  fs.chmodSync(path.join(dir, 'ok.sh'), 0o755)
  const r = await scripts.runScript({ scriptsDir: dir, file: 'ok.sh' })
  assert.equal(r.ok, true)
  assert.equal(r.value, 'hi')
})

test('any stderr is fail even with stdout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scripts-'))
  fs.writeFileSync(path.join(dir, 'bad.sh'), '#!/bin/sh\nprintf out\nprintf err >&2\n')
  fs.chmodSync(path.join(dir, 'bad.sh'), 0o755)
  const r = await scripts.runScript({ scriptsDir: dir, file: 'bad.sh' })
  assert.equal(r.ok, false)
  assert.match(r.error, /stderr/)
})

test('path traversal is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scripts-'))
  const r = await scripts.runScript({ scriptsDir: dir, file: '../escape.sh' })
  assert.equal(r.ok, false)
  assert.match(r.error, /escapes|relative/i)
})

test('absolute paths are rejected', async () => {
  const r = await scripts.runScript({ scriptsDir: '/tmp', file: '/etc/passwd' })
  assert.equal(r.ok, false)
})

test('parseOutput understands json and booleans', () => {
  assert.equal(scripts.parseOutput('true').value, true)
  assert.equal(scripts.parseOutput('12').value, 12)
  assert.deepEqual(scripts.parseOutput('{"a":1}').value, { a: 1 })
})
