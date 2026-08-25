const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync, execSync, spawn } = require('child_process')
const {
  handleTrack,
  handlePostTrack,
  finalizeBashSnapshots,
  pruneBashSnapshots,
  recordBashSessionStop,
  readReadyBashOverlaps,
  readBashOverlapEvents,
  readBashSessionStops,
  compactBashOverlapEvents,
  resolveBashOverlap,
  acquireBashOverlapRecoveryLock,
  bashOverlapRecoveryLockRef,
  bashSnapshotPath,
  fingerprintTrackedPath,
  hasActiveBashSnapshot,
  hasTrackedModifications,
  cleanupTracking,
  extractFilePath,
  extractFilePaths,
  trackingPath
} = require('../lib/track')

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-track-'))
  execSync('git init -q', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  execSync('git commit --allow-empty -q -m init', { cwd: dir, stdio: 'pipe' })
  return dir
}

function tmpWorktree (mainRoot, branch) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-track-wt-'))
  // Remove the empty dir so `git worktree add` can recreate it
  fs.rmdirSync(wt)
  execSync(`git worktree add -q -b ${branch} "${wt}"`, { cwd: mainRoot, stdio: 'pipe' })
  return wt
}

function makeInput (overrides) {
  return JSON.stringify({
    session_id: 'sess-1',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/foo.txt' },
    ...overrides
  })
}

function seedRecoveryLock (root, owner) {
  const ref = bashOverlapRecoveryLockRef(root)
  const token = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    input: typeof owner === 'string' ? owner : JSON.stringify(owner),
    encoding: 'utf8'
  }).trim()
  execFileSync('git', ['update-ref', ref, token], { cwd: root })
}

function readTracking (root, sessionId) {
  const file = trackingPath(root, sessionId)
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  } catch {
    return []
  }
}

