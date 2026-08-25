const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson } = require('./io')
const { parseTranscript, parseCodexTranscript, formatBody, formatTitleTranscript, extractHeadline, extractModel, extractCodexModel } = require('./transcript')
const { runTitleAgent, runBodyAgent } = require('./agent')
const { gitRoot, hasChanges, changedPaths, addAndCommit, stagePaths, commitPaths, commitStagedPaths, stagedChangeContext, currentBranch, pushClean, hasRepositoryOperation } = require('./git')
const { logEvent } = require('./log')
const { wrapText } = require('./wrap')
const {
  hasTrackedModifications,
  cleanupTracking,
  readTracking,
  finalizeBashSnapshots,
  recordBashSessionStop,
  readReadyBashOverlaps,
  pruneBashSnapshots,
  compactBashOverlapEvents,
  resolveBashOverlap,
  invalidateBashOverlap,
  hasActiveBashSnapshot,
  acquireBashOverlapRecoveryLock,
  fingerprintTrackedPath,
  claimedPathsBySessions
} = require('./track')
const { redact, buildRedactions } = require('./redact')
const { handleSessionEnd, getAncestors, savePending, collectPending, cleanupConsumed, cleanupStale, readWatermark, saveWatermark, resolveParentCommit } = require('./session')
const { activeConfig } = require('./config')
const { normalizeHookInput } = require('./harness')
const { resolveCodexTranscriptPath } = require('./codex')
const {
  appendWork,
  deleteManifestIfEmpty,
  dependencyOrder,
  loadManifest,
  readMultiWatermark,
  trackedChangesFromEntries,
  saveManifest,
  saveMultiWatermark
} = require('./multi')

/**
 * Map a model ID like "claude-opus-4-6" to a friendly name like "Claude Opus 4.6".
 * Handles both new (claude-opus-4-6) and old (claude-3-5-sonnet-20241022) formats
 * by separating parts into alphabetic (tier) and numeric (version) groups.
 */
function formatModelName (modelId) {
  if (!modelId) return null
  const stripped = modelId.replace(/^claude-/, '')
  if (stripped === modelId) return modelId // not a claude model, use as-is
  const withoutDate = stripped.replace(/-\d{8}$/, '')
  const parts = withoutDate.split('-')
  const alpha = parts.filter(p => /^[a-z]+$/i.test(p))
  const numeric = parts.filter(p => /^\d+$/.test(p))
  if (alpha.length === 0 || numeric.length === 0) return modelId
  const tier = alpha.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const version = numeric.join('.')
  return `Claude ${tier} ${version}`
}

/**
 * Read Claude Code's attribution.commit setting.
 * Returns the string value (including empty string for explicit opt-out),
 * or undefined when the setting is absent / not running under Claude Code.
 */
function readClaudeAttribution (root) {
  if (!process.env.CLAUDECODE) return undefined
  const globalSettings = loadJson(path.join(os.homedir(), '.claude', 'settings.json'))
  const projectSettings = root ? loadJson(path.join(root, '.claude', 'settings.json')) : null
  const projectVal = projectSettings?.attribution?.commit
  const globalVal = globalSettings?.attribution?.commit
  if (projectVal !== undefined) return projectVal
  if (globalVal !== undefined) return globalVal
  return undefined
}

/**
 * Resolve the Co-Authored-By trailer value.
 * Returns the full trailer line or null.
 *
 * Tier 1: turbocommit config (coauthor: false → null, string → use it)
 * Tier 2: Claude Code attribution.commit setting (when running under Claude)
 * Tier 3: auto-detect model from transcript
 */
function resolveCoauthor (config, transcriptPath, root, opts = {}) {
  // Tier 1: explicit turbocommit config
  if (config.coauthor === false) return null

  if (typeof config.coauthor === 'string') {
    return `Co-Authored-By: ${config.coauthor}`
  }

  // Tier 2: Claude Code attribution setting
  const claudeAttr = opts.harness === 'codex' ? undefined : readClaudeAttribution(root)
  if (claudeAttr !== undefined) {
    return claudeAttr === '' ? null : claudeAttr
  }

  // Tier 3: auto-detect from transcript
  const model = opts.harness === 'codex'
    ? extractCodexModel(transcriptPath, opts.model)
    : extractModel(transcriptPath)
  if (!model) return null
  const name = formatModelName(model)
  const email = opts.harness === 'codex' ? 'noreply@openai.com' : 'noreply@anthropic.com'
  return `Co-Authored-By: ${name} <${email}>`
}

