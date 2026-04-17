const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const {
  handleSessionEnd,
  handleSessionStart,
  getAncestors,
  savePending,
  collectPending,
  cleanupConsumed,
  cleanupStale,
  readChain,
  readWatermark,
  saveWatermark,
  resolveParentCommit,
  breadcrumbDir,
  chainDir,
  pendingDir,
  watermarkDir,
  BREADCRUMB_THRESHOLD_MS
} = require('../lib/session')

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-'))
  execSync('git init -q', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  execSync('git commit --allow-empty -q -m init', { cwd: dir, stdio: 'pipe' })
  return dir
}

function tmpWorktree (mainRoot, branch) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-wt-'))
  fs.rmdirSync(wt)
  execSync(`git worktree add -q -b ${branch} "${wt}"`, { cwd: mainRoot, stdio: 'pipe' })
  return wt
}

describe('worktree support', () => {
  it('writes breadcrumbs and watermarks under the main repo common git dir', () => {
    const main = tmpRoot()
    const wt = tmpWorktree(main, 'feature-wt')

    handleSessionEnd(JSON.stringify({ session_id: 'W1' }), wt)
    saveWatermark(wt, 'W1', 2, 'deadbeef')

    const mainResolved = fs.realpathSync(main)
    const expectedBreadcrumb = path.join(mainResolved, '.git', 'turbocommit', 'breadcrumbs', 'W1.json')
    const expectedWatermark = path.join(mainResolved, '.git', 'turbocommit', 'watermarks', 'W1.json')
    assert.ok(fs.existsSync(expectedBreadcrumb), `breadcrumb should land in main .git: ${expectedBreadcrumb}`)
    assert.ok(fs.existsSync(expectedWatermark), `watermark should land in main .git: ${expectedWatermark}`)

    // And worktree + main resolve to same state, so a session started in main
    // can see the breadcrumb dropped in the worktree.
    assert.equal(fs.realpathSync(breadcrumbDir(main)), fs.realpathSync(breadcrumbDir(wt)))
  })
})

describe('handleSessionEnd', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('writes breadcrumb file', () => {
    handleSessionEnd(JSON.stringify({ session_id: 'A' }), root)
    const file = path.join(breadcrumbDir(root), 'A.json')
    assert.ok(fs.existsSync(file))
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(data.session_id, 'A')
    assert.equal(typeof data.timestamp, 'number')
  })

  it('does nothing without session_id', () => {
    handleSessionEnd(JSON.stringify({}), root)
    try {
      const files = fs.readdirSync(breadcrumbDir(root))
      assert.equal(files.length, 0)
    } catch {
      // Dir doesn't exist — that's fine
    }
  })

  it('does nothing with invalid JSON', () => {
    handleSessionEnd('not json', root)
    // No crash
  })

  it('does nothing without root', () => {
    handleSessionEnd(JSON.stringify({ session_id: 'A' }), null)
    // No crash
  })
})

