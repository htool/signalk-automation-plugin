'use strict'

const fs = require('fs')
const path = require('path')

function emptyState () {
  return {
    helpers: {},
    enabled: {},
    activeSha: null,
    lastRun: {}
  }
}

function loadState (dir) {
  const file = path.join(dir, 'state.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Object.assign(emptyState(), raw)
  } catch (_) {
    return emptyState()
  }
}

function saveState (dir, state) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, 'state.json.tmp')
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function tracesPath (dir, id) {
  return path.join(dir, 'traces', safeId(id) + '.json')
}

function loadTraces (dir, id) {
  try {
    const data = JSON.parse(fs.readFileSync(tracesPath(dir, id), 'utf8'))
    return Array.isArray(data) ? data : []
  } catch (_) {
    return []
  }
}

function appendTrace (dir, id, record, max) {
  const cap = max > 0 ? max : 20
  const list = loadTraces(dir, id)
  list.unshift(record)
  while (list.length > cap) list.pop()
  const folder = path.join(dir, 'traces')
  fs.mkdirSync(folder, { recursive: true })
  const tmp = tracesPath(dir, id) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n')
  fs.renameSync(tmp, tracesPath(dir, id))
  return list
}

function liveDir (dir) {
  return path.join(dir, 'live')
}

function safeId (id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_')
}

module.exports = {
  emptyState,
  loadState,
  saveState,
  loadTraces,
  appendTrace,
  liveDir,
  tracesPath
}
