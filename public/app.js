const PLUGIN = 'signalk-automation-plugin'
const API_READ = '/signalk/v1/api/' + PLUGIN
const API_WRITE = '/plugins/' + PLUGIN

let authToken = sessionStorage.getItem('skAuthToken') || ''
let loggedIn = false
let authRequired = true
let loginUser = ''

function authHeaders (extra) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {})
  if (authToken) headers.Authorization = 'Bearer ' + authToken
  return headers
}

function httpError (res, data, url) {
  if (res.status === 401) {
    loggedIn = false
    authToken = ''
    sessionStorage.removeItem('skAuthToken')
    renderLogin()
    return new Error('Log in to Signal K to Run, Reload, or change automations')
  }
  return new Error((data && (data.error || data.message)) || res.status + ' ' + url)
}

async function getJson (url) {
  const res = await fetch(url, { credentials: 'include', headers: authHeaders() })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch (_) { data = { error: text } }
  if (!res.ok) throw httpError(res, data, url)
  return data
}

async function sendJson (url, method, body) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify(body || {})
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw httpError(res, data, url)
  return data
}

function renderLogin () {
  const form = el('loginForm')
  const who = el('loginWho')
  const need = authRequired && !loggedIn
  form.hidden = !need
  who.hidden = !loggedIn
  if (loggedIn) who.textContent = loginUser ? 'Signed in as ' + loginUser : 'Signed in'
}

async function checkLogin () {
  try {
    const res = await fetch('/skServer/loginStatus', {
      credentials: 'include',
      headers: authHeaders()
    })
    const data = await res.json().catch(() => ({}))
    authRequired = data.authenticationRequired !== false
    loggedIn = data.status === 'loggedIn'
    loginUser = data.username || ''
  } catch (_) {
    authRequired = true
    loggedIn = false
  }
  renderLogin()
}

function el (id) { return document.getElementById(id) }

function displayResult (result) {
  if (!result) return '—'
  if (result === 'failure') return 'Failed'
  return 'OK'
}

function badge (result) {
  const klass = !result ? '' : result === 'failure' ? 'failure' : 'ok'
  return '<span class="badge ' + klass + '">' + displayResult(result) + '</span>'
}

function fmtVal (v) {
  if (v === undefined) return 'unset'
  try { return JSON.stringify(v) } catch (_) { return String(v) }
}

function fmtActions (t) {
  return (t.actions || []).map((a) => {
    if (a.type === 'put') {
      const prev = a.previous !== undefined ? fmtVal(a.previous) + ' → ' : ''
      return 'PUT ' + a.path + '  ' + prev + fmtVal(a.value)
    }
    if (a.type === 'helper') return 'helper ' + a.helper + ' = ' + fmtVal(a.value)
    if (a.type === 'notify') return 'notify ' + (a.path || '') + ' ' + (a.state || '')
    if (a.type === 'delay') return a.skipped ? 'delay skipped (' + a.ms + ' ms)' : 'delay ' + a.ms + ' ms'
    if (a.type === 'run') return 'run ' + (a.file || '')
    return a.type || 'action'
  }).join('\n')
}

function fmtClause (c) {
  if (!c || typeof c !== 'object') return ''
  const label = c.label || c.path || c.expected || ''
  const mark = c.error ? '✗' : c.pass ? '✓' : '✗'
  return (
    '<div class="clause ' + (c.pass && !c.error ? 'pass' : 'fail') + '">' +
      mark + ' ' + escapeHtml(String(label)) +
      (c.error ? ' (' + escapeHtml(c.error) + ')' : '') +
    '</div>'
  )
}

