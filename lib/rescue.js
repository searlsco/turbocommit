const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { gitCommonDir } = require('./git')
const { ensureDir } = require('./io')

function createSessionEndRescue (root, hookInput) {
  const gitDir = gitCommonDir(root)
  if (!gitDir || !hookInput?.sessionId) return null
  const id = crypto.randomUUID()
  const ref = `refs/turbocommit/session-end-rescues/${id}`
  const stateDir = path.join(gitDir, 'turbocommit', 'session-end-rescues')
  const index = path.join(stateDir, `${id}.index`)
  const recordPath = path.join(stateDir, `${id}.json`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  let checkoutIdentity
  try {
    ensureDir(stateDir)
    const rawIndex = gitOutput(root, ['rev-parse', '--git-path', 'index'])
    const realIndex = path.isAbsolute(rawIndex) ? rawIndex : path.resolve(root, rawIndex)
    if (realIndex && fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, index)
    } else {
      gitOutput(root, ['read-tree', 'HEAD'], { env })
    }
    gitOutput(root, ['add', '-A'], { env })
    const tree = gitOutput(root, ['write-tree'], { env })
    const head = gitOutput(root, ['rev-parse', 'HEAD'])
    const branch = gitOutput(root, ['branch', '--show-current'])
    const commit = gitOutput(root, ['commit-tree', tree, '-p', head, '-m', 'turbocommit SessionEnd rescue'])
    gitOutput(root, ['update-ref', ref, commit, '0'.repeat(commit.length)])
    checkoutIdentity = createCheckoutIdentity(root, id)
    if (!checkoutIdentity) throw new Error('Could not identify rescued checkout')
    const rescue = {
      id,
      ref,
      commit,
      head,
      branch: branch || null,
      root,
      gitDir,
      checkoutIdentity,
      recordPath,
      hookInput
    }
    writeRecord(recordPath, rescue)
    return rescue
  } catch {
    try { gitOutput(root, ['update-ref', '-d', ref]) } catch {}
    cleanupCheckoutIdentity(checkoutIdentity)
    try { fs.unlinkSync(recordPath) } catch {}
    return null
  } finally {
    try { fs.unlinkSync(index) } catch {}
  }
}

function restoreSessionEndRescue (rescue) {
  if (!rescue?.gitDir || !rescue.root || !rescue.commit) return false
  if (fs.existsSync(rescue.root)) return false
  let created = false
  try {
    ensureDir(path.dirname(rescue.root))
    const args = ['--git-dir', rescue.gitDir, 'worktree', 'add', '--force', '--detach', rescue.root, rescue.head]
    execFileSync('git', args, { cwd: stableGitCwd(rescue.gitDir), stdio: 'ignore' })
    created = true
    gitOutput(rescue.root, ['restore', '--source', rescue.commit, '--worktree', '--', '.'])
    return true
  } catch {
    if (created) removeSessionEndRescueWorktree(rescue)
    return false
  }
}

function matchesSessionEndRescueRoot (rescue, root) {
  if (!rescue?.checkoutIdentity || !root) return false
  try {
    if (canonicalExistingPath(gitCommonDir(root)) !== canonicalExistingPath(rescue.gitDir)) return false
    if (gitOutput(root, ['rev-parse', 'HEAD']) !== rescue.head) return false
    if ((gitOutput(root, ['branch', '--show-current']) || null) !== rescue.branch) return false
    return sameCheckoutIdentity(readCheckoutIdentity(root), rescue.checkoutIdentity) &&
      hasCheckoutIdentityMarker(rescue.checkoutIdentity)
  } catch {
    return false
  }
}

