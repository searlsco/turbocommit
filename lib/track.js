const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const { ensureDir } = require('./io')
const { turbocommitDir } = require('./session')
const { canonicalRoot, canonicalTrackedPath, changedPathsInRepository, gitCommonDir } = require('./git')

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

function preclaimDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'preclaims')
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
 * PreToolUse handler. Persists ownership before waiting for overlap recovery.
 * Returns false when the caller must deny the tool rather than let it run
 * without a durable ownership claim.
 */
function handleTrack (input, root, opts = {}) {
  const hookInput = typeof input === 'string' ? parseInput(input) : input
  root = root || hookInput?.root
  if (!root || !hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  if (!sessionId) return

  const toolName = hookInput.toolName || hookInput.tool_name
  if (!toolName) return

  const toolInput = hookInput.toolInput || hookInput.tool_input || {}

  // Skip Bash with no command (malformed input). All other non-Bash tools
  // passed the PreToolUse matcher, so they're known modifying tools even if
  // we can't extract a specific file path (e.g. MultiEdit nests paths in edits[]).
  if (toolName === 'Bash' && typeof toolInput.command !== 'string') return

  const cwd = hookInput.cwd || hookInput.raw?.cwd || root
  const entry = { tool: toolName, t: Date.now(), cwd }
  const rawFiles = extractRawFilePaths(toolName, toolInput)
  const files = extractFilePaths(toolName, toolInput, cwd)
  if (rawFiles.length > 0) entry.rawFiles = rawFiles
  if (files.length > 0) entry.files = files

  const toolUseId = hookInput.toolUseId || hookInput.tool_use_id
  let pendingSnapshot = false
  let preclaim = null
  try {
    if (toolName === 'Bash') {
      entry.command = toolInput.command
      savePendingBashSnapshot(root, sessionId, toolUseId, cwd)
      pendingSnapshot = true
      appendTracking(root, sessionId, entry)
    } else {
      preclaim = savePreclaim(root, sessionId, entry)
    }
  } catch (error) {
    if (pendingSnapshot) removeBashSnapshot(root, sessionId, toolUseId)
    if (preclaim) removePreclaim(preclaim)
    throw error
  }

  const recoveryWaitMs = opts.recoveryWaitMs ?? 5000
  if (pendingSnapshot) {
    const release = acquireBashOverlapRecoveryLock(root, recoveryWaitMs)
    if (!release) {
      removeBashSnapshot(root, sessionId, toolUseId)
      return false
    }
    try {
      pruneBashSnapshots(root)
      initializeBashSnapshot(root, sessionId, toolUseId, cwd)
    } catch (error) {
      removeBashSnapshot(root, sessionId, toolUseId)
      throw error
    } finally {
      release()
    }
    return true
  }

  if (!waitForBashOverlapRecovery(root, recoveryWaitMs)) {
    removePreclaim(preclaim)
    return false
  }
  try {
    appendTracking(root, sessionId, entry)
    return true
  } finally {
    removePreclaim(preclaim)
  }
}

function handlePostTrack (input, root) {
  const hookInput = typeof input === 'string' ? parseInput(input) : input
  root = root || hookInput?.root
  if (!root || !hookInput) return

  const sessionId = hookInput.sessionId || hookInput.session_id
  const toolName = hookInput.toolName || hookInput.tool_name
  if (!sessionId || toolName !== 'Bash') return

  const toolUseId = hookInput.toolUseId || hookInput.tool_use_id
  const release = acquireBashOverlapRecoveryLock(root, 5000)
  if (!release) return
  try {
    const snapshot = loadBashSnapshot(root, sessionId, toolUseId)
    if (!snapshot || Number.isFinite(snapshot.endedAt)) return
    finishBashSnapshot(root, snapshot, {
      cwd: hookInput.cwd || hookInput.raw?.cwd || snapshot.cwd || root,
      endedAt: Date.now()
    })
  } finally {
    release()
  }
}

function finishBashSnapshot (root, snapshot, { cwd, endedAt }) {
  if (snapshot.pending === true || !Array.isArray(snapshot.before) || !Number.isFinite(snapshot.startedAt)) return false
  const overlaps = overlappingBashSnapshots(root, snapshot, endedAt)
  const before = new Set(snapshot.before.map(canonicalTrackedPath))
  const changed = changedPathsInRepository(snapshot.root).map(canonicalTrackedPath)
  const overlapping = overlaps.length > 0
  const claimed = overlapping
    ? claimedPathsBySessions(root)
    : claimedPathsBySessions(root, snapshot.sessionId)
  const candidates = changed.filter(file => !before.has(file) && !claimed.has(file))
  const files = overlapping ? [] : candidates

  const entry = { tool: 'Bash', phase: 'post', t: endedAt, cwd }
  if (overlapping) {
    entry.overlapping = true
    entry.overlapEventId = recordBashOverlap(root, snapshot, overlaps, candidates, endedAt)
  }
  if (files.length > 0) {
    entry.rawFiles = files
    entry.files = files
  }
  appendTracking(root, snapshot.sessionId, entry)
  snapshot.endedAt = endedAt
  writeBashSnapshot(root, snapshot.sessionId, snapshot.toolUseId, snapshot)
  return true
}

function bashSnapshotDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'bash-snapshots')
}

