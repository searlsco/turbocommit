const fs = require('fs')
const path = require('path')
const { gitRoot } = require('./git')
const { writeJson, ensureDir } = require('./io')
const { neutralProjectConfigPath, legacyProjectConfigPath } = require('./config')

function configPath (root) {
  return neutralProjectConfigPath(root)
}

function init (cwd) {
  const root = gitRoot(cwd)
  if (!root) {
    return { ok: false, error: 'Not a git repository' }
  }

  const neutralPath = configPath(root)
  const legacyPath = legacyProjectConfigPath(root)
  if (fs.existsSync(neutralPath)) {
    return { ok: true, alreadyExists: true, path: neutralPath }
  }
  if (fs.existsSync(legacyPath)) {
    return { ok: true, alreadyExists: true, path: legacyPath }
  }

  ensureDir(path.dirname(neutralPath))
  writeJson(neutralPath, { enabled: true })
  return { ok: true, alreadyExists: false, path: neutralPath }
}

function deinit (cwd) {
  const root = gitRoot(cwd)
  if (!root) {
    return { ok: false, error: 'Not a git repository' }
  }

  const paths = [configPath(root), legacyProjectConfigPath(root)]
  const existing = paths.filter(p => fs.existsSync(p))
  if (existing.length === 0) {
    return { ok: true, existed: false, path: paths[0], paths: [] }
  }

  for (const p of existing) fs.unlinkSync(p)
  return { ok: true, existed: true, path: existing[0], paths: existing }
}

module.exports = { init, deinit, configPath }
