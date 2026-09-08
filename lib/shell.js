const fs = require('fs')
const os = require('os')
const path = require('path')
const { canonicalRoot, gitRootForPath } = require('./git')
const { activeConfig } = require('./config')

/**
 * Enabled checkouts other than the anchor that a shell command names.
 *
 * A command can `cd` anywhere before it edits, so every word that resolves to
 * an existing path is probed for the repository containing it. Relative words
 * are resolved against the command's working directory and against every
 * absolute directory the command mentions, which is how a loop such as
 * `cd ~/code && for r in app/Core lib/Core; do ...` reaches each checkout.
 */
function shellCheckouts (command, cwd, anchor) {
  if (typeof command !== 'string' || !command) return []
  const anchorRoot = canonicalRoot(anchor)
  const words = shellWords(command)
  const bases = [cwd, ...words.filter(word => path.isAbsolute(word) && isDirectory(word))]

  const candidates = new Set()
  for (const word of words) {
    const resolved = path.isAbsolute(word)
      ? [word]
      : bases.map(base => path.resolve(base, word))
    for (const candidate of resolved) {
      if (!fs.existsSync(candidate)) continue
      const canonical = canonicalRoot(candidate)
      if (isInside(canonical, anchorRoot) || canonical.startsWith('/dev/')) continue
      candidates.add(isDirectory(canonical) ? canonical : path.dirname(canonical))
    }
  }

  const rootsByDir = new Map()
  const checkouts = []
  for (const dir of candidates) {
    if (!rootsByDir.has(dir)) rootsByDir.set(dir, gitRootForPath(dir))
    const root = rootsByDir.get(dir)
    if (!root || root === anchorRoot || checkouts.includes(root)) continue
    if (activeConfig(root).config.enabled !== true) continue
    checkouts.push(root)
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