/**
 * Core auto-commit logic. Called by `turbocommit hook stop`.
 * Reads hook input, checks bail conditions, and commits.
 * Always exits 0 — never blocks Claude, never outputs to stdout.
 *
 * Skip/commit decision is based on PreToolUse tracking:
 * - If tracking file contains changed paths → commit only those paths
 * - If tracking file missing/empty → skip, buffer transcript for later pickup
 */
function run (input, opts = {}) {
  if (process.env.TURBOCOMMIT_DISABLED) return
  const hookInput = typeof input === 'string'
    ? normalizeHookInput(input, 'stop', opts.harness)
    : input
  if (!hookInput) return

  const root = gitRoot(hookInput.cwd || process.cwd())
  if (!root) return
  const { config } = activeConfig(root)
  if (config.enabled !== true) return
  const recoveryDeadline = opts.recoveryDeadline ?? recoveryDeadlineFromWait(opts.recoveryWaitMs ?? 5000)

  if (hookInput.sessionId) {
    const finalized = finalizeBashSnapshots(root, hookInput.sessionId, Date.now(), remainingRecoveryWait(recoveryDeadline))
    if (finalized == null) return
    recordBashSessionStop(root, hookInput.sessionId)
  }

  try {
    return runTrackedStop(hookInput, root, opts)
  } finally {
    const recoveryConfig = opts.deferPush ? { ...config, push: false } : config
    recoverBashOverlaps(root, hookInput, recoveryConfig, remainingRecoveryWait(recoveryDeadline))
  }
}

function recoveryDeadlineFromWait (waitMs) {
  return waitMs === Infinity ? Infinity : Date.now() + waitMs
}

function remainingRecoveryWait (deadline) {
  return deadline === Infinity ? Infinity : Math.max(0, deadline - Date.now())
}

function runTrackedStop (hookInput, root, opts) {
  const entries = hookInput.sessionId ? readTracking(root, hookInput.sessionId) : []
  const tracked = trackedChangesFromEntries(root, entries)
  const manifest = loadManifest(root)
  if (manifest.discardedLegacyWork > 0) {
    logEvent('skip', {
      harness: hookInput.harness,
      project: path.basename(root),
      branch: currentBranch(root),
      reason: 'legacy-manifest',
      discarded: manifest.discardedLegacyWork
    })
    manifest.discardedLegacyWork = 0
    deleteManifestIfEmpty(root, manifest)
  }
  const hasCrossRootPath = tracked.repos.length > 0 &&
    (tracked.repos.length !== 1 || tracked.repos[0].root !== root)

  if (tracked.ambiguous.length > 0) {
    return runSingle(hookInput, { paths: [], trackingReason: 'ambiguous-tracking', operationDeadline: opts.operationDeadline })
  }
  if (manifest.repos.length > 0 || tracked.repos.length > 1 || hasCrossRootPath) {
    return runMulti(hookInput, root, tracked.repos, manifest, opts)
  }
  return runSingle(hookInput, { paths: tracked.repos[0]?.paths || [], operationDeadline: opts.operationDeadline })
}

