const fs = require('fs')
const os = require('os')
const path = require('path')
const { canonicalRoot, gitRootForPath, hasRepositoryOperation } = require('./git')
const { activeConfig } = require('./config')

/**
 * Enabled checkouts other than the anchor that a shell command names, each
 * with the paths inside it the command named. Only changes under those paths
 * are attributed, since a command that merely mentions a repository is not
 * evidence that it wrote anywhere else in it.
 *
 * A command can `cd` anywhere before it edits, so every path-shaped word that
 * resolves to an existing path is probed for the repository containing it.
 * Relative words are resolved against the command's working directory and
 * against every absolute directory the command mentions, which is how a loop
 * such as `cd ~/code && for r in app/Core lib/Core; do ...` reaches each
 * checkout. A checkout with a merge, rebase, or similar operation in progress
 * is left alone: its commits cannot be path-scoped, so nothing there may be
 * attributed on the strength of a mention.
 */
function shellCheckouts (command, cwd, anchor) {
  if (typeof command !== 'string' || !command) return []
  const anchorRoot = canonicalRoot(anchor)
  const words = shellWords(command)
  const bases = [cwd, ...words.filter(word => path.isAbsolute(word) && isDirectory(word))]

  const named = new Set()
  for (const word of words) {
    const resolved = path.isAbsolute(word)
      ? [word]
      : bases.map(base => path.resolve(base, word))
    for (const candidate of resolved) {
      if (!fs.existsSync(candidate)) continue
      const canonical = canonicalRoot(candidate)
      if (isInside(canonical, anchorRoot) || canonical.startsWith('/dev/')) continue
      named.add(canonical)
    }
  }

  const rootsByDir = new Map()
  const checkouts = []
  for (const file of named) {
    const dir = isDirectory(file) ? file : path.dirname(file)
    if (!rootsByDir.has(dir)) rootsByDir.set(dir, gitRootForPath(dir))
    const root = rootsByDir.get(dir)
    if (!root || root === anchorRoot) continue
    let checkout = checkouts.find(candidate => candidate.root === root)
    if (!checkout) {
      if (activeConfig(root).config.enabled !== true || hasRepositoryOperation(root)) continue
      checkout = { root, paths: [] }
      checkouts.push(checkout)
    }
    if (!checkout.paths.includes(file)) checkout.paths.push(file)
  }
  return checkouts
}

function shellWords (command) {
  const home = os.homedir()
  return command.split(/[\s;|&()<>`"'=]+/).flatMap(word => {
    word = word.replace(/[,:.]+$/, '')
    if (word === '~' || word.startsWith('~/')) word = home + word.slice(1)
    if (!word || word.startsWith('-') || word.length > 1024) return []
    if (/[$*?{}[\]\\]/.test(word)) return []
    // A bare word is an argument or prose, not a path, unless it exists
    // relative to the working directory itself.
    if (!path.isAbsolute(word) && !word.includes('/')) return []
    return [word]
  })
}

function isDirectory (file) {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

function isInside (file, root) {
  return file === root || file.startsWith(root + path.sep)
}

module.exports = { shellCheckouts }