function bashSnapshotPath (root, sessionId, toolUseId) {
  const dir = bashSnapshotDir(root)
  if (!dir) return null
  const key = crypto.createHash('sha256')
    .update(`${canonicalRoot(root)}\0${sessionId}\0${toolUseId || 'current'}`)
    .digest('hex')
  return path.join(dir, key + '.json')
}

function savePendingBashSnapshot (root, sessionId, toolUseId, cwd) {
  const checkout = canonicalRoot(root)
  writeBashSnapshot(root, sessionId, toolUseId, {
    root: checkout,
    cwd: cwd || checkout,
    sessionId,
    toolUseId: toolUseId || null,
    createdAt: Date.now(),
    pending: true
  })
}

function initializeBashSnapshot (root, sessionId, toolUseId, cwd) {
  const checkout = canonicalRoot(root)
  const snapshot = loadBashSnapshot(root, sessionId, toolUseId)
  if (!snapshot || snapshot.pending !== true) throw new Error('Bash ownership snapshot disappeared before initialization')
  writeBashSnapshot(root, sessionId, toolUseId, {
    ...snapshot,
    root: checkout,
    cwd: cwd || checkout,
    startedAt: Date.now(),
    before: changedPathsInRepository(checkout),
    pending: false
  })
}

function removeBashSnapshot (root, sessionId, toolUseId) {
  try {
    fs.unlinkSync(bashSnapshotPath(root, sessionId, toolUseId))
  } catch {}
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

function overlappingBashSnapshots (root, current, now) {
  const dir = bashSnapshotDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  return files.flatMap(file => {
    try {
      const other = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      if (other.sessionId === current.sessionId) return []
      if (canonicalRoot(other.root) !== canonicalRoot(current.root)) return []
      if (other.pending === true || !Number.isFinite(other.startedAt)) return []
      const endedAt = Number.isFinite(other.endedAt) ? other.endedAt : now
      return other.startedAt <= now && endedAt >= current.startedAt ? [other] : []
    } catch {
      return []
    }
  })
}

function finalizeBashSnapshots (root, sessionId, endedAt = Date.now(), waitMs = 5000) {
  const files = unfinishedBashSnapshotFiles(root, sessionId)
  if (files.length === 0) return 0
  const release = acquireBashOverlapRecoveryLock(root, waitMs)
  if (!release) return null
  try {
    let finalized = 0
    for (const file of files) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (snapshot.sessionId !== sessionId || Number.isFinite(snapshot.endedAt) || snapshot.pending === true) continue
        if (canonicalRoot(snapshot.root) !== canonicalRoot(root)) continue
        if (finishBashSnapshot(root, snapshot, {
          cwd: snapshot.cwd || snapshot.root || root,
          endedAt
        })) finalized++
      } catch {}
    }
    return finalized
  } finally {
    release()
  }
}

