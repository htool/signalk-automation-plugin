'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const engine = require('../lib/engine')

test('put valueFrom copies another path', async () => {
  const auto = {
    id: 'anchor',
    trigger: [{ path: 'winches.windlass.rode', above: 2, unit: 'm' }],
    condition: [],
    action: [
      { put: 'navigation.anchor.maxRadius', value: 40 },
      { put: 'navigation.anchor.position', valueFrom: 'navigation.position' }
    ],
    choose: []
  }
  const puts = []
  const pos = { latitude: 52.4876, longitude: 5.0636 }
  const record = await engine.evaluateAutomation(auto, {
    values: { 'winches.windlass.rode': 8, 'navigation.position': pos },
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
  assert.deepEqual(puts, [
    ['navigation.anchor.maxRadius', 40],
    ['navigation.anchor.position', pos]
  ])
})

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
  assert.equal(record.result, 'ok')
  assert.equal(record.reason, 'condition not met')
  assert.equal(puts.length, 0)
})

test('starlink standby only at home harbour when not manual', async () => {
  const auto = {
    id: 'starlink_standby',
    trigger: [{ schedule: '0 4 * * *' }],
    condition: [
      { zone: 'home_harbour' },
      { helper: 'starlink_manual', is: false }
    ],
    action: [{ put: 'electrical.switches.starlink.state', value: 1 }],
    choose: []
  }
  const home = { lat: 52.48759, lon: 5.06362, radius: 30 }
  const ctx = (values) => ({
    values,
    zones: { home_harbour: home },
    enabled: true,
    trigger: { schedule: '0 4 * * *' },
    now: new Date(2026, 8, 14, 4, 0, 0).getTime(),
    put: async () => {},
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  const atHome = { latitude: 52.48759, longitude: 5.06362 }
  const away = { latitude: 52.4, longitude: 5.0 }

  const homeOk = await engine.evaluateAutomation(auto, ctx({
    'navigation.position': atHome,
    'automations.helpers.starlink_manual': false
  }))
  assert.equal(homeOk.result, 'ok')

  const homeManual = await engine.evaluateAutomation(auto, ctx({
    'navigation.position': atHome,
    'automations.helpers.starlink_manual': true
  }))
  assert.equal(homeManual.result, 'ok')
  assert.equal(homeManual.reason, 'condition not met')

  const awayOk = await engine.evaluateAutomation(auto, ctx({
    'navigation.position': away,
    'automations.helpers.starlink_manual': false
  }))
  assert.equal(awayOk.result, 'ok')
  assert.equal(awayOk.reason, 'condition not met')
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
  const put = record.actions.find((a) => a.type === 'put')
  assert.equal(put.changed, true)
  assert.equal(put.previous, undefined)
})

test('zone matches lat/lon GPS as well as latitude/longitude', async () => {
  const auto = {
    id: 'z',
    trigger: [],
    condition: [{ zone: 'home_harbour' }],
    action: [{ put: 'electrical.switches.dolphinCharger.state', value: true }],
    choose: []
  }
  const home = { lat: 52.48759, lon: 5.06362, radius: 30 }
  const record = await engine.evaluateAutomation(auto, {
    values: { 'navigation.position': { lat: 52.4875866, lon: 5.0636168 } },
    zones: { home_harbour: home },
    enabled: true,
    now: Date.now(),
    put: async () => {},
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.equal(record.conditions[0].pass, true)
  assert.ok(record.conditions[0].actual.distance_m < 5)
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

test('unchanged PUT is not sent again', async () => {
  const auto = {
    id: 'charge',
    trigger: [],
    condition: [],
    action: [{ put: 'electrical.switches.dolphinCharger.state', value: true }],
    choose: []
  }
  const puts = []
  const record = await engine.evaluateAutomation(auto, {
    values: { 'electrical.switches.dolphinCharger.state': true },
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
  assert.equal(puts.length, 0)
  assert.equal(record.actions[0].changed, false)
})

test('verbose log shows trigger and ✓/✗ conditions', async () => {
  const auto = {
    id: 'charge',
    alias: 'Walstroom laadbeleid',
    trigger: [{ path: 'electrical.switches.dolphinCharger.voltage' }],
    condition: [],
    action: [],
    choose: [
      {
        alias: 'thuis onder 60%',
        conditions: [
          { path: 'electrical.switches.dolphinCharger.voltage', above: 200 },
          { zone: 'home_harbour' },
          { path: 'electrical.batteries.1.capacity.stateOfCharge', below: 0.6 }
        ],
        action: [{ put: 'electrical.switches.dolphinCharger.state', value: true }]
      }
    ]
  }
  const home = { lat: 52.48759, lon: 5.06362, radius: 30 }
  const record = await engine.evaluateAutomation(auto, {
    values: {
      'electrical.switches.dolphinCharger.voltage': 230,
      'electrical.batteries.1.capacity.stateOfCharge': 0.72,
      'navigation.position': { latitude: 52.48759, longitude: 5.06362 }
    },
    zones: { home_harbour: home },
    enabled: true,
    trigger: { path: 'electrical.batteries.1.capacity.stateOfCharge', value: 0.72 },
    now: Date.now(),
    put: async () => {},
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.equal(record.reason, 'no matching choose branch')
  assert.equal(record.firedBy, 'electrical.batteries.1.capacity.stateOfCharge = 0.72')
  assert.match(record.verboseLog, /trigger: electrical\.batteries\.1\.capacity\.stateOfCharge = 0\.72/)
  assert.match(record.verboseLog, /✓ electrical\.switches\.dolphinCharger\.voltage > 200 \(230\)/)
  assert.match(record.verboseLog, /✓ zone home_harbour/)
  assert.match(record.verboseLog, /✗ electrical\.batteries\.1\.capacity\.stateOfCharge < 0\.6 \(0\.72\)/)
  assert.equal(record.branches[0].picked, false)
})

test('any humidity branch still matches when another room is missing', async () => {
  const auto = {
    id: 'ontvochtiger',
    alias: 'Ontvochtiger',
    trigger: [{ path: 'environment.inside.hutvoor.humidity' }],
    condition: [],
    action: [],
    choose: [
      {
        alias: 'vochtig',
        conditions: [
          {
            any: [
              { path: 'environment.inside.hutachterstuurboord.humidity', above: 0.69 },
              { path: 'environment.inside.hutvoor.humidity', above: 0.69 }
            ]
          }
        ],
        action: [{ put: 'electrical.switches.smartplugontvochtiger.state', value: 1 }]
      },
      {
        alias: 'droog',
        action: [{ put: 'electrical.switches.smartplugontvochtiger.state', value: 0 }]
      }
    ]
  }
  const puts = []
  const record = await engine.evaluateAutomation(auto, {
    values: { 'environment.inside.hutvoor.humidity': 0.7 },
    zones: {},
    enabled: true,
    trigger: { path: 'environment.inside.hutvoor.humidity', value: 0.7 },
    now: Date.now(),
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.equal(record.choose, 'vochtig')
  assert.deepEqual(puts, [['electrical.switches.smartplugontvochtiger.state', 1]])
  assert.match(record.verboseLog, /✓ any/)
  assert.match(record.verboseLog, /✓ environment.inside.hutvoor.humidity > 0.69 \(0\.7\)/)
})

test('choose is OK when a compared path is missing', async () => {
  const auto = {
    id: 'charge',
    trigger: [{ path: 'sensors.presence.dolphinshelly' }],
    condition: [],
    action: [],
    choose: [
      {
        alias: 'thuis onder 60%',
        conditions: [
          { path: 'electrical.batteries.1.capacity.stateOfCharge', below: 0.6 }
        ],
        action: [{ put: 'electrical.switches.orionCharger.state', value: 1 }]
      }
    ]
  }
  const record = await engine.evaluateAutomation(auto, {
    values: { 'sensors.presence.dolphinshelly': true },
    zones: {},
    enabled: true,
    trigger: { path: 'sensors.presence.dolphinshelly', value: true },
    now: Date.now(),
    put: async () => {},
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.equal(record.reason, 'no matching choose branch')
  assert.equal(record.branches[0].conditions[0].error, 'missing')
})

test('cronMatch 04:00', () => {
  const d = new Date(2026, 8, 14, 4, 0, 0)
  assert.equal(engine.cronMatch('0 4 * * *', d), true)
  assert.equal(engine.cronMatch('0 5 * * *', d), false)
})

test('cronMatch every 15 minutes', () => {
  assert.equal(engine.cronMatch('*/15 * * * *', new Date(2026, 8, 15, 15, 0, 0)), true)
  assert.equal(engine.cronMatch('*/15 * * * *', new Date(2026, 8, 15, 15, 15, 0)), true)
  assert.equal(engine.cronMatch('*/15 * * * *', new Date(2026, 8, 15, 15, 7, 0)), false)
})

test('path trigger still fires when a schedule is also listed', async () => {
  const auto = {
    id: 'shore_charge',
    trigger: [
      { path: 'sensors.presence.dolphinshelly' },
      { schedule: '*/15 * * * *' }
    ],
    condition: [],
    action: [{ put: 'electrical.switches.orionCharger.state', value: 1 }],
    choose: []
  }
  const puts = []
  const record = await engine.evaluateAutomation(auto, {
    values: { 'sensors.presence.dolphinshelly': true },
    zones: {},
    enabled: true,
    trigger: { path: 'sensors.presence.dolphinshelly', value: true },
    now: new Date(2026, 8, 15, 15, 7, 0).getTime(),
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    setHelper: () => {},
    sleep: async () => {},
    runScript: async () => ({ ok: true, value: '' })
  })
  assert.equal(record.result, 'ok')
  assert.deepEqual(puts, [['electrical.switches.orionCharger.state', 1]])
})

test('quantizeValue rounds numbers and lat/lon', () => {
  assert.equal(engine.quantizeValue(230.4, 1), 230)
  assert.equal(engine.quantizeValue(230.6, 1), 231)
  assert.equal(engine.quantizeValue(0.724, 0.01), 0.72)
  const q = engine.quantizeValue({ latitude: 52.48759, longitude: 5.06362 }, 0.0001)
  assert.equal(q.latitude, 52.4876)
  assert.equal(q.longitude, 5.0636)
})

test('collectPaths includes PUT targets so live switch state is seeded', () => {
  const paths = engine.collectPaths({
    automations: [
      {
        id: 'shore_charge',
        trigger: [{ path: 'sensors.presence.dolphinshelly' }],
        choose: [
          {
            alias: 'klaar voor vertrek laden',
            conditions: [{ helper: 'depart_prep', is: true }],
            action: [{ put: 'electrical.switches.orionCharger.state', value: 1 }]
          }
        ]
      }
    ],
    helpers: { depart_prep: { id: 'depart_prep', type: 'boolean' } }
  })
  assert.ok(paths.includes('electrical.switches.orionCharger.state'))
  assert.ok(paths.includes('sensors.presence.dolphinshelly'))
})



