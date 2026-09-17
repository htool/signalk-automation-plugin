'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { Runtime } = require('../lib/runtime')
const store = require('../lib/store')

function gitCmd (args, cwd) {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf8' }
  )
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim())
  }
  return (r.stdout || '').trim()
}

test('UI on/off survives a fresh load; YAML enabled is ignored', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-on-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  const yamlText = [
    'automations:',
    '  - id: shore_charge',
    '    alias: Walstroom laadbeleid',
    '    enabled: false',
    '    trigger: []',
    '    action: []',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(yamlDir, 'a.yaml'), yamlText)
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
  assert.equal(a.snapshot().automations[0].enabled, false)
  assert.equal(a.doc.automations[0].enabled, undefined)
  a.setEnabled('shore_charge', true)
  assert.equal(a.isEnabled(a.doc.automations[0]), true)

  const b = new Runtime(opts())
  b.load()
  assert.equal(b.snapshot().automations[0].enabled, true)
  b.reloadWorkingTree()
  assert.equal(b.snapshot().automations[0].enabled, true)
  assert.match(fs.readFileSync(path.join(store.liveDir(dataDir), 'a.yaml'), 'utf8'), /enabled: false/)
})

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

test('invalid YAML on activateCommit leaves previous live snapshot in place', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-live-'))
  const dataDir = path.join(root, 'data')
  const yamlDir = path.join(root, 'yaml')
  fs.mkdirSync(yamlDir)
  const good = [
    'automations:',
    '  - id: keep_me',
    '    trigger: []',
    '    action: []',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(yamlDir, 'a.yaml'), good)
  gitCmd(['init', '-b', 'main'], yamlDir)
  gitCmd(['add', '.'], yamlDir)
  gitCmd(['commit', '-m', 'good'], yamlDir)
  const goodSha = gitCmd(['rev-parse', 'HEAD'], yamlDir)

  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async () => {},
    notify: async () => {},
    sleep: async () => {}
  })
  rt.load()
  rt.activateCommit(goodSha)
  assert.equal(rt.doc.automations[0].id, 'keep_me')
  const liveYaml = path.join(store.liveDir(dataDir), 'a.yaml')
  assert.equal(fs.readFileSync(liveYaml, 'utf8'), good)

  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    ['helpers:', '  broken:', '    type: not-a-type', 'automations: []', ''].join('\n')
  )
  gitCmd(['add', '.'], yamlDir)
  gitCmd(['commit', '-m', 'bad'], yamlDir)
  const badSha = gitCmd(['rev-parse', 'HEAD'], yamlDir)

  assert.throws(
    () => rt.activateCommit(badSha),
    /YAML invalid, live not changed/
  )
  assert.equal(rt.doc.automations[0].id, 'keep_me')
  assert.equal(fs.readFileSync(liveYaml, 'utf8'), good)
  assert.equal(fs.existsSync(store.liveDir(dataDir) + '.incoming'), false)

  const reloaded = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async () => {},
    notify: async () => {},
    sleep: async () => {}
  })
  reloaded.load()
  assert.equal(reloaded.doc.automations[0].id, 'keep_me')
})

test('reloadWorkingTree copies disk YAML into live; invalid YAML keeps previous', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-reload-'))
  const dataDir = path.join(root, 'data')
  const yamlDir = path.join(root, 'yaml')
  fs.mkdirSync(yamlDir)
  const first = [
    'automations:',
    '  - id: first',
    '    trigger: []',
    '    action: []',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(yamlDir, 'a.yaml'), first)
  gitCmd(['init', '-b', 'main'], yamlDir)
  gitCmd(['add', '.'], yamlDir)
  gitCmd(['commit', '-m', 'first'], yamlDir)

  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async () => {},
    notify: async () => {},
    sleep: async () => {}
  })
  rt.load()
  rt.reloadWorkingTree()
  assert.equal(rt.doc.automations[0].id, 'first')
  const liveYaml = path.join(store.liveDir(dataDir), 'a.yaml')
  assert.equal(fs.readFileSync(liveYaml, 'utf8'), first)

  const second = [
    'automations:',
    '  - id: second',
    '    trigger: []',
    '    action: []',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(yamlDir, 'a.yaml'), second)
  rt.reloadWorkingTree()
  assert.equal(rt.doc.automations[0].id, 'second')
  assert.equal(fs.readFileSync(liveYaml, 'utf8'), second)

  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    ['helpers:', '  broken:', '    type: not-a-type', 'automations: []', ''].join('\n')
  )
  assert.throws(
    () => rt.reloadWorkingTree(),
    /YAML invalid, live not changed/
  )
  assert.equal(rt.doc.automations[0].id, 'second')
  assert.equal(fs.readFileSync(liveYaml, 'utf8'), second)
  assert.equal(fs.existsSync(store.liveDir(dataDir) + '.incoming'), false)
})

