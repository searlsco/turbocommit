const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./io')
const { turbocommitDir } = require('./session')

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
const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'notebook_path']

/**
 * Extract a file path from tool_input, heuristically checking known keys.
 */
function extractFilePath (toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null
  for (const key of FILE_PATH_KEYS) {
    if (typeof toolInput[key] === 'string' && toolInput[key].length > 0) {
      return toolInput[key]
    }
  }
  return null
}

function extractFilePaths (toolName, toolInput, cwd) {
  const paths = []
  const seen = new Set()
  const add = value => {
    if (typeof value !== 'string' || value.length === 0) return
    const resolved = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value)
    if (seen.has(resolved)) return
    seen.add(resolved)
    paths.push(resolved)
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
      if (FILE_PATH_KEYS.includes(key)) add(nested)
      if (nested && typeof nested === 'object') visit(nested)
    }
  }
  visit(toolInput)
  return paths
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

  const entry = { tool: toolName, t: Date.now() }

  const cwd = hookInput.cwd || hookInput.raw?.cwd || root
  const files = extractFilePaths(toolName, toolInput, cwd)
  if (files.length > 0) entry.files = files

  // For Bash, record the command
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    entry.command = toolInput.command
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

function parseInput (input) {
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

/**
 * Check whether a session has tracked any file-modifying tool calls.
 * Bash entries alone don't count — Bash is too noisy (ls, git status, etc.)
 * and we can't reliably distinguish read-only from write commands.
 * The definitive signal comes from Write/Edit/NotebookEdit/MCP tools.
 */
function hasTrackedModifications (root, sessionId) {
  return readTracking(root, sessionId).some(entry => entry.tool !== 'Bash')
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
  hasTrackedModifications,
  cleanupTracking,
  extractFilePath,
  extractFilePaths,
  readTracking,
  trackingDir,
  trackingPath
}
