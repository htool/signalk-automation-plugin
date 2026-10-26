'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const store = require('../lib/store')
const { Runtime } = require('../lib/runtime')

const PLUG = 'electrical.switches.smartplugVHF.state'

function yamlDir (dataDir, body) {
  const dir = path.join(dataDir, 'yaml')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.yaml'), body)
  return dir
}

const VHF_YAML = [
  'zones:',
  '  home_harbour:',
  '    lat: 52.37',
  '    lon: 4.90',
  '    radius: 500',
  'automations:',
  '  - id: vhf_charge',
  '    alias: Marifoon laden',
  '    mode: single',
  '    trigger:',
  '      - path: ' + PLUG,
  '        is: 1',
  '    choose:',
  '      - alias: charge',
  '        conditions:',
  '          - path: ' + PLUG,
  '            is: 1',
  '        action:',
  '          - put: ' + PLUG,
  '            value: 1',
  '          - delay: 1h',
  '          - put: ' + PLUG,
  '            value: 0',
  '            if:',
  '              - zone: home_harbour',
  '      - alias: other',
  '        action:',
  '          - put: electrical.switches.other.state',
  '            value: 1',
  ''
].join('\n')

function runtime (dataDir, dir, extra) {
  const puts = []
  const slept = []
  const rt = new Runtime(Object.assign({
    pluginId: 'signalk-automation-plugin',
    dataDir,
    automationsDir: dir,
    scriptsDir: dir,
    put: async (p, v) => { puts.push([p, v]) },
    notify: async () => {},
    log: { info () {}, debug () {}, error () {} }
  }, extra, {
    put: extra && extra.put ? extra.put : async (p, v) => { puts.push([p, v]) }
  }))
  rt.puts = puts
  rt.slept = slept
  return rt
}

async function until (fn) {
  for (let i = 0; i < 40; i++) {
    if (fn()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('timed out')
}

test('delay persists the chosen tail and clears it when the wait ends', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t0 = new Date(2026, 9, 26, 3, 15, 0).getTime()
  const rt = runtime(dataDir, dir, {
    now: () => t0,
    sleep: async (ms) => {
      rt.slept.push(ms)
      await gate
    }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  rt.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  const run = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => store.loadDeadlines(dataDir).length === 1)
  const open = store.loadDeadlines(dataDir)[0]
  assert.equal(open.automationId, 'vhf_charge')
  assert.equal(open.alias, 'Marifoon laden')
  assert.equal(open.choose, 'charge')
  assert.equal(open.mode, 'single')
  assert.equal(open.delay, '1h')
  assert.equal(open.delayMs, 60 * 60 * 1000)
  assert.equal(open.deadline, t0 + 60 * 60 * 1000)
  assert.equal(open.actions.length, 1)
  assert.equal(open.actions[0].put, PLUG)
  assert.equal(open.actions[0].value, 0)
  assert.ok(open.actions[0].if)
  assert.equal(rt.snapshot().deadlines.length, 1)
  release()
  const record = await run
  assert.equal(record.result, 'ok')
  assert.equal(record.choose, 'charge')
  assert.deepEqual(store.loadDeadlines(dataDir), [])
  assert.deepEqual(rt.puts, [[PLUG, 0]])
})

test('manual Run does not persist a delay', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-skip-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  const rt = runtime(dataDir, dir, {
    sleep: async () => { throw new Error('sleep should not run') }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  rt.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  const record = await rt.runNow('vhf_charge')
  assert.equal(record.actions.some((a) => a.type === 'delay' && a.skipped), true)
  assert.deepEqual(store.loadDeadlines(dataDir), [])
  assert.deepEqual(rt.puts, [[PLUG, 1], [PLUG, 0]])
})

test('restart catch-up runs a past deadline once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-catch-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  const deadline = 1_700_000_000_000
  store.upsertDeadline(dataDir, {
    id: 'past1',
    automationId: 'vhf_charge',
    alias: 'Marifoon laden',
    mode: 'single',
    choose: 'charge',
    trigger: { schedule: '15 3 * * *' },
    delay: '1h',
    delayMs: 3600000,
    deadline,
    actions: [{ put: PLUG, value: 0, if: [{ zone: 'home_harbour' }] }],
    createdAt: '2026-10-26T02:15:00.000Z'
  })
  const rt = runtime(dataDir, dir, {
    now: () => deadline + 60 * 1000,
    sleep: async (ms) => { throw new Error('catch-up should not wait ' + ms) }
  })
  rt.load()
  rt.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  rt.setPathValue(PLUG, 1)
  const rows = await rt.resumeDeadlines()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].resumed, true)
  assert.equal(rows[0].firedBy, 'resumed delay')
  assert.equal(rows[0].result, 'ok')
  assert.deepEqual(rt.puts, [[PLUG, 0]])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
  const again = await rt.resumeDeadlines()
  assert.deepEqual(again, [])
  assert.deepEqual(rt.puts, [[PLUG, 0]])
  const traces = store.loadTraces(dataDir, 'vhf_charge')
  assert.equal(traces[0].resumed, true)
  assert.equal(rt.state.lastRun.vhf_charge.result, 'ok')
})