function finalizeRestoredSessionEndRescue (rescue, { clean = false } = {}) {
  const recovered = preserveSessionEndRecoveredCommit(rescue, rescue.root)
  if (!recovered) return { resolved: false, preserved: false }
  const { recoveredCommit, recoveredRef } = recovered

  if (!clean) {
    recordPreservedSessionEndRescue(rescue, recovered, 'dirty-recovery-worktree')
    return { resolved: false, preserved: true, recoveredCommit, recoveredRef, removeWorktree: false }
  }

  if (!rescue.branch) {
    recordPreservedSessionEndRescue(rescue, recovered, 'detached-recovered')
    return { resolved: false, preserved: true, recoveredCommit, recoveredRef, removeWorktree: true }
  }

  if (!removeSessionEndRescueWorktree(rescue)) {
    recordPreservedSessionEndRescue(rescue, recovered, 'restore-worktree-removal-failed')
    return { resolved: false, preserved: true, recoveredCommit, recoveredRef, removeWorktree: false }
  }

  let attached = false
  try {
    execFileSync('git', ['--git-dir', rescue.gitDir, 'worktree', 'add', rescue.root, rescue.branch], {
      cwd: stableGitCwd(rescue.gitDir),
      stdio: 'ignore'
    })
    attached = true
    if (gitOutput(rescue.root, ['rev-parse', 'HEAD']) !== rescue.head) throw new Error('Branch advanced')
    if (gitOutput(rescue.root, ['branch', '--show-current']) !== rescue.branch) throw new Error('Wrong branch')
    if (!isClean(rescue.root)) throw new Error('Attached worktree is dirty')
    gitOutput(rescue.root, ['merge', '--ff-only', recoveredRef])
    if (gitOutput(rescue.root, ['rev-parse', 'HEAD']) !== recoveredCommit) throw new Error('Branch did not advance')
    return { resolved: true, preserved: true, recoveredCommit, recoveredRef, attached: true }
  } catch {
    if (attached) removeSessionEndRescueWorktree(rescue)
    const status = branchAtCapturedHead(rescue) ? 'branch-unavailable' : 'branch-advanced'
    recordPreservedSessionEndRescue(rescue, recovered, status)
    return { resolved: false, preserved: true, recoveredCommit, recoveredRef, removeWorktree: false }
  }
}

function recordPreservedSessionEndRescue (rescue, recovered, status) {
  try {
    writeRecord(rescue.recordPath, {
      ...rescue,
      ...recovered,
      status
    })
  } catch {}
}

function branchAtCapturedHead (rescue) {
  if (!rescue?.branch || !rescue.gitDir || !rescue.head) return false
  try {
    return gitOutput(stableGitCwd(rescue.gitDir), [
      '--git-dir', rescue.gitDir, 'rev-parse', '--verify', `refs/heads/${rescue.branch}`
    ]) === rescue.head
  } catch {
    return false
  }
}

function preserveSessionEndRecoveredCommit (rescue, root) {
  if (!rescue?.gitDir || !rescue.id || !root) return null
  try {
    const recoveredCommit = gitOutput(root, ['rev-parse', 'HEAD'])
    const recoveredRef = `refs/turbocommit/session-end-recovered/${rescue.id}`
    let current = null
    try {
      current = gitOutput(stableGitCwd(rescue.gitDir), [
        '--git-dir', rescue.gitDir, 'rev-parse', '--verify', recoveredRef
      ])
    } catch {}
    if (current && current !== recoveredCommit) return null
    if (!current) {
      execFileSync('git', [
        '--git-dir', rescue.gitDir,
        'update-ref', recoveredRef, recoveredCommit, '0'.repeat(recoveredCommit.length)
      ], {
        cwd: stableGitCwd(rescue.gitDir),
        stdio: 'ignore'
      })
    }
    return { recoveredCommit, recoveredRef }
  } catch {
    return null
  }
}

function removeSessionEndRescueWorktree (rescue, { force = false } = {}) {
  if (!rescue?.gitDir || !rescue.root) return false
  try {
    const args = ['--git-dir', rescue.gitDir, 'worktree', 'remove']
    if (force) args.push('--force')
    args.push(rescue.root)
    execFileSync('git', args, {
      cwd: stableGitCwd(rescue.gitDir),
      stdio: 'ignore'
    })
  } catch {}
  return !fs.existsSync(rescue.root)
}

