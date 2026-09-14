'use strict'

function coerce (def, value) {
  if (!def) return value
  if (def.type === 'boolean') {
    if (value === true || value === 'true' || value === 1 || value === '1') return true
    if (value === false || value === 'false' || value === 0 || value === '0') return false
    return Boolean(value)
  }
  if (def.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error('Helper ' + def.id + ' expects a number')
    return n
  }
  const s = value == null ? '' : String(value)
  if (def.type === 'select' && def.options.length && !def.options.includes(s)) {
    throw new Error('Helper ' + def.id + ' value not in options')
  }
  return s
}

function initHelpers (defs, persisted) {
  const values = {}
  const saved = persisted && typeof persisted === 'object' ? persisted : {}
  for (const [id, def] of Object.entries(defs || {})) {
    const mode = def.on_start || 'none'
    if (mode === 'restore') {
      if (Object.prototype.hasOwnProperty.call(saved, id)) {
        values[id] = coerce(def, saved[id])
      } else if (def.default !== undefined) {
        values[id] = coerce(def, def.default)
      }
    } else if (mode === 'default') {
      if (def.default !== undefined) values[id] = coerce(def, def.default)
    }
    // none: leave unset
  }
  return values
}

function persistableHelpers (defs, values) {
  const out = {}
  for (const [id, def] of Object.entries(defs || {})) {
    if (def.on_start !== 'restore') continue
    if (!Object.prototype.hasOwnProperty.call(values, id)) continue
    out[id] = values[id]
  }
  return out
}

function helperPath (id) {
  return 'automations.helpers.' + id
}

module.exports = {
  coerce,
  initHelpers,
  persistableHelpers,
  helperPath
}
