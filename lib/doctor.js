const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')
const { hasTurbocommit, isFullyInstalled, isCodexFullyInstalled, getSettingsPath, getCodexHooksPath, HOOK_DEFS, CODEX_HOOK_DEFS } = require('./install')
const { gitRoot } = require('./git')
const { configPath } = require('./init')
const { activeConfig, xdgConfigPath, legacyGlobalConfigPath, neutralProjectConfigPath, legacyProjectConfigPath } = require('./config')
const { selectedHarnesses } = require('./harness')

function globalConfigPath () {
  return path.join(os.homedir(), '.claude', 'turbocommit.json')
}

function doctor (settingsPathOrOptions, cwd) {
  if (typeof settingsPathOrOptions === 'string' || settingsPathOrOptions == null) {
    return doctorLegacy(settingsPathOrOptions, cwd)
  }
  const options = settingsPathOrOptions || {}
  cwd = options.cwd || process.cwd()
  const checks = []
  const harnesses = selectedHarnesses(options.harness)

  for (const harness of harnesses) {
    if (harness === 'codex') {
      checkCodex(checks, options.codexHooksPath || getCodexHooksPath())
    } else {
      checkClaude(checks, options.claudeSettingsPath || getSettingsPath())
    }
  }
  if (harnesses.length === 0) {
    checks.push({ name: 'Harnesses', status: 'info', message: 'No supported harness config dirs found' })
  }

  checkConfig(checks, cwd)

  const ok = checks.every(c => c.status !== 'error')
  return { ok, checks }
}

function doctorLegacy (settingsPath, cwd) {
  settingsPath = settingsPath || getSettingsPath()
  cwd = cwd || process.cwd()
  const checks = []
  const settings = loadJson(settingsPath)
  if (!settings) {
    checks.push({ name: 'Global settings', status: 'error', message: `Not found: ${settingsPath}` })
    return { ok: false, checks }
  }
  checks.push({ name: 'Global settings', status: 'ok', message: settingsPath })

  // 2. All hooks installed
  if (!isFullyInstalled(settings)) {
    const missing = Object.keys(HOOK_DEFS).filter(event =>
      !hasTurbocommit((settings.hooks && settings.hooks[event]) || [])
    )
    checks.push({ name: 'Hooks installed', status: 'error', message: `Missing hooks: ${missing.join(', ')}. Run: turbocommit uninstall && turbocommit install` })
    return { ok: false, checks }
  }
  checks.push({ name: 'Hooks installed', status: 'ok', message: `All ${Object.keys(HOOK_DEFS).length} hooks installed` })

  // 3. Stop group isolation: turbocommit must be the sole hook in the last group
  const stopGroups = (settings.hooks && settings.hooks.Stop) || []
  const tcGroupIndex = findTurbocommitGroup(stopGroups)
  if (tcGroupIndex >= 0) {
    const tcGroup = stopGroups[tcGroupIndex]
    const isLastGroup = tcGroupIndex === stopGroups.length - 1
    const isSoleHook = tcGroup.hooks.length === 1

    if (!isSoleHook) {
      checks.push({ name: 'Group isolation', status: 'warn', message: 'turbocommit shares a Stop group with other hooks; will commit even if another hook blocks' })
    } else if (!isLastGroup) {
      checks.push({ name: 'Group isolation', status: 'warn', message: 'Another group runs after turbocommit in Stop' })
    } else {
      checks.push({ name: 'Group isolation', status: 'ok', message: 'Sole hook in last Stop group' })
    }
  }

  // 4. Global turbocommit config
  const globalPath = globalConfigPath()
  const globalCfg = loadJson(globalPath)
  if (globalCfg) {
    checks.push({ name: 'Global config', status: 'ok', message: globalPath })
  } else {
    checks.push({ name: 'Global config', status: 'info', message: 'Not found (optional)' })
  }

  // 5. Local config exists
  const root = gitRoot(cwd)
  if (!root) {
    checks.push({ name: 'Local config', status: 'info', message: 'Not in a git repo; skipping local checks' })
  } else {
    const neutralPath = configPath(root)
    const legacyPath = legacyProjectConfigPath(root)
    const localPath = loadJson(neutralPath) ? neutralPath : legacyPath
    const localConfig = loadJson(localPath)
    if (!localConfig) {
      if (globalCfg) {
        checks.push({ name: 'Local config', status: 'info', message: 'Not found (using global config)' })
      } else {
        checks.push({ name: 'Local config', status: 'warn', message: `Not found: ${neutralPath}. Run: turbocommit init` })
      }
    } else {
      checks.push({ name: 'Local config', status: 'ok', message: localPath })
    }

    // 6. Enabled: evaluate merged config
    const merged = mergeConfig(globalCfg || {}, localConfig || {})
    if (merged.enabled !== true) {
      checks.push({ name: 'Enabled', status: 'warn', message: 'enabled is not true in merged config' })
    } else {
      checks.push({ name: 'Enabled', status: 'ok', message: 'Enabled' })
    }
  }

  const ok = checks.every(c => c.status !== 'error')
  return { ok, checks }
}

