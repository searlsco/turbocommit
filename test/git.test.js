const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const {
  gitRoot, hasChanges, addAndCommit, hasCommits, currentBranch, pushClean
} = require('../lib/git')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  return dir
}

function makeRepoWithCommit () {
  const dir = makeRepo()
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello')
  execSync('git add -A && git commit -m "Initial commit"', { cwd: dir, stdio: 'pipe' })
  return dir
}

describe('gitRoot', () => {
  it('returns root for a git repo', () => {
    const dir = makeRepo()
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolved = fs.realpathSync(dir)
    assert.equal(gitRoot(dir), resolved)
  })

  it('returns null for non-repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-'))
    assert.equal(gitRoot(dir), null)
  })
})

describe('hasChanges', () => {
  it('returns false for clean repo', () => {
    const dir = makeRepoWithCommit()
    assert.equal(hasChanges(dir), false)
  })

  it('returns true for unstaged changes', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'README.md'), 'modified')
    assert.equal(hasChanges(dir), true)
  })

  it('returns true for untracked files', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new file')
    assert.equal(hasChanges(dir), true)
  })
})

describe('hasCommits', () => {
  it('returns false for empty repo', () => {
    const dir = makeRepo()
    assert.equal(hasCommits(dir), false)
  })

  it('returns true after a commit', () => {
    const dir = makeRepoWithCommit()
    assert.equal(hasCommits(dir), true)
  })
})

describe('addAndCommit', () => {
  it('commits file changes', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'content')
    addAndCommit(dir, 'added file', 'body text')
    const subject = execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(subject, 'added file')
    // Verify the file is committed
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(status, '')
  })

  it('returns 40-char hex SHA matching HEAD', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'content')
    const sha = addAndCommit(dir, 'test commit', 'body')
    assert.match(sha, /^[0-9a-f]{40}$/)
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(sha, head)
  })
})

describe('currentBranch', () => {
  it('returns branch name for a repo on a branch', () => {
    const dir = makeRepoWithCommit()
    const branch = currentBranch(dir)
    // Default branch is typically main or master
    assert.ok(branch === 'main' || branch === 'master', `expected main or master, got ${branch}`)
  })

  it('returns HEAD for detached HEAD', () => {
    const dir = makeRepoWithCommit()
    const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    execSync(`git checkout ${sha}`, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    assert.equal(currentBranch(dir), 'HEAD')
  })

  it('returns HEAD for non-repo directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-'))
    assert.equal(currentBranch(dir), 'HEAD')
  })
})

function makeRepoWithRemote () {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bare-'))
  execSync('git init --bare', { cwd: bare, stdio: 'pipe' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clone-'))
  execSync(`git clone ${bare} .`, { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial" && git push', { cwd: dir, stdio: 'pipe' })
  return { dir, bare }
}

describe('pushClean', () => {
  it('returns true and pushes on clean fast-forward', () => {
    const { dir, bare } = makeRepoWithRemote()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'content')
    execSync('git add -A && git commit -m "local commit"', { cwd: dir, stdio: 'pipe' })
    assert.equal(pushClean(dir), true)
    const localHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    const remoteHead = execSync('git rev-parse HEAD', { cwd: bare, encoding: 'utf8' }).trim()
    assert.equal(localHead, remoteHead)
  })

  it('returns false when remote is ahead', () => {
    const { dir, bare } = makeRepoWithRemote()
    // Simulate remote being ahead: clone a second copy, commit+push from it
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clone2-'))
    execSync(`git clone ${bare} .`, { cwd: dir2, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: dir2, stdio: 'pipe' })
    execSync('git config user.name "Test"', { cwd: dir2, stdio: 'pipe' })
    fs.writeFileSync(path.join(dir2, 'other.txt'), 'from clone2')
    execSync('git add -A && git commit -m "remote ahead" && git push', { cwd: dir2, stdio: 'pipe' })
    // Now make a local commit in the original clone (diverged)
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local change')
    execSync('git add -A && git commit -m "local commit"', { cwd: dir, stdio: 'pipe' })
    assert.equal(pushClean(dir), false)
  })

  it('returns false when no remote configured', () => {
    const dir = makeRepoWithCommit()
    assert.equal(pushClean(dir), false)
  })

  it('returns false on detached HEAD', () => {
    const { dir } = makeRepoWithRemote()
    const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    execSync(`git checkout ${sha}`, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    fs.writeFileSync(path.join(dir, 'detached.txt'), 'content')
    execSync('git add -A && git commit -m "detached"', { cwd: dir, stdio: 'pipe' })
    assert.equal(pushClean(dir), false)
  })
})