function recoverBashOverlaps (root, hookInput, config, waitMs = 5000) {
  if (process.env.TURBOCOMMIT_DISABLED || !root) return
  hookInput = hookInput || {}
  config = config || activeConfig(root).config
  if (config.enabled !== true) return
  const release = acquireBashOverlapRecoveryLock(root, waitMs)
  if (!release) return
  let shouldPush = false
  try {
    pruneBashSnapshots(root)
    if (hasActiveBashSnapshot(root) || hasRepositoryOperation(root)) return
    for (const overlap of readReadyBashOverlaps(root)) {
      const claimed = claimedPathsBySessions(root)
      const changedFingerprint = overlap.paths.some(item =>
        item.fingerprint == null || fingerprintTrackedPath(item.path) !== item.fingerprint)
      const claimedPath = overlap.paths.some(item => claimed.has(item.path))
      if (changedFingerprint || claimedPath) {
        logEvent('skip', {
          harness: hookInput.harness,
          project: path.basename(root),
          branch: currentBranch(root),
          reason: changedFingerprint ? 'bash-overlap-changed' : 'bash-overlap-claimed',
          paths: overlap.paths.length
        })
        if (changedFingerprint) {
          invalidateBashOverlap(root, overlap.eventIds, 'changed-fingerprint')
        }
        continue
      }

      const paths = changedPaths(root, overlap.paths.map(item => item.path))
      if (paths.length === 0) {
        resolveBashOverlap(root, overlap.eventIds)
        continue
      }

      const title = 'Recover overlapping shell changes'
      const body = 'Recovered unchanged paths observed during overlapping shell commands.\n\n' +
        overlap.sessionIds.map(sessionId => `Session: ${sessionId}`).join('\n')
      const commit = commitPaths(root, paths, title, body, { pathScoped: true })
      if (!commit) continue

      logEvent('success', {
        harness: hookInput.harness,
        project: path.basename(root),
        branch: currentBranch(root),
        title,
        recovered: paths.length
      })
      if (config.push === true) shouldPush = true
      resolveBashOverlap(root, overlap.eventIds)
    }
  } catch {
    logEvent('fail', {
      harness: hookInput.harness,
      project: path.basename(root),
      branch: currentBranch(root),
      reason: 'bash-overlap-recovery'
    })
  } finally {
    try { compactBashOverlapEvents(root) } catch {}
    release()
  }
  if (shouldPush) {
    logEvent(pushClean(root) ? 'push' : 'push-fail', {
      harness: hookInput.harness,
      project: path.basename(root),
      branch: currentBranch(root)
    })
  }
}

