const path = require('path')
const { loadJson, writeJson } = require('./io')
const { selectedHarnesses, claudeHome, codexHome } = require('./harness')

/**
 * Hook definitions for each Claude Code event turbocommit uses.
 */
const HOOK_DEFS = {
  PreToolUse: {
    matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
    hooks: [{ type: 'command', command: 'turbocommit hook pre-tool-use --harness claude' }]
  },
  PostToolUse: {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'turbocommit hook post-tool-use --harness claude' }]
  },
  SessionStart: {
    hooks: [{ type: 'command', command: 'turbocommit hook session-start --harness claude' }]
  },
  SessionEnd: {
    hooks: [{ type: 'command', command: 'turbocommit hook session-end --harness claude' }]
  },
  Stop: {
    hooks: [{ type: 'command', command: 'turbocommit hook stop --harness claude' }]
  }
}

const CODEX_HOOK_DEFS = {
  PreToolUse: {
    matcher: 'apply_patch|Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
    hooks: [{ type: 'command', command: 'turbocommit hook pre-tool-use --harness codex' }]
  },
  PostToolUse: {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'turbocommit hook post-tool-use --harness codex' }]
  },
  SessionStart: {
    matcher: 'resume|clear',
    hooks: [{ type: 'command', command: 'turbocommit hook session-start --harness codex' }]
  },
  PreCompact: {
    matcher: 'manual|auto',
    hooks: [{ type: 'command', command: 'turbocommit hook pre-compact --harness codex' }]
  },
  Stop: {
    hooks: [{ type: 'command', command: 'turbocommit hook stop --harness codex' }]
  }
}

function getSettingsPath () {
  return path.join(claudeHome(), 'settings.json')
}

function getCodexHooksPath () {
  return path.join(codexHome(), 'hooks.json')
}

function hasTurbocommit (groups) {
  if (!Array.isArray(groups)) return false
  return groups.some(g => {
    const hooks = g && g.hooks ? g.hooks : []
    return hooks.some(h => h.command && h.command.includes('turbocommit'))
  })
}

/**
 * Check whether the exact expected command is already installed for an event.
 * Requiring an exact match (not just any turbocommit hook) means legacy
 * flagless installs are treated as out-of-date and get rewritten with the
 * explicit --harness flag on the next install.
 */
function hasExactHooks (groups, def) {
  if (!Array.isArray(groups)) return false
  const expected = def.hooks.map(h => h.command)
  return expected.every(cmd =>
    groups.some(g => {
      const hooks = g && g.hooks ? g.hooks : []
      const matcherMatches = def.matcher === undefined || g.matcher === def.matcher
      return matcherMatches && hooks.some(h => h.command === cmd)
    })
  )
}

/**
 * Check if turbocommit hooks are installed across all expected events.
 */
function isFullyInstalled (settings) {
  if (!settings || !settings.hooks) return false
  return Object.entries(HOOK_DEFS).every(([event, def]) =>
    hasExactHooks(settings.hooks[event], def)
  )
}

function isCodexFullyInstalled (hooksConfig) {
  if (!hooksConfig || !hooksConfig.hooks) return false
  return Object.entries(CODEX_HOOK_DEFS).every(([event, def]) =>
    hasExactHooks(hooksConfig.hooks[event], def)
  )
}

function removeTurbocommitHooks (groups) {
  if (!Array.isArray(groups)) return groups
  return groups.map(g => {
    if (!g || !Array.isArray(g.hooks)) return g
    const filtered = g.hooks.filter(h => !h.command || !h.command.includes('turbocommit'))
    return { ...g, hooks: filtered }
  }).filter(g => g.hooks && g.hooks.length > 0)
}

/**
 * Install every turbocommit hook event. Each event gets its own group at the end.
 * Cleans up stale entries (including old `turbocommit run`) on install.
 */
function installClaude (settingsPath) {
  settingsPath = settingsPath || getSettingsPath()
  const settings = loadJson(settingsPath) || {}

  if (!settings.hooks) settings.hooks = {}

  // Check if already fully installed
  if (isFullyInstalled(settings)) {
    return { alreadyInstalled: true, settingsPath }
  }

  // Clean all stale turbocommit entries first (including old `turbocommit run`)
  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  // Install each hook event in its own group at the end
  for (const [event, def] of Object.entries(HOOK_DEFS)) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    const group = { hooks: def.hooks }
    if (def.matcher) group.matcher = def.matcher
    settings.hooks[event].push(group)
  }

  writeJson(settingsPath, settings)
  return { alreadyInstalled: false, settingsPath }
}