function cleanupSessionEndRescue (rescue, { removeWorktree = false } = {}) {
  if (!rescue) return false
  if (removeWorktree && !removeSessionEndRescueWorktree(rescue)) return false
  if (rescue.gitDir && rescue.ref && rescue.commit) {
    try {
      execFileSync('git', ['--git-dir', rescue.gitDir, 'update-ref', '-d', rescue.ref, rescue.commit], {
        cwd: stableGitCwd(rescue.gitDir),
        stdio: 'ignore'
      })
    } catch {}
  }
  cleanupCheckoutIdentity(rescue.checkoutIdentity)
  try { fs.unlinkSync(rescue.recordPath) } catch {}
  return true
}

function isClean (root) {
  try {
    return gitOutput(root, ['status', '--porcelain']) === ''
  } catch {
    return false
  }
}

function writeRecord (file, rescue) {
  const temporary = file + `.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(rescue) + '\n')
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function readCheckoutIdentity (root) {
  try {
    const rootStat = fs.statSync(root, { bigint: true })
    const rawGitDir = gitOutput(root, ['rev-parse', '--git-dir'])
    const worktreeGitDir = canonicalExistingPath(path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(root, rawGitDir))
    const gitDirStat = fs.statSync(worktreeGitDir, { bigint: true })
    return {
      rootDevice: rootStat.dev.toString(),
      rootInode: rootStat.ino.toString(),
      worktreeGitDir,
      gitDirDevice: gitDirStat.dev.toString(),
      gitDirInode: gitDirStat.ino.toString()
    }
  } catch {
    return null
  }
}

function createCheckoutIdentity (root, id) {
  const identity = readCheckoutIdentity(root)
  if (!identity) return null
  const markerDir = path.join(identity.worktreeGitDir, 'turbocommit-rescue-identities')
  const markerPath = path.join(markerDir, `${id}.marker`)
  const markerToken = crypto.randomUUID()
  ensureDir(markerDir)
  fs.writeFileSync(markerPath, markerToken + '\n', { flag: 'wx' })
  return { ...identity, markerPath, markerToken }
}

function hasCheckoutIdentityMarker (identity) {
  if (!identity?.markerPath || !identity.markerToken) return false
  try {
    return fs.readFileSync(identity.markerPath, 'utf8').trim() === identity.markerToken
  } catch {
    return false
  }
}

function cleanupCheckoutIdentity (identity) {
  if (!identity?.markerPath) return
  try { fs.unlinkSync(identity.markerPath) } catch {}
  try { fs.rmdirSync(path.dirname(identity.markerPath)) } catch {}
}

function sameCheckoutIdentity (actual, expected) {
  if (!actual || !expected) return false
  return actual.rootDevice === expected.rootDevice &&
    actual.rootInode === expected.rootInode &&
    actual.worktreeGitDir === expected.worktreeGitDir &&
    actual.gitDirDevice === expected.gitDirDevice &&
    actual.gitDirInode === expected.gitDirInode
}

function canonicalExistingPath (filePath) {
  return fs.realpathSync(path.resolve(filePath))
}

function gitOutput (cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    env: opts.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function stableGitCwd (gitDir) {
  const parent = path.dirname(gitDir)
  return fs.existsSync(parent) ? parent : os.tmpdir()
}

module.exports = {
  createSessionEndRescue,
  restoreSessionEndRescue,
  matchesSessionEndRescueRoot,
  finalizeRestoredSessionEndRescue,
  preserveSessionEndRecoveredCommit,
  recordPreservedSessionEndRescue,
  removeSessionEndRescueWorktree,
  cleanupSessionEndRescue,
  isClean
}
