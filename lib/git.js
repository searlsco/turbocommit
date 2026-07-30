const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function git (args, opts = {}) {
  const cwd = opts.cwd || process.cwd()
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trimEnd()
}

function gitRoot (cwd) {
  try {
    return git('rev-parse --show-toplevel', { cwd })
  } catch {
    return null
  }
}

function gitRootForPath (filePath) {
  let probe = filePath
  try {
    if (!fs.statSync(probe).isDirectory()) probe = path.dirname(probe)
  } catch {
    probe = path.dirname(probe)
  }
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  return gitRoot(probe)
}

function gitCommonDir (cwd) {
  try {
    const out = git('rev-parse --git-common-dir', { cwd })
    if (!out) return null
    return path.isAbsolute(out) ? out : path.resolve(cwd, out)
  } catch {
    return null
  }
}

function hasChanges (cwd) {
  try {
    git('diff --quiet HEAD', { cwd })
  } catch {
    return true
  }
  try {
    git('diff --cached --quiet', { cwd })
  } catch {
    return true
  }
  // Also check for untracked files
  const untracked = git('ls-files --others --exclude-standard', { cwd })
  return untracked.length > 0
}

function addAndCommit (cwd, headline, body) {
  stageAll(cwd)
  commitStaged(cwd, headline, body)
  return git('rev-parse HEAD', { cwd })
}

function stageAll (cwd) {
  git('add -A', { cwd })
}

function commitStaged (cwd, headline, body) {
  git(`commit -m "${esc(headline)}" -m "${esc(body)}" --no-verify`, { cwd })
  return git('rev-parse HEAD', { cwd })
}

function stagedChangeContext (cwd, budget = 20000) {
  const status = git('status --short', { cwd })
  const stat = git('diff --cached --stat', { cwd })
  const diff = git('diff --cached --no-ext-diff --unified=3', { cwd })
  const prefix = `Status:\n${status || '(clean)'}\n\nDiff stat:\n${stat || '(none)'}\n\nDiff:\n`
  const remaining = Math.max(0, budget - prefix.length)
  return prefix + (diff.length > remaining ? diff.slice(0, remaining) + '\n[... diff truncated ...]' : diff)
}

function isGitlink (parentRoot, childRoot) {
  const relative = path.relative(parentRoot, childRoot)
  if (!relative || relative.startsWith('..')) return false
  try {
    return git(`ls-files --stage -- "${esc(relative)}"`, { cwd: parentRoot })
      .split('\n')
      .some(line => line.startsWith('160000 '))
  } catch {
    return false
  }
}

function hasCommits (cwd) {
  try {
    git('rev-parse HEAD', { cwd })
    return true
  } catch {
    return false
  }
}

function currentBranch (cwd) {
  try {
    return git('branch --show-current', { cwd }) || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

function pushClean (cwd) {
  try {
    git('push', { cwd })
    return true
  } catch {
    return false
  }
}

function esc (s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

module.exports = {
  git,
  gitRoot,
  gitRootForPath,
  gitCommonDir,
  hasChanges,
  addAndCommit,
  stageAll,
  commitStaged,
  stagedChangeContext,
  hasCommits,
  currentBranch,
  pushClean,
  isGitlink
}
