'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ON_START = ['restore', 'default', 'none']
const HELPER_TYPES = ['boolean', 'number', 'string', 'select']

function loadYamlDir (dir) {
  const result = emptyDoc()
  if (!dir || !fs.existsSync(dir)) {
    return result
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
  for (const file of files) {
    const full = path.join(dir, file)
    let raw
    try {
      raw = fs.readFileSync(full, 'utf8')
    } catch (err) {
      result.errors.push({ file, message: err.message })
      continue
    }
    const loaded = loadYamlText(raw, file)
    mergeDoc(result, loaded)
  }
  return result
}

function loadYamlText (text, file) {
  const result = emptyDoc()
  result.files.push(file)
  let parsed
  try {
    parsed = yaml.load(text) || {}
  } catch (err) {
    result.errors.push({ file, message: err.message })
    return result
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.errors.push({ file, message: 'YAML root must be a mapping' })
    return result
  }
  result.rawText[file] = text
  mergeHelpers(result, parsed.helpers, file)
  mergeZones(result, parsed.zones, file)
  mergeAutomations(result, parsed.automations, file)
  return result
}

function emptyDoc () {
  return {
    helpers: {},
    zones: {},
    automations: [],
    errors: [],
    files: [],
    rawText: {}
  }
}

function mergeDoc (into, other) {
  into.files.push.apply(into.files, other.files)
  into.errors.push.apply(into.errors, other.errors)
  Object.assign(into.rawText, other.rawText)
  for (const [id, def] of Object.entries(other.helpers)) {
    if (into.helpers[id]) {
      into.errors.push({ file: def.file, message: 'Duplicate helper id: ' + id })
      continue
    }
    into.helpers[id] = def
  }
  for (const [id, def] of Object.entries(other.zones)) {
    if (into.zones[id]) {
      into.errors.push({ file: def.file, message: 'Duplicate zone id: ' + id })
      continue
    }
    into.zones[id] = def
  }
  const seen = new Set(into.automations.map((a) => a.id))
  for (const auto of other.automations) {
    if (seen.has(auto.id)) {
      into.errors.push({ file: auto.file, message: 'Duplicate automation id: ' + auto.id })
      continue
    }
    seen.add(auto.id)
    into.automations.push(auto)
  }
}

function mergeHelpers (result, helpers, file) {
  if (helpers == null) return
  if (typeof helpers !== 'object' || Array.isArray(helpers)) {
    result.errors.push({ file, message: 'helpers must be a mapping' })
    return
  }
  for (const [id, raw] of Object.entries(helpers)) {
    const def = normalizeHelper(id, raw, file)
    if (def.error) {
      result.errors.push({ file, message: def.error })
      continue
    }
    result.helpers[id] = def
  }
}

function normalizeHelper (id, raw, file) {
  const spec = raw && typeof raw === 'object' ? raw : {}
  const type = spec.type || 'boolean'
  if (!HELPER_TYPES.includes(type)) {
    return { error: 'Helper ' + id + ': unknown type ' + type }
  }
  const onStart = spec.on_start || spec.onStart || 'none'
  if (!ON_START.includes(onStart)) {
    return { error: 'Helper ' + id + ': on_start must be restore|default|none' }
  }
  if (type === 'select' && !Array.isArray(spec.options)) {
    return { error: 'Helper ' + id + ': select requires options' }
  }
  return {
    id,
    file,
    type,
    name: spec.name || id,
    default: spec.default,
    on_start: onStart,
    options: spec.options || [],
    latch_on_external_put: spec.latch_on_external_put || spec.latchOnExternalPut || null
  }
}

function mergeZones (result, zones, file) {
  if (zones == null) return
  if (typeof zones !== 'object' || Array.isArray(zones)) {
    result.errors.push({ file, message: 'zones must be a mapping' })
    return
  }
  for (const [id, raw] of Object.entries(zones)) {
    const spec = raw || {}
    const lat = Number(spec.lat)
    const lon = Number(spec.lon)
    const radius = Number(spec.radius)
    if (![lat, lon, radius].every(Number.isFinite)) {
      result.errors.push({ file, message: 'Zone ' + id + ' needs lat, lon, radius' })
      continue
    }
    result.zones[id] = { id, file, lat, lon, radius, name: spec.name || id }
  }
}

function mergeAutomations (result, list, file) {
  if (list == null) return
  if (!Array.isArray(list)) {
    result.errors.push({ file, message: 'automations must be a list' })
    return
  }
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !raw.id) {
      result.errors.push({ file, message: 'Automation needs an id' })
      continue
    }
    result.automations.push({
      id: String(raw.id),
      file,
      alias: raw.alias || raw.id,
      trigger: asArray(raw.trigger),
      condition: asArray(raw.condition),
      action: asArray(raw.action),
      choose: Array.isArray(raw.choose) ? raw.choose : [],
      debounceMs: raw.debounceMs || 0,
      edge: raw.edge || 'every',
      mode: raw.mode || 'parallel'
    })
    if (raw.mode && ['parallel', 'restart', 'single'].indexOf(raw.mode) === -1) {
      result.errors.push({
        file,
        message: 'Automation ' + raw.id + ': mode must be parallel, restart, or single'
      })
    }
    for (const t of asArray(raw.trigger)) {
      if (!t || t.round == null) continue
      const n = Number(t.round)
      if (!Number.isFinite(n) || n <= 0) {
        result.errors.push({
          file,
          message: 'Automation ' + raw.id + ': round must be a positive number'
        })
      }
    }
    if (raw.zones) mergeZones(result, raw.zones, file)
  }
}