function unfinishedBashSnapshotFiles (root, sessionId) {
  const dir = bashSnapshotDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const checkout = canonicalRoot(root)
  return files.map(file => path.join(dir, file)).filter(file => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
      return snapshot.sessionId === sessionId &&
        !Number.isFinite(snapshot.endedAt) &&
        snapshot.pending !== true &&
        canonicalRoot(snapshot.root) === checkout
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
  const checkout = canonicalRoot(root)
  const cutoff = Date.now() - BASH_SNAPSHOT_TTL_MS
  const expired = []
  for (const file of files) {
    try {
      const fullPath = path.join(dir, file)
      const snapshot = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
      if (canonicalRoot(snapshot.root) !== checkout) continue
      if (Number.isFinite(snapshot.endedAt) && snapshot.endedAt < cutoff) {
        fs.unlinkSync(fullPath)
        continue
      }
      const startedAt = Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : snapshot.createdAt
      if (!Number.isFinite(snapshot.endedAt) && Number.isFinite(startedAt) && startedAt < cutoff) {
        expired.push({ fullPath, snapshot })
      }
    } catch {}
  }

  if (expired.length === 0) return
  const expiredIds = new Set(expired.map(({ snapshot }) => bashSnapshotId(snapshot)))
  const eventIds = bashOverlapComponents(unresolvedBashOverlapEvents(root))
    .filter(component => [...component.snapshotIds].some(id => expiredIds.has(id)))
    .flatMap(component => component.events.map(event => event.id))
  if (eventIds.length > 0) invalidateBashOverlap(root, [...new Set(eventIds)], 'expired-snapshot')
  for (const { fullPath } of expired) {
    try { fs.unlinkSync(fullPath) } catch {}
  }
}

function claimedPathsBySessions (root, excludedSessionId) {
  const result = new Set()
  const dir = trackingDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    files = []
  }
  for (const file of files) {
    if (file === excludedSessionId + '.jsonl' || !file.endsWith('.jsonl')) continue
    try {
      const entries = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')
      for (const line of entries) {
        const entry = JSON.parse(line)
        if (!Array.isArray(entry.files)) continue
        for (const claimed of entry.files) result.add(canonicalTrackedPath(claimed))
      }
    } catch {}
  }
  const claimsDir = preclaimDir(root)
  let claims
  try {
    claims = fs.readdirSync(claimsDir)
  } catch {
    claims = []
  }
  for (const file of claims) {
    if (!file.endsWith('.json')) continue
    try {
      const claim = JSON.parse(fs.readFileSync(path.join(claimsDir, file), 'utf8'))
      if (claim.sessionId === excludedSessionId || !Array.isArray(claim.entry?.files)) continue
      for (const claimed of claim.entry.files) result.add(canonicalTrackedPath(claimed))
    } catch {}
  }
  return result
}

function bashOverlapPath (root) {
  const base = turbocommitDir(root)
  if (!base) return null
  const checkout = crypto.createHash('sha256').update(canonicalRoot(root)).digest('hex').slice(0, 20)
  return path.join(base, `bash-overlaps-${checkout}.jsonl`)
}

function bashOverlapRecoveryLockRef (root) {
  if (!turbocommitDir(root)) return null
  const checkout = crypto.createHash('sha256').update(canonicalRoot(root)).digest('hex').slice(0, 20)
  return `refs/turbocommit/bash-overlap-locks/${checkout}`
}

function bashSessionStopDir (root) {
  const base = turbocommitDir(root)
  return base && path.join(base, 'bash-stops')
}

function bashSessionStopPath (root, sessionId) {
  const dir = bashSessionStopDir(root)
  if (!dir) return null
  const key = crypto.createHash('sha256')
    .update(`${canonicalRoot(root)}\0${sessionId}`)
    .digest('hex')
  return path.join(dir, key + '.json')
}