test('PUT from automation is recorded on the switch log', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-swrt-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    alias: Walstroom laadbeleid',
      '    trigger: []',
      '    action:',
      '      - put: electrical.switches.dolphinCharger.state',
      '        value: true',
      ''
    ].join('\n')
  )
  const lines = []
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async () => {},
    notify: async () => {},
    sleep: async () => {},
    log: { info: (m) => lines.push(m), debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('shore_charge', true)
  await rt.maybeRun(rt.doc.automations[0], {})
  const log = store.loadSwitchLog(dataDir)
  assert.equal(log.length, 1)
  assert.equal(log[0].kind, 'put')
  assert.equal(log[0].path, 'electrical.switches.dolphinCharger.state')
  assert.equal(log[0].to, true)
  assert.match(lines[0], /PUT electrical.switches.dolphinCharger.state/)
})

test('runNow ignores enabled:false and skips triggers', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-runnow-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    alias: Walstroom laadbeleid',
      '    enabled: false',
      '    trigger:',
      '      - path: electrical.never',
      '        above: 999',
      '    action:',
      '      - put: electrical.switches.dolphinCharger.state',
      '        value: true',
      '      - delay: 15m',
      ''
    ].join('\n')
  )
  const puts = []
  let slept = false
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => { slept = true },
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  const skipped = await rt.maybeRun(rt.doc.automations[0], { path: 'electrical.never' })
  assert.equal(skipped, undefined)
  assert.equal(puts.length, 0)
  const record = await rt.runNow('shore_charge')
  assert.equal(record.result, 'ok')
  assert.equal(record.manual, true)
  assert.deepEqual(puts, [['electrical.switches.dolphinCharger.state', true]])
  assert.equal(slept, false)
  assert.equal(record.actions.some((a) => a.type === 'delay' && a.skipped), true)
})

test('choose policy re-evaluates after a no-branch skip; verbose logs the path', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-choose-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    alias: Walstroom laadbeleid',
      '    zones:',
      '      home_harbour:',
      '        lat: 52.48759',
      '        lon: 5.06362',
      '        radius: 30',
      '    trigger:',
      '      - path: electrical.switches.dolphinCharger.voltage',
      '      - path: electrical.batteries.1.capacity.stateOfCharge',
      '    choose:',
      '      - alias: thuis onder 60%',
      '        conditions:',
      '          - path: electrical.switches.dolphinCharger.voltage',
      '            above: 200',
      '          - zone: home_harbour',
      '          - path: electrical.batteries.1.capacity.stateOfCharge',
      '            below: 0.6',
      '        action:',
      '          - put: electrical.switches.dolphinCharger.state',
      '            value: true',
      ''
    ].join('\n')
  )
  const puts = []
  const logs = []
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info: (m) => logs.push(m), debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('shore_charge', true)
  rt.setPathValue('electrical.switches.dolphinCharger.voltage', 230)
  rt.setPathValue('electrical.batteries.1.capacity.stateOfCharge', 0.7)
  rt.setPathValue('navigation.position', { latitude: 52.48759, longitude: 5.06362 })

  const mid = await rt.maybeRun(rt.doc.automations[0], {
    path: 'electrical.batteries.1.capacity.stateOfCharge',
    value: 0.7
  })
  assert.equal(mid.result, 'ok')
  assert.equal(mid.reason, 'no matching choose branch')
  assert.equal(puts.length, 0)
  assert.equal(store.loadTraces(dataDir, 'shore_charge').length, 0)
  assert.equal(logs.length, 0)

  rt.setVerbose('shore_charge', true)
  const verboseSkip = await rt.maybeRun(rt.doc.automations[0], {
    path: 'electrical.batteries.1.capacity.stateOfCharge',
    value: 0.7
  })
  assert.equal(verboseSkip.result, 'ok')
  assert.equal(store.loadTraces(dataDir, 'shore_charge').length, 1)
  assert.match(verboseSkip.verboseLog, /trigger: electrical\.batteries\.1\.capacity\.stateOfCharge = 0\.7/)
  assert.match(verboseSkip.verboseLog, /✗ electrical\.batteries\.1\.capacity\.stateOfCharge < 0\.6/)
  assert.match(logs[0], /✗/)

  rt.setPathValue('electrical.batteries.1.capacity.stateOfCharge', 0.5)
  const low = await rt.maybeRun(rt.doc.automations[0], {
    path: 'electrical.batteries.1.capacity.stateOfCharge',
    value: 0.5
  })
  assert.equal(low.result, 'ok')
  assert.equal(low.choose, 'thuis onder 60%')
  assert.deepEqual(puts, [['electrical.switches.dolphinCharger.state', true]])
  assert.match(low.verboseLog, /✓ electrical\.batteries\.1\.capacity\.stateOfCharge < 0\.6 \(0\.5\)/)
})

