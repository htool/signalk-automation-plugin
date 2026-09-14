'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('./yaml')
const helpers = require('./helpers')
const store = require('./store')
const git = require('./git')
const engine = require('./engine')

class Runtime {
  constructor (opts) {
    this.app = opts.app
    this.pluginId = opts.pluginId
    this.dataDir = opts.dataDir
    this.automationsDir = opts.automationsDir
    this.scriptsDir = opts.scriptsDir
    this.traceCount = opts.traceCount || 20
    this.scriptTimeoutMs = (opts.scriptTimeoutSeconds || 30) * 1000
    this.now = opts.now || (() => Date.now())
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.putFn = opts.put
    this.notifyFn = opts.notify
    this.log = opts.log || { debug () {}, error () {} }

    this.doc = yaml.emptyDoc()
    this.state = store.emptyState()
    this.values = {}
    this.helperValues = {}
    this.lastTruthy = {}
    this.pendingSince = {}
    this.lastDebounce = {}
    this.lastCronMinute = ''
    this.unsubscribes = []
  }

  load () {
    this.state = store.loadState(this.dataDir)
    const live = store.liveDir(this.dataDir)
    const from = fs.existsSync(live) ? live : this.automationsDir
    this.doc = yaml.loadYamlDir(from)
    this.helperValues = helpers.initHelpers(this.doc.helpers, this.state.helpers)
    this.persistHelpers()
    for (const [id, value] of Object.entries(this.helperValues)) {
      this.values[helpers.helperPath(id)] = value
    }
  }

  persistHelpers () {
    this.state.helpers = helpers.persistableHelpers(this.doc.helpers, this.helperValues)
    store.saveState(this.dataDir, this.state)
  }

  isEnabled (auto) {
    if (Object.prototype.hasOwnProperty.call(this.state.enabled, auto.id)) {
      return !!this.state.enabled[auto.id]
    }
    return auto.enabled !== false
  }

  setEnabled (id, enabled) {
    this.state.enabled[id] = !!enabled
    store.saveState(this.dataDir, this.state)
  }

  setHelper (id, value) {
    const def = this.doc.helpers[id]
    if (!def) throw new Error('Unknown helper: ' + id)
    const coerced = helpers.coerce(def, value)
    this.helperValues[id] = coerced
    this.values[helpers.helperPath(id)] = coerced
    this.persistHelpers()
    return coerced
  }

  resetHelper (id) {
    const def = this.doc.helpers[id]
    if (!def) throw new Error('Unknown helper: ' + id)
    if (def.default === undefined) {
      delete this.helperValues[id]
      delete this.values[helpers.helperPath(id)]
    } else {
      this.helperValues[id] = helpers.coerce(def, def.default)
      this.values[helpers.helperPath(id)] = this.helperValues[id]
    }
    this.persistHelpers()
    return this.helperValues[id]
  }

  setPathValue (p, value, meta) {
    this.values[p] = value
    if (meta && meta.$source) {
      this.values[p + '.$source'] = meta.$source
    }
  }

  async handlePathChange (p, value, source) {
    this.setPathValue(p, value, { $source: source })
    this.applyLatches(p, source)
    for (const auto of this.doc.automations) {
      if (!engine.triggerMatchesPath(auto, p)) continue
      await this.maybeRun(auto, { path: p, value })
    }
  }

  applyLatches (p, source) {
    const fromSelf = source && String(source).includes(this.pluginId)
    if (fromSelf) return
    for (const def of Object.values(this.doc.helpers)) {
      if (def.latch_on_external_put === p && def.type === 'boolean') {
        if (this.values[p]) this.setHelper(def.id, true)
      }
    }
  }

  async tickSchedule (date) {
    const d = date || new Date(this.now())
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours() + '-' + d.getMinutes()
    if (key === this.lastCronMinute) return
    this.lastCronMinute = key
    for (const auto of this.doc.automations) {
      const schedules = (auto.trigger || []).filter((t) => t.schedule)
      if (!schedules.length) continue
      const hit = schedules.some((t) => engine.cronMatch(t.schedule, d))
      if (hit) await this.maybeRun(auto, { schedule: schedules[0].schedule })
    }
  }

