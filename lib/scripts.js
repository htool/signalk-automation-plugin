'use strict'

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

function resolveScript (scriptsDir, file) {
  if (!scriptsDir) {
    throw new Error('scriptsDir is not configured')
  }
  if (!file || typeof file !== 'string') {
    throw new Error('Script file is required')
  }
  if (path.isAbsolute(file)) {
    throw new Error('Script path must be relative to scriptsDir')
  }
  const root = path.resolve(scriptsDir)
  const resolved = path.resolve(root, file)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Script path escapes scriptsDir')
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('Script not found: ' + file)
  }
  return resolved
}

function interpreterFor (scriptPath) {
  const ext = path.extname(scriptPath).toLowerCase()
  if (ext === '.py') return { cmd: 'python3', args: [scriptPath] }
  if (ext === '.sh') return { cmd: 'bash', args: [scriptPath] }
  return { cmd: scriptPath, args: [] }
}

function parseOutput (stdout) {
  const text = String(stdout || '').trim()
  if (!text) return { stdout: '', value: '' }
  if (
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'))
  ) {
    try {
      return { stdout: text, value: JSON.parse(text) }
    } catch (_) {
      /* fall through */
    }
  }
  if (text === 'true') return { stdout: text, value: true }
  if (text === 'false') return { stdout: text, value: false }
  const n = Number(text)
  if (text !== '' && Number.isFinite(n)) return { stdout: text, value: n }
  return { stdout: text, value: text }
}

function runScript (opts) {
  const scriptsDir = opts.scriptsDir
  const file = opts.file
  const extraArgs = Array.isArray(opts.args) ? opts.args.map(String) : []
  const timeout = opts.timeoutMs || 30000
  const env = Object.assign({}, process.env, opts.env || {})
  const exec = opts.execFile || execFile

  let resolved
  try {
    resolved = resolveScript(scriptsDir, file)
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: err.message,
      stdout: '',
      stderr: '',
      value: null
    })
  }

  const interp = interpreterFor(resolved)
  const args = interp.args.concat(extraArgs)

  return new Promise((resolve) => {
    exec(
      interp.cmd,
      args,
      { cwd: path.resolve(scriptsDir), timeout, env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const errText = String(stderr || '').trim()
        if (errText) {
          resolve({
            ok: false,
            error: 'stderr: ' + errText,
            stdout: String(stdout || ''),
            stderr: errText,
            value: null
          })
          return
        }
        if (err) {
          resolve({
            ok: false,
            error: err.killed ? 'Script timed out' : err.message,
            stdout: String(stdout || ''),
            stderr: errText,
            value: null
          })
          return
        }
        const parsed = parseOutput(stdout)
        resolve({
          ok: true,
          error: null,
          stdout: parsed.stdout,
          stderr: '',
          value: parsed.value
        })
      }
    )
  })
}

module.exports = { resolveScript, interpreterFor, parseOutput, runScript }
