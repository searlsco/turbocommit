const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawnSync } = require('child_process')
const { HOOK_DEFS } = require('../lib/install')

function hasClaude () {
  const r = spawnSync('which claude', { shell: true, encoding: 'utf8' })
  return r.status === 0
}

const SKIP = !hasClaude() && 'claude not found in PATH'

function makeProject (opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-integ-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })

  const claudeDir = path.join(dir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })

  // turbocommit config — use transcript title to avoid extra API calls
  fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
    enabled: true,
    title: { type: 'transcript' }
  }, null, 2))

  // Diagnostic hook that writes a file when Stop fires, proving hooks work
  const hookLog = path.join(dir, 'hook-fired.txt')
  const diagHook = { type: 'command', command: `bash -c 'echo fired >> "${hookLog}"'` }

  // Build full hook settings with every turbocommit event plus diagnostic hook
  const settings = opts.settings || buildSettings(diagHook)
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2))

  // Seed file + initial commit
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

  return { dir, hookLog }
}

function buildSettings (extraStopHook) {
  const hooks = {}
  for (const [event, def] of Object.entries(HOOK_DEFS)) {
    const group = { hooks: [...def.hooks] }
    if (def.matcher) group.matcher = def.matcher
    if (event === 'Stop' && extraStopHook) {
      group.hooks.unshift(extraStopHook)
    }
    hooks[event] = [group]
  }
  return { hooks }
}

function commitCount (dir) {
  return Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim())
}

function cleanEnv () {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE') || k === 'ANTHROPIC_API_KEY' || k === 'TURBOCOMMIT_DISABLED' || k === 'PROVE_IT_DISABLED') continue
    env[k] = v
  }
  return env
}

function runClaude (dir, prompt, { retries = 0, check } = {}) {
  // Clean env: strip all CLAUDE* and turbocommit/prove_it vars to prevent
  // the outer session from interfering with the inner claude -p
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = spawnSync('claude -p --model haiku', {
      cwd: dir,
      shell: true,
      encoding: 'utf8',
      input: prompt,
      timeout: 120_000,
      env: cleanEnv()
    })
    if (r.status !== 0) {
      if (attempt < retries) continue
      throw new Error(`claude exited ${r.status}: ${r.stderr}`)
    }
    if (check && !check() && attempt < retries) continue
    return r.stdout
  }
}

describe('integration', { skip: SKIP }, () => {
  it('turbocommit commits on stop when agent writes files', () => {
    const { dir, hookLog } = makeProject()
    const before = commitCount(dir)

    // Ask Claude to write a file — this triggers PreToolUse tracking + Stop commit
    // Retry up to 2 times because LLM may not follow the Write instruction
    runClaude(dir, 'Create a file called hello.txt containing "hello world". Use the Write tool.', {
      retries: 2,
      check: () => commitCount(dir) > before
    })

    const hookFired = fs.existsSync(hookLog)
    const after = commitCount(dir)
    assert.ok(hookFired, 'diagnostic hook should have written hook-fired.txt — Stop hooks did not fire')
    assert.ok(after > before, `expected commits after turbocommit, got ${before} -> ${after}`)
  })

  it('turbocommit appends co-authored-by trailer', () => {
    const { dir } = makeProject()

    runClaude(dir, 'Create a file called test.txt containing "test". Use the Write tool.', {
      retries: 2,
      check: () => commitCount(dir) > 1
    })

    const after = commitCount(dir)
    assert.ok(after > 1, `expected turbocommit commit, got ${after} commits`)
    const body = execSync('git log --format=%b -1', { cwd: dir, encoding: 'utf8' })
    assert.ok(body.includes('Co-Authored-By:'), `expected Co-Authored-By trailer in commit body, got:\n${body.slice(-200)}`)
  })

  it('turbocommit skips commit for read-only sessions', () => {
    const { dir } = makeProject()
    const before = commitCount(dir)

    // Ask Claude something that doesn't require writing files
    runClaude(dir, 'What is 2+2? Answer briefly.')

    const after = commitCount(dir)
    // Should NOT create a new commit — no tool modifications tracked
    assert.equal(after, before, `expected no new commit for read-only session, got ${before} -> ${after}`)
  })
})
