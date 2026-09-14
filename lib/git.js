'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function runGit (args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim()
    throw new Error('git ' + args.join(' ') + ' failed: ' + err)
  }
  return (r.stdout || '').trim()
}

function isGitRepo (dir) {
  if (!dir || !fs.existsSync(dir)) return false
  try {
    runGit(['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch (_) {
    return false
  }
}

function listCommits (dir, limit) {
  if (!isGitRepo(dir)) return []
  const n = limit > 0 ? limit : 30
  const out = runGit(
    ['log', '-n', String(n), '--pretty=format:%H%x09%cI%x09%s'],
    dir
  )
  if (!out) return []
  return out.split('\n').map((line) => {
    const [sha, date, ...rest] = line.split('\t')
    return { sha, date, subject: rest.join('\t') }
  })
}

function currentSha (dir) {
  if (!isGitRepo(dir)) return null
  try {
    return runGit(['rev-parse', 'HEAD'], dir)
  } catch (_) {
    return null
  }
}

function materializeCommit (repoDir, sha, destDir) {
  if (!sha) throw new Error('Commit sha is required')
  if (!isGitRepo(repoDir)) throw new Error('automationsDir is not a git repository')
  runGit(['cat-file', '-t', sha], repoDir)
  const parent = path.dirname(path.resolve(destDir))
  fs.mkdirSync(parent, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(parent, 'live-tmp-'))
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', sha], {
      cwd: repoDir,
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024
    })
    if (archive.status !== 0) {
      throw new Error(
        'git archive failed: ' + String(archive.stderr || archive.stdout || '')
      )
    }
    const tar = spawnSync('tar', ['-x', '-C', tmp], {
      input: archive.stdout,
      encoding: 'buffer'
    })
    if (tar.status !== 0) {
      throw new Error('tar extract failed: ' + String(tar.stderr || ''))
    }
    const bak = destDir + '.bak'
    if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true })
    if (fs.existsSync(destDir)) fs.renameSync(destDir, bak)
    try {
      fs.renameSync(tmp, destDir)
      if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true })
    } catch (err) {
      if (fs.existsSync(bak) && !fs.existsSync(destDir)) {
        fs.renameSync(bak, destDir)
      }
      throw err
    }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
  }
  return destDir
}

module.exports = { runGit, isGitRepo, listCommits, currentSha, materializeCommit }
