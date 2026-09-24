'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const git = require('../lib/git')

function gitCmd (args, cwd) {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf8' }
  )
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim())
  }
  return (r.stdout || '').trim()
}

function initRepo (dir) {
  fs.mkdirSync(dir, { recursive: true })
  gitCmd(['init', '-b', 'main'], dir)
}

test('archives only the automationsDir subtree of a larger git repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-git-'))
  const examples = path.join(root, 'examples')
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true })
  fs.mkdirSync(examples)
  fs.writeFileSync(path.join(root, 'plugin', 'index.js'), 'module.exports = {}\n')
  fs.writeFileSync(
    path.join(examples, 'automations.yaml'),
    ['automations:', '  - id: keep_me', '    trigger: []', '    action: []', ''].join('\n')
  )
  initRepo(root)
  gitCmd(['add', '.'], root)
  gitCmd(['commit', '-m', 'plugin plus examples'], root)
  const sha = gitCmd(['rev-parse', 'HEAD'], root)

  assert.equal(git.archiveTreeish(examples, sha), sha + ':examples')

  const dest = path.join(root, 'out-live')
  git.materializeCommit(examples, sha, dest)
  assert.equal(fs.existsSync(path.join(dest, 'automations.yaml')), true)
  assert.equal(fs.existsSync(path.join(dest, 'plugin')), false)
  assert.equal(fs.existsSync(path.join(dest, 'index.js')), false)
})

test('diffRange is only the automationsDir subtree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-diff-'))
  const examples = path.join(root, 'examples')
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true })
  fs.mkdirSync(examples)
  fs.writeFileSync(path.join(root, 'plugin', 'index.js'), 'one\n')
  fs.writeFileSync(path.join(examples, 'a.yaml'), 'automations:\n  - id: keep_me\n')
  initRepo(root)
  gitCmd(['add', '.'], root)
  gitCmd(['commit', '-m', 'first'], root)
  const a = gitCmd(['rev-parse', 'HEAD'], root)
  fs.writeFileSync(path.join(root, 'plugin', 'index.js'), 'two\n')
  fs.writeFileSync(path.join(examples, 'a.yaml'), 'automations:\n  - id: other\n')
  gitCmd(['add', '.'], root)
  gitCmd(['commit', '-m', 'second'], root)
  const b = gitCmd(['rev-parse', 'HEAD'], root)
  const d = git.diffRange(examples, a, b)
  assert.match(d.diff, /id: other/)
  assert.doesNotMatch(d.diff, /plugin\/index/)
})

test('repo paths still match when reached through a tmpdir symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-git-real-'))
  const examples = path.join(root, 'examples')
  fs.mkdirSync(examples)
  fs.writeFileSync(
    path.join(examples, 'automations.yaml'),
    ['automations:', '  - id: keep_me', '    trigger: []', '    action: []', ''].join('\n')
  )
  initRepo(root)
  gitCmd(['add', '.'], root)
  gitCmd(['commit', '-m', 'yaml'], root)
  const sha = gitCmd(['rev-parse', 'HEAD'], root)
  const link = root + '-link'
  try {
    fs.symlinkSync(root, link, 'dir')
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return
    throw err
  }
  const viaLink = path.join(link, 'examples')
  assert.equal(git.archiveTreeish(viaLink, sha), sha + ':examples')
  const d = git.diffRange(viaLink, sha, sha)
  assert.equal(d.diff, '')
})