describe('handleTrack', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('records Write tool with file_path', () => {
    handleTrack(makeInput({ tool_name: 'Write', tool_input: { file_path: '/tmp/a.txt' } }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'Write')
    assert.deepEqual(entries[0].files, ['/tmp/a.txt'])
    assert.equal(typeof entries[0].t, 'number')
  })

  it('does not promote explicit path ownership when recovery forces a denial', () => {
    const release = acquireBashOverlapRecoveryLock(root)
    assert.ok(release)
    try {
      const tracked = handleTrack(makeInput({
        tool_name: 'Write',
        tool_input: { file_path: path.join(root, 'claimed.txt') }
      }), root, { recoveryWaitMs: 1 })

      assert.equal(tracked, false)
      assert.deepEqual(readTracking(root, 'sess-1'), [])
    } finally {
      release()
    }
  })

  it('removes a pending shell snapshot when recovery forces the tool to be denied', () => {
    const release = acquireBashOverlapRecoveryLock(root)
    assert.ok(release)
    try {
      const tracked = handleTrack(makeInput({
        tool_name: 'Bash',
        tool_use_id: 'denied-bash',
        tool_input: { command: 'generate something' }
      }), root, { recoveryWaitMs: 1 })

      assert.equal(tracked, false)
      assert.equal(hasActiveBashSnapshot(root), false)
    } finally {
      release()
    }
  })

  it('does not steal an old recovery lock from a live process', () => {
    const release = acquireBashOverlapRecoveryLock(root)
    assert.ok(release)
    const stolen = acquireBashOverlapRecoveryLock(root)
    try {
      assert.equal(stolen, null)
    } finally {
      if (stolen) stolen()
      release()
    }
  })

  it('immediately reclaims a recovery lock owned by a dead process', () => {
    seedRecoveryLock(root, '2147483647:abandoned')

    const release = acquireBashOverlapRecoveryLock(root)
    assert.ok(release)
    release()
  })

  it('immediately reclaims a recovery lock after its PID is reused', () => {
    seedRecoveryLock(root, {
      pid: process.pid,
      startIdentity: 'a different process start',
      token: 'abandoned'
    })

    const release = acquireBashOverlapRecoveryLock(root)
    assert.ok(release)
    release()
  })

  it('never admits multiple owners while reclaiming one stale lock', async () => {
    seedRecoveryLock(root, '2147483647:abandoned')
    const coordination = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lock-race-'))
    const readyDir = path.join(coordination, 'ready')
    const startFile = path.join(coordination, 'start')
    const guardFile = path.join(coordination, 'guard')
    const collisionFile = path.join(coordination, 'collision')
    fs.mkdirSync(readyDir)
    const contender = `
      const fs = require('fs')
      const path = require('path')
      const { acquireBashOverlapRecoveryLock } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'track.js'))})
      const [root, readyDir, startFile, guardFile, collisionFile] = process.argv.slice(1)
      fs.writeFileSync(path.join(readyDir, String(process.pid)), '')
      const sleeper = new Int32Array(new SharedArrayBuffer(4))
      while (!fs.existsSync(startFile)) Atomics.wait(sleeper, 0, 0, 1)
      const release = acquireBashOverlapRecoveryLock(root, 5000)
      if (!release) process.exit(2)
      let guard
      try {
        try {
          guard = fs.openSync(guardFile, 'wx')
        } catch (error) {
          if (error.code === 'EEXIST') fs.writeFileSync(collisionFile, 'collision')
          else throw error
        }
        Atomics.wait(sleeper, 0, 0, 50)
      } finally {
        if (guard != null) {
          fs.closeSync(guard)
          try { fs.unlinkSync(guardFile) } catch {}
        }
        release()
      }
    `
    const children = Array.from({ length: 16 }, () => spawn(process.execPath, ['-e', contender, root, readyDir, startFile, guardFile, collisionFile], {
      stdio: 'pipe'
    }))
    const exits = children.map(child => new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`contender exited ${code}`)))
    }))
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 5000
    while (fs.readdirSync(readyDir).length < children.length && Date.now() < deadline) {
      Atomics.wait(sleeper, 0, 0, 10)
    }
    assert.equal(fs.readdirSync(readyDir).length, children.length)
    fs.writeFileSync(startFile, '')
    await Promise.all(exits)

    assert.equal(fs.existsSync(collisionFile), false)
  })

  it('records Edit tool with file_path', () => {
    handleTrack(makeInput({ tool_name: 'Edit', tool_input: { file_path: '/tmp/b.txt' } }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'Edit')
    assert.deepEqual(entries[0].files, ['/tmp/b.txt'])
  })

  it('records MCP tool and extracts file path from tool_input', () => {
    handleTrack(makeInput({
      tool_name: 'mcp__xcode__XcodeEdit',
      tool_input: { filePath: '/tmp/View.swift' }
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'mcp__xcode__XcodeEdit')
    assert.deepEqual(entries[0].files, ['/tmp/View.swift'])
  })

  it('records Bash tool with command', () => {
    handleTrack(makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'npm install' }
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'Bash')
    assert.equal(entries[0].command, 'npm install')
  })

  it('records only paths made dirty by a completed Bash tool', () => {
    const existing = path.join(root, 'existing.txt')
    fs.writeFileSync(existing, 'existing')
    execSync('git add existing.txt && git commit -q -m fixture', { cwd: root })
    fs.writeFileSync(existing, 'already dirty')

    const input = {
      sessionId: 'sess-1',
      toolUseId: 'bash-1',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate lockfile' }
    }
    handleTrack(input, root)
    const generated = path.join(root, 'package-lock.json')
    fs.writeFileSync(generated, '{}')
    handlePostTrack(input, root)

    const entries = readTracking(root, 'sess-1')
    assert.deepEqual(entries.at(-1).rawFiles, [path.join(fs.realpathSync(root), 'package-lock.json')])
    assert.equal(entries.at(-1).phase, 'post')
    assert.equal(hasTrackedModifications(root, 'sess-1'), true)
  })

  it('records a tracked file deleted by Bash', () => {
    const deleted = path.join(root, 'deleted.txt')
    fs.writeFileSync(deleted, 'delete me')
    execSync('git add deleted.txt && git commit -q -m fixture', { cwd: root })
    const input = {
      sessionId: 'sess-1',
      toolUseId: 'bash-delete',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'remove generated file' }
    }

    handleTrack(input, root)
    fs.unlinkSync(deleted)
    handlePostTrack(input, root)

    assert.deepEqual(readTracking(root, 'sess-1').at(-1).rawFiles, [
      path.join(fs.realpathSync(root), 'deleted.txt')
    ])
  })

  it('records both sides of a tracked file renamed by Bash', () => {
    const before = path.join(root, 'before.txt')
    const after = path.join(root, 'after.txt')
    fs.writeFileSync(before, 'rename me')
    execSync('git add before.txt && git commit -q -m fixture', { cwd: root })
    const input = {
      sessionId: 'sess-1',
      toolUseId: 'bash-rename',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'rename generated file' }
    }

    handleTrack(input, root)
    fs.renameSync(before, after)
    handlePostTrack(input, root)

    assert.deepEqual(readTracking(root, 'sess-1').at(-1).rawFiles.sort(), [
      path.join(fs.realpathSync(root), 'after.txt'),
      path.join(fs.realpathSync(root), 'before.txt')
    ])
  })

  it('does not attribute shell changes while another shell tool overlaps', () => {
    const a = {
      sessionId: 'session-a',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'session-b',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }

    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    handlePostTrack(b, root)

    assert.equal(hasTrackedModifications(root, 'session-a'), false)
    assert.equal(hasTrackedModifications(root, 'session-b'), false)
  })

  it('attributes overlapping shell changes to their shared session', () => {
    const a = {
      sessionId: 'shared-session',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'shared-session',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }

    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    handlePostTrack(b, root)

    const files = readTracking(root, 'shared-session')
      .flatMap(entry => entry.files || [])
      .map(file => path.basename(file))
    assert.deepEqual([...new Set(files)].sort(), ['a.txt', 'b.txt'])
  })

  it('finalizes an abandoned shell snapshot at Stop', () => {
    const input = {
      sessionId: 'abandoned-session',
      toolUseId: 'bash-abandoned',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate file before interruption' }
    }

    handleTrack(input, root)
    fs.writeFileSync(path.join(root, 'generated.txt'), 'generated')

    assert.equal(finalizeBashSnapshots(root, 'abandoned-session'), 1)
    assert.equal(hasTrackedModifications(root, 'abandoned-session'), true)
  })

  it('retires an expired unfinished shell before tracking a later shell', () => {
    const abandoned = {
      sessionId: 'expired-shell',
      toolUseId: 'bash-expired',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'never completed' }
    }
    handleTrack(abandoned, root)
    const abandonedPath = bashSnapshotPath(root, abandoned.sessionId, abandoned.toolUseId)
    const snapshot = JSON.parse(fs.readFileSync(abandonedPath, 'utf8'))
    snapshot.startedAt = Date.now() - 2 * 60 * 60 * 1000
    fs.writeFileSync(abandonedPath, JSON.stringify(snapshot) + '\n')

    const later = {
      sessionId: 'later-shell',
      toolUseId: 'bash-later',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate later file' }
    }
    handleTrack(later, root)
    fs.writeFileSync(path.join(root, 'later.txt'), 'later')
    handlePostTrack(later, root)

    assert.equal(fs.existsSync(abandonedPath), false)
    assert.equal(hasTrackedModifications(root, later.sessionId), true)
  })

  it('invalidates an overlap component that depended on an expired shell', () => {
    const a = {
      sessionId: 'expired-overlap-a',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'expired-overlap-b',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'never completed' }
    }
    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)

    const abandonedPath = bashSnapshotPath(root, b.sessionId, b.toolUseId)
    const snapshot = JSON.parse(fs.readFileSync(abandonedPath, 'utf8'))
    snapshot.startedAt = Date.now() - 2 * 60 * 60 * 1000
    fs.writeFileSync(abandonedPath, JSON.stringify(snapshot) + '\n')
    pruneBashSnapshots(root)
    recordBashSessionStop(root, a.sessionId)
    recordBashSessionStop(root, b.sessionId)

    assert.equal(fs.existsSync(abandonedPath), false)
    assert.deepEqual(readReadyBashOverlaps(root), [])
  })

  it('makes cross-session overlap recoverable only after every owner stops', () => {
    const a = {
      sessionId: 'session-a',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'session-b',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }

    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    handlePostTrack(b, root)

    recordBashSessionStop(root, 'session-a')
    assert.deepEqual(readReadyBashOverlaps(root), [])

    recordBashSessionStop(root, 'session-b')
    const ready = readReadyBashOverlaps(root)
    assert.equal(ready.length, 1)
    assert.deepEqual(ready[0].sessionIds, ['session-a', 'session-b'])
    assert.deepEqual(ready[0].paths.map(item => path.basename(item.path)).sort(), ['a.txt', 'b.txt'])
  })

  it('compacts resolved overlap events and obsolete Stop records', () => {
    const a = {
      sessionId: 'compact-a',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'compact-b',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }
    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    handlePostTrack(b, root)
    recordBashSessionStop(root, a.sessionId)
    recordBashSessionStop(root, b.sessionId)
    const ready = readReadyBashOverlaps(root)
    assert.equal(ready.length, 1)

    resolveBashOverlap(root, ready[0].eventIds)
    compactBashOverlapEvents(root)

    assert.deepEqual(readBashOverlapEvents(root), [])
    assert.deepEqual(readBashSessionStops(root), [])
  })

  it('does not retain Stop state when no overlap evidence exists', () => {
    recordBashSessionStop(root, 'no-overlap')

    assert.deepEqual(readBashSessionStops(root), [])
  })

  it('accepts a session Stop that occurs before the other overlapping shell finishes', () => {
    const a = {
      sessionId: 'early-stop-a',
      toolUseId: 'bash-a',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'late-stop-b',
      toolUseId: 'bash-b',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }

    handleTrack(a, root)
    handleTrack(b, root)
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    handlePostTrack(a, root)
    recordBashSessionStop(root, 'early-stop-a')
    const stoppedAt = Date.now()
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    while (Date.now() <= stoppedAt) Atomics.wait(sleeper, 0, 0, 1)
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    handlePostTrack(b, root)
    recordBashSessionStop(root, 'late-stop-b')

    const ready = readReadyBashOverlaps(root)
    assert.equal(ready.length, 1)
    assert.deepEqual(ready[0].sessionIds, ['early-stop-a', 'late-stop-b'])
  })

  it('scopes ready overlap evidence to its linked worktree', () => {
    const worktree = tmpWorktree(root, 'overlap-scope')
    const a = {
      sessionId: 'worktree-a',
      toolUseId: 'bash-a',
      cwd: worktree,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'worktree-b',
      toolUseId: 'bash-b',
      cwd: worktree,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }

    handleTrack(a, worktree)
    handleTrack(b, worktree)
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'a')
    handlePostTrack(a, worktree)
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'b')
    handlePostTrack(b, worktree)
    recordBashSessionStop(worktree, 'worktree-a')
    recordBashSessionStop(worktree, 'worktree-b')

    assert.equal(readReadyBashOverlaps(root).length, 0)
    assert.equal(readReadyBashOverlaps(worktree).length, 1)
  })

  it('includes executable mode in regular-file fingerprints', () => {
    const file = path.join(root, 'script.sh')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o644)
    const before = fingerprintTrackedPath(file)

    fs.chmodSync(file, 0o755)

    assert.notEqual(fingerprintTrackedPath(file), before)
  })

  it('retries snapshot completion when tracking persistence fails', () => {
    const input = {
      sessionId: 'retry-completion',
      toolUseId: 'bash-retry',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate file' }
    }
    handleTrack(input, root)
    fs.writeFileSync(path.join(root, 'generated.txt'), 'generated')
    const file = trackingPath(root, 'retry-completion')
    fs.chmodSync(file, 0o444)

    try {
      assert.throws(() => handlePostTrack(input, root))
    } finally {
      fs.chmodSync(file, 0o644)
    }

    assert.equal(finalizeBashSnapshots(root, 'retry-completion'), 1)
    assert.equal(hasTrackedModifications(root, 'retry-completion'), true)
  })

  it('does not attribute a path claimed by another session during Bash', () => {
    const bash = {
      sessionId: 'bash-session',
      toolUseId: 'bash-1',
      cwd: root,
      toolName: 'Bash',
      toolInput: { command: 'generate files' }
    }
    const claimed = path.join(root, 'claimed.txt')

    handleTrack(bash, root)
    handleTrack({
      sessionId: 'edit-session',
      cwd: root,
      toolName: 'Write',
      toolInput: { file_path: claimed }
    }, root)
    fs.writeFileSync(claimed, 'claimed by edit session')
    handlePostTrack(bash, root)

    assert.equal(hasTrackedModifications(root, 'bash-session'), false)
    assert.equal(hasTrackedModifications(root, 'edit-session'), true)
  })

  it('records MCP tool even without extractable file path', () => {
    handleTrack(makeInput({
      tool_name: 'mcp__xcode__XcodeEdit',
      tool_input: { query: 'modify something' }
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'mcp__xcode__XcodeEdit')
    assert.equal(entries[0].files, undefined)
  })

  it('records MultiEdit tool (nested file paths in edits array)', () => {
    handleTrack(makeInput({
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: '/a.txt', old_string: 'x', new_string: 'y' }] }
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].tool, 'MultiEdit')
    assert.equal(hasTrackedModifications(root, 'sess-1'), true)
  })

  it('skips Bash with no command string', () => {
    handleTrack(makeInput({
      tool_name: 'Bash',
      tool_input: {}
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 0)
  })

  it('appends multiple entries to same session', () => {
    handleTrack(makeInput({ tool_input: { file_path: '/a.txt' } }), root)
    handleTrack(makeInput({ tool_input: { file_path: '/b.txt' } }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 2)
  })

  it('does nothing with invalid JSON input', () => {
    handleTrack('not json', root)
    // No crash
  })

  it('does nothing without session_id', () => {
    handleTrack(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }), root)
    // No tracking file created (no session_id dir to check)
  })

  it('does nothing without root', () => {
    handleTrack(makeInput(), null)
    // No crash
  })

  it('extracts file from notebook_path key', () => {
    handleTrack(makeInput({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/tmp/nb.ipynb' }
    }), root)
    const entries = readTracking(root, 'sess-1')
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0].files, ['/tmp/nb.ipynb'])
  })
})

