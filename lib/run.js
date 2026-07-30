const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadJson } = require('./io')
const { parseTranscript, parseCodexTranscript, formatBody, formatTitleTranscript, extractHeadline, extractModel, extractCodexModel } = require('./transcript')
const { runTitleAgent, runBodyAgent } = require('./agent')
const { gitRoot, hasChanges, addAndCommit, stageAll, commitStaged, stagedChangeContext, hasCommits, currentBranch, pushClean } = require('./git')
const { logEvent } = require('./log')
const { wrapText } = require('./wrap')
const { hasTrackedModifications, cleanupTracking, readTracking } = require('./track')
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
  rootsFromEntries,
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
 * - If tracking file exists with entries → this agent modified files → commit
 * - If tracking file missing/empty → skip, buffer transcript for later pickup
 */
function run (input, opts = {}) {
  if (process.env.TURBOCOMMIT_DISABLED) return
  const hookInput = typeof input === 'string'
    ? normalizeHookInput(input, 'stop', opts.harness)
    : input
  if (!hookInput) return

  const root = gitRoot(hookInput.cwd || process.cwd())
  if (!root || activeConfig(root).config.enabled !== true) return

  const entries = hookInput.sessionId ? readTracking(root, hookInput.sessionId) : []
  const roots = rootsFromEntries(root, entries)
  const manifest = loadManifest(root)
  const hasCrossRootPath = entries.some(entry =>
    Array.isArray(entry.files) && entry.files.length > 0
  ) && (roots.length !== 1 || roots[0] !== root)

  if (manifest.repos.length > 0 || roots.length > 1 || hasCrossRootPath) {
    return runMulti(hookInput, root, roots, manifest)
  }
  return runSingle(hookInput)
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
    logEvent('skip', { harness: hookInput.harness, project, branch, context })
    cleanupStale(root)
    return
  }

  try {
    // Early exit: tracking fired but all changes were reverted
    if (hasCommits(root) && !hasChanges(root)) {
      if (sessionId) {
        if (!(precompactWatermark && newPairs.length === 0 && selfPrecompactPending.length > 0)) {
          savePending(root, sessionId, formatBody(effectivePairs))
        }
        cleanupTracking(root, sessionId)
      }
      logEvent('skip', { harness: hookInput.harness, project, branch, context })
      cleanupStale(root)
      return
    }

    logEvent('start', { harness: hookInput.harness, project, branch, context })

    const formattedTranscript = formatBody(effectivePairs)

    // Title: agent by default, transcript if opted out
    let headline
    if (config.title?.type !== 'transcript') {
      const titleTranscript = formatTitleTranscript(effectivePairs)
      headline = runTitleAgent(root, config.title || {}, titleTranscript, hookInput.harness)
    }
    headline = headline || extractHeadline(effectivePairs)

    // Body: transcript by default, agent if opted in
    let body
    if (config.body?.type === 'agent') {
      body = runBodyAgent(root, config.body, formattedTranscript, hookInput.harness)
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
    const sha = addAndCommit(root, safeHeadline, safeBody)

    logEvent('success', { harness: hookInput.harness, project, branch, context, title: safeHeadline })

    if (config.push === true) {
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

function runMulti (hookInput, anchor, currentRoots, manifest) {
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

  const dirtyRoots = currentRoots.filter(root => !hasCommits(root) || hasChanges(root))
  const isMultiTurn = currentRoots.length > 1
  const turnKey = hookInput.raw?.turn_id ||
    cryptoKey(`${sessionId || 'no-session'}\n${pairs.length}\n${turnBody}`)

  if (dirtyRoots.length === 0 && manifest.repos.length === 0) {
    if (sessionId) {
      savePending(anchor, sessionId, formattedTranscript)
      cleanupTracking(anchor, sessionId)
    }
    logEvent('skip', {
      harness: hookInput.harness,
      project: path.basename(anchor),
      branch: currentBranch(anchor),
      context: transcriptSize(transcriptPath)
    })
    return
  }

  for (const root of currentRoots) {
    appendWork(manifest, root, {
      key: turnKey,
      body: turnBody,
      sessionIds: isMultiTurn && sessionId ? [sessionId] : []
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

    if (config.enabled !== true) {
      manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
      logEvent('skip', { harness: hookInput.harness, project, branch, context })
      continue
    }
    if (hasCommits(root) && !hasChanges(root)) {
      manifest.repos = manifest.repos.filter(candidate => candidate !== repo)
      logEvent('skip', { harness: hookInput.harness, project, branch, context })
      continue
    }

    try {
      logEvent('start', { harness: hookInput.harness, project, branch, context })
      stageAll(root)

      const rawBody = repo.work.map(item => item.body).join('\n\n---\n\n')
      const redactions = buildRedactions()
      const changeContext = redact(stagedChangeContext(root, 10000), redactions)
      const titleInput = `${changeContext}\n\nTranscript:\n${rawBody}`.slice(0, 20000)

      let headline
      if (config.title?.type !== 'transcript') {
        headline = runTitleAgent(root, config.title || {}, titleInput, hookInput.harness)
      }
      headline = headline || extractHeadline(effectivePairs)

      let body
      if (config.body?.type === 'agent') {
        body = runBodyAgent(root, config.body, rawBody, hookInput.harness)
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
      const sha = commitStaged(root, safeHeadline, safeBody)
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

module.exports = { run, runPreCompact, formatModelName, resolveCoauthor, readClaudeAttribution, resolveTranscriptPath, recordCodexStop }