test('catch-up still runs when the automation is disabled', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-off-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  store.upsertDeadline(dataDir, {
    id: 'past2',
    automationId: 'vhf_charge',
    alias: 'Marifoon laden',
    mode: 'single',
    deadline: 50,
    actions: [{ put: PLUG, value: 0 }]
  })
  const rt = runtime(dataDir, dir, { now: () => 100, sleep: async () => {} })
  rt.load()
  assert.equal(rt.isEnabled(rt.doc.automations[0]), false)
  await rt.resumeDeadlines()
  assert.deepEqual(rt.puts, [[PLUG, 0]])
})

test('zone if is evaluated at catch-up time', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-zone-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  store.upsertDeadline(dataDir, {
    id: 'zone1',
    automationId: 'vhf_charge',
    mode: 'single',
    deadline: 10,
    actions: [{ put: PLUG, value: 0, if: [{ zone: 'home_harbour' }] }]
  })
  const rt = runtime(dataDir, dir, { now: () => 20, sleep: async () => {} })
  rt.load()
  rt.setPathValue('navigation.position', { latitude: 51.5, longitude: 4.5 })
  rt.setPathValue(PLUG, 1)
  const rows = await rt.resumeDeadlines()
  assert.equal(rows[0].actions[0].skipped, true)
  assert.deepEqual(rt.puts, [])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})

test('future deadline is re-armed for the remaining time', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-future-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  const deadline = 5_000_000
  store.upsertDeadline(dataDir, {
    id: 'fut1',
    automationId: 'vhf_charge',
    alias: 'Marifoon laden',
    mode: 'single',
    deadline,
    actions: [{ put: PLUG, value: 0 }]
  })
  let now = deadline - 4000
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const rt = runtime(dataDir, dir, {
    now: () => now,
    sleep: async (ms) => {
      rt.slept.push(ms)
      await gate
    }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  const pending = rt.resumeDeadlines()
  await until(() => rt.slept.length === 1)
  assert.deepEqual(rt.slept, [4000])
  assert.equal(store.loadDeadlines(dataDir)[0].id, 'fut1')
  const blocked = await rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  assert.equal(blocked, undefined)
  assert.deepEqual(rt.puts, [])
  release()
  const rows = await pending
  assert.deepEqual(rt.puts, [[PLUG, 0]])
  assert.equal(rows[0].result, 'ok')
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})

test('plugin stop keeps the deadline and the next start catch-up runs it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-stop-'))
  const dir = yamlDir(dataDir, VHF_YAML)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t0 = 10_000_000
  const rt = runtime(dataDir, dir, {
    now: () => t0,
    sleep: async () => { await gate }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  const run = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => store.loadDeadlines(dataDir).length === 1)
  const open = store.loadDeadlines(dataDir)[0]
  rt.halt()
  const paused = await run
  assert.equal(paused.reason, 'paused')
  assert.equal(store.loadDeadlines(dataDir).length, 1)
  release()

  const rt2 = runtime(dataDir, dir, {
    now: () => open.deadline + 5000,
    sleep: async (ms) => { throw new Error('catch-up waited ' + ms) }
  })
  rt2.load()
  rt2.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  rt2.setPathValue(PLUG, 1)
  await rt2.resumeDeadlines()
  assert.deepEqual(rt2.puts, [[PLUG, 0]])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})

