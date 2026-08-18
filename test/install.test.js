const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { install, uninstall, installCodex, uninstallCodex, hasTurbocommit, isFullyInstalled, isCodexFullyInstalled, HOOK_DEFS, CODEX_HOOK_DEFS } = require('../lib/install')

function tmpSettings (content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
  const file = path.join(dir, 'settings.json')
  if (content !== undefined) {
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
  }
  return file
}

function tmpHooks (content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-hooks-'))
  const file = path.join(dir, 'hooks.json')
  if (content !== undefined) {
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
  }
  return file
}

describe('install', () => {
  it('installs every hook event when no hooks exist', () => {
    const file = tmpSettings({})
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const event of Object.keys(HOOK_DEFS)) {
      assert.ok(settings.hooks[event], `expected ${event} hook group`)
      assert.ok(hasTurbocommit(settings.hooks[event]), `expected turbocommit in ${event}`)
    }
  })

  it('PreToolUse group includes matcher', () => {
    const file = tmpSettings({})
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    const ptGroup = settings.hooks.PreToolUse.find(g =>
      g.hooks.some(h => h.command && h.command.includes('turbocommit'))
    )
    assert.ok(ptGroup.matcher, 'PreToolUse group should have a matcher')
    assert.ok(ptGroup.matcher.includes('Write'))
    assert.ok(ptGroup.matcher.includes('mcp__'))
  })

  it('installs a Bash-only PostToolUse hook', () => {
    const file = tmpSettings({})
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    const group = settings.hooks.PostToolUse.find(g =>
      g.hooks.some(h => h.command === 'turbocommit hook post-tool-use --harness claude')
    )
    assert.equal(group.matcher, 'Bash')
  })

  it('Stop hook uses turbocommit hook stop command with explicit harness', () => {
    const file = tmpSettings({})
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    const stopHook = settings.hooks.Stop
      .flatMap(g => g.hooks)
      .find(h => h.command && h.command.includes('turbocommit'))
    assert.equal(stopHook.command, 'turbocommit hook stop --harness claude')
  })

  it('creates own group after existing groups in each event', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'prove_it hook claude:Stop' }
          ]
        }],
        PreToolUse: [{
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }]
        }]
      }
    })
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Stop: existing + turbocommit
    assert.equal(settings.hooks.Stop.length, 2)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'prove_it hook claude:Stop')
    assert.equal(settings.hooks.Stop[1].hooks[0].command, 'turbocommit hook stop --harness claude')
    // PreToolUse: existing + turbocommit
    assert.equal(settings.hooks.PreToolUse.length, 2)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'prove_it hook claude:PreToolUse')
  })

  it('creates settings file if missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
    const file = path.join(dir, 'settings.json')
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    assert.ok(fs.existsSync(file))
  })

  it('reports already installed when all hooks exist', () => {
    const file = tmpSettings({})
    install(file)
    const result = install(file)
    assert.equal(result.alreadyInstalled, true)
  })

  it('is idempotent — no duplicates on re-install', () => {
    const file = tmpSettings({})
    install(file)
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const event of Object.keys(HOOK_DEFS)) {
      const tcCount = settings.hooks[event]
        .flatMap(g => g.hooks)
        .filter(h => h.command && h.command.includes('turbocommit')).length
      assert.equal(tcCount, 1, `expected exactly 1 turbocommit hook in ${event}`)
    }
  })

  it('cleans up old turbocommit run on install', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Old `turbocommit run` should be gone
    const allCommands = Object.values(settings.hooks)
      .flat()
      .flatMap(g => g.hooks)
      .map(h => h.command)
    assert.ok(!allCommands.includes('turbocommit run'))
    // New hooks should be installed
    assert.ok(allCommands.includes('turbocommit hook stop --harness claude'))
  })

  it('upgrades a legacy flagless install to the explicit --harness command', () => {
    // Legacy installs registered `turbocommit hook stop` with no harness flag,
    // which the (now fixed) inference misrouted. Re-installing must rewrite them.
    const file = tmpSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*', hooks: [{ type: 'command', command: 'turbocommit hook pre-tool-use' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'turbocommit hook session-start' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'turbocommit hook session-end' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit hook stop' }] }]
      }
    })
    const result = install(file)
    assert.equal(result.alreadyInstalled, false, 'legacy flagless install should not count as already installed')
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    const allCommands = Object.values(settings.hooks)
      .flat()
      .flatMap(g => g.hooks)
      .map(h => h.command)
    // Flagless variants are gone; every event now carries an explicit --harness.
    assert.ok(!allCommands.includes('turbocommit hook stop'), 'flagless Stop command should be replaced')
    assert.ok(allCommands.includes('turbocommit hook stop --harness claude'))
    assert.ok(allCommands.includes('turbocommit hook pre-tool-use --harness claude'))
    // No duplicate turbocommit hooks left behind.
    for (const event of Object.keys(HOOK_DEFS)) {
      const tcCount = settings.hooks[event]
        .flatMap(g => g.hooks)
        .filter(h => h.command && h.command.includes('turbocommit')).length
      assert.equal(tcCount, 1, `expected exactly 1 turbocommit hook in ${event}`)
    }
  })

  it('preserves other non-turbocommit hooks', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool run' }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }] }]
      }
    })
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(settings.hooks.PreToolUse.some(g =>
      g.hooks.some(h => h.command === 'prove_it hook claude:PreToolUse')
    ))
    assert.ok(settings.hooks.Stop.some(g =>
      g.hooks.some(h => h.command === 'other-tool run')
    ))
  })
})