function fmtRunRecord (t) {
  if (!t) return '<p class="hint">No run yet.</p>'
  if (t.verboseLog) {
    return (
      '<div class="card run-card">' +
        badge(t.result) + ' <span class="muted">' + fmtTime(t.ts) + (t.manual ? ' · manual' : '') + '</span>' +
        '<pre class="run-path">' + escapeHtml(t.verboseLog) + '</pre>' +
        (fmtActions(t) ? '<pre class="run-actions">' + escapeHtml(fmtActions(t)) + '</pre>' : '') +
      '</div>'
    )
  }
  const clauses = [].concat(t.triggerResults || [], t.conditions || []).map(fmtClause).join('')
  return (
    '<div class="card run-card">' +
      badge(t.result) + ' <span class="muted">' + fmtTime(t.ts) + (t.manual ? ' · manual' : '') + '</span>' +
      (t.firedBy ? '<div class="clause">trigger: ' + escapeHtml(t.firedBy) + '</div>' : '') +
      (t.choose ? '<div>choose: ' + escapeHtml(t.choose) + '</div>' : '') +
      (t.reason ? '<div class="muted">' + escapeHtml(t.reason) + '</div>' : '') +
      clauses +
      (fmtActions(t) ? '<pre class="run-actions">' + escapeHtml(fmtActions(t)) + '</pre>' : '') +
    '</div>'
  )
}

function fmtTime (iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(d)
  } catch (_) { return iso }
}

