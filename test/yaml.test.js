'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('../lib/yaml')

const SAMPLE = `
helpers:
  starlink_manual:
    type: boolean
    default: false
    on_start: restore
zones:
  home_harbour:
    lat: 52.37
    lon: 5.22
    radius: 150
automations:
  - id: start_anchorwatch
    alias: chain
    trigger:
      - path: winches.windlass.rode
        above: 2
        unit: m
    action:
      - put: navigation.anchor.watch
        value: true
`

test('loads helpers, zones and automations', () => {
  const doc = yaml.loadYamlText(SAMPLE, 'a.yaml')
  assert.equal(doc.errors.length, 0)
  assert.equal(doc.helpers.starlink_manual.on_start, 'restore')
  assert.equal(doc.zones.home_harbour.radius, 150)
  assert.equal(doc.automations[0].id, 'start_anchorwatch')
})

test('rejects bad on_start', () => {
  const doc = yaml.loadYamlText(
    'helpers:\n  x:\n    type: boolean\n    on_start: banana\n',
    'b.yaml'
  )
  assert.ok(doc.errors.some((e) => /on_start/.test(e.message)))
})

test('duplicate automation ids error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-yaml-'))
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'automations:\n  - id: one\n    action: []\n')
  fs.writeFileSync(path.join(dir, 'b.yaml'), 'automations:\n  - id: one\n    action: []\n')
  const doc = yaml.loadYamlDir(dir)
  assert.ok(doc.errors.some((e) => /Duplicate automation id/.test(e.message)))
})