test('cron fires again the next day without an explicit rising edge', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: starlink_standby',
      '    trigger:',
      '      - schedule: "0 4 * * *"',
      '    action:',
      '      - put: electrical.switches.starlink.state',
      '        value: 1',
      ''
    ].join('\n')
  )
  const puts = []
  let now = new Date(2026, 8, 14, 4, 0, 0).getTime()
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    now: () => now,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('starlink_standby', true)
  await rt.tickSchedule(new Date(now))
  assert.equal(puts.length, 1)
  rt.setPathValue('electrical.switches.starlink.state', 0)
  now = new Date(2026, 8, 15, 4, 0, 0).getTime()
  await rt.tickSchedule(new Date(now))
  assert.equal(puts.length, 2)
})

test('mixed path + schedule: path change runs off the cron minute', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mixtrig-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    trigger:',
      '      - path: sensors.presence.dolphinshelly',
      '      - helper: depart_prep',
      '      - schedule: "*/15 * * * *"',
      '    action:',
      '      - put: electrical.switches.orionCharger.state',
      '        value: 1',
      ''
    ].join('\n')
  )
  const puts = []
  let now = new Date(2026, 8, 15, 15, 7, 0).getTime()
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    now: () => now,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('shore_charge', true)
  rt.setPathValue('sensors.presence.dolphinshelly', true)
  await rt.handlePathChange('sensors.presence.dolphinshelly', true)
  assert.equal(puts.length, 1)
  rt.setPathValue('electrical.switches.orionCharger.state', 0)
  now = new Date(2026, 8, 15, 15, 15, 0).getTime()
  await rt.tickSchedule(new Date(now))
  assert.equal(puts.length, 2)
})

test('round on a trigger ignores sub-step path noise', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-round-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    trigger:',
      '      - path: electrical.switches.dolphinCharger.voltage',
      '        round: 1',
      '    action:',
      '      - put: electrical.switches.dolphinCharger.state',
      '        value: true',
      ''
    ].join('\n')
  )
  const puts = []
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('shore_charge', true)
  await rt.handlePathChange('electrical.switches.dolphinCharger.voltage', 230.1)
  assert.equal(puts.length, 1)
  await rt.handlePathChange('electrical.switches.dolphinCharger.voltage', 230.4)
  assert.equal(puts.length, 1)
  await rt.handlePathChange('electrical.switches.dolphinCharger.voltage', 231.2)
  assert.equal(puts.length, 1)
})

