const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const { ensureDir } = require('./io')
const { turbocommitDir } = require('./session')
const { canonicalRoot, canonicalTrackedPath, changedPathsInRepository } = require('./git')

const BASH_SNAPSHOT_TTL_MS = 60 * 60 * 1000

/**
 * Directory under the git common dir where turbocommit stores tracking state.
 * Returns null when the root isn't resolvable to a git repo (including when
 * run outside a repo, which is not expected during normal operation).
 */
function trackingDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'tracking')
}

function trackingPath (root, sessionId) {
  const dir = trackingDir(root)
  return dir && path.join(dir, sessionId + '.jsonl')
}

/**
 * Keys to probe in tool_input for a file path (MCP tools, Write, Edit, etc.)
 */
const FILE_PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'file',
  'notebook_path',
  'relative_path',
  'relativePath',
  'uri'
]
const FILE_PATH_ARRAY_KEYS = ['file_paths', 'filePaths', 'paths', 'files']

/**
 * Extract a file path from tool_input, heuristically checking known keys.
 */
function extractFilePath (toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null
  for (const key of FILE_PATH_KEYS) {
    const value = normalizeRawPath(toolInput[key], key)
    if (value) return value
  }
  return null
}

function extractRawFilePaths (toolName, toolInput) {
  const paths = []
  const seen = new Set()
  const add = (value, key) => {
    value = normalizeRawPath(value, key)
    if (!value) return
    if (seen.has(value)) return
    seen.add(value)
    paths.push(value)
  }

  if (toolName === 'apply_patch' && typeof toolInput?.command === 'string') {
    for (const line of toolInput.command.split('\n')) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ||
        line.match(/^\*\*\* Move to: (.+)$/)
      if (match) add(match[1])
    }
    return paths
  }

  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      if (FILE_PATH_KEYS.includes(key)) add(nested, key)
      if (FILE_PATH_ARRAY_KEYS.includes(key) && Array.isArray(nested)) {
        for (const item of nested) add(item, key)
      }
      if (nested && typeof nested === 'object') visit(nested)
    }
  }
  visit(toolInput)
  return paths
}

function normalizeRawPath (value, key) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (key !== 'uri') return value
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value)
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null
  return value
}

