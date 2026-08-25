#!/usr/bin/env node

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { readStdin, ensureDir } = require('./lib/io')
const { install, uninstall } = require('./lib/install')
const { init, deinit } = require('./lib/init')
const { run, runPreCompact, recoverBashOverlaps } = require('./lib/run')
const { handleTrack, handlePostTrack, finalizeBashSnapshots, recordBashSessionStop, readTracking } = require('./lib/track')
const { handleSessionStart, handleSessionEnd, turbocommitDir } = require('./lib/session')
const { doctor } = require('./lib/doctor')
const { monitor } = require('./lib/monitor')
const { gitRoot, pushClean } = require('./lib/git')
const { activeConfig } = require('./lib/config')
const { logEvent } = require('./lib/log')
const { parseHarnessArg, normalizeHookInput } = require('./lib/harness')
const {
  createSessionEndRescue,
  restoreSessionEndRescue,
  matchesSessionEndRescueRoot,
  finalizeRestoredSessionEndRescue,
  preserveSessionEndRecoveredCommit,
  recordPreservedSessionEndRescue,
  removeSessionEndRescueWorktree,
  cleanupSessionEndRescue,
  isClean
} = require('./lib/rescue')

const VERSION = require('./package.json').version

const USAGE = `turbocommit v${VERSION}
Auto-commit after every AI coding agent turn.

Commands:
  install     Add turbocommit hooks to installed harnesses
  uninstall   Remove turbocommit hooks
  init        Create .turbocommit.json in current git repo
  deinit      Remove turbocommit project config
  doctor      Check hook and config health
  monitor     Tail the event log (start/success/fail)
  hook        Hook entry points (called by harness hooks, not manually)
  help        Show this help text
  --version, -v  Show version

Usage:
  turbocommit install     # set up the global hooks
  turbocommit init        # enable in a project
  turbocommit doctor      # verify everything is wired correctly
  turbocommit monitor     # watch commits in real-time
`

function main (argv) {
  const parsed = parseHarnessArg(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    console.error('Run "turbocommit help" for usage.')
    process.exitCode = 1
    return
  }
  const cmd = parsed.args[0]

  switch (cmd) {
    case 'install':
      return cmdInstall(parsed.harness)
    case 'uninstall':
      return cmdUninstall(parsed.harness)
    case 'doctor':
      return cmdDoctor(parsed.harness)
    case 'monitor':
      return cmdMonitor(parsed.harness)
    case 'init':
      return cmdInit()
    case 'deinit':
      return cmdDeinit()
    case 'hook':
      return cmdHook(parsed.args.slice(1), parsed.harness)
    case 'session-end-worker':
      return cmdSessionEndWorker(parsed.args.slice(1), parsed.harness)
    case 'session-end-rescue-worker':
      return cmdSessionEndRescueWorker(parsed.args.slice(1))
    case 'run':
      return cmdRunDeprecated()
    case '--version':
    case '-v':
    case 'version':
      console.log(VERSION)
      return
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE)
      return
    default:
      console.error(`Unknown command: ${cmd}`)
      console.error('Run "turbocommit help" for usage.')
      process.exitCode = 1
  }
}

function cmdInstall (harness) {
  const result = install({ harness })
  if (result.results.length === 0) {
    console.log('No supported harness config dirs found.')
    return
  }
  for (const r of result.results) {
    console.log(r.alreadyInstalled ? `turbocommit already installed for ${r.harness}.` : `turbocommit installed for ${r.harness}.`)
    console.log(`  ${r.harness === 'codex' ? 'Hooks' : 'Settings'}: ${r.hooksPath || r.settingsPath}`)
  }
  console.log('')
  console.log('════════════════════════════════════════════════════════════════════')
  for (const r of result.results) {
    if (r.harness === 'codex') {
      console.log('IMPORTANT: Restart Codex and run /hooks to review turbocommit hooks.')
    } else {
      console.log('IMPORTANT: Restart Claude Code for the hooks to take effect.')
    }
  }
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Restart the installed harness')
  console.log('  2. Run: turbocommit init  in a repo to enable auto-commits')
}