function recordBashOverlap (root, current, overlaps, files, at) {
  const event = {
    type: 'overlap',
    id: crypto.randomUUID(),
    t: at,
    root: canonicalRoot(current.root),
    completedSessionId: current.sessionId,
    completedAt: at,
    snapshotIds: [current, ...overlaps].map(bashSnapshotId).sort(),
    sessionIds: [...new Set([current, ...overlaps].map(snapshot => snapshot.sessionId))].sort(),
    paths: files.map(file => ({ path: file, fingerprint: fingerprintTrackedPath(file) }))
  }
  appendBashOverlapEvent(root, event)
  return event.id
}

function bashSnapshotId (snapshot) {
  return crypto.createHash('sha256')
    .update(`${canonicalRoot(snapshot.root)}\0${snapshot.sessionId}\0${snapshot.toolUseId || 'current'}`)
    .digest('hex')
}

function fingerprintTrackedPath (file) {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) {
      return 'link:' + crypto.createHash('sha256').update(fs.readlinkSync(file)).digest('hex')
    }
    if (stat.isFile()) {
      const executable = (stat.mode & 0o111) !== 0 ? 'x' : '-'
      return `file:${executable}:` + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
    return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'missing' : null
  }
}

function recordBashSessionStop (root, sessionId, at = Date.now()) {
  const overlapFile = bashOverlapPath(root)
  if (!overlapFile || !fs.existsSync(overlapFile)) return
  const file = sessionId && bashSessionStopPath(root, sessionId)
  if (!file) return
  ensureDir(path.dirname(file))
  const temporary = file + `.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ root: canonicalRoot(root), sessionId, t: at }) + '\n')
    fs.renameSync(temporary, file)
    if (!fs.existsSync(overlapFile)) {
      try { fs.unlinkSync(file) } catch {}
    }
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function appendBashOverlapEvent (root, event) {
  const file = bashOverlapPath(root)
  if (!file) return
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
}

function readBashOverlapEvents (root) {
  try {
    return fs.readFileSync(bashOverlapPath(root), 'utf8').trim().split('\n').map(line => {
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

function readBashSessionStops (root) {
  const dir = bashSessionStopDir(root)
  const checkout = canonicalRoot(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  return files.flatMap(file => {
    try {
      const stop = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      return stop.root === checkout && stop.sessionId && Number.isFinite(stop.t) ? [stop] : []
    } catch {
      return []
    }
  })
}

function unresolvedBashOverlapEvents (root, events = readBashOverlapEvents(root)) {
  const checkout = canonicalRoot(root)
  const terminal = new Set(events
    .filter(event => (event.type === 'resolved' || event.type === 'invalidated') && event.root === checkout)
    .flatMap(event => event.eventIds || []))
  return events.filter(event =>
    event.type === 'overlap' && event.root === checkout && !terminal.has(event.id))
}

function bashOverlapComponents (overlaps) {
  const components = []
  for (const event of overlaps) {
    const matching = components.filter(component =>
      event.snapshotIds.some(id => component.snapshotIds.has(id)))
    const component = matching.shift() || { events: [], snapshotIds: new Set() }
    component.events.push(event)
    for (const id of event.snapshotIds) component.snapshotIds.add(id)
    for (const merged of matching) {
      component.events.push(...merged.events)
      for (const id of merged.snapshotIds) component.snapshotIds.add(id)
      components.splice(components.indexOf(merged), 1)
    }
    if (!components.includes(component)) components.push(component)
  }
  return components
}

function readReadyBashOverlaps (root) {
  const events = readBashOverlapEvents(root)
  const stops = new Map()
  for (const stop of readBashSessionStops(root)) {
    stops.set(stop.sessionId, Math.max(stops.get(stop.sessionId) || 0, stop.t))
  }

  const components = bashOverlapComponents(unresolvedBashOverlapEvents(root, events))

  return components.flatMap(component => {
    const sessionIds = new Set()
    const completionTimes = new Map()
    const paths = new Map()
    for (const event of component.events.sort((a, b) => a.t - b.t)) {
      for (const sessionId of event.sessionIds || []) sessionIds.add(sessionId)
      if (event.completedSessionId && Number.isFinite(event.completedAt)) {
        completionTimes.set(event.completedSessionId, Math.max(
          completionTimes.get(event.completedSessionId) || 0,
          event.completedAt
        ))
      } else {
        for (const sessionId of event.sessionIds || []) {
          completionTimes.set(sessionId, Math.max(completionTimes.get(sessionId) || 0, event.t))
        }
      }
      for (const item of event.paths || []) paths.set(item.path, item)
    }
    const ready = [...sessionIds].every(sessionId => {
      const completedAt = completionTimes.get(sessionId)
      return Number.isFinite(completedAt) && (stops.get(sessionId) || 0) >= completedAt
    })
    if (!ready) return []
    return [{
      eventIds: component.events.map(event => event.id),
      sessionIds: [...sessionIds].sort(),
      paths: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path))
    }]
  })
}

function compactBashOverlapEvents (root) {
  const overlaps = unresolvedBashOverlapEvents(root)
  const file = bashOverlapPath(root)
  if (!file) return
  if (overlaps.length === 0) {
    try { fs.unlinkSync(file) } catch {}
    for (const stop of readBashSessionStops(root)) {
      try { fs.unlinkSync(bashSessionStopPath(root, stop.sessionId)) } catch {}
    }
    return
  }

  const referencedSessions = new Set(overlaps.flatMap(event => event.sessionIds || []))
  for (const stop of readBashSessionStops(root)) {
    if (referencedSessions.has(stop.sessionId)) continue
    try { fs.unlinkSync(bashSessionStopPath(root, stop.sessionId)) } catch {}
  }
  ensureDir(path.dirname(file))
  const temporary = file + `.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, overlaps
      .sort((a, b) => a.t - b.t)
      .map(event => JSON.stringify(event)).join('\n') + '\n')
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function resolveBashOverlap (root, eventIds) {
  appendBashOverlapEvent(root, {
    type: 'resolved',
    root: canonicalRoot(root),
    eventIds,
    t: Date.now()
  })
}