test('mode restart drops the superseded deadline so it cannot catch up', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-re-'))
  const body = VHF_YAML.replace('mode: single', 'mode: restart')
  const dir = yamlDir(dataDir, body)
  const gates = []
  const t0 = new Date(2026, 9, 26, 3, 15, 0).getTime()
  const rt = runtime(dataDir, dir, {
    now: () => t0,
    sleep: () => new Promise((resolve) => { gates.push(resolve) })
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  const first = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => store.loadDeadlines(dataDir).length === 1)
  const oldId = store.loadDeadlines(dataDir)[0].id
  const second = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => {
    const rows = store.loadDeadlines(dataDir)
    return rows.length === 1 && rows[0].id !== oldId
  })
  const kept = store.loadDeadlines(dataDir)[0]
  assert.equal(kept.actions.length, 1)
  assert.equal(kept.actions[0].value, 0)
  const firstRecord = await first
  assert.equal(firstRecord.reason, 'superseded')
  rt.halt()
  const secondRecord = await second
  assert.equal(secondRecord.reason, 'paused')
  assert.equal(store.loadDeadlines(dataDir)[0].id, kept.id)

  const rt2 = runtime(dataDir, dir, {
    now: () => kept.deadline + 1000,
    sleep: async (ms) => { throw new Error('catch-up waited ' + ms) }
  })
  rt2.load()
  rt2.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  rt2.setPathValue(PLUG, 1)
  await rt2.resumeDeadlines()
  assert.deepEqual(rt2.puts, [[PLUG, 0]])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})

test('parallel runs keep distinct deadlines and both catch up', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-par-'))
  const body = VHF_YAML.replace('mode: single', 'mode: parallel')
  const dir = yamlDir(dataDir, body)
  const t0 = 42_000
  const rt = runtime(dataDir, dir, {
    now: () => t0,
    sleep: () => new Promise(() => {})
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  const a = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  const b = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => store.loadDeadlines(dataDir).length === 2)
  const ids = store.loadDeadlines(dataDir).map((d) => d.id)
  assert.equal(new Set(ids).size, 2)
  void a
  void b

  const rt2 = runtime(dataDir, dir, {
    now: () => t0 + 3600000 + 1,
    sleep: async (ms) => { throw new Error('catch-up waited ' + ms) }
  })
  rt2.load()
  rt2.setPathValue('navigation.position', { latitude: 52.37, longitude: 4.9 })
  rt2.setPathValue(PLUG, 1)
  await rt2.resumeDeadlines()
  assert.deepEqual(rt2.puts, [[PLUG, 0], [PLUG, 0]])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})

