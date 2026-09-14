'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Runtime } = require('../lib/runtime')

test('restore helper comes back after new Runtime load', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rt-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'helpers:',
      '  manual:',
      '    type: boolean',
      '    default: false',
      '    on_start: restore',
      '  hold:',
      '    type: boolean',
      '    default: true',
      '    on_start: default',
      'automations: []',
      ''
    ].join('\n')
  )
  const opts = () => ({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async () => {},
    notify: async () => {},
    sleep: async () => {}
  })
  const a = new Runtime(opts())
  a.load()
  a.setHelper('manual', true)
  a.setHelper('hold', false)

  const b = new Runtime(opts())
  b.load()
  assert.equal(b.helperValues.manual, true)
  assert.equal(b.helperValues.hold, true)
})
