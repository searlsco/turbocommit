const fs = require('fs')
const os = require('os')
const path = require('path')

const HARNESSES = ['claude', 'codex']

function parseHarnessArg (argv) {
  const args = []
  let harness = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--harness') {
      harness = argv[++i]
    } else if (arg.startsWith('--harness=')) {
      harness = arg.slice('--harness='.length)
    } else {
      args.push(arg)
    }
  }
  if (harness && !HARNESSES.includes(harness)) {
    return { ok: false, error: `Invalid harness: ${harness}`, args, harness }
  }
  return { ok: true, args, harness }
}

function claudeHome () {
  return path.join(os.homedir(), '.claude')
}

function codexHome () {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function harnessHome (harness) {
  return harness === 'codex' ? codexHome() : claudeHome()
}

function existingHarnesses () {
  return HARNESSES.filter(h => fs.existsSync(harnessHome(h)))
}

function selectedHarnesses (harness, { create = false } = {}) {
  if (harness) {
    if (create) fs.mkdirSync(harnessHome(harness), { recursive: true })
    return [harness]
  }
  return existingHarnesses()
}

function inferHarness (hookInput, forcedHarness) {
  if (forcedHarness) return forcedHarness
  if (hookInput && hookInput.hook_event_name) return 'codex'
  return 'claude'
}

function normalizeHookInput (input, event, forcedHarness) {
  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return null
  }
  const harness = inferHarness(hookInput, forcedHarness)
  const hookEvent = hookInput.hook_event_name || eventName(event)
  return {
    harness,
    event: hookEvent,
    sessionId: hookInput.session_id,
    transcriptPath: hookInput.transcript_path,
    toolName: hookInput.tool_name,
    toolInput: hookInput.tool_input || {},
    cwd: hookInput.cwd,
    model: hookInput.model,
    source: hookInput.source,
    raw: hookInput
  }
}

function eventName (event) {
  const names = {
    'pre-tool-use': 'PreToolUse',
    'session-start': 'SessionStart',
    'session-end': 'SessionEnd',
    'pre-compact': 'PreCompact',
    stop: 'Stop'
  }
  return names[event] || event
}

module.exports = {
  HARNESSES,
  parseHarnessArg,
  claudeHome,
  codexHome,
  harnessHome,
  existingHarnesses,
  selectedHarnesses,
  normalizeHookInput
}
