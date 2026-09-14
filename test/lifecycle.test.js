'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')

function makeApp (dataDir) {
  return {
    debug: () => {},
    error: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
    getDataDirPath: () => dataDir,
    handleMessage: () => {},
    putSelfPath: (_p, _v, cb) => cb && cb(null),
    registerPutHandler: () => {},
    subscriptionmanager: {
      subscribe: (_sub, unsubscribes) => {
        unsubscribes.push(() => {})
      }
    }
  }
}

function freshPlugin (app) {
  const resolved = require.resolve('../plugin/index.js')
  delete require.cache[resolved]
  return require('../plugin/index.js')(app)
}

describe('plugin lifecycle', () => {
  let dataDir, app, plugin

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-auto-life-'))
    app = makeApp(dataDir)
    plugin = freshPlugin(app)
  })

  afterEach(() => {
    try { plugin.stop() } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('has id and schema', () => {
    assert.equal(plugin.id, 'signalk-automation-plugin')
    assert.equal(typeof plugin.schema, 'object')
    assert.equal(plugin.schema.type, 'object')
  })

  it('registerWithRouter works before start', () => {
    const routes = []
    const router = {
      get: (p) => routes.push('GET ' + p),
      put: (p) => routes.push('PUT ' + p),
      post: (p) => routes.push('POST ' + p)
    }
    plugin.registerWithRouter(router)
    assert.ok(routes.some((r) => r === 'GET /status'))
    assert.ok(routes.some((r) => r === 'POST /live'))
  })

  it('signalKApiRoutes is GET-only under plugin id', () => {
    const api = { get: {}, put: {}, post: {} }
    const router = {
      get: (p) => { api.get[p] = true },
      put: (p) => { api.put[p] = true },
      post: (p) => { api.post[p] = true }
    }
    const returned = plugin.signalKApiRoutes(router)
    assert.equal(typeof returned.get, 'function')
    assert.equal(api.get['/signalk-automation-plugin/status'], true)
    assert.equal(api.post['/signalk-automation-plugin/live'], undefined)
  })

  it('start stop start', () => {
    plugin.start({})
    plugin.stop()
    assert.doesNotThrow(() => plugin.start({}))
  })
})