test('a second delay replaces the deadline with the later tail', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-two-'))
  const dir = yamlDir(dataDir, [
    'automations:',
    '  - id: vhf_charge',
    '    alias: Marifoon laden',
    '    trigger:',
    '      - path: ' + PLUG,
    '    action:',
    '      - put: ' + PLUG,
    '        value: 1',
    '      - delay: 1h',
    '      - put: ' + PLUG,
    '        value: 1',
    '      - delay: 30m',
    '      - put: ' + PLUG,
    '        value: 0',
    ''
  ].join('\n'))
  const sleeps = []
  let pending = []
  const t0 = 1000
  const rt = runtime(dataDir, dir, {
    now: () => t0,
    sleep: (ms) => {
      const snap = store.loadDeadlines(dataDir).map((d) => ({
        delay: d.delay,
        n: d.actions.length,
        last: d.actions.length ? d.actions[d.actions.length - 1].value : null
      }))
      sleeps.push({ ms, snap })
      return new Promise((resolve) => { pending.push(resolve) })
    }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 0)
  const run = rt.maybeRun(rt.doc.automations[0], { path: PLUG, value: 1 })
  await until(() => sleeps.length === 1)
  assert.equal(sleeps[0].ms, 3600000)
  assert.equal(sleeps[0].snap.length, 1)
  assert.equal(sleeps[0].snap[0].delay, '1h')
  assert.equal(sleeps[0].snap[0].n, 3)
  assert.equal(sleeps[0].snap[0].last, 0)
  pending.shift()()
  await until(() => sleeps.length === 2)
  assert.equal(sleeps[1].ms, 30 * 60 * 1000)
  assert.equal(sleeps[1].snap.length, 1)
  assert.equal(sleeps[1].snap[0].delay, '30m')
  assert.equal(sleeps[1].snap[0].n, 1)
  assert.equal(sleeps[1].snap[0].last, 0)
  pending.shift()()
  await run
  assert.deepEqual(store.loadDeadlines(dataDir), [])
  assert.deepEqual(rt.puts, [[PLUG, 1], [PLUG, 0]])
})

test('plugin start catch-up runs a persisted tail', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-life-'))
  const dir = yamlDir(dataDir, [
    'automations:',
    '  - id: vhf_charge',
    '    alias: Marifoon laden',
    '    trigger:',
    '      - schedule: "15 3 * * *"',
    '    action:',
    '      - delay: 1h',
    '      - put: ' + PLUG,
    '        value: 0',
    ''
  ].join('\n'))
  store.upsertDeadline(dataDir, {
    id: 'boot1',
    automationId: 'vhf_charge',
    alias: 'Marifoon laden',
    mode: 'single',
    deadline: Date.now() - 1000,
    actions: [{ put: PLUG, value: 0 }]
  })
  const puts = []
  const app = {
    debug () {},
    error (err) { throw err },
    setPluginStatus () {},
    getDataDirPath: () => dataDir,
    handleMessage () {},
    putSelfPath (p, v, cb) {
      puts.push([p, v])
      if (cb) cb(null)
    },
    registerPutHandler () {},
    subscriptionmanager: {
      subscribe (_sub, unsubscribes) {
        unsubscribes.push(() => {})
      }
    }
  }
  const resolved = require.resolve('../plugin/index.js')
  delete require.cache[resolved]
  const plugin = require('../plugin/index.js')(app)
  plugin.start({
    automationsDir: dir,
    scriptsDir: dir,
    startupSilence: 0
  })
  try {
    await until(() => puts.length === 1)
    assert.deepEqual(puts, [[PLUG, 0]])
    assert.deepEqual(store.loadDeadlines(dataDir), [])
  } finally {
    plugin.stop()
  }
})

test('start re-evaluation does not supersede an open deadline', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-delay-start-'))
  const body = VHF_YAML.replace('mode: single', 'mode: restart')
  const dir = yamlDir(dataDir, body)
  const deadline = 9_000_000
  store.upsertDeadline(dataDir, {
    id: 'stay1',
    automationId: 'vhf_charge',
    alias: 'Marifoon laden',
    mode: 'restart',
    choose: 'charge',
    deadline,
    actions: [{ put: PLUG, value: 0 }]
  })
  let now = deadline - 2500
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const rt = runtime(dataDir, dir, {
    now: () => now,
    sleep: async (ms) => {
      rt.slept.push(ms)
      await gate
    }
  })
  rt.load()
  rt.setEnabled('vhf_charge', true)
  rt.setPathValue(PLUG, 1)
  const pending = rt.resumeDeadlines()
  await until(() => rt.slept.length === 1)
  assert.deepEqual(rt.slept, [2500])
  await rt.evaluateOnStart()
  assert.equal(store.loadDeadlines(dataDir)[0].id, 'stay1')
  assert.deepEqual(rt.puts, [])
  now = deadline
  release()
  await pending
  assert.deepEqual(rt.puts, [[PLUG, 0]])
  assert.deepEqual(store.loadDeadlines(dataDir), [])
})