describe('hasTrackedModifications', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('returns true when tracking file has Write entries', () => {
    handleTrack(makeInput(), root)
    assert.equal(hasTrackedModifications(root, 'sess-1'), true)
  })

  it('returns false when tracking file is missing', () => {
    assert.equal(hasTrackedModifications(root, 'sess-1'), false)
  })

  it('returns false when tracking file is empty', () => {
    const file = trackingPath(root, 'sess-1')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    assert.equal(hasTrackedModifications(root, 'sess-1'), false)
  })

  it('returns false when only Bash entries exist', () => {
    handleTrack(makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'ls src/' }
    }), root)
    handleTrack(makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'git status' }
    }), root)
    assert.equal(hasTrackedModifications(root, 'sess-1'), false)
  })

  it('returns true when Bash entries exist alongside Write', () => {
    handleTrack(makeInput({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), root)
    handleTrack(makeInput({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.txt' }
    }), root)
    assert.equal(hasTrackedModifications(root, 'sess-1'), true)
  })
})

describe('cleanupTracking', () => {
  it('deletes the tracking file', () => {
    const root = tmpRoot()
    handleTrack(makeInput(), root)
    assert.equal(hasTrackedModifications(root, 'sess-1'), true)
    cleanupTracking(root, 'sess-1')
    assert.equal(hasTrackedModifications(root, 'sess-1'), false)
  })

  it('does not throw when file is missing', () => {
    const root = tmpRoot()
    cleanupTracking(root, 'nonexistent')
    // No crash
  })
})

