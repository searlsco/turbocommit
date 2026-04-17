const { execSync } = require('child_process')
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
  git('add -A', { cwd })
  git(`commit -m "${esc(headline)}" -m "${esc(body)}" --no-verify`, { cwd })
  return git('rev-parse HEAD', { cwd })
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
  gitCommonDir,
  hasChanges,
  addAndCommit,
  hasCommits,
  currentBranch,
  pushClean
}