function invalidateBashOverlap (root, eventIds, reason) {
  appendBashOverlapEvent(root, {
    type: 'invalidated',
    root: canonicalRoot(root),
    eventIds,
    reason,
    t: Date.now()
  })
}

function hasActiveBashSnapshot (root) {
  const dir = bashSnapshotDir(root)
  const checkout = canonicalRoot(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return false
  }
  return files.some(file => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      return canonicalRoot(snapshot.root) === checkout && !Number.isFinite(snapshot.endedAt)
    } catch {
      return false
    }
  })
}

function acquireBashOverlapRecoveryLock (root, waitMs = 0) {
  // update-ref supplies the compare-and-swap that a lock file cannot. A stale
  // owner can only be replaced if the ref still points to its exact token.
  // Released token blobs become unreachable and are removed by normal Git GC.
  const ref = bashOverlapRecoveryLockRef(root)
  const gitDir = gitCommonDir(root)
  if (!ref || !gitDir) return null
  const deadline = Date.now() + waitMs
  const owner = JSON.stringify({
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    token: crypto.randomUUID()
  })
  const token = writeRecoveryLockOwner(gitDir, owner)
  if (!token) return null
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    if (!fs.existsSync(root)) return null
    const state = readRecoveryLockToken(gitDir, ref)
    if (!state.ok) return null
    const current = state.token
    if ((!current && updateRecoveryLock(gitDir, ref, token, '0'.repeat(token.length))) ||
      (current && !isRecoveryLockOwnerAlive(gitDir, current) && updateRecoveryLock(gitDir, ref, token, current))) {
      return () => {
        deleteRecoveryLock(gitDir, ref, token)
      }
    }
    if (Date.now() >= deadline) return null
    Atomics.wait(sleeper, 0, 0, Math.min(25, deadline - Date.now()))
  }
}

