const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { ensureDir, loadJson } = require('./io')
const { turbocommitDir } = require('./session')
const { gitRoot, gitRootForPath, isGitlink } = require('./git')
const { activeConfig } = require('./config')

function checkoutKey (root) {
  return crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16)
}

function manifestPath (anchor) {
  return path.join(turbocommitDir(anchor), 'multi', checkoutKey(anchor), 'manifest.json')
}

function loadManifest (anchor) {
  return loadJson(manifestPath(anchor)) || { nextOrder: 0, repos: [] }
}

function saveManifest (anchor, manifest) {
  const file = manifestPath(anchor)
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
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

function rootsFromEntries (anchor, entries) {
  const roots = []
  const seen = new Set()
  const add = root => {
    if (!root) return
    let real
    try {
      real = fs.realpathSync(root)
    } catch {
      return
    }
    if (seen.has(real)) return
    if (activeConfig(real).config.enabled !== true) return
    seen.add(real)
    roots.push(real)
  }

  for (const entry of entries) {
    if (entry.tool === 'Bash') continue
    if (Array.isArray(entry.files) && entry.files.length > 0) {
      for (const file of entry.files) add(gitRootForPath(file) || anchor)
    } else {
      add(anchor)
    }
  }
  return addEnabledSuperprojects(roots, add)
}

function addEnabledSuperprojects (roots, add) {
  for (let i = 0; i < roots.length; i++) {
    const child = roots[i]
    const parent = gitRoot(path.dirname(child))
    if (parent && parent !== child && isGitlink(parent, child)) add(parent)
  }
  return roots
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
  rootsFromEntries,
  saveManifest,
  saveMultiWatermark
}
