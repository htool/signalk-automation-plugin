'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const engine = require('../lib/engine')

test('path above trigger in SI metres', async () => {
  const auto = {
    id: 'chain',
    trigger: [{ path: 'winches.windlass.rode', above: 2, unit: 'm' }],
    condition: [],
    action: [{ put: 'navigation.anchor.watch', value: true }],
    choose: []
  }
  const puts = []
  const record = await engine.evaluateAutomation(auto, {
    values: { 'winches.windlass.rode': 3 },
    zones: {},
    enabled: true,
    now: Date.now(),
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.deepEqual(puts, [['navigation.anchor.watch', true]])
})

test('helper condition blocks action', async () => {
  const auto = {
    id: 'sl',
    trigger: [{ schedule: '0 4 * * *' }],
    condition: [{ helper: 'starlink_manual', is: false }],
    action: [{ put: 'electrical.switches.starlink.state', value: true }],
    choose: []
  }
  const puts = []
  const record = await engine.evaluateAutomation(auto, {
    values: { 'automations.helpers.starlink_manual': true },
    zones: {},
    enabled: true,
    trigger: { schedule: '0 4 * * *' },
    now: new Date(2026, 8, 14, 4, 0, 0).getTime(),
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'skipped')
  assert.equal(puts.length, 0)
})

test('choose picks first matching branch', async () => {
  const auto = {
    id: 'charge',
    trigger: [{ path: 'electrical.chargers.shore.connected' }],
    condition: [],
    action: [],
    choose: [
      {
        alias: 'away',
        conditions: [
          { path: 'electrical.chargers.shore.connected', is: true },
          { not: { zone: 'home_harbour' } }
        ],
        action: [{ put: 'electrical.switches.dolphinCharger.state', value: 1 }]
      },
      {
        alias: 'home-low',
        conditions: [
          { path: 'electrical.chargers.shore.connected', is: true },
          { zone: 'home_harbour' }
        ],
        action: [{ put: 'electrical.switches.dolphinCharger.state', value: 0 }]
      }
    ]
  }
  const puts = []
  const home = { lat: 52.37, lon: 5.22, radius: 150 }
  const record = await engine.evaluateAutomation(auto, {
    values: {
      'electrical.chargers.shore.connected': true,
      'navigation.position': { latitude: 52.3701, longitude: 5.2201 }
    },
    zones: { home_harbour: home },
    enabled: true,
    now: Date.now(),
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.equal(record.choose, 'home-low')
  assert.deepEqual(puts, [['electrical.switches.dolphinCharger.state', 0]])
})

test('script action failure from stderr', async () => {
  const auto = {
    id: 'run',
    trigger: [],
    condition: [],
    action: [{ run: { file: 'x.sh' } }],
    choose: []
  }
  const record = await engine.evaluateAutomation(auto, {
    values: {},
    zones: {},
    enabled: true,
    now: Date.now(),
    put: async () => {},
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: false, error: 'stderr: boom', stdout: '' })
  })
  assert.equal(record.result, 'failure')
  assert.match(record.reason, /stderr/)
})

test('cronMatch 04:00', () => {
  const d = new Date(2026, 8, 14, 4, 0, 0)
  assert.equal(engine.cronMatch('0 4 * * *', d), true)
  assert.equal(engine.cronMatch('0 5 * * *', d), false)
})