function cmdUninstall (harness) {
  const result = uninstall({ harness })
  if (result.results.length === 0) {
    console.log('No supported harness config dirs found.')
    return
  }
  for (const r of result.results) {
    console.log(r.wasInstalled ? `turbocommit uninstalled for ${r.harness}.` : `turbocommit was not installed for ${r.harness}.`)
    console.log(`  ${r.harness === 'codex' ? 'Hooks' : 'Settings'}: ${r.hooksPath || r.settingsPath}`)
  }
}

function cmdInit () {
  const result = init()
  if (!result.ok) {
    console.error(`Error: ${result.error}`)
    process.exitCode = 1
    return
  }
  if (result.alreadyExists) {
    console.log('turbocommit already enabled in this repo.')
    console.log(`  Config: ${result.path}`)
    return
  }
  console.log('turbocommit enabled.')
  console.log(`  Config: ${result.path}`)
}

function cmdDeinit () {
  const result = deinit()
  if (!result.ok) {
    console.error(`Error: ${result.error}`)
    process.exitCode = 1
    return
  }
  if (!result.existed) {
    console.log('turbocommit project config was not found.')
    console.log('Global config may still enable turbocommit.')
    return
  }
  console.log('turbocommit disabled.')
  for (const p of result.paths) console.log(`  Removed: ${p}`)
}

function cmdDoctor (harness) {
  const STATUS = { ok: '  ok', warn: 'warn', error: ' err', info: 'info' }
  const result = doctor({ harness })
  for (const check of result.checks) {
    console.log(`[${STATUS[check.status] || check.status}] ${check.name}: ${check.message}`)
  }
  if (!result.ok) {
    process.exitCode = 1
  }
}

function cmdMonitor (harness) {
  if (!monitor(harness)) process.exitCode = 1
}

function cmdHook (argv, harness) {
  if (process.env.TURBOCOMMIT_DISABLED) return
  const event = argv[0]
  try {
    const input = readStdin()
    const hookInput = normalizeHookInput(input, event, harness)
    if (!hookInput) return
    const root = gitRoot(hookInput.cwd || process.cwd())
    switch (event) {
      case 'pre-tool-use':
        try {
          if (handleTrack(hookInput, root) === false) denyPreToolUse()
        } catch {
          denyPreToolUse()
        }
        return
      case 'post-tool-use':
        handlePostTrack(hookInput, root)
        return
      case 'session-start':
        handleSessionStart(hookInput, root)
        return
      case 'session-end':
        handleSessionEnd(hookInput, root)
        if (hookInput.harness === 'claude') {
          let completed = false
          try { completed = completeSessionEnd(hookInput, root, 45000) } catch {}
          if (!completed) rescueClaudeSessionEnd(hookInput, root)
        } else {
          spawnSessionEndWorker(hookInput, root, harness)
        }
        return
      case 'pre-compact':
        runPreCompact(hookInput)
        return
      case 'stop':
        run(hookInput)
        break
      default:
        // Unknown hook event: ignore silently (never fail)
        break
    }
  } catch {
    // Never fail: fire and forget
  }
}