function runSingle (input, opts = {}) {
  if (process.env.TURBOCOMMIT_DISABLED) return

  const hookInput = typeof input === 'string'
    ? normalizeHookInput(input, 'stop', opts.harness)
    : input
  if (!hookInput) return

  // Find git root
  const root = gitRoot(hookInput.cwd || process.cwd())
  if (!root) return

  // Merge global + project config (project wins)
  const { config } = activeConfig(root)
  if (config.enabled !== true) return
  recordCodexStop(hookInput, root)

  // Parse transcript
  const transcriptPath = resolveTranscriptPath(hookInput)
  const pairs = hookInput.harness === 'codex'
    ? parseCodexTranscript(transcriptPath)
    : parseTranscript(transcriptPath)

  // Gather monitor metadata
  const project = path.basename(root)
  const branch = currentBranch(root)
  let context = 0
  try { context = fs.statSync(transcriptPath).size } catch {}

  const sessionId = hookInput.sessionId
  const ownedPaths = opts.paths || []

  // Watermark slicing: only include new pairs since last commit in this session
  const watermark = sessionId ? readWatermark(root, sessionId) : null
  const watermarkPairCount = watermark && Number.isInteger(watermark.pairs) ? watermark.pairs : 0
  const newPairs = watermark ? pairs.slice(watermarkPairCount) : pairs
  const precompactWatermark = watermark && watermark.source === 'precompact'
  const selfPrecompactPending = sessionId ? collectPending(root, [sessionId], { source: 'precompact' }) : []
  let effectivePairs = newPairs.length > 0 ? newPairs : pairs
  if (precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0) {
    const basePairs = Number.isInteger(watermark.basePairs) ? watermark.basePairs : 0
    const bufferedPairs = pairs.slice(basePairs, watermarkPairCount)
    effectivePairs = bufferedPairs.length > 0 ? bufferedPairs : pairs
  }

  // Skip decision: if PreToolUse never fired for this session, skip commit
  if (sessionId && !hasTrackedModifications(root, sessionId)) {
    if (!(precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0)) {
      savePending(root, sessionId, formatBody(effectivePairs))
    }
    cleanupTracking(root, sessionId)
    logEvent('skip', { harness: hookInput.harness, project, branch, context, reason: 'no-tracking' })
    cleanupStale(root)
    return
  }

  if (sessionId && (opts.trackingReason || ownedPaths.length === 0)) {
    if (!(precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0)) {
      savePending(root, sessionId, formatBody(effectivePairs))
    }
    cleanupTracking(root, sessionId)
    logEvent('skip', {
      harness: hookInput.harness,
      project,
      branch,
      context,
      reason: opts.trackingReason || 'no-path-changes'
    })
    cleanupStale(root)
    return
  }

  try {
    // Early exit: tracking fired but all changes were reverted
    const hasOwnedChanges = sessionId ? changedPaths(root, ownedPaths).length > 0 : hasChanges(root)
    if (!hasOwnedChanges) {
      if (sessionId) {
        if (!(precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0)) {
          savePending(root, sessionId, formatBody(effectivePairs))
        }
        cleanupTracking(root, sessionId)
      }
      logEvent('skip', { harness: hookInput.harness, project, branch, context, reason: 'no-path-changes' })
      cleanupStale(root)
      return
    }

    logEvent('start', { harness: hookInput.harness, project, branch, context })

    const formattedTranscript = formatBody(effectivePairs)

    // Title: agent by default, transcript if opted out
    let headline
    if (config.title?.type !== 'transcript') {
      const titleTranscript = formatTitleTranscript(effectivePairs)
      headline = runTitleAgent(root, config.title || {}, titleTranscript, hookInput.harness, { deadline: opts.operationDeadline })
    }
    headline = headline || extractHeadline(effectivePairs)

    // Body: transcript by default, agent if opted in
    let body
    if (config.body?.type === 'agent') {
      body = runBodyAgent(root, config.body, formattedTranscript, hookInput.harness, { deadline: opts.operationDeadline })
    }
    body = body || formattedTranscript

    // Continuation reference + pending transcripts from ancestor sessions
    let combinedBody = body
    if (sessionId) {
      const parentCommit = resolveParentCommit(root, sessionId)
      const continuation = parentCommit
        ? `Continuation of ${parentCommit.slice(0, 7)}\n\n`
        : ''

      const ancestors = getAncestors(root, sessionId)
      // Normal self-pending is already covered by effectivePairs. Precompact
      // self-pending is different because PreCompact advances the watermark.
      const pending = collectPending(root, [...ancestors].reverse())
      if (precompactWatermark && newPairs.length > 0 && selfPrecompactPending.length > 0) {
        pending.push(...selfPrecompactPending)
      }

      if (pending.length > 0) {
        combinedBody = continuation + '## Planning\n\n' + pending.join('\n\n---\n\n') +
          '\n\n## Implementation\n\n' + body
      } else {
        combinedBody = continuation + body
      }
    }

    // Wrap body lines if configured
    const wrappedBody = wrapText(combinedBody, config.body?.maxLineLength)

    // Resolve coauthor trailer
    const coauthor = resolveCoauthor(config, transcriptPath, root, {
      harness: hookInput.harness,
      model: hookInput.model
    })
    const tag = coauthor ? '\n\n' + coauthor : ''

    const redactions = buildRedactions()
    const safeHeadline = redact(headline, redactions)
    const safeBody = redact(wrappedBody + tag, redactions)
    const sha = sessionId
      ? commitPaths(root, ownedPaths, safeHeadline, safeBody)
      : addAndCommit(root, safeHeadline, safeBody)
    if (!sha) {
      if (sessionId) cleanupTracking(root, sessionId)
      logEvent('skip', {
        harness: hookInput.harness,
        project,
        branch,
        context,
        reason: 'no-path-changes'
      })
      cleanupStale(root)
      return
    }

    logEvent('success', { harness: hookInput.harness, project, branch, context, title: safeHeadline })

    if (config.push === true && !opts.deferPush) {
      if (pushClean(root)) {
        logEvent('push', { harness: hookInput.harness, project, branch })
      } else {
        logEvent('push-fail', { harness: hookInput.harness, project, branch })
      }
    }

    // Post-commit: save watermark and cleanup
    if (sessionId) {
      saveWatermark(root, sessionId, pairs.length, sha, { source: 'commit' })
      const ancestors = getAncestors(root, sessionId)
      cleanupConsumed(root, [...ancestors, sessionId])
      cleanupTracking(root, sessionId)
    }
    cleanupStale(root)
  } catch (err) {
    logEvent('fail', { harness: hookInput.harness, project, branch, context })
    throw err
  }
}