test('depart_prep helper turns home charging on until nearly full', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-depart-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'helpers:',
      '  depart_prep:',
      '    type: boolean',
      '    default: false',
      '    on_start: restore',
      'automations:',
      '  - id: shore_charge',
      '    zones:',
      '      home_harbour:',
      '        lat: 52.48759',
      '        lon: 5.06362',
      '        radius: 30',
      '    trigger:',
      '      - path: electrical.switches.dolphinCharger.voltage',
      '        round: 1',
      '      - path: electrical.batteries.1.capacity.stateOfCharge',
      '        round: 0.01',
      '      - helper: depart_prep',
      '    choose:',
      '      - alias: klaar voor vertrek laden',
      '        conditions:',
      '          - zone: home_harbour',
      '          - helper: depart_prep',
      '            is: true',
      '          - path: electrical.batteries.1.capacity.stateOfCharge',
      '            below: 0.98',
      '        action:',
      '          - put: electrical.switches.dolphinCharger.state',
      '            value: true',
      '      - alias: klaar voor vertrek vol',
      '        conditions:',
      '          - helper: depart_prep',
      '            is: true',
      '          - path: electrical.batteries.1.capacity.stateOfCharge',
      '            above: 0.97',
      '        action:',
      '          - put: electrical.switches.dolphinCharger.state',
      '            value: false',
      '          - helper: depart_prep',
      '            value: false',
      ''
    ].join('\n')
  )
  const puts = []
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('shore_charge', true)
  rt.setPathValue('electrical.switches.dolphinCharger.voltage', 230)
  rt.setPathValue('electrical.batteries.1.capacity.stateOfCharge', 0.7)
  rt.setPathValue('navigation.position', { latitude: 52.48759, longitude: 5.06362 })
  await rt.setHelper('depart_prep', true)
  assert.deepEqual(puts, [['electrical.switches.dolphinCharger.state', true]])
  rt.setPathValue('electrical.batteries.1.capacity.stateOfCharge', 0.99)
  await rt.handlePathChange('electrical.batteries.1.capacity.stateOfCharge', 0.99)
  assert.equal(puts[1][1], false)
  assert.equal(rt.helperValues.depart_prep, false)
})

test('runNow PUT previous is live SK value, not a stale cache from a failed PUT', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-putprev-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'automations:',
      '  - id: shore_charge',
      '    alias: Walstroom laadbeleid',
      '    trigger: []',
      '    action:',
      '      - put: electrical.switches.orionCharger.state',
      '        value: 1',
      ''
    ].join('\n')
  )
  let shouldFail = true
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    app: {
      getSelfPath (p) {
        if (p === 'electrical.switches.orionCharger.state') return { value: 0 }
        return undefined
      }
    },
    put: async () => {
      if (shouldFail) throw new Error('multiple sources')
    },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  const failed = await rt.runNow('shore_charge')
  assert.equal(failed.result, 'failure')
  assert.equal(rt.values['electrical.switches.orionCharger.state'], 0)
  shouldFail = false
  const ok = await rt.runNow('shore_charge')
  assert.equal(ok.result, 'ok')
  const put = ok.actions.find((a) => a.type === 'put')
  assert.equal(put.previous, 0)
  assert.equal(put.value, 1)
  assert.equal(put.changed, true)
})

test('latch_on_external_put sets helper on off as well as on', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-latch-'))
  const yamlDir = path.join(dataDir, 'yaml')
  fs.mkdirSync(yamlDir)
  fs.writeFileSync(
    path.join(yamlDir, 'a.yaml'),
    [
      'helpers:',
      '  kruimeldief_manual:',
      '    type: boolean',
      '    default: false',
      '    on_start: restore',
      '    latch_on_external_put: electrical.switches.smartplugkruimeldief.state',
      'automations:',
      '  - id: kruimeldief',
      '    trigger:',
      '      - helper: kruimeldief_manual',
      '    choose:',
      '      - alias: handmatig',
      '        conditions:',
      '          - helper: kruimeldief_manual',
      '            is: true',
      '        action: []',
      '      - alias: thuis',
      '        action:',
      '          - put: electrical.switches.smartplugkruimeldief.state',
      '            value: 0',
      ''
    ].join('\n')
  )
  const puts = []
  const rt = new Runtime({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: yamlDir,
    scriptsDir: yamlDir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    sleep: async () => {},
    log: { info () {}, debug () {}, error () {} }
  })
  rt.load()
  rt.setEnabled('kruimeldief', true)
  await rt.handlePathChange('electrical.switches.smartplugkruimeldief.state', 0, 'mqtt.zigbee')
  assert.equal(rt.helperValues.kruimeldief_manual, false)
  await rt.handlePathChange('electrical.switches.smartplugkruimeldief.state', false, 'mqtt.zigbee')
  assert.equal(rt.helperValues.kruimeldief_manual, false)
  await rt.handlePathChange('electrical.switches.smartplugkruimeldief.state', 1, 'mqtt.zigbee')
  assert.equal(rt.helperValues.kruimeldief_manual, true)
  await rt.handlePathChange('electrical.switches.smartplugkruimeldief.state', 0, 'mqtt.zigbee')
  assert.equal(rt.helperValues.kruimeldief_manual, true)
  assert.equal(puts.length, 0)
})


