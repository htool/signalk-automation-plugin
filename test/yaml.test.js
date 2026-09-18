'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('../lib/yaml')

const SAMPLE = `
helpers:
  dish_manual:
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
  assert.equal(doc.helpers.dish_manual.on_start, 'restore')
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

test('snippetAutomation is only that list item', () => {
  const doc = yaml.loadYamlText(SAMPLE, 'a.yaml')
  const snip = yaml.snippetAutomation(doc, 'start_anchorwatch')
  assert.match(snip, /id: start_anchorwatch/)
  assert.match(snip, /winches\.windlass\.rode/)
  assert.doesNotMatch(snip, /home_harbour/)
  assert.doesNotMatch(snip, /dish_manual/)
})

test('zones on an automation are loaded and shown in that snippet', () => {
  const text = [
    'automations:',
    '  - id: shore_charge',
    '    alias: Shore charge',
    '    zones:',
    '      home_harbour:',
    '        lat: 52.1',
    '        lon: 4.9',
    '        radius: 30',
    '    trigger: []',
    '    action: []',
    ''
  ].join('\n')
  const doc = yaml.loadYamlText(text, 'a.yaml')
  assert.equal(doc.errors.length, 0)
  assert.equal(doc.zones.home_harbour.radius, 30)
  const snip = yaml.snippetAutomation(doc, 'shore_charge')
  assert.match(snip, /zones:/)
  assert.match(snip, /home_harbour:/)
  assert.match(snip, /radius: 30/)
})

test('snippetHelper is only that mapping', () => {
  const doc = yaml.loadYamlText(SAMPLE, 'a.yaml')
  const snip = yaml.snippetHelper(doc, 'dish_manual')
  assert.match(snip, /dish_manual:/)
  assert.match(snip, /on_start: restore/)
  assert.doesNotMatch(snip, /home_harbour/)
  assert.doesNotMatch(snip, /start_anchorwatch/)
})

test('round on a trigger must be a positive number', () => {
  const doc = yaml.loadYamlText(
    [
      'automations:',
      '  - id: shore_charge',
      '    trigger:',
      '      - path: electrical.switches.charger.voltage',
      '        round: 0',
      '    action: []',
      ''
    ].join('\n'),
    'a.yaml'
  )
  assert.ok(doc.errors.some((e) => /round must be a positive number/.test(e.message)))
})

test('mode must be parallel, restart, or single', () => {
  const doc = yaml.loadYamlText(
    [
      'automations:',
      '  - id: plug_charge',
      '    mode: banana',
      '    trigger: []',
      '    action: []',
      ''
    ].join('\n'),
    'a.yaml'
  )
  assert.ok(doc.errors.some((e) => /mode must be parallel, restart, or single/.test(e.message)))
})