function runMulti (hookInput, anchor, currentRepos, manifest, opts = {}) {
  recordCodexStop(hookInput, anchor)

  const transcriptPath = resolveTranscriptPath(hookInput)
  const pairs = hookInput.harness === 'codex'
    ? parseCodexTranscript(transcriptPath)
    : parseTranscript(transcriptPath)
  const sessionId = hookInput.sessionId
  const watermark = sessionId ? readWatermark(anchor, sessionId) : null
  const watermarkPairCount = watermark && Number.isInteger(watermark.pairs) ? watermark.pairs : 0
  const newPairs = watermark ? pairs.slice(watermarkPairCount) : pairs
  const precompactWatermark = watermark && watermark.source === 'precompact'
  const selfPrecompactPending = sessionId
    ? collectPending(anchor, [sessionId], { source: 'precompact' })
    : []
  let effectivePairs = newPairs.length > 0 ? newPairs : pairs
  if (precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0) {
    const basePairs = Number.isInteger(watermark.basePairs) ? watermark.basePairs : 0
    const bufferedPairs = pairs.slice(basePairs, watermarkPairCount)
    effectivePairs = bufferedPairs.length > 0 ? bufferedPairs : pairs
  }
  const formattedTranscript = formatBody(effectivePairs)
  const ancestors = sessionId ? getAncestors(anchor, sessionId) : []
  const pending = sessionId ? collectPending(anchor, [...ancestors].reverse()) : []
  if (precompactWatermark && newPairs.length > 0 && selfPrecompactPending.length > 0) {
    pending.push(...selfPrecompactPending)
  }
  const turnBody = pending.length > 0
    ? '## Planning\n\n' + pending.join('\n\n---\n\n') +
      '\n\n## Implementation\n\n' + formattedTranscript
    : formattedTranscript

  const dirtyRepos = currentRepos.filter(repo => changedPaths(repo.root, repo.paths).length > 0)
  const isMultiTurn = currentRepos.length > 1
  const turnKey = hookInput.raw?.turn_id ||
    cryptoKey(`${sessionId || 'no-session'}\n${pairs.length}\n${turnBody}`)

  if (dirtyRepos.length === 0 && manifest.repos.length === 0) {
    if (sessionId) {
      savePending(anchor, sessionId, formattedTranscript)
      cleanupTracking(anchor, sessionId)
    }
    logEvent('skip', {
      harness: hookInput.harness,
      project: path.basename(anchor),
      branch: currentBranch(anchor),
      context: transcriptSize(transcriptPath),
      reason: 'no-path-changes'
    })
    return
  }

  for (const repo of currentRepos) {
    appendWork(manifest, repo.root, {
      key: turnKey,
      body: turnBody,
      sessionIds: isMultiTurn && sessionId ? [sessionId] : [],
      paths: repo.paths
    })
  }

  saveManifest(anchor, manifest)
  const successes = []
  const ordered = dependencyOrder(manifest.repos)

  for (const repo of ordered) {
    const root = repo.root
    const { config } = activeConfig(root)
    const project = path.basename(root)
    const branch = currentBranch(root)
    const context = transcriptSize(transcriptPath)
    const ownedPaths = [...new Set(repo.work.flatMap(item => item.paths || []))]

    if (config.enabled !== true) {
      manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
      logEvent('skip', { harness: hookInput.harness, project, branch, context })
      continue
    }
    if (ownedPaths.length === 0) {
      logEvent('skip', {
        harness: hookInput.harness,
        project,
        branch,
        context,
        reason: 'missing-manifest-paths'
      })
      continue
    }
    const currentPaths = changedPaths(root, ownedPaths)
    if (currentPaths.length === 0) {
      manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
      logEvent('skip', { harness: hookInput.harness, project, branch, context, reason: 'no-path-changes' })
      continue
    }

    try {
      logEvent('start', { harness: hookInput.harness, project, branch, context })
      const stagedPaths = stagePaths(root, currentPaths)
      if (stagedPaths.length === 0) {
        manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
        logEvent('skip', { harness: hookInput.harness, project, branch, context, reason: 'no-path-changes' })
        continue
      }

      const rawBody = repo.work.map(item => item.body).join('\n\n---\n\n')
      const redactions = buildRedactions()
      const changeContext = redact(stagedChangeContext(root, 10000, stagedPaths), redactions)
      const titleInput = `${changeContext}\n\nTranscript:\n${rawBody}`.slice(0, 20000)

      let headline
      if (config.title?.type !== 'transcript') {
        headline = runTitleAgent(root, config.title || {}, titleInput, hookInput.harness, { deadline: opts.operationDeadline })
      }
      headline = headline || extractHeadline(effectivePairs)

      let body
      if (config.body?.type === 'agent') {
        body = runBodyAgent(root, config.body, rawBody, hookInput.harness, { deadline: opts.operationDeadline })
      }
      body = body || rawBody

      const parent = sessionId
        ? readMultiWatermark(root, [sessionId, ...ancestors])
        : null
      if (parent?.commit) body = `Continuation of ${parent.commit.slice(0, 7)}\n\n${body}`
      body = wrapText(body, config.body?.maxLineLength)

      const trailers = []
      for (const work of repo.work) {
        for (const id of work.sessionIds || []) {
          if (!trailers.includes(id)) trailers.push(id)
        }
      }
      if (trailers.length > 0) {
        body += '\n\n' + trailers.map(id => `Turbocommit-Session: ${id}`).join('\n')
      }

      const coauthor = resolveCoauthor(config, transcriptPath, root, {
        harness: hookInput.harness,
        model: hookInput.model
      })
      if (coauthor) body += '\n\n' + coauthor

      const safeHeadline = redact(headline, redactions)
      const safeBody = redact(body, redactions)
      const sha = commitStagedPaths(root, stagedPaths, safeHeadline, safeBody)
      if (!sha) throw new Error('Tracked paths changed before commit')
      if (sessionId) saveMultiWatermark(root, sessionId, sha)
      if (root === anchor && sessionId) {
        saveWatermark(anchor, sessionId, pairs.length, sha, { source: 'commit' })
      }
      manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
      successes.push({ root, config, project, branch })
      logEvent('success', {
        harness: hookInput.harness,
        project,
        branch,
        context,
        title: safeHeadline
      })
    } catch {
      logEvent('fail', { harness: hookInput.harness, project, branch, context })
    }
  }

  for (const success of successes) {
    if (success.config.push !== true) continue
    if (opts.deferPush && success.root === anchor) continue
    if (pushClean(success.root)) {
      logEvent('push', {
        harness: hookInput.harness,
        project: success.project,
        branch: success.branch
      })
    } else {
      logEvent('push-fail', {
        harness: hookInput.harness,
        project: success.project,
        branch: success.branch
      })
    }
  }

  if (sessionId) {
    if (!readWatermark(anchor, sessionId)) {
      saveWatermark(anchor, sessionId, pairs.length, undefined, { source: 'multi' })
    }
    cleanupConsumed(anchor, [...ancestors, sessionId])
    cleanupTracking(anchor, sessionId)
  }
  deleteManifestIfEmpty(anchor, manifest)
  cleanupStale(anchor)
}

