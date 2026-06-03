#!/usr/bin/env node

const { readStdin } = require('./lib/io')
const { install, uninstall } = require('./lib/install')
const { init, deinit } = require('./lib/init')
const { run, runPreCompact } = require('./lib/run')
const { handleTrack } = require('./lib/track')
const { handleSessionStart, handleSessionEnd } = require('./lib/session')
const { doctor } = require('./lib/doctor')
const { monitor } = require('./lib/monitor')
const { gitRoot } = require('./lib/git')
const { parseHarnessArg, normalizeHookInput } = require('./lib/harness')

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
  const event = argv[0]
  try {
    const input = readStdin()
    const hookInput = normalizeHookInput(input, event, harness)
    if (!hookInput) return
    const root = gitRoot(hookInput.cwd || process.cwd())
    switch (event) {
      case 'pre-tool-use':
        handleTrack(hookInput, root)
        return
      case 'session-start':
        handleSessionStart(hookInput, root)
        return
      case 'session-end':
        handleSessionEnd(hookInput, root)
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
