'use strict'

const { toSi, parseDuration } = require('./units')
const { inZone } = require('./geo')
const { runScript } = require('./scripts')
const { helperPath } = require('./helpers')

function collectPaths (doc) {
  const paths = new Set()
  for (const auto of doc.automations || []) {
    for (const t of auto.trigger || []) addPathsFromClause(paths, t)
    for (const c of auto.condition || []) addPathsFromClause(paths, c)
    for (const branch of auto.choose || []) {
      for (const c of branch.conditions || []) addPathsFromClause(paths, c)
    }
    if (auto.latch_on_external_put) paths.add(auto.latch_on_external_put)
  }
  for (const def of Object.values(doc.helpers || {})) {
    if (def.latch_on_external_put) paths.add(def.latch_on_external_put)
  }
  return Array.from(paths)
}

function addPathsFromClause (paths, clause) {
  if (!clause || typeof clause !== 'object') return
  if (clause.path) paths.add(clause.path)
  if (clause.zone || clause.not && clause.not.zone) paths.add('navigation.position')
  if (clause.helper) paths.add(helperPath(clause.helper))
  if (clause.not) addPathsFromClause(paths, clause.not)
  if (Array.isArray(clause.all)) clause.all.forEach((c) => addPathsFromClause(paths, c))
  if (Array.isArray(clause.any)) clause.any.forEach((c) => addPathsFromClause(paths, c))
}

function getByPath (values, p) {
  if (Object.prototype.hasOwnProperty.call(values, p)) return values[p]
  return undefined
}

function compareNumber (actual, op, expected, unit) {
  const a = Number(actual)
  const b = toSi(expected, unit)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (op === 'above' || op === 'gt') return a > b
  if (op === 'below' || op === 'lt') return a < b
  if (op === 'gte') return a >= b
  if (op === 'lte') return a <= b
  return a === b
}

function evalClause (clause, ctx) {
  if (!clause || typeof clause !== 'object') {
    return { pass: false, error: 'empty clause', actual: null }
  }
  if (clause.not) {
    const inner = evalClause(clause.not, ctx)
    return {
      pass: inner.error ? false : !inner.pass,
      error: inner.error,
      actual: inner.actual,
      clause: { not: true }
    }
  }
  if (Array.isArray(clause.all)) {
    const parts = clause.all.map((c) => evalClause(c, ctx))
    return {
      pass: parts.every((p) => p.pass),
      error: parts.find((p) => p.error)?.error || null,
      actual: parts,
      clause: { all: true }
    }
  }
  if (Array.isArray(clause.any)) {
    const parts = clause.any.map((c) => evalClause(c, ctx))
    return {
      pass: parts.some((p) => p.pass),
      error: parts.find((p) => p.error)?.error || null,
      actual: parts,
      clause: { any: true }
    }
  }
  if (clause.zone) {
    const pos = getByPath(ctx.values, 'navigation.position')
    const zone = ctx.zones[clause.zone]
    const pass = zone ? inZone(pos, zone) : false
    return {
      pass,
      error: zone ? null : 'Unknown zone: ' + clause.zone,
      actual: pos,
      path: 'navigation.position',
      expected: clause.zone
    }
  }
  if (clause.run) {
    return {
      async: true,
      run: typeof clause.run === 'string' ? { file: clause.run } : clause.run,
      equals: clause.equals,
      is: clause.is
    }
  }
  if (clause.schedule) {
    const when = ctx.now ? new Date(ctx.now) : new Date()
    const fromTick = ctx.trigger && ctx.trigger.schedule
    const pass = fromTick ? cronMatch(clause.schedule, when) : false
    return {
      pass,
      error: null,
      actual: clause.schedule,
      expected: fromTick ? ctx.trigger.schedule : 'schedule tick'
    }
  }
  const path = clause.helper ? helperPath(clause.helper) : clause.path
  if (!path) {
    return { pass: false, error: 'clause needs path, helper, zone, or run', actual: null }
  }
  const actual = getByPath(ctx.values, path)
  let pass = false
  if (Object.prototype.hasOwnProperty.call(clause, 'is')) {
    pass = actual === clause.is
  } else if (Object.prototype.hasOwnProperty.call(clause, 'equals')) {
    pass = actual === clause.equals || String(actual) === String(clause.equals)
  } else if (Object.prototype.hasOwnProperty.call(clause, 'above')) {
    pass = compareNumber(actual, 'above', clause.above, clause.unit)
  } else if (Object.prototype.hasOwnProperty.call(clause, 'below')) {
    pass = compareNumber(actual, 'below', clause.below, clause.unit)
  } else if (Object.prototype.hasOwnProperty.call(clause, 'to')) {
    pass = actual === clause.to
  } else {
    pass = actual !== undefined
  }
  return { pass, error: null, actual, path, expected: expectedOf(clause) }
}

function expectedOf (clause) {
  if (clause.is !== undefined) return clause.is
  if (clause.equals !== undefined) return clause.equals
  if (clause.above !== undefined) return { above: clause.above, unit: clause.unit }
  if (clause.below !== undefined) return { below: clause.below, unit: clause.unit }
  if (clause.to !== undefined) return clause.to
  return true
}

async function evalClauseAsync (clause, ctx) {
  const first = evalClause(clause, ctx)
  if (!first.async) return first
  const ran = await ctx.runScript(first.run)
  if (!ran.ok) {
    return {
      pass: false,
      error: ran.error,
      actual: ran.stdout,
      run: first.run.file || first.run
    }
  }
  let pass = true
  if (first.equals !== undefined) pass = ran.value === first.equals || String(ran.value) === String(first.equals)
  else if (first.is !== undefined) pass = ran.value === first.is
  else pass = Boolean(ran.value)
  return {
    pass,
    error: null,
    actual: ran.value,
    run: first.run.file || first.run
  }
}

