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

  it('helper PUT handler returns PENDING so SK fixReply does not crash', () => {
    const src = fs.readFileSync(path.join(__dirname, '../plugin/index.js'), 'utf8')
    assert.match(src, /registerPutHandler[\s\S]*return \{ state: 'PENDING' \}/)
  })

  it('webapp appIcon file exists', () => {
    const pkg = require('../package.json')
    assert.equal(pkg.signalk.appIcon, 'icon.png')
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', pkg.signalk.appIcon)), true)
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
    assert.ok(routes.some((r) => r === 'GET /diff'))
    assert.ok(routes.some((r) => r === 'POST /live'))
    assert.ok(routes.some((r) => r === 'POST /reload'))
    assert.ok(routes.some((r) => r === 'POST /automations/:id/run'))
    assert.ok(routes.some((r) => r === 'POST /automations/:id/verbose'))
  })

  it('marks write routes readwrite when router.access exists', () => {
    const perms = []
    const router = {
      get () {},
      put () {},
      post () {},
      access (level) {
        return {
          post (p) { perms.push(level + ' POST ' + p) },
          put (p) { perms.push(level + ' PUT ' + p) }
        }
      }
    }
    plugin.registerWithRouter(router)
    assert.ok(perms.includes('readwrite POST /automations/:id/run'))
    assert.ok(perms.includes('readwrite POST /automations/:id/verbose'))
    assert.ok(perms.includes('readwrite POST /reload'))
    assert.ok(perms.includes('readwrite PUT /helpers/:id'))
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
    assert.equal(api.get['/signalk-automation-plugin/diff'], true)
    assert.equal(api.post['/signalk-automation-plugin/live'], undefined)
  })

  it('start stop start', () => {
    plugin.start({})
    plugin.stop()
    assert.doesNotThrow(() => plugin.start({}))
  })

  it('POST /reload picks up working-tree YAML and unsubscribes old paths', async () => {
    const yamlDir = path.join(dataDir, 'yaml')
    fs.mkdirSync(yamlDir)
    fs.writeFileSync(
      path.join(yamlDir, 'a.yaml'),
      'automations:\n  - id: one\n    trigger:\n      - path: electrical.one\n        above: 1\n    action: []\n'
    )
    let unsubCount = 0
    let lastPaths = []
    app.subscriptionmanager = {
      subscribe: (sub, unsubs) => {
        lastPaths = (sub.subscribe || []).map((s) => s.path)
        unsubs.push(() => { unsubCount += 1 })
      }
    }
    plugin.start({ automationsDir: yamlDir, scriptsDir: yamlDir })
    assert.deepEqual(lastPaths, ['electrical.one'])

    fs.writeFileSync(
      path.join(yamlDir, 'a.yaml'),
      'automations:\n  - id: two\n    trigger:\n      - path: electrical.two\n        above: 1\n    action: []\n'
    )

    const handlers = {}
    plugin.registerWithRouter({
      get () {},
      put () {},
      post (p, fn) { handlers[p] = fn }
    })

    const body = await new Promise((resolve, reject) => {
      const chunks = []
      const res = {
        statusCode: 200,
        setHeader () {},
        end (s) {
          chunks.push(s)
          try {
            resolve({ status: res.statusCode, json: JSON.parse(chunks.join('')) })
          } catch (err) {
            reject(err)
          }
        }
      }
      handlers['/reload']({}, res)
    })
    assert.equal(body.status, 200)
    assert.equal(body.json.automations[0].id, 'two')
    assert.equal(unsubCount, 1)
    assert.deepEqual(lastPaths, ['electrical.two'])
  })

  it('POST /enabled persists across a later status snapshot', async () => {
    const yamlDir = path.join(dataDir, 'yaml')
    fs.mkdirSync(yamlDir)
    fs.writeFileSync(
      path.join(yamlDir, 'a.yaml'),
      'automations:\n  - id: shore_charge\n    enabled: false\n    trigger: []\n    action: []\n'
    )
    plugin.start({ automationsDir: yamlDir, scriptsDir: yamlDir })
    const handlers = {}
    plugin.registerWithRouter({
      get (p, fn) { handlers['GET ' + p] = fn },
      put () {},
      post (p, fn) { handlers['POST ' + p] = fn }
    })

    const post = await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        setHeader () {},
        end (s) {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(s) })
          } catch (err) {
            reject(err)
          }
        }
      }
      handlers['POST /automations/:id/enabled'](
        { params: { id: 'shore_charge' }, body: { enabled: true } },
        res
      )
    })
    assert.equal(post.status, 200)
    assert.equal(post.json.enabled, true)

    const snap = await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        setHeader () {},
        end (s) {
          try {
            resolve(JSON.parse(s))
          } catch (err) {
            reject(err)
          }
        }
      }
      handlers['GET /status']({}, res)
    })
    assert.equal(snap.automations[0].enabled, true)
    assert.equal(snap.automations[0].verbose, false)
  })

  it('PUT treats SK 200 reply as success and 405 as failure', async () => {
    const yamlDir = path.join(dataDir, 'yaml')
    fs.mkdirSync(yamlDir)
    fs.writeFileSync(
      path.join(yamlDir, 'a.yaml'),
      [
        'automations:',
        '  - id: start_anchorwatch',
        '    enabled: false',
        '    trigger: []',
        '    action:',
        '      - put: navigation.anchor.maxRadius',
        '        value: 40',
        ''
      ].join('\n')
    )
    plugin.start({ automationsDir: yamlDir, scriptsDir: yamlDir })
    const handlers = {}
    plugin.registerWithRouter({
      get () {},
      put () {},
      post (p, fn) { handlers[p] = fn }
    })

    function runNow () {
      return new Promise((resolve, reject) => {
        const res = {
          statusCode: 200,
          setHeader () {},
          end (s) {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(s) })
            } catch (err) {
              reject(err)
            }
          }
        }
        handlers['/automations/:id/run']({ params: { id: 'start_anchorwatch' } }, res)
      })
    }

    app.putSelfPath = (_p, _v, cb) => {
      cb({ state: 'COMPLETED', statusCode: 200 })
    }
    const ok = await runNow()
    assert.equal(ok.json.result, 'ok')
    assert.equal(ok.json.actions[0].path, 'navigation.anchor.maxRadius')

    app.putSelfPath = (_p, _v, cb) => {
      cb({
        state: 'COMPLETED',
        statusCode: 405,
        message: 'PUT not supported for navigation.anchor.maxRadius'
      })
    }
    const bad = await runNow()
    assert.equal(bad.json.result, 'failure')
    assert.match(bad.json.reason, /PUT not supported for navigation.anchor.maxRadius/)
  })
})
