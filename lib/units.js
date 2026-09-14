'use strict'

const TO_SI = {
  m: 1,
  km: 1000,
  nm: 1852,
  kn: 0.514444,
  kt: 0.514444,
  '%': 0.01,
  percent: 0.01,
  s: 1,
  min: 60,
  h: 3600
}

function toSi (value, unit) {
  if (unit == null || unit === '') return value
  const key = String(unit).trim()
  const factor = TO_SI[key] != null ? TO_SI[key] : TO_SI[key.toLowerCase()]
  if (factor == null) {
    throw new Error('Unknown unit: ' + unit)
  }
  return Number(value) * factor
}

function parseDuration (raw) {
  if (raw == null) return 0
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const s = String(raw).trim()
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (!m) throw new Error('Invalid duration: ' + raw)
  const n = Number(m[1])
  const unit = (m[2] || 'ms').toLowerCase()
  if (unit === 'ms') return n
  if (unit === 's') return n * 1000
  if (unit === 'm') return n * 60 * 1000
  return n * 60 * 60 * 1000
}

module.exports = { toSi, parseDuration }
