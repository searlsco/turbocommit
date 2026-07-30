const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { handleTrack, hasTrackedModifications, cleanupTracking, extractFilePath, extractFilePaths, trackingPath } = require('../lib/track')

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
})
