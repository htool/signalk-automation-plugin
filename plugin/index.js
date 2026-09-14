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
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      resolve(req.body)
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
        resolve({})
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
      sendJson(res, snap)
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleEnabled (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const body = await readJson(req)
      rt.setEnabled(id, body.enabled)
      sendJson(res, { id, enabled: rt.isEnabled({ id, enabled: true }) && body.enabled })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  async function handleHelperPut (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const body = await readJson(req)
      const value = rt.setHelper(id, body.value)
      emitHelper(id, value)
      sendJson(res, { id, value })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  function handleHelperReset (req, res, id) {
    const rt = requireRuntime(res)
    if (!rt) return
    try {
      const value = rt.resetHelper(id)
      emitHelper(id, value)
      sendJson(res, { id, value: value == null ? null : value })
    } catch (err) {
      sendJson(res, { error: err.message }, 400)
    }
  }

  plugin.registerWithRouter = function (router) {
    router.get('/status', (req, res) => sendJson(res, snapshot()))
    router.get('/yaml', (req, res) => sendJson(res, { yaml: snapshot().yaml, sha: snapshot().activeSha }))
    router.get('/commits', (req, res) => sendJson(res, { commits: snapshot().commits, activeSha: snapshot().activeSha }))
    router.get('/automations/:id/traces', (req, res) => {
      const rt = requireRuntime(res)
      if (!rt) return
      sendJson(res, { id: req.params.id, traces: rt.traces(req.params.id) })
    })
    router.post('/live', (req, res) => {
      handleLive(req, res)
    })
    router.post('/automations/:id/enabled', (req, res) => {
      handleEnabled(req, res, req.params.id)
    })
    router.put('/helpers/:id', (req, res) => {
      handleHelperPut(req, res, req.params.id)
    })
    router.post('/helpers/:id/reset', (req, res) => {
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

  function putPath (p, value) {
    return new Promise((resolve, reject) => {
      if (typeof app.putSelfPath === 'function') {
        app.putSelfPath(p, value, (err) => (err ? reject(err) : resolve()))
        return
      }
      app.handleMessage(PLUGIN_ID, {
        updates: [{ values: [{ path: p, value }] }]
      })
      resolve()
    })
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
      log: { debug: app.debug ? app.debug.bind(app) : () => {}, error: app.error ? app.error.bind(app) : console.error }
    })
    runtime.load()

    for (const [id, value] of Object.entries(runtime.helperValues)) {
      emitHelper(id, value)
      if (typeof app.registerPutHandler === 'function') {
        app.registerPutHandler('vessels.self', helpers.helperPath(id), (context, p, v, cb) => {
          try {
            const next = runtime.setHelper(id, v)
            emitHelper(id, next)
            if (cb) cb({ state: 'COMPLETED' })
          } catch (err) {
            if (cb) cb({ state: 'COMPLETED', statusCode: 400, message: err.message })
          }
        })
      }
    }

    const paths = require('../lib/engine').collectPaths(runtime.doc)
    if (paths.length && app.subscriptionmanager) {
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

    timers.push(setInterval(() => {
      runtime.tickSchedule().catch((err) => app.error && app.error(err))
    }, 15000))

    if (app.setPluginStatus) {
      const n = runtime.doc.automations.length
      const err = runtime.doc.errors.length
      app.setPluginStatus(n + ' automations' + (err ? ', ' + err + ' YAML error(s)' : ''))
    }
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

module.exports.app = 'app'
module.exports.options = 'options'
