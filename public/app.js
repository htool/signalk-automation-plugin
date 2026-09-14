const PLUGIN = 'signalk-automation-plugin'
const API_READ = '/signalk/v1/api/' + PLUGIN
const API_WRITE = '/plugins/' + PLUGIN

async function getJson (url) {
  const res = await fetch(url, { credentials: 'same-origin' })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch (_) { data = { error: text } }
  if (!res.ok) throw new Error(data.error || res.status + ' ' + url)
  return data
}

async function sendJson (url, method, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.status + ' ' + url)
  return data
}

function el (id) { return document.getElementById(id) }

function badge (result) {
  const r = result || '—'
  return '<span class="badge ' + (result || '') + '">' + r + '</span>'
}

function fmtTime (iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleString() } catch (_) { return iso }
}

let status = null

async function load () {
  status = await getJson(API_READ + '/status')
  render()
}

function render () {
  const sha = status.activeSha ? status.activeSha.slice(0, 8) : 'working tree / empty'
  el('shaLine').textContent =
    (status.started ? 'Running' : 'Not started') +
    ' · live ' + sha +
    (status.automationsDir ? ' · repo ' + status.automationsDir : '')
  if (status.errors && status.errors.length) {
    el('shaLine').innerHTML +=
      '<div class="error">' +
      status.errors.map((e) => e.file + ': ' + e.message).join('<br>') +
      '</div>'
  }

  el('autos').innerHTML = (status.automations || []).map((a) => {
    const last = a.lastRun || {}
    return (
      '<div class="card">' +
        '<div class="row">' +
          '<div><div class="name">' + escapeHtml(a.alias) + '</div>' +
          '<div class="muted">' + escapeHtml(a.id) + ' · ' + fmtTime(last.ts) + '</div></div>' +
          '<div class="row">' +
            badge(last.result) +
            '<label class="muted"><input type="checkbox" data-toggle="' + escapeHtml(a.id) + '"' +
              (a.enabled ? ' checked' : '') + '> on</label>' +
            '<button data-traces="' + escapeHtml(a.id) + '" data-alias="' + escapeHtml(a.alias) + '">runs</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    )
  }).join('') || '<p class="hint">No automations loaded. Set automationsDir and activate a commit.</p>'

  el('helpers').innerHTML = (status.helpers || []).map((h) => {
    const mode = h.on_start === 'restore' ? 'survive reboot' : h.on_start === 'default' ? 'default on start' : 'nothing'
    const val = h.set ? JSON.stringify(h.value) : 'unset'
    return (
      '<div class="card"><div class="row">' +
        '<div><div class="name">' + escapeHtml(h.name) + '</div>' +
        '<div class="muted">' + escapeHtml(h.id) + ' · ' + mode + ' · ' + escapeHtml(val) + '</div></div>' +
        '<button data-reset="' + escapeHtml(h.id) + '">reset default</button>' +
      '</div></div>'
    )
  }).join('') || '<p class="hint">No helpers in live YAML.</p>'

  el('yaml').textContent = status.yaml || '# no live YAML'
  el('commits').innerHTML = (status.commits || []).map((c) => {
    const live = status.activeSha && c.sha === status.activeSha
    return (
      '<div class="card"><div class="row">' +
        '<div><div class="name">' + escapeHtml(c.subject || '') + '</div>' +
        '<div class="muted">' + escapeHtml(c.sha.slice(0, 10)) + ' · ' + escapeHtml(c.date || '') +
        (live ? ' · live' : '') + '</div></div>' +
        (live ? '' : '<button class="primary" data-sha="' + escapeHtml(c.sha) + '">make live</button>') +
      '</div></div>'
    )
  }).join('') || '<p class="hint">automationsDir is not a git repo (or git is missing in the container).</p>'

  bind()
}

function bind () {
  document.querySelectorAll('[data-toggle]').forEach((box) => {
    box.addEventListener('change', async () => {
      await sendJson(API_WRITE + '/automations/' + box.getAttribute('data-toggle') + '/enabled', 'POST', {
        enabled: box.checked
      })
      await load()
    })
  })
  document.querySelectorAll('[data-traces]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-traces')
      const data = await getJson(API_READ + '/automations/' + encodeURIComponent(id) + '/traces')
      el('detail').hidden = false
      el('detailTitle').textContent = 'Runs — ' + btn.getAttribute('data-alias')
      el('traces').innerHTML = (data.traces || []).map((t) => {
        return (
          '<div class="card">' +
            badge(t.result) + ' <span class="muted">' + fmtTime(t.ts) + '</span>' +
            (t.reason ? '<div class="muted">' + escapeHtml(t.reason) + '</div>' : '') +
            '<pre class="trace">' + escapeHtml(JSON.stringify(t, null, 2)) + '</pre>' +
          '</div>'
        )
      }).join('') || '<p class="hint">No runs yet.</p>'
      el('detail').scrollIntoView({ behavior: 'smooth' })
    })
  })
  document.querySelectorAll('[data-sha]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sendJson(API_WRITE + '/live', 'POST', { sha: btn.getAttribute('data-sha') })
      await load()
    })
  })
  document.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sendJson(API_WRITE + '/helpers/' + btn.getAttribute('data-reset') + '/reset', 'POST', {})
      await load()
    })
  })
}

function escapeHtml (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

load().catch((err) => {
  el('shaLine').innerHTML = '<span class="error">' + escapeHtml(err.message) + '</span>'
})
