'use strict'

const path = require('path')
const { Runtime } = require('../lib/runtime')
const helpers = require('../lib/helpers')

const PLUGIN_ID = 'signalk-automation-plugin'

function sendJson (res, body, status) {
  res.statusCode = status || 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    const parsed = req.body
    const hasParsed =
      parsed &&
      typeof parsed === 'object' &&
      !Buffer.isBuffer(parsed) &&
      Object.keys(parsed).length > 0
    if (hasParsed || req.readableEnded) {
      resolve(hasParsed ? parsed : (parsed && typeof parsed === 'object' && !Buffer.isBuffer(parsed) ? parsed : {}))
      return
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) {
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!raw) {
        resolve(parsed && typeof parsed === 'object' && !Buffer.isBuffer(parsed) ? parsed : {})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

module.exports = function (app) {
  const plugin = {}
  plugin.id = PLUGIN_ID
  plugin.name = 'Automations'
  plugin.description =
    'YAML automations for Signal K: helpers, path triggers, PUT/notify/script actions, git-live YAML.'

  let runtime = null
  let options = {}
  const timers = []
  const unsubscribes = []

  plugin.schema = {
    type: 'object',
    properties: {
      automationsDir: {
        type: 'string',
        title: 'Automations git / YAML directory',
        description: 'Folder with *.yaml (preferably a git repo). Live snapshot is stored in plugin data.',
        default: ''
      },
      scriptsDir: {
        type: 'string',
        title: 'Allowed scripts directory',
        description: 'run: actions may only execute files under this path (relative paths in YAML).',
        default: ''
      },
      traceCount: {
        type: 'number',
        title: 'Decision records to keep per automation',
        default: 20,
        minimum: 1
      },
      scriptTimeoutSeconds: {
        type: 'number',
        title: 'Script timeout (seconds)',
        default: 30,
        minimum: 1
      }
    }
  }

  function snapshot () {
    if (!runtime) {
      return {
        started: false,
        automations: [],
        helpers: [],
        zones: [],
        switches: [],
        errors: [],
        yaml: '',
        commits: []
      }
    }
    return runtime.snapshot()
  }

  function requireRuntime (res) {
    if (!runtime) {
      sendJson(res, { error: 'plugin not started' }, 409)
      return null
    }
    return runtime
  }

  async function handleLive (req, res) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const body = await readJson(req)
      const snap = rt.activateCommit(body.sha)
      rewireAfterYamlChange()
      sendJson(res, snap)
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  function handleReload (req, res) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const snap = rt.reloadWorkingTree()
      rewireAfterYamlChange()
      sendJson(res, snap)
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleEnabled (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const auto = rt.doc.automations.find((a) => a.id === id)
      if (!auto) {
        sendJson(res, { error: 'Unknown automation: ' + id }, 404)
        return
      }
      const body = await readJson(req)
      if (!Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        throw new Error('enabled is required')
      }
      rt.setEnabled(id, body.enabled)
      sendJson(res, { id, enabled: rt.isEnabled(auto) })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleVerbose (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const auto = rt.doc.automations.find((a) => a.id === id)
      if (!auto) {
        sendJson(res, { error: 'Unknown automation: ' + id }, 404)
        return
      }
      const body = await readJson(req)
      if (!Object.prototype.hasOwnProperty.call(body, 'verbose')) {
        throw new Error('verbose is required')
      }
      rt.setVerbose(id, body.verbose)
      sendJson(res, { id, verbose: rt.isVerbose(auto) })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleHelperPut (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const body = await readJson(req)
      const value = await rt.setHelper(id, body.value)
      emitHelper(id, value)
      sendJson(res, { id, value })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleHelperReset (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const value = await rt.resetHelper(id)
      emitHelper(id, value)
      sendJson(res, { id, value: value == null ? null : value })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleRun (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const record = await rt.runNow(id)
      sendJson(res, record)
    } catch (err) {
      sendJson(res, { error: err.message }, 404)
    }
  }

  plugin.registerWithRouter = function (router) {
    const write = typeof router.access === 'function' ? router.access('readwrite') : router
    router.get('/status', (req, res) => sendJson(res, snapshot()))
    router.get('/yaml', (req, res) => sendJson(res, { yaml: snapshot().yaml, sha: snapshot().activeSha }))
    router.get('/commits', (req, res) => sendJson(res, { commits: snapshot().commits, activeSha: snapshot().activeSha }))
    router.get('/diff', (req, res) => {
      const rt = requireRuntime(res)
      if (!rt) return
      try {
        sendJson(res, rt.diffCommit(queryParam(req, 'sha')))
      } catch (err) {
        sendJson(res, { error: err.message }, 400)
      }
    })
    router.get('/automations/:id/traces', (req, res) => {
      const rt = requireRuntime(res)
      if (!rt) return
      sendJson(res, { id: req.params.id, traces: rt.traces(req.params.id) })
    })
    write.post('/live', (req, res) => {
      handleLive(req, res)
    })
    write.post('/reload', (req, res) => {
      handleReload(req, res)
    })
    write.post('/automations/:id/enabled', (req, res) => {
      handleEnabled(req, res, req.params.id)
    })
    write.post('/automations/:id/verbose', (req, res) => {
      handleVerbose(req, res, req.params.id)
    })
    write.post('/automations/:id/run', (req, res) => {
      handleRun(req, res, req.params.id)
    })
    write.put('/helpers/:id', (req, res) => {
      handleHelperPut(req, res, req.params.id)
    })
    write.post('/helpers/:id/reset', (req, res) => {
      handleHelperReset(req, res, req.params.id)
    })
  }

  plugin.signalKApiRoutes = function (router) {
    const prefix = '/' + PLUGIN_ID
    router.get(prefix + '/status', (req, res) => sendJson(res, snapshot()))
    router.get(prefix + '/yaml', (req, res) =>
      sendJson(res, { yaml: snapshot().yaml, sha: snapshot().activeSha })
    )
    router.get(prefix + '/commits', (req, res) =>
      sendJson(res, { commits: snapshot().commits, activeSha: snapshot().activeSha })
    )
    router.get(prefix + '/diff', (req, res) => {
      if (!runtime) {
        sendJson(res, { error: 'plugin not started' }, 409)
        return
      }
      try {
        sendJson(res, runtime.diffCommit(queryParam(req, 'sha')))
      } catch (err) {
        sendJson(res, { error: err.message }, 400)
      }
    })
    router.get(prefix + '/automations/:id/traces', (req, res) => {
      if (!runtime) {
        sendJson(res, { error: 'plugin not started' }, 409)
        return
      }
      sendJson(res, { id: req.params.id, traces: runtime.traces(req.params.id) })
    })
    return router
  }

  function emitHelper (id, value) {
    const def = runtime && runtime.doc.helpers[id]
    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          values: [{ path: helpers.helperPath(id), value: value == null ? null : value }],
          meta: [
            {
              path: helpers.helperPath(id),
              value: {
                displayName: def ? def.name : id,
                supportsPut: true
              }
            }
          ]
        }
      ]
    })
  }

  function isMultipleSources (err) {
    return /multiple sources for the given path/i.test(String((err && err.message) || err || ''))
  }

  function putSources (p) {
    const out = []
    const seen = Object.create(null)
    const add = (s) => {
      if (!s) return
      const id = String(s)
      if (seen[id] || id.includes(PLUGIN_ID)) return
      seen[id] = true
      out.push(id)
    }
    const node = typeof app.getSelfPath === 'function' ? app.getSelfPath(p) : null
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      add(node.$source)
      const vals = node.values
      if (vals && typeof vals === 'object') {
        Object.keys(vals)
          .sort((a, b) => Number(/^mqtt\b/i.test(b)) - Number(/^mqtt\b/i.test(a)))
          .forEach(add)
      }
    }
    if (runtime && runtime.values) add(runtime.values[p + '.$source'])
    return out
  }

  function callPutSelf (p, value, source) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      const fromReply = (reply) => {
        if (reply == null) return finish(null)
        if (reply instanceof Error) return finish(reply)
        const code = reply.statusCode
        if (typeof code === 'number' && code >= 400) {
          finish(new Error(reply.message || ('PUT failed (' + code + ') for ' + p)))
          return
        }
        finish(null)
      }
      try {
        const ret = source
          ? app.putSelfPath(p, value, fromReply, source)
          : app.putSelfPath(p, value, fromReply)
        if (ret && typeof ret.then === 'function') {
          ret.then(fromReply, finish)
        }
      } catch (err) {
        finish(err)
      }
    })
  }

  async function putPath (p, value) {
    if (typeof app.putSelfPath !== 'function') {
      app.handleMessage(PLUGIN_ID, {
        updates: [{ values: [{ path: p, value }] }]
      })
      return
    }
    try {
      await callPutSelf(p, value)
    } catch (err) {
      if (!isMultipleSources(err)) throw err
      let last = err
      for (const source of putSources(p)) {
        try {
          await callPutSelf(p, value, source)
          return
        } catch (e) {
          last = e
        }
      }
      throw last
    }
  }

  function notify (p, state, message) {
    const npath = String(p).startsWith('notifications.') ? p : 'notifications.' + p
    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          values: [
            {
              path: npath,
              value: {
                state: state || 'alert',
                message: message || '',
                method: ['visual', 'sound']
              }
            }
          ]
        }
      ]
    })
  }

  plugin.start = function (opts) {
    options = opts || {}
    const dataDir =
      (app.getDataDirPath && app.getDataDirPath()) ||
      path.join(process.cwd(), 'plugin-data', PLUGIN_ID)
    fsMkdir(dataDir)

    runtime = new Runtime({
      app,
      pluginId: PLUGIN_ID,
      dataDir,
      automationsDir: options.automationsDir || '',
      scriptsDir: options.scriptsDir || '',
      traceCount: options.traceCount,
      scriptTimeoutSeconds: options.scriptTimeoutSeconds,
      put: putPath,
      notify,
      onHelper: (id, value) => emitHelper(id, value),
      log: {
        debug: app.debug ? app.debug.bind(app) : () => {},
        error: app.error ? app.error.bind(app) : console.error,
        info: (msg) => {
          if (app.debug) app.debug(msg)
          console.log('[signalk-automation-plugin] ' + msg)
        }
      }
    })
    runtime.load()
    runtime.seedFromSelf()
    rewireAfterYamlChange()
    runtime.evaluateOnStart().catch((err) => app.error && app.error(err))

    timers.push(setInterval(() => {
      runtime.tickSchedule().catch((err) => app.error && app.error(err))
    }, 15000))
  }

  function clearSubscriptions () {
    unsubscribes.splice(0).forEach((f) => {
      try {
        f()
      } catch (_) {}
    })
  }

  function emitAllHelpers () {
    if (!runtime) return
    for (const [id, value] of Object.entries(runtime.helperValues)) {
      emitHelper(id, value)
      if (typeof app.registerPutHandler === 'function') {
        app.registerPutHandler('vessels.self', helpers.helperPath(id), (context, p, v, cb) => {
          Promise.resolve(runtime.setHelper(id, v))
            .then((next) => {
              const live = Object.prototype.hasOwnProperty.call(runtime.helperValues, id)
                ? runtime.helperValues[id]
                : next
              emitHelper(id, live)
              if (cb) cb({ state: 'COMPLETED' })
            })
            .catch((err) => {
              if (cb) cb({ state: 'COMPLETED', statusCode: 400, message: err.message })
            })
          return { state: 'PENDING' }
        })
      }
    }
  }

  function subscribePaths () {
    if (!runtime || !app.subscriptionmanager) return
    const paths = require('../lib/engine').collectPaths(runtime.doc)
    if (!paths.length) return
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: paths.map((p) => ({ path: p }))
      },
      unsubscribes,
      (err) => app.error && app.error(err),
      (delta) => {
        const src = delta && delta.updates && delta.updates[0] && delta.updates[0].$source
        ;(delta.updates || []).forEach((u) => {
          const source = u.$source || src
          ;(u.values || []).forEach((v) => {
            runtime.handlePathChange(v.path, v.value, source).catch((err) => {
              if (app.error) app.error(err)
            })
          })
        })
      }
    )
  }

  function setStatusFromRuntime () {
    if (!app.setPluginStatus || !runtime) return
    const n = runtime.doc.automations.length
    const err = runtime.doc.errors.length
    app.setPluginStatus(n + ' automations' + (err ? ', ' + err + ' YAML error(s)' : ''))
  }

  function rewireAfterYamlChange () {
    clearSubscriptions()
    emitAllHelpers()
    subscribePaths()
    setStatusFromRuntime()
  }

  plugin.stop = function () {
    timers.splice(0).forEach((t) => clearInterval(t))
    unsubscribes.splice(0).forEach((f) => {
      try {
        f()
      } catch (_) {}
    })
    runtime = null
  }

  return plugin
}

function fsMkdir (dir) {
  const fs = require('fs')
  fs.mkdirSync(dir, { recursive: true })
}

function queryParam (req, name) {
  if (req.query && req.query[name] != null) return String(req.query[name])
  const raw = String(req.url || '').split('?')[1] || ''
  return new URLSearchParams(raw).get(name) || ''
}

module.exports.app = 'app'
module.exports.options = 'options'