describe('worktree support', () => {
  it('tracks modifications when invoked from a git worktree', () => {
    const main = tmpRoot()
    const wt = tmpWorktree(main, 'feature')

    handleTrack(makeInput({ tool_name: 'Write', tool_input: { file_path: '/tmp/wt.txt' } }), wt)

    assert.equal(hasTrackedModifications(wt, 'sess-1'), true, 'worktree session should record tracking')
  })

  it('stores tracking state under the main repo\'s common git dir', () => {
    const main = tmpRoot()
    const wt = tmpWorktree(main, 'feature-2')

    handleTrack(makeInput({ tool_name: 'Write', tool_input: { file_path: '/tmp/wt.txt' } }), wt)

    const mainTracking = path.join(fs.realpathSync(main), '.git', 'turbocommit', 'tracking', 'sess-1.jsonl')
    assert.ok(fs.existsSync(mainTracking), `expected tracking file at ${mainTracking}`)
  })
})

describe('extractFilePath', () => {
  it('finds file_path key', () => {
    assert.equal(extractFilePath({ file_path: '/a' }), '/a')
  })

  it('finds filePath key', () => {
    assert.equal(extractFilePath({ filePath: '/b' }), '/b')
  })

  it('finds path key', () => {
    assert.equal(extractFilePath({ path: '/c' }), '/c')
  })

  it('finds file key', () => {
    assert.equal(extractFilePath({ file: '/d' }), '/d')
  })

  it('returns null for no match', () => {
    assert.equal(extractFilePath({ query: 'hello' }), null)
  })

  it('returns null for null input', () => {
    assert.equal(extractFilePath(null), null)
  })

  it('prefers file_path over other keys', () => {
    assert.equal(extractFilePath({ file_path: '/a', path: '/b' }), '/a')
  })
})