describe('installCodex', () => {
  it('matches canonical Codex apply_patch calls', () => {
    assert.ok(CODEX_HOOK_DEFS.PreToolUse.matcher.includes('apply_patch'))
  })

  it('installs a Bash-only PostToolUse hook', () => {
    const file = tmpHooks({})
    installCodex(file)
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
    const group = hooks.hooks.PostToolUse.find(g =>
      g.hooks.some(h => h.command === 'turbocommit hook post-tool-use --harness codex')
    )
    assert.equal(group.matcher, 'Bash')
  })

  it('installs all Codex hook events when no hooks exist', () => {
    const file = tmpHooks({})

    const result = installCodex(file)

    assert.equal(result.alreadyInstalled, false)
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(isCodexFullyInstalled(hooks), true)
    for (const event of Object.keys(CODEX_HOOK_DEFS)) {
      assert.ok(hasTurbocommit(hooks.hooks[event]), `expected turbocommit in ${event}`)
    }
  })

  it('upgrades an installed Codex hook whose matcher is stale', () => {
    const file = tmpHooks({})
    installCodex(file)
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
    const group = hooks.hooks.PreToolUse.find(g =>
      g.hooks.some(h => h.command === 'turbocommit hook pre-tool-use --harness codex')
    )
    group.matcher = 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*'
    fs.writeFileSync(file, JSON.stringify(hooks, null, 2))

    const result = installCodex(file)

    assert.equal(result.alreadyInstalled, false)
    const upgraded = JSON.parse(fs.readFileSync(file, 'utf8'))
    const upgradedGroup = upgraded.hooks.PreToolUse.find(g =>
      g.hooks.some(h => h.command === 'turbocommit hook pre-tool-use --harness codex')
    )
    assert.equal(upgradedGroup.matcher, CODEX_HOOK_DEFS.PreToolUse.matcher)
  })

  it('preserves other Codex hooks', () => {
    const file = tmpHooks({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }]
      }
    })

    installCodex(file)

    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(hooks.hooks.Stop.some(g =>
      g.hooks.some(h => h.command === 'other-tool stop')
    ))
    assert.ok(hooks.hooks.Stop.some(g =>
      g.hooks.some(h => h.command === 'turbocommit hook stop --harness codex')
    ))
  })
})

describe('uninstallCodex', () => {
  it('removes only turbocommit Codex hooks', () => {
    const file = tmpHooks({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'other-tool stop' }] },
          { hooks: [{ type: 'command', command: 'turbocommit hook stop' }] }
        ]
      }
    })

    const result = uninstallCodex(file)

    assert.equal(result.wasInstalled, true)
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(hooks.hooks.Stop.length, 1)
    assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'other-tool stop')
  })
})

describe('uninstall', () => {
  it('removes turbocommit hooks from all events', () => {
    const file = tmpSettings({})
    install(file)
    const result = uninstall(file)
    assert.equal(result.wasInstalled, true)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const event of Object.keys(HOOK_DEFS)) {
      assert.ok(!settings.hooks[event], `expected ${event} to be removed (was only turbocommit)`)
    }
  })

  it('preserves other hooks in same event when uninstalling', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'prove_it hook claude:Stop' }] },
          { hooks: [{ type: 'command', command: 'turbocommit hook stop' }] }
        ],
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'turbocommit hook pre-tool-use' }] }
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'turbocommit hook session-start' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'turbocommit hook session-end' }] }]
      }
    })
    const result = uninstall(file)
    assert.equal(result.wasInstalled, true)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    // prove_it hooks should remain
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'prove_it hook claude:Stop')
    assert.equal(settings.hooks.PreToolUse.length, 1)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'prove_it hook claude:PreToolUse')
    // SessionStart/End should be completely removed
    assert.equal(settings.hooks.SessionStart, undefined)
    assert.equal(settings.hooks.SessionEnd, undefined)
  })

  it('removes old turbocommit run entries too', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })
    const result = uninstall(file)
    assert.equal(result.wasInstalled, true)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.hooks.Stop, undefined)
  })

  it('reports not installed when hook absent', () => {
    const file = tmpSettings({ hooks: {} })
    const result = uninstall(file)
    assert.equal(result.wasInstalled, false)
  })

  it('handles missing settings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
    const file = path.join(dir, 'settings.json')
    const result = uninstall(file)
    assert.equal(result.wasInstalled, false)
  })
})

describe('hasTurbocommit', () => {
  it('returns false for empty array', () => {
    assert.equal(hasTurbocommit([]), false)
  })

  it('returns false for null', () => {
    assert.equal(hasTurbocommit(null), false)
  })

  it('returns true for turbocommit hook stop', () => {
    assert.equal(
      hasTurbocommit([{
        hooks: [{ type: 'command', command: 'turbocommit hook stop' }]
      }]),
      true
    )
  })

  it('returns true for old turbocommit run', () => {
    assert.equal(
      hasTurbocommit([{
        hooks: [{ type: 'command', command: 'turbocommit run' }]
      }]),
      true
    )
  })
})

describe('isFullyInstalled', () => {
  it('returns true when every hook is present', () => {
    const file = tmpSettings({})
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(isFullyInstalled(settings), true)
  })

  it('returns false when only Stop installed', () => {
    assert.equal(isFullyInstalled({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit hook stop' }] }]
      }
    }), false)
  })

  it('returns false for null settings', () => {
    assert.equal(isFullyInstalled(null), false)
  })
})