function escapeHtml (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightYaml (text) {
  return String(text || '').split('\n').map((line) => {
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
      return '<span class="tok-cmt">' + escapeHtml(line) + '</span>'
    }
    const m = line.match(/^(\s*)(- )?(("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+):)(\s*)(.*)$/)
    if (!m) return escapeHtml(line)
    const value = m[6]
    let lit = escapeHtml(value)
    if (/^(true|false|null)$/.test(value)) lit = '<span class="tok-bool">' + lit + '</span>'
    else if (/^-?\d+(\.\d+)?$/.test(value)) lit = '<span class="tok-num">' + lit + '</span>'
    else if (value) lit = '<span class="tok-str">' + lit + '</span>'
    return (
      escapeHtml(m[1]) +
      escapeHtml(m[2] || '') +
      '<span class="tok-key">' + escapeHtml(m[3].replace(/:$/, '')) + '</span>:' +
      escapeHtml(m[5]) +
      lit
    )
  }).join('\n')
}

function highlightDiff (text) {
  if (!text) return '<span class="tok-cmt">(no differences)</span>'
  return text.split('\n').map((line) => {
    const esc = escapeHtml(line)
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      return '<span class="diff-meta">' + esc + '</span>'
    }
    if (line.startsWith('@@')) return '<span class="diff-hunk">' + esc + '</span>'
    if (line.startsWith('+')) return '<span class="diff-add">' + esc + '</span>'
    if (line.startsWith('-')) return '<span class="diff-del">' + esc + '</span>'
    return esc
  }).join('\n')
}

let status = null
let selected = null
let pickedSha = ''
let lastSeenRuns = ''
let writesInFlight = 0
const POLL_MS = 1500

function runFingerprint (snap) {
  return (snap.automations || []).map((a) => {
    const last = a.lastRun || {}
    return a.id + '\t' + (last.ts || '') + '\t' + (last.result || '')
  }).join('\n')
}

function liveSha () {
  return status.activeSha || status.headSha || ''
}

async function load () {
  status = await getJson(API_READ + '/status')
  lastSeenRuns = runFingerprint(status)
  if (!selected) {
    const first = (status.automations || [])[0]
    if (first) selected = { kind: 'automation', id: first.id }
  }
  render()
  if (selected && selected.kind === 'automation') {
    const a = (status.automations || []).find((x) => x.id === selected.id)
    await showRunLog(selected.id, a ? a.alias : selected.id).catch(() => {})
  } else {
    el('runLog').hidden = true
  }
}

async function refreshIfRan () {
  if (writesInFlight || document.hidden || !status) return
  try {
    const next = await getJson(API_READ + '/status')
    const fp = runFingerprint(next)
    if (fp === lastSeenRuns) return
    const prevTs =
      selected && selected.kind === 'automation'
        ? (((status.automations || []).find((a) => a.id === selected.id) || {}).lastRun || {}).ts
        : null
    lastSeenRuns = fp
    status = next
    render()
    if (selected && selected.kind === 'automation') {
      const a = (status.automations || []).find((x) => x.id === selected.id)
      await showRunLog(selected.id, a ? a.alias : selected.id).catch(() => {})
      const ts = a && a.lastRun && a.lastRun.ts
      if (ts && ts !== prevTs) el('runLog').scrollIntoView({ block: 'nearest' })
    }
  } catch (_) {}
}

function render () {
  const sha = liveSha()
  el('shaLine').textContent =
    (status.started ? 'Running' : 'Not started') +
    ' · live ' + (sha ? sha.slice(0, 8) : 'working tree') +
    (status.automationsDir ? ' · ' + status.automationsDir.split('/').pop() : '')
  if (status.errors && status.errors.length) {
    el('shaLine').innerHTML +=
      '<div class="error">' +
      status.errors.map((e) => e.file + ': ' + e.message).join('<br>') +
      '</div>'
  }

  el('autos').innerHTML = (status.automations || []).map((a) => {
    const last = a.lastRun || {}
    const on = selected && selected.kind === 'automation' && selected.id === a.id
    return (
      '<div class="item' + (on ? ' selected' : '') + '" data-select="automation:' + escapeHtml(a.id) + '" tabindex="0">' +
        '<div class="row">' +
          '<div><div class="name">' + escapeHtml(a.alias) + '</div>' +
          '<div class="muted">' + escapeHtml(a.id) + (last.ts ? ' · ' + fmtTime(last.ts) : '') + '</div></div>' +
          '<div class="row">' +
            badge(last.result) +
            '<div class="auto-switches" onclick="event.stopPropagation()">' +
              '<label class="pwr' + (a.enabled ? ' is-on' : '') + '">' +
                '<input type="checkbox" data-toggle="' + escapeHtml(a.id) + '"' +
                  (a.enabled ? ' checked' : '') + '>' +
                '<span class="pwr-ui"></span>' +
                '<span class="pwr-label">' + (a.enabled ? 'On' : 'Off') + '</span>' +
              '</label>' +
              '<label class="pwr pwr-verbose' + (a.verbose ? ' is-on' : '') + '">' +
                '<input type="checkbox" data-verbose="' + escapeHtml(a.id) + '"' +
                  (a.verbose ? ' checked' : '') + '>' +
                '<span class="pwr-ui"></span>' +
                '<span class="pwr-label">Verbose</span>' +
              '</label>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    )
  }).join('') || '<p class="hint">No automations loaded.</p>'

  el('helpers').innerHTML = (status.helpers || []).map((h) => {
    const on = selected && selected.kind === 'helper' && selected.id === h.id
    const mode = h.on_start === 'restore' ? 'survive reboot' : h.on_start === 'default' ? 'default on start' : 'nothing'
    const val = h.set ? JSON.stringify(h.value) : 'unset'
    return (
      '<div class="item' + (on ? ' selected' : '') + '" data-select="helper:' + escapeHtml(h.id) + '" tabindex="0">' +
        '<div class="row">' +
          '<div><div class="name">' + escapeHtml(h.name) + '</div>' +
          '<div class="muted">' + escapeHtml(h.id) + ' · ' + mode + ' · ' + escapeHtml(val) + '</div></div>' +
          '<button type="button" data-reset="' + escapeHtml(h.id) + '">reset</button>' +
        '</div>' +
      '</div>'
    )
  }).join('') || '<p class="hint">No helpers in live YAML.</p>'

  el('zones').innerHTML = (status.zones || []).map((z) => {
    const on = selected && selected.kind === 'zone' && selected.id === z.id
    return (
      '<div class="item' + (on ? ' selected' : '') + '" data-select="zone:' + escapeHtml(z.id) + '" tabindex="0">' +
        '<div class="name">' + escapeHtml(z.name || z.id) + '</div>' +
        '<div class="muted">' + escapeHtml(z.id) + ' · ' + Number(z.lat).toFixed(5) + ', ' +
          Number(z.lon).toFixed(5) + ' · r=' + escapeHtml(String(z.radius)) + ' m</div>' +
      '</div>'
    )
  }).join('') || '<p class="hint">No zones in live YAML.</p>'

  el('switches').innerHTML = (status.switches || []).slice(0, 20).map((s) => {
    const who = [s.automation, s.branch].filter(Boolean).join(' / ')
    const kind = s.kind === 'helper' ? 'helper ' + s.path : 'PUT ' + s.path
    const line = kind + '  ' + fmtVal(s.from) + ' → ' + fmtVal(s.to)
    return (
      '<div class="switch-line">' +
        '<div class="muted">' + fmtTime(s.ts) + (who ? ' · ' + escapeHtml(who) : '') + '</div>' +
        '<div>' + escapeHtml(line) + '</div>' +
      '</div>'
    )
  }).join('') || '<p class="hint">No PUTs or helper changes yet.</p>'

  const commits = status.commits || []
  el('gitBar').hidden = commits.length === 0
  if (commits.length) {
    if (!pickedSha || !commits.some((c) => c.sha === pickedSha)) pickedSha = liveSha() || commits[0].sha
    el('commitSelect').innerHTML = commits.map((c) => {
      const live = c.sha === liveSha()
      const label = (c.subject || c.sha.slice(0, 7)) + (live ? ' (live)' : '')
      return '<option value="' + escapeHtml(c.sha) + '"' + (c.sha === pickedSha ? ' selected' : '') + '>' +
        escapeHtml(label) + '</option>'
    }).join('')
  }

  renderYaml()
  bind()
}

function renderYaml () {
  let title = 'YAML'
  let body = '# select an automation or helper'
  if (selected && selected.kind === 'automation') {
    const a = (status.automations || []).find((x) => x.id === selected.id)
    title = a ? a.alias : selected.id
    body = (a && a.yaml) || '# not found'
  } else if (selected && selected.kind === 'zone') {
    const z = (status.zones || []).find((x) => x.id === selected.id)
    title = z ? (z.name || z.id) : selected.id
    body = (z && z.yaml) || '# not found'
  } else if (selected && selected.kind === 'helper') {
    const h = (status.helpers || []).find((x) => x.id === selected.id)
    title = h ? h.name : selected.id
    body = (h && h.yaml) || '# not found'
  }
  el('yamlTitle').textContent = title
  el('yaml').innerHTML = highlightYaml(body)
  const run = el('runAuto')
  run.hidden = !(selected && selected.kind === 'automation')
  run.disabled = false
}

async function showRunLog (id, alias, latest) {
  const box = el('runLog')
  box.hidden = false
  el('runLogTitle').textContent = 'Run — ' + alias
  if (latest) {
    el('runLogBody').innerHTML = fmtRunRecord(latest)
    return
  }
  const data = await getJson(API_READ + '/automations/' + encodeURIComponent(id) + '/traces')
  const traces = data.traces || []
  el('runLogBody').innerHTML = traces.length
    ? traces.slice(0, 8).map(fmtRunRecord).join('')
    : '<p class="hint">No run yet. Press Run to execute this automation now.</p>'
}

async function loadDiff (sha) {
  pickedSha = sha
  const box = el('gitDiff')
  if (!sha || sha === liveSha()) {
    box.hidden = true
    return
  }
  try {
    const data = await getJson(API_READ + '/diff?sha=' + encodeURIComponent(sha))
    box.hidden = false
    el('diffView').innerHTML = highlightDiff(data.diff)
    el('diffHint').textContent = data.current
      ? 'This commit is already live.'
      : 'Live ' + (data.from ? data.from.slice(0, 8) : 'HEAD') + ' → ' + data.to.slice(0, 8)
    el('resetGit').disabled = !!data.current
    el('resetGit').setAttribute('data-sha', sha)
  } catch (err) {
    box.hidden = false
    el('diffView').textContent = err.message
    el('resetGit').disabled = true
  }
}

function showWriteError (err) {
  el('shaLine').innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>'
}

async function selectItem (btn) {
  const raw = btn.getAttribute('data-select')
  const i = raw.indexOf(':')
  selected = { kind: raw.slice(0, i), id: raw.slice(i + 1) }
  document.querySelectorAll('.item.selected').forEach((n) => n.classList.remove('selected'))
  btn.classList.add('selected')
  renderYaml()
  if (selected.kind === 'automation') {
    const a = (status.automations || []).find((x) => x.id === selected.id)
    await showRunLog(selected.id, a ? a.alias : selected.id).catch(() => {})
  } else {
    el('runLog').hidden = true
  }
}

function bind () {
  el('commitSelect').onchange = () => loadDiff(el('commitSelect').value)
  el('resetGit').onclick = async () => {
    const sha = el('resetGit').getAttribute('data-sha')
    if (!sha) return
    el('resetGit').disabled = true
    writesInFlight += 1
    try {
      await sendJson(API_WRITE + '/live', 'POST', { sha })
      pickedSha = sha
      await load()
      el('gitDiff').hidden = true
    } catch (err) {
      showWriteError(err)
      el('resetGit').disabled = false
    } finally {
      writesInFlight -= 1
    }
  }
  if (bind.once) return
  bind.once = true
  document.querySelector('aside').addEventListener('click', async (ev) => {
    const reset = ev.target.closest('[data-reset]')
    if (reset) {
      ev.stopPropagation()
      writesInFlight += 1
      try {
        await sendJson(API_WRITE + '/helpers/' + reset.getAttribute('data-reset') + '/reset', 'POST', {})
        await load()
      } catch (err) {
        showWriteError(err)
      } finally {
        writesInFlight -= 1
      }
      return
    }
    if (ev.target.closest('[data-toggle]') || ev.target.closest('[data-verbose]')) return
    const btn = ev.target.closest('[data-select]')
    if (btn) await selectItem(btn)
  })
  document.querySelector('aside').addEventListener('change', async (ev) => {
    const verbose = ev.target.closest('[data-verbose]')
    if (verbose) {
      const wanted = verbose.checked
      writesInFlight += 1
      try {
        await sendJson(API_WRITE + '/automations/' + verbose.getAttribute('data-verbose') + '/verbose', 'POST', {
          verbose: wanted
        })
        await load()
      } catch (err) {
        verbose.checked = !wanted
        showWriteError(err)
      } finally {
        writesInFlight -= 1
      }
      return
    }
    const box = ev.target.closest('[data-toggle]')
    if (!box) return
    const wanted = box.checked
    writesInFlight += 1
    try {
      await sendJson(API_WRITE + '/automations/' + box.getAttribute('data-toggle') + '/enabled', 'POST', {
        enabled: wanted
      })
      await load()
    } catch (err) {
      box.checked = !wanted
      showWriteError(err)
    } finally {
      writesInFlight -= 1
    }
  })
}

el('reloadAutos').onclick = async () => {
  const btn = el('reloadAutos')
  btn.disabled = true
  writesInFlight += 1
  try {
    await sendJson(API_WRITE + '/reload', 'POST', {})
    await load()
    el('gitDiff').hidden = true
  } catch (err) {
    el('shaLine').innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>'
  } finally {
    writesInFlight -= 1
    btn.disabled = false
  }
}

el('runAuto').onclick = async () => {
  if (!selected || selected.kind !== 'automation') return
  const btn = el('runAuto')
  btn.disabled = true
  writesInFlight += 1
  try {
    const record = await sendJson(
      API_WRITE + '/automations/' + encodeURIComponent(selected.id) + '/run',
      'POST',
      {}
    )
    const a = (status.automations || []).find((x) => x.id === selected.id)
    await showRunLog(selected.id, a ? a.alias : selected.id, record)
    el('runLog').scrollIntoView({ block: 'nearest' })
    await load()
    await showRunLog(selected.id, a ? a.alias : selected.id).catch(() => {})
  } catch (err) {
    const msg = escapeHtml(err.message)
    el('shaLine').innerHTML = '<span class="error">' + msg + '</span>'
    el('runLog').hidden = false
    el('runLogBody').innerHTML = '<p class="error">' + msg + '</p>'
  } finally {
    writesInFlight -= 1
    btn.disabled = false
  }
}

el('loginForm').onsubmit = async (ev) => {
  ev.preventDefault()
  const errEl = el('loginErr')
  errEl.textContent = ''
  const username = el('loginUser').value
  const password = el('loginPass').value
  try {
    const res = await fetch('/signalk/v1/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, rememberMe: true })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      errEl.textContent = data.message || data.error || 'Login failed'
      return
    }
    authToken = data.token || ''
    if (authToken) sessionStorage.setItem('skAuthToken', authToken)
    el('loginPass').value = ''
    loggedIn = true
    loginUser = username
    renderLogin()
  } catch (err) {
    errEl.textContent = err.message || 'Login failed'
  }
}

checkLogin()
  .then(() => load())
  .then(() => {
    setInterval(refreshIfRan, POLL_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshIfRan()
    })
  })
  .catch((err) => {
    el('shaLine').innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>'
  })