function waitForBashOverlapRecovery (root, waitMs) {
  const ref = bashOverlapRecoveryLockRef(root)
  const gitDir = gitCommonDir(root)
  if (!ref || !gitDir) return false
  const deadline = Date.now() + waitMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    if (!fs.existsSync(root)) return false
    const state = readRecoveryLockToken(gitDir, ref)
    if (!state.ok) return false
    const current = state.token
    if (state.ok && !current) return true
    if (current && !isRecoveryLockOwnerAlive(gitDir, current) && deleteRecoveryLock(gitDir, ref, current)) continue
    if (Date.now() >= deadline) return false
    Atomics.wait(sleeper, 0, 0, Math.min(25, deadline - Date.now()))
  }
}

function writeRecoveryLockOwner (gitDir, owner) {
  try {
    return execFileSync('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], {
      cwd: stableGitCwd(gitDir),
      input: owner,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim() || null
  } catch {
    return null
  }
}

function readRecoveryLockToken (gitDir, ref) {
  try {
    const token = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', ref], {
      cwd: stableGitCwd(gitDir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null
    return { ok: true, token }
  } catch (error) {
    return { ok: error?.status === 1, token: null }
  }
}

function isRecoveryLockOwnerAlive (gitDir, token) {
  let owner
  try {
    owner = execFileSync('git', ['--git-dir', gitDir, 'cat-file', 'blob', token], {
      cwd: stableGitCwd(gitDir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return false
  }
  const parsed = parseRecoveryLockOwner(owner)
  const pid = parsed?.pid
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (parsed.startIdentity) {
    const currentStartIdentity = processStartIdentity(pid)
    if (currentStartIdentity && currentStartIdentity !== parsed.startIdentity) return false
  }
  return isProcessAlive(pid)
}

function updateRecoveryLock (gitDir, ref, token, expected) {
  try {
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', ref, token, expected], {
      cwd: stableGitCwd(gitDir),
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function deleteRecoveryLock (gitDir, ref, expected) {
  try {
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', '-d', ref, expected], {
      cwd: stableGitCwd(gitDir),
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function stableGitCwd (gitDir) {
  const parent = path.dirname(gitDir)
  return fs.existsSync(parent) ? parent : process.cwd()
}

function parseRecoveryLockOwner (owner) {
  try {
    const parsed = JSON.parse(owner)
    if (Number.isInteger(parsed?.pid)) return parsed
  } catch {}
  const pid = Number(owner.split(':', 1)[0])
  return Number.isInteger(pid) ? { pid } : null
}

function processStartIdentity (pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null
  } catch {
    return null
  }
}

function isProcessAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function appendTracking (root, sessionId, entry) {
  const file = trackingPath(root, sessionId)
  if (!file) return
  ensureDir(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

function savePreclaim (root, sessionId, entry) {
  const dir = preclaimDir(root)
  if (!dir) throw new Error('Cannot persist path ownership outside a git repository')
  ensureDir(dir)
  const file = path.join(dir, `${crypto.randomUUID()}.json`)
  const temporary = file + `.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ sessionId, entry }) + '\n')
    fs.renameSync(temporary, file)
    return file
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function removePreclaim (file) {
  if (!file) return
  try { fs.unlinkSync(file) } catch {}
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
  const dir = preclaimDir(root)
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const fullPath = path.join(dir, file)
      const claim = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
      if (claim.sessionId === sessionId) fs.unlinkSync(fullPath)
    } catch {}
  }
}

module.exports = {
  handleTrack,
  handlePostTrack,
  finalizeBashSnapshots,
  pruneBashSnapshots,
  recordBashSessionStop,
  readBashOverlapEvents,
  readBashSessionStops,
  readReadyBashOverlaps,
  compactBashOverlapEvents,
  resolveBashOverlap,
  invalidateBashOverlap,
  hasActiveBashSnapshot,
  acquireBashOverlapRecoveryLock,
  bashOverlapRecoveryLockRef,
  bashSnapshotPath,
  fingerprintTrackedPath,
  claimedPathsBySessions,
  hasTrackedModifications,
  cleanupTracking,
  extractFilePath,
  extractFilePaths,
  extractRawFilePaths,
  readTracking,
  trackingDir,
  trackingPath
}