describe('handleSessionStart', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('matches closest breadcrumb within threshold', () => {
    // Write a breadcrumb with recent timestamp
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Breadcrumb should be claimed (deleted)
    assert.ok(!fs.existsSync(path.join(dir, 'A.json')))

    // Chain should exist
    const chain = readChain(root, 'B')
    assert.ok(chain)
    assert.equal(chain.parent, 'A')
    assert.deepEqual(chain.ancestors, ['A'])
  })

  it('ignores breadcrumbs older than threshold', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'OLD.json'),
      JSON.stringify({ session_id: 'OLD', timestamp: Date.now() - BREADCRUMB_THRESHOLD_MS - 1000 })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Breadcrumb should NOT be claimed
    assert.ok(fs.existsSync(path.join(dir, 'OLD.json')))
    // No chain should exist
    assert.equal(readChain(root, 'B'), null)
  })

  it('ignores non-clear/resume sources', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'startup' }), root)
    // Breadcrumb should still exist
    assert.ok(fs.existsSync(path.join(dir, 'A.json')))
  })

  it('handles resume source', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'resume' }), root)
    const chain = readChain(root, 'B')
    assert.ok(chain)
    assert.equal(chain.parent, 'A')
  })

  it('matches closest breadcrumb when two are within threshold', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    // Two breadcrumbs: X ended 500ms ago, Y ended 200ms ago
    fs.writeFileSync(
      path.join(dir, 'X.json'),
      JSON.stringify({ session_id: 'X', timestamp: now - 500 })
    )
    fs.writeFileSync(
      path.join(dir, 'Y.json'),
      JSON.stringify({ session_id: 'Y', timestamp: now - 200 })
    )

    handleSessionStart(JSON.stringify({ session_id: 'Z', source: 'clear' }), root)

    // Y is closer → claimed (deleted), X remains
    assert.ok(!fs.existsSync(path.join(dir, 'Y.json')), 'closest breadcrumb (Y) should be claimed')
    assert.ok(fs.existsSync(path.join(dir, 'X.json')), 'farther breadcrumb (X) should remain')

    const chain = readChain(root, 'Z')
    assert.ok(chain)
    assert.equal(chain.parent, 'Y')
  })

  it('links chains transitively: B→A, then C→B gives ancestors [B, A]', () => {
    // Create chain A (standalone, no chain file)
    // Create breadcrumb A and start B
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    fs.writeFileSync(
      path.join(bDir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )
    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Now end B and start C
    fs.writeFileSync(
      path.join(bDir, 'B.json'),
      JSON.stringify({ session_id: 'B', timestamp: Date.now() })
    )
    handleSessionStart(JSON.stringify({ session_id: 'C', source: 'clear' }), root)

    const chain = readChain(root, 'C')
    assert.ok(chain)
    assert.equal(chain.parent, 'B')
    assert.deepEqual(chain.ancestors, ['B', 'A'])
  })
})

describe('getAncestors', () => {
  it('returns empty array when no chain exists', () => {
    const root = tmpRoot()
    assert.deepEqual(getAncestors(root, 'X'), [])
  })

  it('returns ancestor list from chain', () => {
    const root = tmpRoot()
    const dir = chainDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'C.json'),
      JSON.stringify({ parent: 'B', ancestors: ['B', 'A'] })
    )
    assert.deepEqual(getAncestors(root, 'C'), ['B', 'A'])
  })
})

describe('savePending / collectPending', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('saves and collects pending transcript', () => {
    savePending(root, 'A', 'transcript A')
    const result = collectPending(root, ['A'])
    assert.deepEqual(result, ['transcript A'])
  })

  it('collects from multiple sessions in order', () => {
    savePending(root, 'A', 'transcript A')
    savePending(root, 'B', 'transcript B')
    // Oldest ancestor first
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, ['transcript A', 'transcript B'])
  })

  it('collects multiple pending from same session in order', () => {
    savePending(root, 'A', 'turn 1')
    // Slight delay to ensure different timestamps
    savePending(root, 'A', 'turn 2')
    const result = collectPending(root, ['A'])
    assert.equal(result.length, 2)
    assert.equal(result[0], 'turn 1')
    assert.equal(result[1], 'turn 2')
  })

  it('skips sessions with no pending', () => {
    savePending(root, 'B', 'transcript B')
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, ['transcript B'])
  })

  it('returns empty for no pending at all', () => {
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, [])
  })
})

describe('cleanupConsumed', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('deletes pending dir but preserves chain files', () => {
    savePending(root, 'A', 'transcript A')
    const cDir = chainDir(root)
    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, 'B.json'), JSON.stringify({ parent: 'A', ancestors: ['A'] }))

    cleanupConsumed(root, ['A', 'B'])

    // Pending dir should be gone
    assert.ok(!fs.existsSync(path.join(pendingDir(root), 'A')))
    // Chain file should survive (needed for resolveParentCommit)
    assert.ok(fs.existsSync(path.join(cDir, 'B.json')))
  })

  it('does not crash on missing files', () => {
    cleanupConsumed(root, ['X', 'Y'])
    // No crash
  })
})