function asArray (value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function combinedYaml (doc) {
  const parts = []
  for (const file of doc.files) {
    const text = doc.rawText[file]
    if (text) {
      parts.push('# file: ' + file + '\n' + text.trim())
    }
  }
  return parts.join('\n\n---\n\n')
}

function escapeRegExp (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractIndentedBlock (text, startLine, baseIndent) {
  const lines = text.split('\n')
  let end = startLine + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') {
      end++
      continue
    }
    const indent = (line.match(/^[ \t]*/) || [''])[0]
    if (indent.length <= baseIndent.length) break
    end++
  }
  while (end > startLine + 1 && lines[end - 1].trim() === '') end--
  return lines.slice(startLine, end).join('\n').replace(/\s+$/, '') + '\n'
}

function extractListItemById (text, id) {
  if (!text || !id) return null
  const lines = text.split('\n')
  const idRe = new RegExp('^- id:\\s*["\']?' + escapeRegExp(id) + '["\']?\\s*$')
  for (let i = 0; i < lines.length; i++) {
    const indent = (lines[i].match(/^[ \t]*/) || [''])[0]
    const rest = lines[i].slice(indent.length)
    if (idRe.test(rest)) return extractIndentedBlock(text, i, indent)
  }
  return null
}

function extractMappingEntry (text, id) {
  if (!text || !id) return null
  const lines = text.split('\n')
  const keyRe = new RegExp('^' + escapeRegExp(id) + ':\\s*(.*)$')
  for (let i = 0; i < lines.length; i++) {
    const indent = (lines[i].match(/^[ \t]*/) || [''])[0]
    const rest = lines[i].slice(indent.length)
    const m = rest.match(keyRe)
    if (!m) continue
    if (m[1] && m[1].trim() && !m[1].trim().startsWith('#') && !m[1].trim().startsWith('|') && !m[1].trim().startsWith('>')) {
      return lines[i].replace(/\s+$/, '') + '\n'
    }
    return extractIndentedBlock(text, i, indent)
  }
  return null
}

function snippetAutomation (doc, id) {
  for (const file of doc.files || []) {
    const text = doc.rawText && doc.rawText[file]
    const block = extractListItemById(text, id)
    if (block) return block
  }
  return ''
}

function snippetHelper (doc, id) {
  for (const file of doc.files || []) {
    const text = doc.rawText && doc.rawText[file]
    const block = extractMappingEntry(text, id)
    if (block) return block
  }
  return ''
}

module.exports = {
  ON_START,
  HELPER_TYPES,
  loadYamlDir,
  loadYamlText,
  emptyDoc,
  combinedYaml,
  extractListItemById,
  extractMappingEntry,
  snippetAutomation,
  snippetHelper
}