  async maybeRun (auto, trigger) {
    if (!this.isEnabled(auto)) return
    const ctx = this.makeCtx(trigger)
    const trig = await engine.evalList(auto.trigger || [], ctx)
    const matched = !(auto.trigger || []).length || trig.pass

    if (!matched) {
      this.lastTruthy[auto.id] = false
      delete this.pendingSince[auto.id]
      return
    }

    const hold = holdMs(auto)
    if (hold > 0) {
      if (!this.pendingSince[auto.id]) this.pendingSince[auto.id] = this.now()
      if (this.now() - this.pendingSince[auto.id] < hold) return
    }

    const prev = !!this.lastTruthy[auto.id]
    const edge = auto.edge || 'rising'
    if (edge === 'rising' && prev) return
    if (edge === 'falling') return
    this.lastTruthy[auto.id] = true

    if (auto.debounceMs && this.lastDebounce[auto.id] && this.now() - this.lastDebounce[auto.id] < auto.debounceMs) {
      return
    }

    this.lastDebounce[auto.id] = this.now()
    const record = await engine.evaluateAutomation(auto, this.makeCtx(trigger))
    this.state.lastRun[auto.id] = {
      ts: record.ts,
      result: record.result,
      reason: record.reason || null
    }
    store.saveState(this.dataDir, this.state)
    store.appendTrace(this.dataDir, auto.id, record, this.traceCount)
    return record
  }

  makeCtx (trigger) {
    return {
      values: this.values,
      zones: this.doc.zones,
      enabled: true,
      trigger,
      now: this.now(),
      put: (p, value) => this.put(p, value),
      notify: (p, state, message) => this.notify(p, state, message),
      setHelper: (id, value) => this.setHelper(id, value),
      sleep: this.sleep,
      runScript: engine.makeRunScript({
        scriptsDir: this.scriptsDir,
        timeoutMs: this.scriptTimeoutMs
      })
    }
  }

  async put (p, value) {
    this.values[p] = value
    if (this.putFn) return this.putFn(p, value)
  }

  async notify (p, state, message) {
    if (this.notifyFn) return this.notifyFn(p, state, message)
  }

  snapshot () {
    return {
      started: true,
      activeSha: this.state.activeSha,
      automationsDir: this.automationsDir || null,
      errors: this.doc.errors,
      files: this.doc.files,
      yaml: yaml.combinedYaml(this.doc),
      helpers: Object.values(this.doc.helpers).map((def) => ({
        id: def.id,
        name: def.name,
        type: def.type,
        on_start: def.on_start,
        default: def.default,
        options: def.options,
        value: Object.prototype.hasOwnProperty.call(this.helperValues, def.id)
          ? this.helperValues[def.id]
          : null,
        set: Object.prototype.hasOwnProperty.call(this.helperValues, def.id)
      })),
      automations: this.doc.automations.map((auto) => ({
        id: auto.id,
        alias: auto.alias,
        enabled: this.isEnabled(auto),
        yamlEnabled: auto.enabled !== false,
        lastRun: this.state.lastRun[auto.id] || null
      })),
      zones: Object.values(this.doc.zones),
      commits: git.isGitRepo(this.automationsDir)
        ? git.listCommits(this.automationsDir, 40)
        : []
    }
  }

  traces (id) {
    return store.loadTraces(this.dataDir, id)
  }

  activateCommit (sha) {
    const dest = store.liveDir(this.dataDir)
    const incoming = dest + '.incoming'
    if (fs.existsSync(incoming)) fs.rmSync(incoming, { recursive: true, force: true })
    git.materializeCommit(this.automationsDir, sha, incoming)
    const next = yaml.loadYamlDir(incoming)
    if (next.errors.length) {
      fs.rmSync(incoming, { recursive: true, force: true })
      const err = next.errors.map((e) => e.file + ': ' + e.message).join('; ')
      throw new Error('YAML invalid, live not changed: ' + err)
    }
    const bak = dest + '.bak'
    if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true })
    if (fs.existsSync(dest)) fs.renameSync(dest, bak)
    fs.renameSync(incoming, dest)
    if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true })
    this.state.activeSha = sha
    store.saveState(this.dataDir, this.state)
    this.load()
    return this.snapshot()
  }
}

function holdMs (auto) {
  for (const t of auto.trigger || []) {
    if (t.for) {
      try {
        return engine.parseDuration(t.for)
      } catch (_) {
        return 0
      }
    }
  }
  return 0
}

module.exports = { Runtime }