describe('cleanupStale', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('removes files older than TTL', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'old.json')
    fs.writeFileSync(file, '{}')
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(file, twoDaysAgo, twoDaysAgo)

    cleanupStale(root)

    assert.ok(!fs.existsSync(file))
  })

  it('preserves files within TTL', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'recent.json')
    fs.writeFileSync(file, '{}')

    cleanupStale(root)

    assert.ok(fs.existsSync(file))
  })

  it('removes stale pending directories', () => {
    const pDir = path.join(pendingDir(root), 'stale-sess')
    fs.mkdirSync(pDir, { recursive: true })
    fs.writeFileSync(path.join(pDir, '001.txt'), 'old data')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(pDir, twoDaysAgo, twoDaysAgo)

    cleanupStale(root)

    assert.ok(!fs.existsSync(pDir))
  })

  it('does not crash when directories do not exist', () => {
    cleanupStale(root)
    // No crash
  })

  it('respects custom maxAgeMs', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'test.json')
    fs.writeFileSync(file, '{}')
    // Set mtime to 1 second ago
    const oneSecAgo = new Date(Date.now() - 1000)
    fs.utimesSync(file, oneSecAgo, oneSecAgo)

    // With a 500ms TTL, the file should be removed
    cleanupStale(root, 500)
    assert.ok(!fs.existsSync(file))
  })

  it('removes stale watermark files', () => {
    const wDir = watermarkDir(root)
    fs.mkdirSync(wDir, { recursive: true })
    const file = path.join(wDir, 'old-session.json')
    fs.writeFileSync(file, JSON.stringify({ pairs: 5, commit: 'abc123' }))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(file, twoDaysAgo, twoDaysAgo)

    cleanupStale(root)

    assert.ok(!fs.existsSync(file))
  })
})

describe('readWatermark / saveWatermark', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('returns null when no watermark exists', () => {
    assert.equal(readWatermark(root, 'X'), null)
  })

  it('saves and reads a watermark', () => {
    saveWatermark(root, 'S1', 5, 'abc123def456')
    const wm = readWatermark(root, 'S1')
    assert.deepEqual(wm, { pairs: 5, commit: 'abc123def456' })
  })

  it('overwrites watermark on second save', () => {
    saveWatermark(root, 'S1', 3, 'first')
    saveWatermark(root, 'S1', 7, 'second')
    const wm = readWatermark(root, 'S1')
    assert.equal(wm.pairs, 7)
    assert.equal(wm.commit, 'second')
  })
})

describe('resolveParentCommit', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('returns null when no watermark or chain exists', () => {
    assert.equal(resolveParentCommit(root, 'X'), null)
  })

  it('returns own watermark commit (same-session)', () => {
    saveWatermark(root, 'S1', 5, 'own-sha')
    assert.equal(resolveParentCommit(root, 'S1'), 'own-sha')
  })

  it('walks chain ancestors when own watermark is absent', () => {
    // A committed, B chains from A
    saveWatermark(root, 'A', 3, 'ancestor-sha')
    const cDir = chainDir(root)
    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, 'B.json'), JSON.stringify({ parent: 'A', ancestors: ['A'] }))

    assert.equal(resolveParentCommit(root, 'B'), 'ancestor-sha')
  })

  it('prefers nearest ancestor watermark', () => {
    // Chain: C → B → A, both A and B have watermarks
    saveWatermark(root, 'A', 2, 'old-sha')
    saveWatermark(root, 'B', 4, 'recent-sha')
    const cDir = chainDir(root)
    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, 'C.json'), JSON.stringify({ parent: 'B', ancestors: ['B', 'A'] }))

    // B is nearer, so its watermark should win
    assert.equal(resolveParentCommit(root, 'C'), 'recent-sha')
  })

  it('prefers own watermark over ancestor', () => {
    saveWatermark(root, 'A', 2, 'ancestor-sha')
    saveWatermark(root, 'B', 5, 'own-sha')
    const cDir = chainDir(root)
    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, 'B.json'), JSON.stringify({ parent: 'A', ancestors: ['A'] }))

    assert.equal(resolveParentCommit(root, 'B'), 'own-sha')
  })
})
