const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./io')
const { gitCommonDir } = require('./git')

const BREADCRUMB_THRESHOLD_MS = 2000
const STALE_TTL_MS = 24 * 60 * 60 * 1000

function turbocommitDir (root) {
  if (!root) return null
  const gitDir = gitCommonDir(root)
  if (!gitDir) return null
  return path.join(gitDir, 'turbocommit')
}

function breadcrumbDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'breadcrumbs')
}

function chainDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'chains')
}

function pendingDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'pending')
}

function watermarkDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'watermarks')
}

/**
 * SessionEnd handler. Writes a breadcrumb for the ending session.
 */
function handleSessionEnd (input, root) {
  if (!root) return

  const hookInput = typeof input === 'string' ? parseInput(input) : input
  if (!hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  if (!sessionId) return

  const dir = breadcrumbDir(root)
  if (!dir) return
  ensureDir(dir)
  const data = { session_id: sessionId, timestamp: Date.now() }
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify(data) + '\n')
}

/**
 * SessionStart handler. Matches breadcrumbs for /clear and resume continuations.
 */
function handleSessionStart (input, root) {
  if (!root) return

  const hookInput = typeof input === 'string' ? parseInput(input) : input
  if (!hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  if (!sessionId) return

  const source = hookInput.source
  if (source !== 'clear' && source !== 'resume') return

  const dir = breadcrumbDir(root)
  if (!dir || !fs.existsSync(dir)) return

  // Scan breadcrumbs for closest match
  const now = Date.now()
  let best = null
  let bestGap = Infinity

  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      const gap = Math.abs(now - data.timestamp)
      if (gap < bestGap) {
        bestGap = gap
        best = data
      }
    } catch {
      continue
    }
  }

  if (!best || bestGap > BREADCRUMB_THRESHOLD_MS) return

  // Claim the breadcrumb (delete it so no other session grabs it)
  try {
    fs.unlinkSync(path.join(dir, best.session_id + '.json'))
  } catch {}

  // Read predecessor's chain to get full ancestry
  const predecessorChain = readChain(root, best.session_id)
  const ancestors = [best.session_id, ...(predecessorChain ? predecessorChain.ancestors : [])]

  // Write chain for this session
  const cDir = chainDir(root)
  if (!cDir) return
  ensureDir(cDir)
  const chain = { parent: best.session_id, ancestors }
  fs.writeFileSync(path.join(cDir, sessionId + '.json'), JSON.stringify(chain) + '\n')
}

function parseInput (input) {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function readChain (root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(chainDir(root), sessionId + '.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Get ordered ancestor list for a session (nearest first).
 */
function getAncestors (root, sessionId) {
  const chain = readChain(root, sessionId)
  return chain ? chain.ancestors : []
}

/**
 * Save formatted transcript to pending directory for later pickup.
 */
let pendingSeq = 0
function savePending (root, sessionId, transcript, opts = {}) {
  const base = pendingDir(root)
  if (!base) return
  const dir = path.join(base, sessionId)
  ensureDir(dir)
  const timestamp = String(Date.now()) + '-' + String(pendingSeq++).padStart(4, '0')
  const source = opts.source ? '.' + String(opts.source).replace(/[^a-z0-9-]/gi, '-') : ''
  fs.writeFileSync(path.join(dir, timestamp + source + '.txt'), transcript)
}

/**
 * Collect pending transcripts for a list of session IDs, in order
 * (oldest ancestor first). Returns array of strings.
 */
function collectPending (root, sessionIds, opts = {}) {
  const results = []
  const base = pendingDir(root)
  if (!base) return results
  const sourceSuffix = opts.source ? '.' + opts.source + '.txt' : null
  for (const sid of sessionIds) {
    const dir = path.join(base, sid)
    let files
    try {
      files = fs.readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.txt')) continue
      if (sourceSuffix && !file.endsWith(sourceSuffix)) continue
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8')
        if (content.trim()) results.push(content)
      } catch {
        continue
      }
    }
  }
  return results
}

/**
 * Read watermark for a session. Returns { pairs, commit } or null.
 */
function readWatermark (root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(watermarkDir(root), sessionId + '.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Save watermark after a commit: pair count and commit SHA.
 */
function saveWatermark (root, sessionId, pairs, commit, meta = {}) {
  const dir = watermarkDir(root)
  if (!dir) return
  ensureDir(dir)
  const data = { pairs }
  if (commit) data.commit = commit
  Object.assign(data, meta)
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify(data) + '\n')
}

/**
 * Resolve parent commit SHA for continuation references.
 * Checks own watermark first, then walks chain ancestors nearest-first.
 */
function resolveParentCommit (root, sessionId) {
  // Own watermark takes priority (same-session previous commit)
  const own = readWatermark(root, sessionId)
  if (own && own.commit) return own.commit

  // Walk chain ancestors nearest-first
  const ancestors = getAncestors(root, sessionId)
  for (const aid of ancestors) {
    const wm = readWatermark(root, aid)
    if (wm && wm.commit) return wm.commit
  }
  return null
}

/**
 * Delete consumed pending + chain files after commit.
 */
function cleanupConsumed (root, sessionIds) {
  const base = pendingDir(root)
  if (!base) return
  for (const sid of sessionIds) {
    // Remove pending dir
    const dir = path.join(base, sid)
    try {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file))
      }
      fs.rmdirSync(dir)
    } catch {}

    // Chain files are preserved — resolveParentCommit needs them
    // to walk cross-session lineage. Stale cleanup handles them after 24h.
  }
}

/**
 * Remove stale orphaned files older than maxAgeMs (default 24h).
 */
function cleanupStale (root, maxAgeMs) {
  const ttl = maxAgeMs != null ? maxAgeMs : STALE_TTL_MS
  const now = Date.now()
  const base = turbocommitDir(root)
  if (!base) return

  for (const sub of ['breadcrumbs', 'chains', 'tracking', 'watermarks']) {
    const dir = path.join(base, sub)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const fp = path.join(dir, file)
      try {
        const stat = fs.statSync(fp)
        if (now - stat.mtimeMs > ttl) {
          fs.unlinkSync(fp)
        }
      } catch {}
    }
  }

  // Clean stale pending directories
  const pDir = path.join(base, 'pending')
  let pdirs
  try {
    pdirs = fs.readdirSync(pDir)
  } catch {
    return
  }
  for (const sid of pdirs) {
    const dir = path.join(pDir, sid)
    try {
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs > ttl) {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          fs.unlinkSync(path.join(dir, file))
        }
        fs.rmdirSync(dir)
      }
    } catch {}
  }
}

module.exports = {
  handleSessionEnd,
  handleSessionStart,
  getAncestors,
  savePending,
  collectPending,
  cleanupConsumed,
  cleanupStale,
  readChain,
  readWatermark,
  saveWatermark,
  resolveParentCommit,
  breadcrumbDir,
  chainDir,
  pendingDir,
  watermarkDir,
  turbocommitDir,
  BREADCRUMB_THRESHOLD_MS,
  STALE_TTL_MS
}