function transcriptSize (transcriptPath) {
  try {
    return fs.statSync(transcriptPath).size
  } catch {
    return 0
  }
}

function cryptoKey (value) {
  return require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function runPreCompact (input, opts = {}) {
  if (process.env.TURBOCOMMIT_DISABLED) return
  const hookInput = typeof input === 'string'
    ? normalizeHookInput(input, 'pre-compact', opts.harness)
    : input
  if (!hookInput || !hookInput.sessionId) return

  const root = gitRoot(hookInput.cwd || process.cwd())
  if (!root) return

  const transcriptPath = resolveTranscriptPath(hookInput)
  const pairs = hookInput.harness === 'codex'
    ? parseCodexTranscript(transcriptPath)
    : parseTranscript(transcriptPath)
  if (pairs.length === 0) return

  const existing = readWatermark(root, hookInput.sessionId)
  const existingPairCount = existing && Number.isInteger(existing.pairs) ? existing.pairs : 0
  const baseline = existingPairCount <= pairs.length ? existingPairCount : 0
  const pendingPairs = pairs.slice(baseline)
  if (pendingPairs.length > 0) {
    savePending(root, hookInput.sessionId, formatBody(pendingPairs), { source: 'precompact' })
  }
  const basePairs = existing && existing.source === 'precompact' && Number.isInteger(existing.basePairs)
    ? existing.basePairs
    : baseline
  saveWatermark(root, hookInput.sessionId, pairs.length, existing ? existing.commit : undefined, {
    source: 'precompact',
    basePairs
  })
}

function resolveTranscriptPath (hookInput) {
  return hookInput.harness === 'codex'
    ? resolveCodexTranscriptPath(hookInput)
    : hookInput.transcriptPath
}

function recordCodexStop (hookInput, root) {
  if (hookInput.harness === 'codex' && hookInput.event === 'Stop') handleSessionEnd(hookInput, root)
}

module.exports = { run, runPreCompact, recoverBashOverlaps, formatModelName, resolveCoauthor, readClaudeAttribution, resolveTranscriptPath, recordCodexStop }