function extractFilePaths (toolName, toolInput, cwd) {
  const seen = new Set()
  return extractRawFilePaths(toolName, toolInput).map(value =>
    path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value)
  ).filter(value => {
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

/**
 * PreToolUse handler. Appends a tracking entry for potentially-modifying tools.
 * Always exits 0 (never blocks tool execution).
 */
function handleTrack (input, root) {
  const hookInput = typeof input === 'string' ? parseInput(input) : input
  root = root || hookInput?.root
  if (!root || !hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  if (!sessionId) return

  const toolName = hookInput.toolName || hookInput.tool_name
  if (!toolName) return

  const toolInput = hookInput.toolInput || hookInput.tool_input || {}

  const cwd = hookInput.cwd || hookInput.raw?.cwd || root
  const entry = { tool: toolName, t: Date.now(), cwd }
  const rawFiles = extractRawFilePaths(toolName, toolInput)
  const files = extractFilePaths(toolName, toolInput, cwd)
  if (rawFiles.length > 0) entry.rawFiles = rawFiles
  if (files.length > 0) entry.files = files

  // For Bash, record the command
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    entry.command = toolInput.command
    saveBashSnapshot(root, sessionId, hookInput.toolUseId || hookInput.tool_use_id)
  }

  // Skip Bash with no command (malformed input). All other non-Bash tools
  // passed the PreToolUse matcher, so they're known modifying tools even if
  // we can't extract a specific file path (e.g. MultiEdit nests paths in edits[]).
  if (toolName === 'Bash' && typeof toolInput.command !== 'string') return

  const file = trackingPath(root, sessionId)
  if (!file) return
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

function handlePostTrack (input, root) {
  const hookInput = typeof input === 'string' ? parseInput(input) : input
  root = root || hookInput?.root
  if (!root || !hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  const toolName = hookInput.toolName || hookInput.tool_name
  if (!sessionId || toolName !== 'Bash') return

  const cwd = hookInput.cwd || hookInput.raw?.cwd || root
  const toolUseId = hookInput.toolUseId || hookInput.tool_use_id
  const snapshot = loadBashSnapshot(root, sessionId, toolUseId)
  if (!snapshot) return

  const now = Date.now()
  const overlapping = hasOverlappingBashSnapshot(root, snapshot, now)
  snapshot.endedAt = now
  writeBashSnapshot(root, sessionId, toolUseId, snapshot)

  const before = new Set(snapshot.before.map(canonicalTrackedPath))
  const claimed = claimedPathsByOtherSessions(root, sessionId)
  const files = overlapping
    ? []
    : changedPathsInRepository(snapshot.root)
      .map(canonicalTrackedPath)
      .filter(file => !before.has(file) && !claimed.has(file))

  const entry = { tool: 'Bash', phase: 'post', t: now, cwd }
  if (overlapping) entry.overlapping = true
  if (files.length > 0) {
    entry.rawFiles = files
    entry.files = files
  }
  appendTracking(root, sessionId, entry)
}

function bashSnapshotDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'bash-snapshots')
}

function bashSnapshotPath (root, sessionId, toolUseId) {
  const dir = bashSnapshotDir(root)
  if (!dir) return null
  const key = crypto.createHash('sha256')
    .update(`${sessionId}\0${toolUseId || 'current'}`)
    .digest('hex')
  return path.join(dir, key + '.json')
}

function saveBashSnapshot (root, sessionId, toolUseId) {
  const checkout = canonicalRoot(root)
  pruneBashSnapshots(root)
  writeBashSnapshot(root, sessionId, toolUseId, {
    root: checkout,
    sessionId,
    toolUseId: toolUseId || null,
    startedAt: Date.now(),
    before: changedPathsInRepository(checkout)
  })
}

function writeBashSnapshot (root, sessionId, toolUseId, snapshot) {
  const file = bashSnapshotPath(root, sessionId, toolUseId)
  if (!file) return
  ensureDir(path.dirname(file))
  const temporary = file + `.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot) + '\n')
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function loadBashSnapshot (root, sessionId, toolUseId) {
  try {
    return JSON.parse(fs.readFileSync(bashSnapshotPath(root, sessionId, toolUseId), 'utf8'))
  } catch {
    return null
  }
}

function hasOverlappingBashSnapshot (root, current, now) {
  const dir = bashSnapshotDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return false
  }
  return files.some(file => {
    try {
      const other = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      if (other.sessionId === current.sessionId && other.toolUseId === current.toolUseId) return false
      if (canonicalRoot(other.root) !== canonicalRoot(current.root)) return false
      const endedAt = Number.isFinite(other.endedAt) ? other.endedAt : now
      return other.startedAt <= now && endedAt >= current.startedAt
    } catch {
      return false
    }
  })
}

function pruneBashSnapshots (root) {
  const dir = bashSnapshotDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - BASH_SNAPSHOT_TTL_MS
  for (const file of files) {
    try {
      const fullPath = path.join(dir, file)
      const snapshot = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
      if ((snapshot.endedAt || snapshot.startedAt || 0) < cutoff) fs.unlinkSync(fullPath)
    } catch {}
  }
}

function claimedPathsByOtherSessions (root, sessionId) {
  const result = new Set()
  const dir = trackingDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return result
  }
  for (const file of files) {
    if (file === sessionId + '.jsonl' || !file.endsWith('.jsonl')) continue
    try {
      const entries = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')
      for (const line of entries) {
        const entry = JSON.parse(line)
        if (!Array.isArray(entry.files)) continue
        for (const claimed of entry.files) result.add(canonicalTrackedPath(claimed))
      }
    } catch {}
  }
  return result
}

function appendTracking (root, sessionId, entry) {
  const file = trackingPath(root, sessionId)
  if (!file) return
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

function parseInput (input) {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

/**
 * Check whether a session has tracked any file-modifying tool calls.
 * A Bash pre-hook alone doesn't count because shell commands may be read-only.
 * A Bash post-hook counts only when its snapshot found newly dirty paths.
 */
function hasTrackedModifications (root, sessionId) {
  return readTracking(root, sessionId).some(entry =>
    entry.tool !== 'Bash' || (entry.phase === 'post' && Array.isArray(entry.files) && entry.files.length > 0)
  )
}

function readTracking (root, sessionId) {
  const file = trackingPath(root, sessionId)
  try {
    const data = fs.readFileSync(file, 'utf8')
    if (!data) return []
    return data.trim().split('\n').map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Delete tracking file after commit or cleanup.
 */
function cleanupTracking (root, sessionId) {
  try {
    fs.unlinkSync(trackingPath(root, sessionId))
  } catch {}
}

module.exports = {
  handleTrack,
  handlePostTrack,
  hasTrackedModifications,
  cleanupTracking,
  extractFilePath,
  extractFilePaths,
  extractRawFilePaths,
  readTracking,
  trackingDir,
  trackingPath
}
