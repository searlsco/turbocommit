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

  // Extract file path for file-modifying tools
  const filePath = extractFilePath(toolInput)
  if (filePath) {
    entry.file = filePath
  }

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
  const file = trackingPath(root, sessionId)
  try {
    const data = fs.readFileSync(file, 'utf8')
    if (!data) return false
    const lines = data.trim().split('\n')
    return lines.some(line => {
      try {
        const entry = JSON.parse(line)
        return entry.tool !== 'Bash'
      } catch {
        return false
      }
    })
  } catch {
    return false
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
  trackingDir,
  trackingPath
}