function uninstallClaude (settingsPath) {
  settingsPath = settingsPath || getSettingsPath()
  const settings = loadJson(settingsPath)

  if (!settings || !settings.hooks) {
    return { wasInstalled: false, settingsPath }
  }

  // Check if any turbocommit hook exists in any event
  const wasInstalled = Object.keys(settings.hooks).some(event =>
    hasTurbocommit(settings.hooks[event])
  )

  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  writeJson(settingsPath, settings)
  return { wasInstalled, settingsPath }
}

function installCodex (hooksPath) {
  hooksPath = hooksPath || getCodexHooksPath()
  const hooksConfig = loadJson(hooksPath) || {}

  if (!hooksConfig.hooks) hooksConfig.hooks = {}

  if (isCodexFullyInstalled(hooksConfig)) {
    return { alreadyInstalled: true, hooksPath }
  }

  for (const k of Object.keys(hooksConfig.hooks)) {
    hooksConfig.hooks[k] = removeTurbocommitHooks(hooksConfig.hooks[k])
    if (Array.isArray(hooksConfig.hooks[k]) && hooksConfig.hooks[k].length === 0) {
      delete hooksConfig.hooks[k]
    }
  }

  for (const [event, def] of Object.entries(CODEX_HOOK_DEFS)) {
    if (!hooksConfig.hooks[event]) hooksConfig.hooks[event] = []
    const group = { hooks: def.hooks }
    if (def.matcher) group.matcher = def.matcher
    hooksConfig.hooks[event].push(group)
  }

  writeJson(hooksPath, hooksConfig)
  return { alreadyInstalled: false, hooksPath }
}

function uninstallCodex (hooksPath) {
  hooksPath = hooksPath || getCodexHooksPath()
  const hooksConfig = loadJson(hooksPath)

  if (!hooksConfig || !hooksConfig.hooks) {
    return { wasInstalled: false, hooksPath }
  }

  const wasInstalled = Object.keys(hooksConfig.hooks).some(event =>
    hasTurbocommit(hooksConfig.hooks[event])
  )

  for (const k of Object.keys(hooksConfig.hooks)) {
    hooksConfig.hooks[k] = removeTurbocommitHooks(hooksConfig.hooks[k])
    if (Array.isArray(hooksConfig.hooks[k]) && hooksConfig.hooks[k].length === 0) {
      delete hooksConfig.hooks[k]
    }
  }

  writeJson(hooksPath, hooksConfig)
  return { wasInstalled, hooksPath }
}

function install (settingsPathOrOptions) {
  if (typeof settingsPathOrOptions === 'string') return installClaude(settingsPathOrOptions)
  const harness = settingsPathOrOptions?.harness || null
  const harnesses = selectedHarnesses(harness, { create: Boolean(harness) })
  const results = harnesses.map(h =>
    h === 'codex'
      ? { harness: h, ...installCodex(settingsPathOrOptions?.codexHooksPath) }
      : { harness: h, ...installClaude(settingsPathOrOptions?.claudeSettingsPath) }
  )
  return { results, installedHarnesses: harnesses }
}

function uninstall (settingsPathOrOptions) {
  if (typeof settingsPathOrOptions === 'string') return uninstallClaude(settingsPathOrOptions)
  const harness = settingsPathOrOptions?.harness || null
  const harnesses = selectedHarnesses(harness)
  const results = harnesses.map(h =>
    h === 'codex'
      ? { harness: h, ...uninstallCodex(settingsPathOrOptions?.codexHooksPath) }
      : { harness: h, ...uninstallClaude(settingsPathOrOptions?.claudeSettingsPath) }
  )
  return { results, uninstalledHarnesses: harnesses }
}

module.exports = {
  install,
  uninstall,
  installClaude,
  uninstallClaude,
  installCodex,
  uninstallCodex,
  hasTurbocommit,
  isFullyInstalled,
  isCodexFullyInstalled,
  getSettingsPath,
  getCodexHooksPath,
  HOOK_DEFS,
  CODEX_HOOK_DEFS
}