function spawnSessionEndWorker (hookInput, root, harness) {
  if (process.env.TURBOCOMMIT_DISABLED || !root || !hookInput.sessionId) return
  const transcript = copySessionEndTranscript(root, hookInput.transcriptPath)
  const payload = Buffer.from(JSON.stringify({
    sessionId: hookInput.sessionId,
    event: 'SessionEnd',
    cwd: root,
    harness: hookInput.harness || harness,
    transcriptPath: transcript.path,
    temporaryTranscript: transcript.temporary,
    model: hookInput.model
  })).toString('base64url')
  const args = [__filename, 'session-end-worker', payload]
  if (harness) args.push('--harness', harness)
  const child = spawn(process.execPath, args, {
    cwd: stableWorkerCwd(root),
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => {
    if (transcript.temporary) cleanupSessionEndTranscript(root, transcript.path)
  })
  child.unref()
}

function cmdSessionEndWorker (argv, harness) {
  if (process.env.TURBOCOMMIT_DISABLED) return
  let hookInput
  try {
    hookInput = JSON.parse(Buffer.from(argv[0], 'base64url').toString('utf8'))
  } catch {
    return
  }
  hookInput.harness = hookInput.harness || harness
  const root = gitRoot(hookInput.cwd || process.cwd())
  try {
    if (!root || !hookInput.sessionId) return
    completeSessionEnd(hookInput, root, Infinity)
  } finally {
    if (hookInput.temporaryTranscript) cleanupTemporarySessionEndTranscript(root, hookInput.transcriptPath)
  }
}

function completeSessionEnd (hookInput, root, waitMs, { deferPush = false } = {}) {
  if (!root || !hookInput.sessionId) return false
  const deadline = waitMs === Infinity ? Infinity : Date.now() + waitMs
  const remainingWait = () => deadline === Infinity ? Infinity : Math.max(0, deadline - Date.now())
  const finalized = finalizeBashSnapshots(root, hookInput.sessionId, Date.now(), remainingWait())
  if (finalized == null) return false
  if (readTracking(root, hookInput.sessionId).length > 0) {
    run(hookInput, { recoveryDeadline: deadline, operationDeadline: deadline, deferPush })
    return readTracking(root, hookInput.sessionId).length === 0
  }
  recordBashSessionStop(root, hookInput.sessionId)
  const recoveryConfig = deferPush ? { ...activeConfig(root).config, push: false } : undefined
  recoverBashOverlaps(root, hookInput, recoveryConfig, remainingWait())
  return true
}

function rescueClaudeSessionEnd (hookInput, root) {
  if (!root || !hookInput.sessionId) return
  const transcript = copySessionEndTranscript(root, hookInput.transcriptPath)
  const rescueInput = {
    ...hookInput,
    transcriptPath: transcript.path,
    temporaryTranscript: transcript.temporary
  }
  const rescue = createSessionEndRescue(root, rescueInput)
  if (!rescue) {
    if (transcript.temporary) cleanupTemporarySessionEndTranscript(root, transcript.path)
    return
  }
  spawnSessionEndRescueWorker(rescue)
}

function spawnSessionEndRescueWorker (rescue) {
  const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
  const child = spawn(process.execPath, [__filename, 'session-end-rescue-worker', payload], {
    cwd: stableWorkerCwd(rescue.root),
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', () => {})
  child.unref()
}

function cmdSessionEndRescueWorker (argv) {
  let rescue
  try {
    rescue = JSON.parse(Buffer.from(argv[0], 'base64url').toString('utf8'))
  } catch {
    return
  }
  let recreated = false
  let completed = false
  try {
    const existingRoot = gitRoot(rescue.root)
    if (existingRoot) {
      if (!matchesSessionEndRescueRoot(rescue, existingRoot)) return
      try { completed = completeSessionEnd(rescue.hookInput, existingRoot, Infinity) } catch {}
    }
    if (!completed && !fs.existsSync(rescue.root)) {
      recreated = restoreRescueWithRetry(rescue)
      if (recreated) {
        try { completed = completeSessionEnd(rescue.hookInput, rescue.root, Infinity, { deferPush: true }) } catch {}
      }
    }
    if (!completed) return
    const clean = isClean(rescue.root)
    if (!recreated) {
      const recovered = preserveSessionEndRecoveredCommit(rescue, rescue.root)
      if (!recovered) return
      if (clean) {
        cleanupSessionEndRescue(rescue)
      } else {
        recordPreservedSessionEndRescue(rescue, recovered, 'dirty-existing-worktree')
      }
    } else {
      const finalized = finalizeRestoredSessionEndRescue(rescue, { clean })
      if (finalized.resolved) {
        pushRestoredSessionEndRescue(rescue, finalized)
        if (isClean(rescue.root)) {
          cleanupSessionEndRescue(rescue, { removeWorktree: true })
        } else {
          recordPreservedSessionEndRescue(rescue, finalized, 'dirty-attached-worktree')
        }
      } else if (finalized.preserved && finalized.removeWorktree) {
        removeSessionEndRescueWorktree(rescue)
      }
    }
    if (rescue.hookInput?.temporaryTranscript) {
      cleanupTemporarySessionEndTranscript(rescue.root, rescue.hookInput.transcriptPath)
    }
  } catch {
    // The rescue ref and record remain available for a later retry.
  }
}

function pushRestoredSessionEndRescue (rescue, finalized) {
  const config = activeConfig(rescue.root).config
  if (config.push !== true) return
  const pushed = finalized.attached && pushClean(rescue.root)
  logEvent(pushed ? 'push' : 'push-fail', {
    harness: rescue.hookInput?.harness,
    project: path.basename(rescue.root),
    branch: rescue.branch
  })
}

function restoreRescueWithRetry (rescue) {
  const deadline = Date.now() + 30000
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(rescue.root)) {
    if (restoreSessionEndRescue(rescue)) return true
    if (Date.now() >= deadline) return false
    Atomics.wait(sleeper, 0, 0, 100)
  }
  return false
}

function stableWorkerCwd (root) {
  const base = turbocommitDir(root)
  return base ? path.dirname(base) : root
}

function copySessionEndTranscript (root, source) {
  if (!source) return { path: source, temporary: false }
  const base = turbocommitDir(root)
  if (!base) return { path: source, temporary: false }
  const dir = path.join(base, 'session-end-transcripts')
  const destination = path.join(dir, `${process.pid}-${crypto.randomUUID()}.jsonl`)
  try {
    ensureDir(dir)
    fs.copyFileSync(source, destination)
    return { path: destination, temporary: true }
  } catch {
    return { path: source, temporary: false }
  }
}

function cleanupSessionEndTranscript (root, transcriptPath) {
  const base = turbocommitDir(root)
  if (!base || !transcriptPath) return false
  const dir = path.join(base, 'session-end-transcripts')
  if (path.dirname(path.resolve(transcriptPath)) !== path.resolve(dir)) return false
  try { fs.unlinkSync(transcriptPath) } catch {}
  return !fs.existsSync(transcriptPath)
}

function cleanupTemporarySessionEndTranscript (root, transcriptPath) {
  if (root && cleanupSessionEndTranscript(root, transcriptPath)) return
  if (!transcriptPath) return
  const resolved = path.resolve(transcriptPath)
  if (path.basename(path.dirname(resolved)) !== 'session-end-transcripts') return
  if (!/^\d+-[0-9a-f-]{36}\.jsonl$/i.test(path.basename(resolved))) return
  try { fs.unlinkSync(resolved) } catch {}
}

function denyPreToolUse () {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'turbocommit could not safely persist path ownership; retry the tool'
    }
  }) + '\n')
}

function cmdRunDeprecated () {
  let hookInput
  try {
    hookInput = JSON.parse(readStdin())
  } catch {
    hookInput = {}
  }
  // Prevent infinite loop: if we already blocked once, let Claude stop
  if (hookInput.stop_hook_active) return
  const msg = 'turbocommit hooks are outdated (v0.6). ' +
    'Auto-commits are paused until you upgrade. ' +
    'Run: turbocommit install'
  // Block the stop so the agent sees the reason and can relay it to the user
  const output = JSON.stringify({ decision: 'block', reason: msg })
  process.stdout.write(output + '\n')
}

main(process.argv.slice(2))
