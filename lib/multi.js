const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { ensureDir, loadJson } = require('./io')
const { turbocommitDir } = require('./session')
const { canonicalRoot, canonicalTrackedPath, gitRoot, gitRootForPath, gitWorktrees, hasPathChanges, isGitlink } = require('./git')
const { activeConfig } = require('./config')

function checkoutKey (root) {
  return crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16)
}

function manifestPath (anchor) {
  return path.join(turbocommitDir(anchor), 'multi', checkoutKey(anchor), 'manifest.json')
}

function loadManifest (anchor) {
  return normalizeManifest(loadJson(manifestPath(anchor)))
}

function saveManifest (anchor, manifest) {
  const file = manifestPath(anchor)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({
    nextOrder: manifest.nextOrder,
    repos: manifest.repos
  }, null, 2) + '\n')
}

function deleteManifestIfEmpty (anchor, manifest) {
  if (manifest.repos.length > 0) {
    saveManifest(anchor, manifest)
    return
  }
  try {
    fs.unlinkSync(manifestPath(anchor))
  } catch {}
}

function trackedChangesFromEntries (anchor, entries) {
  const pathsByRoot = new Map()
  const ambiguous = []
  const add = (root, file) => {
    root = canonicalRoot(root)
    file = canonicalTrackedPath(file)
    if (!root || activeConfig(root).config.enabled !== true) return
    const relative = path.relative(root, file)
    if (!relative || relative.startsWith('..')) return
    if (!pathsByRoot.has(root)) pathsByRoot.set(root, new Set())
    pathsByRoot.get(root).add(path.join(root, relative))
  }

  for (const entry of entries) {
    const rawFiles = Array.isArray(entry.rawFiles) && entry.rawFiles.length > 0
      ? entry.rawFiles
      : Array.isArray(entry.files) ? entry.files : []
    if (entry.tool === 'Bash' && rawFiles.length === 0) continue
    if (rawFiles.length === 0) continue

    for (const rawFile of rawFiles) {
      const candidates = changedCandidates(anchor, entry.cwd || anchor, rawFile, entry.tool)
      if (candidates.length > 1) {
        ambiguous.push({ tool: entry.tool, path: rawFile, reason: 'multiple-worktrees' })
      } else if (candidates.length === 1) {
        add(candidates[0].root, candidates[0].file)
      }
    }
  }

  addEnabledSuperprojects(pathsByRoot, add)
  const repos = [...pathsByRoot].map(([root, paths]) => ({ root, paths: [...paths] }))
  return { repos, ambiguous }
}

function changedCandidates (anchor, cwd, rawFile, tool) {
  if (path.isAbsolute(rawFile)) return changedCandidate(rawFile)

  anchor = canonicalRoot(anchor)
  const direct = canonicalTrackedPath(path.resolve(cwd, rawFile))
  const directRoot = gitRootForPath(direct)
  if (!isOpaquePathTool(tool) || (directRoot && directRoot !== anchor)) {
    return changedCandidate(direct)
  }

  const relative = path.relative(anchor, direct)
  if (!relative || relative.startsWith('..')) return changedCandidate(direct)
  const candidates = []
  const seen = new Set()
  for (const worktree of gitWorktrees(anchor)) {
    const file = canonicalTrackedPath(path.join(worktree, relative))
    if (isDirectoryPath(file)) continue
    const root = gitRootForPath(file)
    if (!root || seen.has(root) || activeConfig(root).config.enabled !== true) continue
    seen.add(root)
    if (hasPathChanges(root, file)) candidates.push({ root, file })
  }
  return candidates
}

function isOpaquePathTool (tool) {
  return typeof tool === 'string' && tool.startsWith('mcp__')
}

function changedCandidate (file) {
  if (isDirectoryPath(file)) return []
  file = canonicalTrackedPath(file)
  const root = gitRootForPath(file)
  if (!root || activeConfig(root).config.enabled !== true) return []
  return hasPathChanges(root, file) ? [{ root, file }] : []
}

function isDirectoryPath (file) {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

function addEnabledSuperprojects (pathsByRoot, add) {
  for (const child of [...pathsByRoot.keys()]) {
    const parent = gitRoot(path.dirname(child))
    if (parent && parent !== child && isGitlink(parent, child)) add(parent, child)
  }
}

function dependencyOrder (repos) {
  return [...repos].sort((a, b) => {
    if (isGitlink(a.root, b.root)) return 1
    if (isGitlink(b.root, a.root)) return -1
    return a.order - b.order
  })
}

function appendWork (manifest, root, work) {
  let repo = manifest.repos.find(candidate => candidate.root === root)
  if (!repo) {
    repo = { root, order: manifest.nextOrder++, work: [] }
    manifest.repos.push(repo)
  }
  if (!repo.work.some(item => item.key === work.key)) repo.work.push(work)
  return repo
}

function normalizeManifest (stored) {
  const manifest = stored && typeof stored === 'object' ? stored : {}
  const repos = Array.isArray(manifest.repos) ? manifest.repos : []
  let discardedLegacyWork = 0
  const normalizedRepos = []

  for (const repo of repos) {
    if (!repo || typeof repo.root !== 'string' || !Array.isArray(repo.work)) continue
    const work = repo.work.filter(item => {
      const safe = item && Array.isArray(item.paths) && item.paths.length > 0
      if (!safe) discardedLegacyWork++
      return safe
    })
    if (work.length > 0) normalizedRepos.push({ ...repo, work })
  }

  return {
    nextOrder: Number.isInteger(manifest.nextOrder) ? manifest.nextOrder : 0,
    repos: normalizedRepos,
    discardedLegacyWork
  }
}

function multiWatermarkPath (root, sessionId) {
  return path.join(turbocommitDir(root), 'multi-watermarks', checkoutKey(root), sessionId + '.json')
}

function readMultiWatermark (root, sessionIds) {
  for (const sessionId of sessionIds) {
    const value = loadJson(multiWatermarkPath(root, sessionId))
    if (value?.commit) return value
  }
  return null
}

function saveMultiWatermark (root, sessionId, commit) {
  const file = multiWatermarkPath(root, sessionId)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify({ commit }) + '\n')
}

module.exports = {
  appendWork,
  checkoutKey,
  deleteManifestIfEmpty,
  dependencyOrder,
  loadManifest,
  manifestPath,
  readMultiWatermark,
  trackedChangesFromEntries,
  saveManifest,
  saveMultiWatermark
}
