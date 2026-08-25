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
    return canonicalRoot(git('rev-parse --show-toplevel', { cwd }))
  } catch {
    return null
  }
}

function canonicalRoot (filePath) {
  const target = path.resolve(filePath)
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return target
    probe = parent
  }
  try {
    return path.join(fs.realpathSync(probe), path.relative(probe, target))
  } catch {
    return target
  }
}

function canonicalTrackedPath (filePath) {
  const target = path.resolve(filePath)
  return path.join(canonicalRoot(path.dirname(target)), path.basename(target))
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

function gitWorktrees (cwd) {
  try {
    return git('worktree list --porcelain', { cwd })
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length))
      .map(root => {
        try {
          return fs.realpathSync(root)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
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

function hasPathChanges (cwd, filePath) {
  return changedPaths(cwd, [filePath]).length > 0
}

function addAndCommit (cwd, headline, body) {
  stageAll(cwd)
  commitStaged(cwd, headline, body)
  return git('rev-parse HEAD', { cwd })
}

function stageAll (cwd) {
  git('add -A', { cwd })
}

function stagePaths (cwd, filePaths) {
  const changed = changedPaths(cwd, filePaths)
  const paths = pathspecs(cwd, changed)
  if (paths.length === 0) return []
  git(`add -A -- ${paths.map(quote).join(' ')}`, { cwd })
  return changed
}

function commitPaths (cwd, filePaths, headline, body, opts = {}) {
  if (opts.pathScoped && hasRepositoryOperation(cwd)) return null
  const changed = stagePaths(cwd, filePaths)
  return commitStagedPaths(cwd, changed, headline, body, opts)
}

function commitStagedPaths (cwd, filePaths, headline, body, opts = {}) {
  const paths = pathspecs(cwd, filePaths)
  if (paths.length === 0) return null
  if (hasRepositoryOperation(cwd)) {
    return opts.pathScoped ? null : commitStaged(cwd, headline, body)
  }
  git(`commit --only -m "${esc(headline)}" -m "${esc(body)}" --no-verify -- ${paths.map(quote).join(' ')}`, { cwd })
  return git('rev-parse HEAD', { cwd })
}

function commitStaged (cwd, headline, body) {
  git(`commit -m "${esc(headline)}" -m "${esc(body)}" --no-verify`, { cwd })
  return git('rev-parse HEAD', { cwd })
}

function stagedChangeContext (cwd, budget = 20000, filePaths) {
  const selected = filePaths && filePaths.length > 0
    ? ` -- ${pathspecs(cwd, filePaths).map(quote).join(' ')}`
    : ''
  const status = git(`status --short${selected}`, { cwd })
  const stat = git(`diff --cached --stat${selected}`, { cwd })
  const diff = git(`diff --cached --no-ext-diff --unified=3${selected}`, { cwd })
  const prefix = `Status:\n${status || '(clean)'}\n\nDiff stat:\n${stat || '(none)'}\n\nDiff:\n`
  const remaining = Math.max(0, budget - prefix.length)
  return prefix + (diff.length > remaining ? diff.slice(0, remaining) + '\n[... diff truncated ...]' : diff)
}

function isGitlink (parentRoot, childRoot) {
  const relative = path.relative(parentRoot, childRoot)
  if (!relative || relative.startsWith('..')) return false
  try {
    return git(`ls-files --stage -- ${quote(literalPathspec(relative))}`, { cwd: parentRoot })
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

function quote (value) {
  return `'${value.replace(/'/g, '\'"\'"\'')}'`
}

function pathspecs (cwd, filePaths) {
  cwd = canonicalRoot(cwd)
  return [...new Set(filePaths.map(filePath => path.relative(cwd, canonicalTrackedPath(filePath))))]
    .filter(relative => relative && !relative.startsWith('..'))
    .map(literalPathspec)
}

function literalPathspec (relative) {
  return `:(literal)${relative}`
}

function changedPaths (cwd, filePaths) {
  cwd = canonicalRoot(cwd)
  const selected = pathspecs(cwd, filePaths)
  if (selected.length === 0) return []
  return collectChangedPaths(cwd, selected)
}

function changedPathsInRepository (cwd) {
  cwd = canonicalRoot(cwd)
  return collectChangedPaths(cwd, [])
}

function collectChangedPaths (cwd, selected) {
  const args = selected.length > 0 ? ` -- ${selected.map(quote).join(' ')}` : ''
  const tracked = hasCommits(cwd)
    ? git(`diff --name-only --no-renames -z HEAD${args}`, { cwd })
    : git(`ls-files --cached -z${args}`, { cwd })
  const untracked = git(`ls-files --others --exclude-standard -z${args}`, { cwd })
  const relativePaths = [...splitNull(tracked), ...splitNull(untracked)]
  return [...new Set(relativePaths)]
    .filter(relative => !isEmbeddedRepository(cwd, relative) || isHeadGitlink(cwd, relative))
    .map(relative => path.join(cwd, relative))
}

function splitNull (value) {
  return value ? value.split('\0').filter(Boolean) : []
}

function isEmbeddedRepository (cwd, relative) {
  const candidate = path.join(cwd, relative)
  try {
    return fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, '.git'))
  } catch {
    return false
  }
}

function isHeadGitlink (cwd, relative) {
  try {
    return git(`ls-tree HEAD -- ${quote(literalPathspec(relative))}`, { cwd })
      .split('\n')
      .some(line => line.startsWith('160000 '))
  } catch {
    return false
  }
}

function hasRepositoryOperation (cwd) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    .some(name => {
      try {
        const gitPath = git(`rev-parse --git-path ${quote(name)}`, { cwd })
        return fs.existsSync(path.isAbsolute(gitPath) ? gitPath : path.join(cwd, gitPath))
      } catch {
        return false
      }
    })
}

module.exports = {
  git,
  canonicalRoot,
  canonicalTrackedPath,
  gitRoot,
  gitRootForPath,
  gitWorktrees,
  gitCommonDir,
  hasChanges,
  changedPaths,
  changedPathsInRepository,
  hasPathChanges,
  addAndCommit,
  stageAll,
  stagePaths,
  commitPaths,
  commitStagedPaths,
  commitStaged,
  stagedChangeContext,
  hasCommits,
  currentBranch,
  pushClean,
  isGitlink,
  hasRepositoryOperation
}