describe('extractFilePaths', () => {
  it('extracts nested Claude MultiEdit paths', () => {
    assert.deepEqual(extractFilePaths('MultiEdit', {
      edits: [
        { file_path: '/repo-a/a.txt' },
        { file_path: '/repo-b/b.txt' }
      ]
    }), ['/repo-a/a.txt', '/repo-b/b.txt'])
  })

  it('extracts Codex apply_patch add, update, delete, and move paths', () => {
    const command = [
      '*** Begin Patch',
      '*** Add File: ../repo-b/new.txt',
      '*** Update File: src/old.txt',
      '*** Move to: src/new.txt',
      '*** Delete File: gone.txt',
      '*** End Patch'
    ].join('\n')
    assert.deepEqual(
      extractFilePaths('apply_patch', { command }, '/workspace/repo-a'),
      [
        '/workspace/repo-b/new.txt',
        '/workspace/repo-a/src/old.txt',
        '/workspace/repo-a/src/new.txt',
        '/workspace/repo-a/gone.txt'
      ]
    )
  })

  it('deduplicates recursively discovered MCP paths', () => {
    assert.deepEqual(extractFilePaths('mcp__xcode__edit', {
      filePath: '/repo/View.swift',
      edits: [{ path: '/repo/View.swift' }, { file: '/repo/Model.swift' }]
    }), ['/repo/View.swift', '/repo/Model.swift'])
  })

  it('extracts alternate singular and plural MCP path fields', () => {
    assert.deepEqual(extractFilePaths('mcp__writer__edit', {
      relative_path: 'src/a.js',
      file_paths: ['src/b.js', 'src/c.js'],
      nested: { relativePath: 'src/d.js', filePaths: ['src/e.js'] }
    }, '/repo'), [
      '/repo/src/a.js',
      '/repo/src/b.js',
      '/repo/src/c.js',
      '/repo/src/d.js',
      '/repo/src/e.js'
    ])
  })

  it('extracts local file URIs and ignores remote URIs', () => {
    assert.deepEqual(extractFilePaths('mcp__writer__edit', {
      changes: [
        { uri: 'file:///repo/src/space%20name.js' },
        { uri: 'https://example.com/not-a-file' }
      ]
    }, '/repo'), ['/repo/src/space name.js'])
  })
})