async function evalList (list, ctx) {
  const results = []
  for (const clause of list || []) {
    const r = await evalClauseAsync(clause, ctx)
    results.push(r)
    if (!r.pass) return { pass: false, results }
  }
  return { pass: true, results }
}

function triggerMatchesPath (auto, changedPath) {
  if (!changedPath) return true
  const paths = new Set()
  for (const t of auto.trigger || []) addPathsFromClause(paths, t)
  const hasSchedule = (auto.trigger || []).some((t) => t.schedule)
  if (paths.size === 0) return !hasSchedule
  return paths.has(changedPath)
}

function cronMatch (expr, date) {
  if (!expr) return false
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length < 5) return false
  const [min, hour, dom, mon, dow] = parts
  return (
    fieldMatch(min, date.getMinutes()) &&
    fieldMatch(hour, date.getHours()) &&
    fieldMatch(dom, date.getDate()) &&
    fieldMatch(mon, date.getMonth() + 1) &&
    fieldMatch(dow, date.getDay())
  )
}

function fieldMatch (field, value) {
  if (field === '*') return true
  return String(field)
    .split(',')
    .some((bit) => {
      if (bit.includes('/')) {
        const [range, step] = bit.split('/')
        const st = Number(step)
        if (!Number.isFinite(st) || st <= 0) return false
        if (range === '*') return value % st === 0
      }
      if (bit.includes('-')) {
        const [a, b] = bit.split('-').map(Number)
        return value >= a && value <= b
      }
      return Number(bit) === value
    })
}

async function evaluateAutomation (auto, ctx) {
  const record = {
    ts: new Date(ctx.now || Date.now()).toISOString(),
    id: auto.id,
    result: 'skipped',
    trigger: ctx.trigger || null,
    conditions: [],
    choose: null,
    actions: []
  }
  if (!ctx.enabled) {
    record.reason = 'disabled'
    return record
  }

  const trig = await evalList(auto.trigger || [], ctx)
  record.triggerResults = trig.results
  if ((auto.trigger || []).length && !trig.pass) {
    record.reason = 'trigger not matched'
    return record
  }

  const cond = await evalList(auto.condition || [], ctx)
  record.conditions = cond.results
  if ((auto.condition || []).length && !cond.pass) {
    const failed = cond.results.find((r) => r.error)
    record.result = failed ? 'failure' : 'skipped'
    record.reason = failed ? failed.error : 'condition not met'
    return record
  }

  let actions = auto.action || []
  if (auto.choose && auto.choose.length) {
    let picked = null
    for (const branch of auto.choose) {
      const br = await evalList(branch.conditions || [], ctx)
      if (br.pass) {
        picked = branch
        record.choose = branch.id || branch.alias || 'branch'
        actions = branch.action || []
        break
      }
    }
    if (!picked) {
      record.reason = 'no matching choose branch'
      return record
    }
  }

  for (const action of actions) {
    const ran = await runAction(action, ctx)
    record.actions.push(ran)
    if (!ran.ok) {
      record.result = 'failure'
      record.reason = ran.error
      return record
    }
  }
  record.result = 'ok'
  return record
}

async function runAction (action, ctx) {
  if (!action || typeof action !== 'object') {
    return { ok: false, error: 'empty action' }
  }
  if (action.put) {
    try {
      await ctx.put(action.put, action.value)
      return { ok: true, type: 'put', path: action.put, value: action.value }
    } catch (err) {
      return { ok: false, type: 'put', path: action.put, error: err.message }
    }
  }
  if (action.helper) {
    try {
      ctx.setHelper(action.helper, action.value)
      return { ok: true, type: 'helper', helper: action.helper, value: action.value }
    } catch (err) {
      return { ok: false, type: 'helper', helper: action.helper, error: err.message }
    }
  }
  if (action.notify) {
    const n = action.notify
    try {
      await ctx.notify(n.path, n.state || 'alert', n.message || '')
      return { ok: true, type: 'notify', path: n.path, state: n.state }
    } catch (err) {
      return { ok: false, type: 'notify', error: err.message }
    }
  }
  if (action.delay != null) {
    const ms = parseDuration(action.delay)
    await ctx.sleep(ms)
    return { ok: true, type: 'delay', ms }
  }
  if (action.run) {
    const spec = typeof action.run === 'string' ? { file: action.run } : action.run
    const ran = await ctx.runScript(spec)
    if (!ran.ok) {
      return { ok: false, type: 'run', file: spec.file, error: ran.error, stdout: ran.stdout }
    }
    if (action.as) {
      ctx.setHelper(action.as, ran.value)
    }
    return { ok: true, type: 'run', file: spec.file, value: ran.value, stdout: ran.stdout }
  }
  return { ok: false, error: 'unknown action' }
}

function makeRunScript (opts) {
  return function (spec) {
    return runScript({
      scriptsDir: opts.scriptsDir,
      file: spec.file,
      args: spec.args,
      timeoutMs: opts.timeoutMs,
      env: spec.env
    })
  }
}

module.exports = {
  collectPaths,
  evalClause,
  evalClauseAsync,
  evalList,
  evaluateAutomation,
  triggerMatchesPath,
  cronMatch,
  runAction,
  makeRunScript,
  parseDuration
}