function checkClaude (checks, settingsPath) {
  const settings = loadJson(settingsPath)
  if (!settings) {
    checks.push({ name: 'Claude settings', status: 'error', message: `Not found: ${settingsPath}` })
    return
  }
  checks.push({ name: 'Claude settings', status: 'ok', message: settingsPath })

  if (!isFullyInstalled(settings)) {
    const missing = Object.keys(HOOK_DEFS).filter(event =>
      !hasTurbocommit((settings.hooks && settings.hooks[event]) || [])
    )
    checks.push({ name: 'Claude hooks', status: 'error', message: `Missing hooks: ${missing.join(', ')}` })
    return
  }
  checks.push({ name: 'Claude hooks', status: 'ok', message: `All ${Object.keys(HOOK_DEFS).length} hooks installed` })
}

function checkCodex (checks, hooksPath) {
  const hooks = loadJson(hooksPath)
  if (!hooks) {
    checks.push({ name: 'Codex hooks', status: 'error', message: `Not found: ${hooksPath}` })
    return
  }
  if (!isCodexFullyInstalled(hooks)) {
    const missing = Object.keys(CODEX_HOOK_DEFS).filter(event =>
      !hasTurbocommit((hooks.hooks && hooks.hooks[event]) || [])
    )
    checks.push({ name: 'Codex hooks', status: 'error', message: `Missing hooks: ${missing.join(', ')}` })
    return
  }
  checks.push({ name: 'Codex hooks', status: 'ok', message: `All ${Object.keys(CODEX_HOOK_DEFS).length} hooks installed` })
  checks.push({ name: 'Codex hook trust', status: 'warn', message: 'Unknown. Run /hooks in Codex to verify trust.' })
}

function checkConfig (checks, cwd) {
  const root = gitRoot(cwd)
  const xdgPath = xdgConfigPath()
  const legacyGlobal = legacyGlobalConfigPath()
  const globalPath = loadJson(xdgPath) ? xdgPath : legacyGlobal
  const globalCfg = loadJson(globalPath)
  checks.push(globalCfg
    ? { name: 'Global config', status: 'ok', message: globalPath }
    : { name: 'Global config', status: 'info', message: 'Not found (optional)' })

  if (!root) {
    checks.push({ name: 'Project config', status: 'info', message: 'Not in a git repo' })
    return
  }

  const neutralPath = neutralProjectConfigPath(root)
  const legacyPath = legacyProjectConfigPath(root)
  const projectPath = loadJson(neutralPath) ? neutralPath : legacyPath
  const projectCfg = loadJson(projectPath)
  checks.push(projectCfg
    ? { name: 'Project config', status: 'ok', message: projectPath }
    : { name: 'Project config', status: 'info', message: `Not found: ${configPath(root)}` })

  const { config } = activeConfig(root)
  checks.push(config.enabled === true
    ? { name: 'Enabled', status: 'ok', message: 'Enabled' }
    : { name: 'Enabled', status: 'warn', message: 'enabled is not true in active config' })
}

function findTurbocommitGroup (groups) {
  for (let i = 0; i < groups.length; i++) {
    const hooks = (groups[i] && groups[i].hooks) || []
    if (hooks.some(h => h.command && h.command.includes('turbocommit'))) {
      return i
    }
  }
  return -1
}

module.exports = { doctor }
