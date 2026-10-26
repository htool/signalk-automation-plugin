'use strict'

const crypto = require('crypto')
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
    const silence = Number(opts.startupSilenceSeconds)
    this.startupSilenceMs = (Number.isFinite(silence) && silence >= 0 ? silence : 0) * 1000
    this.startedAt = null
    this.now = opts.now || (() => Date.now())
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.putFn = opts.put
    this.notifyFn = opts.notify
    this.onHelper = opts.onHelper || null
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
    this.inFlight = {}
    this.liveRuns = new Set()
    this.armedIds = new Set()
  }

  load () {
    this.state = store.loadState(this.dataDir)
    if (!this.state.pathValues || typeof this.state.pathValues !== 'object') this.state.pathValues = {}
    this.startedAt = this.now()
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
      this.emitHelperValue(id, coerced)
      if (!opts || opts.kick !== false) {
        await this.kickPath(helpers.helperPath(id), coerced)
      }
    }
    const current = Object.prototype.hasOwnProperty.call(this.helperValues, id)
      ? this.helperValues[id]
      : coerced
    if (!engine.sameValue(current, coerced)) this.emitHelperValue(id, current)
    return current
  }

  emitHelperValue (id, value) {
    if (typeof this.onHelper === 'function') this.onHelper(id, value)
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

  triggerPaths () {
    const paths = new Set()
    for (const auto of this.doc.automations) {
      for (const t of auto.trigger || []) {
        if (t && typeof t.path === 'string') paths.add(t.path)
      }
    }
    return paths
  }

  inStartupSilence () {
    if (this.startedAt == null || !(this.startupSilenceMs > 0)) return false
    return this.now() - this.startedAt < this.startupSilenceMs
  }

  rememberPathValue (p, value) {
    if (!this.triggerPaths().has(p)) return
    const pv = this.state.pathValues || (this.state.pathValues = {})
    const has = Object.prototype.hasOwnProperty.call(pv, p)
    if (has && engine.sameValue(pv[p], value)) return
    if (value === undefined) return
    try {
      pv[p] = JSON.parse(JSON.stringify(value))
    } catch (_) {
      return
    }
    store.saveState(this.dataDir, this.state)
  }

  async handlePathChange (p, value, source) {
    let previous = Object.prototype.hasOwnProperty.call(this.values, p)
      ? this.values[p]
      : undefined
    const inMemory = previous !== undefined
    const pv = this.state.pathValues || {}
    if (!inMemory && Object.prototype.hasOwnProperty.call(pv, p)) {
      // Value remembered from before a restart.
      previous = pv[p]
    }
    this.setPathValue(p, value, { $source: source })
    this.rememberPathValue(p, value)
    await this.applyLatches(p, source, inMemory ? previous : undefined)
    if (engine.valueUnchanged(previous, value)) return
    if (this.inStartupSilence()) {
      this.log.debug('startup silence: not triggering on ' + p)
      return
    }
    await this.kickPath(p, value)
  }

  async applyLatches (p, source, previous) {
    const fromSelf = source && String(source).includes(this.pluginId)
    if (fromSelf) return
    if (previous === undefined) return
    const next = this.values[p]
    if (engine.valueUnchanged(previous, next)) return
    for (const def of Object.values(this.doc.helpers)) {
      if (def.latch_on_external_put === p && def.type === 'boolean') {
        await this.setHelper(def.id, true)
      }
    }
  }

  async tickSchedule (date) {
    const d = date || new Date(this.now())
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours() + '-' + d.getMinutes()
    if (key === this.lastCronMinute) return
    this.lastCronMinute = key
    const runs = []
    for (const auto of this.doc.automations) {
      const schedules = (auto.trigger || []).filter((t) => t.schedule)
      if (!schedules.length) continue
      const hit = schedules.some((t) => engine.cronMatch(t.schedule, d))
      if (hit) runs.push(this.maybeRun(auto, { schedule: schedules[0].schedule }))
    }
    await Promise.all(runs)
  }

  async maybeRun (auto, trigger) {
    if (!this.isEnabled(auto)) return
    const mode = auto.mode || 'parallel'
    // Plugin start re-evaluates path automations. An open delay is already
    // that run; do not supersede it with the synthetic start pass.
    if (trigger && trigger.start && this.hasResume(auto.id)) return
    if (mode === 'single' && this.inFlight[auto.id]) return
    if (mode === 'restart' && this.inFlight[auto.id]) this.inFlight[auto.id].abort()
    const ctx = this.makeCtx(trigger)
    const trig = await engine.evalListAll(auto.trigger || [], ctx)
    const matched = engine.triggerListMatched(auto.trigger, trig.results)

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
    const abort = this.makeAbort()
    abort.automationId = auto.id
    this.liveRuns.add(abort)
    if (mode === 'single' || mode === 'restart') this.inFlight[auto.id] = abort
    try {
      const record = await engine.evaluateAutomation(auto, this.makeCtx(trigger, { abort }))
      this.finishRun(auto, record, { forceTrace: false })
      return record
    } finally {
      this.liveRuns.delete(abort)
      if (this.inFlight[auto.id] === abort) delete this.inFlight[auto.id]
    }
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
    const runs = []
    for (const auto of this.doc.automations) {
      if (!this.isEnabled(auto)) continue
      if (this.scheduleOnly(auto)) continue
      runs.push(this.maybeRun(auto, { start: true }))
    }
    await Promise.all(runs)
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
    const abort = extra.abort
    return {
      values: this.values,
      zones: this.doc.zones,
      enabled: true,
      trigger,
      now: this.now(),
      skipDelay: !!extra.skipDelay,
      skipUnchanged: extra.skipUnchanged !== false,
      abort: abort || null,
      log: this.log,
      put: (p, value) => this.put(p, value),
      notify: (p, state, message) => this.notify(p, state, message),
      setHelper: (id, value) => this.setHelper(id, value, { kick: false }),
      sleep: (ms) => this.cancellableSleep(ms, abort),
      armDelay: (ms, frame) => this.armDelay(ms, frame, abort),
      disarmDelay: (id) => this.forgetDeadline(id, abort),
      runScript: engine.makeRunScript({
        scriptsDir: this.scriptsDir,
        timeoutMs: this.scriptTimeoutMs
      })
    }
  }

  cancellableSleep (ms, abort) {
    if (!abort) return Promise.resolve(this.sleep(ms))
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        reject(err)
      }
      const ok = () => {
        if (settled) return
        settled = true
        if (abort.aborted) {
          const err = new Error(abort.stopped ? 'stopped' : 'superseded')
          err.cancelled = true
          if (abort.stopped) err.stopped = true
          reject(err)
          return
        }
        resolve()
      }
      Promise.resolve(this.sleep(ms)).then(ok, fail)
      abort.promise.then(() => {}, fail)
    })
  }

  makeAbort () {
    return newAbort((ids) => {
      for (const id of ids) this.forgetDeadline(id, null)
    })
  }

  armDelay (ms, frame, abort) {
    const id = crypto.randomBytes(8).toString('hex')
    const deadline = this.now() + ms
    const actions = plainJson((frame && frame.actions) || [])
    const item = {
      id,
      automationId: (frame && frame.automationId) || 'unknown',
      alias: (frame && frame.alias) || null,
      mode: (frame && frame.mode) || 'parallel',
      choose: (frame && frame.choose) || null,
      trigger: plainJson((frame && frame.trigger) || null),
      delay: frame && frame.delay != null ? frame.delay : null,
      delayMs: ms,
      deadline,
      actions,
      createdAt: new Date(this.now()).toISOString()
    }
    store.upsertDeadline(this.dataDir, item)
    this.armedIds.add(id)
    if (abort) {
      abort.deadlineIds.push(id)
      abort.automationId = item.automationId
    }
    return { id, deadline, waitMs: ms }
  }

  forgetDeadline (id, abort) {
    store.removeDeadline(this.dataDir, id)
    this.armedIds.delete(id)
    if (abort && abort.deadlineIds) {
      const at = abort.deadlineIds.indexOf(id)
      if (at >= 0) abort.deadlineIds.splice(at, 1)
    }
  }

  hasResume (autoId) {
    for (const abort of this.liveRuns) {
      if (abort.resuming && abort.automationId === autoId && !abort.aborted) return true
    }
    return false
  }

  resumeDeadlines () {
    const items = store.loadDeadlines(this.dataDir)
    const jobs = []
    for (const item of items) {
      if (!item || this.armedIds.has(item.id)) continue
      jobs.push(this.beginResume(item))
    }
    return Promise.all(jobs)
  }

  beginResume (item) {
    this.armedIds.add(item.id)
    const abort = this.makeAbort()
    abort.resuming = true
    abort.automationId = item.automationId
    abort.deadlineIds.push(item.id)
    this.liveRuns.add(abort)
    const mode = item.mode || 'parallel'
    if ((mode === 'single' || mode === 'restart') && !this.inFlight[item.automationId]) {
      this.inFlight[item.automationId] = abort
    }
    return this.finishResume(item, abort)
  }

  async finishResume (item, abort) {
    const label = item.alias || item.automationId
    try {
      const wait = Number(item.deadline) - this.now()
      if (wait > 0) {
        this.info('delay resume ' + label + ' in ' + wait + ' ms')
        try {
          await this.cancellableSleep(wait, abort)
        } catch (err) {
          if (err && (err.stopped || err.cancelled)) return null
          throw err
        }
      } else {
        this.info('delay resume ' + label + ' (catch-up)')
      }
      if (abort.stopped || abort.aborted) return null
      if (!store.loadDeadlines(this.dataDir).some((row) => row.id === item.id)) return null
      this.forgetDeadline(item.id, abort)
      this.seedFromSelf()
      const auto = this.doc.automations.find((a) => a.id === item.automationId) || {
        id: item.automationId,
        alias: item.alias || item.automationId,
        mode: item.mode || 'parallel'
      }
      const trigger = Object.assign({}, item.trigger || {}, { resume: true })
      const ctx = this.makeCtx(trigger, { abort })
      const record = {
        ts: new Date(this.now()).toISOString(),
        id: auto.id,
        result: 'ok',
        trigger,
        firedBy: engine.triggerFiredLabel(trigger),
        conditions: [],
        branches: [],
        choose: item.choose || null,
        actions: [],
        resumed: true
      }
      const done = await engine.runActionList(item.actions || [], ctx, record, auto)
      this.finishRun(auto, done, { forceTrace: true })
      return done
    } finally {
      this.liveRuns.delete(abort)
      if (this.inFlight[item.automationId] === abort) delete this.inFlight[item.automationId]
      this.armedIds.delete(item.id)
    }
  }

  halt () {
    for (const abort of Array.from(this.liveRuns)) {
      try {
        abort.stop()
      } catch (_) {}
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
      deadlines: store.loadDeadlines(this.dataDir).map((d) => ({
        id: d.id,
        automationId: d.automationId,
        alias: d.alias,
        deadline: d.deadline,
        delayMs: d.delayMs,
        choose: d.choose
      })),
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
    const pending = this.resumeDeadlines()
    if (pending && typeof pending.catch === 'function') {
      pending.catch((err) => {
        if (this.log && typeof this.log.error === 'function') this.log.error(err)
      })
    }
    return this.snapshot()
  }
}

function newAbort (onCancel) {
  const abort = {
    aborted: false,
    stopped: false,
    resuming: false,
    automationId: null,
    deadlineIds: [],
    abort () {
      if (this.aborted) return
      this.aborted = true
      const ids = this.deadlineIds.splice(0, this.deadlineIds.length)
      try {
        if (onCancel) onCancel(ids)
      } catch (_) {}
      const err = new Error('superseded')
      err.cancelled = true
      this._reject(err)
    },
    stop () {
      if (this.aborted) return
      this.aborted = true
      this.stopped = true
      const err = new Error('stopped')
      err.cancelled = true
      err.stopped = true
      this._reject(err)
    }
  }
  abort.promise = new Promise((_, reject) => {
    abort._reject = reject
  })
  abort.promise.catch(() => {})
  return abort
}

function plainJson (value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
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
