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
    this.lastQuantized = {}
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
    return !!this.state.enabled[auto.id]
  }

  isVerbose (auto) {
    return !!this.state.verbose[auto.id]
  }

  setEnabled (id, enabled) {
    this.state.enabled[id] = !!enabled
    store.saveState(this.dataDir, this.state)
  }

  setVerbose (id, verbose) {
    this.state.verbose[id] = !!verbose
    store.saveState(this.dataDir, this.state)
  }

  async setHelper (id, value, opts) {
    const def = this.doc.helpers[id]
    if (!def) throw new Error('Unknown helper: ' + id)
    const previous = Object.prototype.hasOwnProperty.call(this.helperValues, id)
      ? this.helperValues[id]
      : undefined
    const coerced = helpers.coerce(def, value)
    this.helperValues[id] = coerced
    this.values[helpers.helperPath(id)] = coerced
    this.persistHelpers()
    const changed = !engine.sameValue(previous, coerced)
    if (changed) {
      this.recordSwitch({
        kind: 'helper',
        path: id,
        from: previous,
        to: coerced,
        changed: true
      })
      if (!opts || opts.kick !== false) {
        await this.kickPath(helpers.helperPath(id), coerced)
      }
    }
    return coerced
  }

  async resetHelper (id) {
    const def = this.doc.helpers[id]
    if (!def) throw new Error('Unknown helper: ' + id)
    const previous = Object.prototype.hasOwnProperty.call(this.helperValues, id)
      ? this.helperValues[id]
      : undefined
    if (def.default === undefined) {
      delete this.helperValues[id]
      delete this.values[helpers.helperPath(id)]
    } else {
      this.helperValues[id] = helpers.coerce(def, def.default)
      this.values[helpers.helperPath(id)] = this.helperValues[id]
    }
    this.persistHelpers()
    const next = Object.prototype.hasOwnProperty.call(this.helperValues, id)
      ? this.helperValues[id]
      : undefined
    if (!engine.sameValue(previous, next)) {
      await this.kickPath(helpers.helperPath(id), next)
    }
    return this.helperValues[id]
  }

  async kickPath (p, value) {
    for (const auto of this.doc.automations) {
      if (!engine.triggerMatchesPath(auto, p)) continue
      if (engine.quantizedUnchanged(this.lastQuantized, auto, p, value)) continue
      await this.maybeRun(auto, { path: p, value })
    }
  }

  setPathValue (p, value, meta) {
    this.values[p] = value
    if (meta && meta.$source) {
      this.values[p + '.$source'] = meta.$source
    }
  }

  async handlePathChange (p, value, source) {
    this.setPathValue(p, value, { $source: source })
    await this.applyLatches(p, source)
    await this.kickPath(p, value)
  }

  async applyLatches (p, source) {
    const fromSelf = source && String(source).includes(this.pluginId)
    if (fromSelf) return
    for (const def of Object.values(this.doc.helpers)) {
      if (def.latch_on_external_put === p && def.type === 'boolean') {
        if (this.values[p]) await this.setHelper(def.id, true)
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
    const edge = auto.edge || 'every'
    if (edge === 'rising' && prev) return
    if (edge === 'falling') return
    this.lastTruthy[auto.id] = true

    if (auto.debounceMs && this.lastDebounce[auto.id] && this.now() - this.lastDebounce[auto.id] < auto.debounceMs) {
      return
    }

    this.lastDebounce[auto.id] = this.now()
    const record = await engine.evaluateAutomation(auto, this.makeCtx(trigger))
    this.finishRun(auto, record, { forceTrace: false })
    return record
  }

  keepTrace (auto, record, extra) {
    extra = extra || {}
    if (extra.forceTrace) return true
    if (this.isVerbose(auto)) return true
    if (record.result === 'failure') return true
    if (record.result === 'ok') {
      return (record.actions || []).some((a) => a.changed)
    }
    return false
  }

  finishRun (auto, record, extra) {
    extra = extra || {}
    this.state.lastRun[auto.id] = {
      ts: record.ts,
      result: record.result,
      reason: record.reason || null
    }
    store.saveState(this.dataDir, this.state)
    if (this.keepTrace(auto, record, extra)) {
      store.appendTrace(this.dataDir, auto.id, record, this.traceCount)
    }
    this.noteSwitches(auto, record)
    if (this.isVerbose(auto) && record.verboseLog) this.info(record.verboseLog)
  }

  scheduleOnly (auto) {
    const trig = auto.trigger || []
    return trig.length > 0 && trig.every((t) => t.schedule)
  }

  async evaluateOnStart () {
    this.seedFromSelf()
    for (const auto of this.doc.automations) {
      if (!this.isEnabled(auto)) continue
      if (this.scheduleOnly(auto)) continue
      await this.maybeRun(auto, { start: true })
    }
  }

  seedFromSelf () {
    if (!this.app || typeof this.app.getSelfPath !== 'function') return
    for (const p of engine.collectPaths(this.doc)) {
      if (p.startsWith('automations.helpers.')) continue
      try {
        const raw = this.app.getSelfPath(p)
        const value =
          raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'value')
            ? raw.value
            : raw
        if (value !== undefined) this.values[p] = value
      } catch (_) {}
    }
  }

  async runNow (id) {
    const auto = this.doc.automations.find((a) => a.id === id)
    if (!auto) throw new Error('Unknown automation: ' + id)
    this.seedFromSelf()
    const forced = Object.assign({}, auto, { trigger: [] })
    const record = await engine.evaluateAutomation(
      forced,
      this.makeCtx({ manual: true }, { skipDelay: true, skipUnchanged: false })
    )
    record.id = auto.id
    record.manual = true
    this.finishRun(auto, record, { forceTrace: true })
    if (!this.isVerbose(auto)) {
      this.info('Run ' + (auto.alias || auto.id) + ' → ' + record.result + (record.reason ? ' (' + record.reason + ')' : ''))
    }
    return record
  }

  info (msg) {
    if (this.log && typeof this.log.info === 'function') this.log.info(msg)
    else if (this.log && typeof this.log.debug === 'function') this.log.debug(msg)
  }

  formatSwitch (row) {
    const who = [row.automation, row.branch].filter(Boolean).join(' / ')
    const kind = row.kind === 'helper' ? 'helper ' + row.path : 'PUT ' + row.path
    const line = (who ? who + ' · ' : '') + kind + '  ' + fmtVal(row.from) + ' → ' + fmtVal(row.to)
    return row.changed === false ? line + ' (unchanged)' : line
  }

  recordSwitch (entry) {
    const row = Object.assign({ ts: new Date(this.now()).toISOString() }, entry)
    if (row.changed === false) {
      if (this.log && typeof this.log.debug === 'function') this.log.debug(this.formatSwitch(row))
      return row
    }
    store.appendSwitchLog(this.dataDir, row, 50)
    this.info(this.formatSwitch(row))
    return row
  }

  noteSwitches (auto, record) {
    for (const a of record.actions || []) {
      if (a.type !== 'put' || !a.ok) continue
      this.recordSwitch({
        kind: 'put',
        automation: auto.alias || auto.id,
        id: auto.id,
        branch: record.choose || null,
        path: a.path,
        from: a.previous,
        to: a.value,
        changed: a.changed !== false
      })
    }
  }

  makeCtx (trigger, extra) {
    extra = extra || {}
    return {
      values: this.values,
      zones: this.doc.zones,
      enabled: true,
      trigger,
      now: this.now(),
      skipDelay: !!extra.skipDelay,
      skipUnchanged: extra.skipUnchanged !== false,
      put: (p, value) => this.put(p, value),
      notify: (p, state, message) => this.notify(p, state, message),
      setHelper: (id, value) => this.setHelper(id, value, { kick: false }),
      sleep: this.sleep,
      runScript: engine.makeRunScript({
        scriptsDir: this.scriptsDir,
        timeoutMs: this.scriptTimeoutMs
      })
    }
  }

  async put (p, value) {
    if (this.putFn) await this.putFn(p, value)
    this.values[p] = value
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
        yaml: yaml.snippetHelper(this.doc, def.id),
        value: Object.prototype.hasOwnProperty.call(this.helperValues, def.id)
          ? this.helperValues[def.id]
          : null,
        set: Object.prototype.hasOwnProperty.call(this.helperValues, def.id)
      })),
      automations: this.doc.automations.map((auto) => ({
        id: auto.id,
        alias: auto.alias,
        enabled: this.isEnabled(auto),
        verbose: this.isVerbose(auto),
        yaml: yaml.snippetAutomation(this.doc, auto.id),
        lastRun: this.state.lastRun[auto.id] || null
      })),
      zones: Object.values(this.doc.zones).map((z) => ({
        id: z.id,
        name: z.name,
        lat: z.lat,
        lon: z.lon,
        radius: z.radius,
        yaml: yaml.snippetHelper(this.doc, z.id)
      })),
      switches: store.loadSwitchLog(this.dataDir),
      headSha: git.currentSha(this.automationsDir),
      commits: git.isGitRepo(this.automationsDir)
        ? git.listCommits(this.automationsDir, 40)
        : []
    }
  }

  traces (id) {
    return store.loadTraces(this.dataDir, id)
  }

  diffCommit (sha) {
    const to = sha || ''
    if (!to) throw new Error('Commit sha is required')
    const from = this.state.activeSha || git.currentSha(this.automationsDir)
    const result = git.diffRange(this.automationsDir, from, to)
    const commits = git.listCommits(this.automationsDir, 80)
    const found = commits.find((c) => c.sha === result.to) || {}
    return {
      from: result.from,
      to: result.to,
      diff: result.diff,
      subject: found.subject || '',
      current: !result.from || result.from === result.to
    }
  }

  activateCommit (sha) {
    const dest = store.liveDir(this.dataDir)
    const incoming = dest + '.incoming'
    if (fs.existsSync(incoming)) fs.rmSync(incoming, { recursive: true, force: true })
    git.materializeCommit(this.automationsDir, sha, incoming)
    return this.installIncoming(incoming, dest, sha)
  }

  reloadWorkingTree () {
    const dest = store.liveDir(this.dataDir)
    const incoming = dest + '.incoming'
    if (fs.existsSync(incoming)) fs.rmSync(incoming, { recursive: true, force: true })
    store.copyYamlFiles(this.automationsDir, incoming)
    return this.installIncoming(incoming, dest, git.currentSha(this.automationsDir))
  }

  installIncoming (incoming, dest, sha) {
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
    this.state.activeSha = sha || null
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

function fmtVal (v) {
  if (v === undefined) return 'unset'
  try {
    return JSON.stringify(v)
  } catch (_) {
    return String(v)
  }
}

module.exports = { Runtime }
