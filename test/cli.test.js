const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, execSync, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { handleTrack, handlePostTrack, acquireBashOverlapRecoveryLock, cleanupTracking } = require('../lib/track')
const { createSessionEndRescue, cleanupSessionEndRescue } = require('../lib/rescue')

const CLI = path.join(__dirname, '..', 'cli.js')

function cli (args, opts = {}) {
  try {
    return {
      stdout: execSync(`node ${CLI} ${args}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...opts
      }).trim(),
      exitCode: 0
    }
  } catch (err) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      exitCode: err.status
    }
  }
}

function waitFor (predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    if (predicate()) return true
    Atomics.wait(sleeper, 0, 0, 25)
  }
  return predicate()
}

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, '.turbocommit.json'), JSON.stringify({
    enabled: true,
    title: { type: 'transcript' },
    coauthor: false
  }))
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })
  return dir
}

function makeCodexTranscript (pairs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-codex-'))
  const file = path.join(dir, 'rollout.jsonl')
  const lines = []
  for (const { prompt, response } of pairs) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
    }))
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response }] }
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function makeClaudeTranscript (pairs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-claude-'))
  const file = path.join(dir, 'transcript.jsonl')
  const lines = []
  for (const { prompt, response } of pairs) {
    lines.push(JSON.stringify({ type: 'user', message: { content: prompt } }))
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: response }] } }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function commitCount (dir) {
  return Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim())
}

function lastBody (dir) {
  return execSync('git log --format=%b -1', { cwd: dir, encoding: 'utf8' }).trim()
}

describe('cli', () => {
  it('shows help by default', () => {
    const result = cli('')
    assert.ok(result.stdout.includes('turbocommit'))
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows help with --help', () => {
    const result = cli('--help')
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows help with help command', () => {
    const result = cli('help')
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows version with --version', () => {
    const result = cli('--version')
    const pkg = require('../package.json')
    assert.equal(result.stdout, pkg.version)
  })

  it('shows version with -v', () => {
    const result = cli('-v')
    const pkg = require('../package.json')
    assert.equal(result.stdout, pkg.version)
  })

  it('reports unknown command', () => {
    const result = cli('bogus')
    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes('Unknown command'))
  })

  it('run command outputs block JSON for outdated hooks', () => {
    const result = cli('run', { input: '{}' })
    assert.equal(result.exitCode, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.decision, 'block')
    assert.ok(output.reason.includes('outdated'))
    assert.ok(output.reason.includes('turbocommit install'))
  })

  it('run command exits cleanly when stop_hook_active is true', () => {
    const result = cli('run', { input: JSON.stringify({ stop_hook_active: true }) })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, '')
  })

  it('hook subcommand with unknown event does not crash', () => {
    const result = cli('hook unknown', { input: '{}' })
    assert.equal(result.exitCode, 0)
  })

  it('Codex hook commands commit from Codex payloads', () => {
    const dir = makeRepo()
    const transcript = makeCodexTranscript([
      { prompt: 'Add Codex CLI file', response: 'Created it.' }
    ])

    let result = cli('hook pre-tool-use --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'CLI-C1',
        cwd: dir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'codex-cli.txt') }
      })
    })
    assert.equal(result.exitCode, 0)
    fs.writeFileSync(path.join(dir, 'codex-cli.txt'), 'content')

    result = cli('hook stop --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'CLI-C1',
        cwd: dir,
        transcript_path: transcript
      })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(commitCount(dir), 2)
    assert.ok(lastBody(dir).includes('Response:\nCreated it.'))
  })

  it('denies a modifying tool when recovery does not release its lock', () => {
    const dir = makeRepo()
    const blocked = path.join(dir, 'blocked.txt')
    const transcript = makeCodexTranscript([
      { prompt: 'Write the blocked file', response: 'The write was denied.' }
    ])
    fs.writeFileSync(blocked, 'preexisting dirty content')
    const release = acquireBashOverlapRecoveryLock(dir)
    assert.ok(release)
    let result
    try {
      result = cli('hook pre-tool-use --harness codex', {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: 'CLI-LOCKED',
          cwd: dir,
          tool_name: 'Write',
          tool_input: { file_path: blocked }
        })
      })
    } finally {
      release()
    }

    assert.equal(result.exitCode, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny')

    result = cli('hook stop --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'CLI-LOCKED',
        cwd: dir,
        transcript_path: transcript
      })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(commitCount(dir), 1)
    assert.equal(execSync('git status --short -- blocked.txt', { cwd: dir, encoding: 'utf8' }).trim(), '?? blocked.txt')
  })

  it('skips all hook bookkeeping when turbocommit is disabled', () => {
    const dir = makeRepo()
    const env = { ...process.env, TURBOCOMMIT_DISABLED: '1' }
    const input = {
      session_id: 'CLI-DISABLED',
      cwd: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'disabled.txt') }
    }

    let result = cli('hook pre-tool-use --harness codex', {
      cwd: dir,
      env,
      input: JSON.stringify({ ...input, hook_event_name: 'PreToolUse' })
    })
    assert.equal(result.exitCode, 0)

    result = cli('hook session-end --harness codex', {
      cwd: dir,
      env,
      input: JSON.stringify({ ...input, hook_event_name: 'SessionEnd' })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(fs.existsSync(path.join(dir, '.git', 'turbocommit')), false)
  })

  it('commits a tracked Write when Codex reaches SessionEnd without Stop', () => {
    const dir = makeRepo()
    const transcript = makeCodexTranscript([
      { prompt: 'Create the fallback file', response: 'Created it.' }
    ])
    const file = path.join(dir, 'session-end-write.txt')
    cli('hook pre-tool-use --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'CLI-SESSION-END-WRITE',
        cwd: dir,
        tool_name: 'Write',
        tool_input: { file_path: file }
      })
    })
    fs.writeFileSync(file, 'content')

    const release = acquireBashOverlapRecoveryLock(dir)
    assert.ok(release)

    const result = cli('hook session-end --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'CLI-SESSION-END-WRITE',
        cwd: dir,
        transcript_path: transcript,
        model: 'gpt-5'
      })
    })
    fs.unlinkSync(transcript)
    release()

    assert.equal(result.exitCode, 0)
    assert.equal(waitFor(() => commitCount(dir) === 2), true)
    assert.equal(execSync('git show --format= --name-only HEAD', { cwd: dir, encoding: 'utf8' }).trim(), 'session-end-write.txt')
    assert.ok(lastBody(dir).includes('Response:\nCreated it.'))
  })

  it('finalizes and commits Bash changes when Codex reaches SessionEnd without Stop or PostToolUse', () => {
    const dir = makeRepo()
    const transcript = makeCodexTranscript([
      { prompt: 'Generate the fallback file', response: 'Generated it.' }
    ])
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: 'CLI-SESSION-END-BASH',
      cwd: dir,
      tool_name: 'Bash',
      tool_use_id: 'bash-without-post',
      tool_input: { command: 'generate fallback file' }
    }
    cli('hook pre-tool-use --harness codex', { cwd: dir, input: JSON.stringify(input) })
    fs.writeFileSync(path.join(dir, 'session-end-bash.txt'), 'content')

    const result = cli('hook session-end --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'CLI-SESSION-END-BASH',
        cwd: dir,
        transcript_path: transcript
      })
    })

    assert.equal(result.exitCode, 0)
    assert.equal(waitFor(() => commitCount(dir) === 2), true)
    assert.equal(execSync('git show --format= --name-only HEAD', { cwd: dir, encoding: 'utf8' }).trim(), 'session-end-bash.txt')
  })

  it('commits Bash ownership created while the SessionEnd worker finalizes snapshots', () => {
    const dir = makeRepo()
    const transcript = makeCodexTranscript([
      { prompt: 'Generate a file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-WORKER-FINALIZE-FIRST'
    handleTrack({
      sessionId,
      toolUseId: 'bash-without-post',
      cwd: dir,
      toolName: 'Bash',
      toolInput: { command: 'generate file' }
    }, dir)
    fs.writeFileSync(path.join(dir, 'generated.txt'), 'content')
    cleanupTracking(dir, sessionId)

    const payload = Buffer.from(JSON.stringify({
      event: 'SessionEnd',
      sessionId,
      cwd: dir,
      harness: 'codex',
      transcriptPath: transcript
    })).toString('base64url')
    const result = cli(`session-end-worker ${payload} --harness codex`, { cwd: dir })

    assert.equal(result.exitCode, 0)
    assert.equal(commitCount(dir), 2)
    assert.equal(execSync('git show --format= --name-only HEAD', { cwd: dir, encoding: 'utf8' }).trim(), 'generated.txt')
  })

  it('cleans a copied transcript when the SessionEnd worktree has vanished', () => {
    const dir = makeRepo()
    const transcriptDir = path.join(dir, '.git', 'turbocommit', 'session-end-transcripts')
    fs.mkdirSync(transcriptDir, { recursive: true })
    const transcript = path.join(transcriptDir, `${process.pid}-12345678-1234-1234-1234-123456789abc.jsonl`)
    fs.writeFileSync(transcript, '{}\n')
    const payload = Buffer.from(JSON.stringify({
      event: 'SessionEnd',
      sessionId: 'CLI-MISSING-WORKTREE',
      cwd: path.join(dir, 'missing-worktree'),
      harness: 'codex',
      transcriptPath: transcript,
      temporaryTranscript: true
    })).toString('base64url')

    const result = cli(`session-end-worker ${payload} --harness codex`, { cwd: dir })

    assert.equal(result.exitCode, 0)
    assert.equal(fs.existsSync(transcript), false)
  })

  it('waits past the hook deadline to finish a detached SessionEnd worker', async () => {
    const dir = makeRepo()
    const transcript = makeCodexTranscript([
      { prompt: 'Generate a delayed file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-WORKER-CONTENTION'
    handleTrack({
      sessionId,
      toolUseId: 'delayed-bash',
      cwd: dir,
      toolName: 'Bash',
      toolInput: { command: 'generate delayed file' }
    }, dir)
    fs.writeFileSync(path.join(dir, 'delayed.txt'), 'content')

    const release = acquireBashOverlapRecoveryLock(dir)
    assert.ok(release)
    const payload = Buffer.from(JSON.stringify({
      event: 'SessionEnd',
      sessionId,
      cwd: dir,
      harness: 'codex',
      transcriptPath: transcript
    })).toString('base64url')

    const child = spawn(process.execPath, [CLI, 'session-end-worker', payload, '--harness', 'codex'], {
      cwd: dir,
      stdio: 'pipe'
    })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
    })
    await new Promise(resolve => setTimeout(resolve, 5250))
    release()
    await exited

    assert.equal(commitCount(dir), 2)
    assert.equal(execSync('git show --format= --name-only HEAD', { cwd: dir, encoding: 'utf8' }).trim(), 'delayed.txt')
  })

  it('exits and cleans its transcript if a Codex worktree vanishes while waiting', async () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-codex-wt-parent-')), 'worktree')
    execSync(`git worktree add -q -b vanished-codex-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const sessionId = 'CLI-CODEX-VANISHED'
    handleTrack({
      sessionId,
      toolUseId: 'vanished-bash',
      cwd: worktree,
      toolName: 'Bash',
      toolInput: { command: 'generate vanished file' }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'vanished.txt'), 'content')
    const transcriptDir = path.join(dir, '.git', 'turbocommit', 'session-end-transcripts')
    fs.mkdirSync(transcriptDir, { recursive: true })
    const transcript = path.join(transcriptDir, `${process.pid}-abcdefab-1234-1234-1234-abcdefabcdef.jsonl`)
    fs.writeFileSync(transcript, '{}\n')
    const release = acquireBashOverlapRecoveryLock(worktree)
    assert.ok(release)
    const payload = Buffer.from(JSON.stringify({
      event: 'SessionEnd',
      sessionId,
      cwd: worktree,
      harness: 'codex',
      transcriptPath: transcript,
      temporaryTranscript: true
    })).toString('base64url')
    const child = spawn(process.execPath, [CLI, 'session-end-worker', payload, '--harness', 'codex'], {
      cwd: dir,
      stdio: 'pipe'
    })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    release()
    let timeout
    try {
      await Promise.race([
        exited,
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('worker did not exit after its worktree vanished')), 5000)
        })
      ])
    } finally {
      clearTimeout(timeout)
      if (child.exitCode == null) child.kill()
    }

    assert.equal(fs.existsSync(transcript), false)
  })

  it('recovers a Claude deadline rescue after its managed worktree is removed', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-wt-parent-')), 'worktree')
    execSync(`git worktree add -q -b rescued-claude-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the rescued file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-bash',
      cwd: worktree,
      toolName: 'Bash',
      toolInput: { command: 'generate rescued file' }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'rescued.txt'), 'content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })
    const recoveredRef = `refs/turbocommit/session-end-recovered/${rescue.id}`
    const recoveredCommit = execSync('git rev-parse rescued-claude-worktree', { cwd: dir, encoding: 'utf8' }).trim()

    assert.equal(result.exitCode, 0)
    assert.equal(Number(execSync('git rev-list --count rescued-claude-worktree', { cwd: dir, encoding: 'utf8' }).trim()), 2)
    assert.equal(execSync('git show --format= --name-only rescued-claude-worktree', { cwd: dir, encoding: 'utf8' }).trim(), 'rescued.txt')
    assert.equal(execSync(`git rev-parse ${recoveredRef}`, { cwd: dir, encoding: 'utf8' }).trim(), recoveredCommit)
    assert.equal(fs.existsSync(worktree), false)
    assert.throws(() => execFileSync('git', ['show-ref', '--verify', '--quiet', rescue.ref], { cwd: dir }))
    assert.equal(fs.existsSync(rescue.recordPath), false)

    execSync(`git update-ref refs/heads/rescued-claude-worktree ${rescue.head} ${recoveredCommit}`, { cwd: dir, stdio: 'pipe' })
    assert.equal(execSync(`git show ${recoveredRef}:rescued.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'content')
  })

  it('pushes a recovered Claude deadline rescue after attaching its branch', () => {
    const dir = makeRepo()
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-remote-'))
    execSync('git init --bare -q', { cwd: remote, stdio: 'pipe' })
    execSync(`git remote add origin "${remote}"`, { cwd: dir, stdio: 'pipe' })
    fs.writeFileSync(path.join(dir, '.turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' },
      coauthor: false,
      push: true
    }))
    execSync('git add .turbocommit.json && git commit -q -m "Enable push" && git push -q -u origin HEAD', { cwd: dir, stdio: 'pipe' })
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-push-parent-')), 'worktree')
    execSync(`git worktree add -q -b rescued-push-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    execSync('git push -q -u origin HEAD', { cwd: worktree, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the pushed file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-PUSH'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-push-write',
      cwd: worktree,
      toolName: 'Write',
      toolInput: { file_path: path.join(worktree, 'pushed.txt') }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'pushed.txt'), 'pushed content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })
    const local = execSync('git rev-parse rescued-push-worktree', { cwd: dir, encoding: 'utf8' }).trim()
    const pushed = execSync('git rev-parse refs/heads/rescued-push-worktree', { cwd: remote, encoding: 'utf8' }).trim()

    assert.equal(result.exitCode, 0)
    assert.equal(pushed, local)
    assert.equal(execSync('git show rescued-push-worktree:pushed.txt', { cwd: dir, encoding: 'utf8' }).trim(), 'pushed content')
  })

  it('preserves a Claude deadline rescue when its worktree path is reused', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-reused-parent-')), 'worktree')
    execSync(`git worktree add -q -b rescued-reused-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the rescued file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-REUSED'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-reused-bash',
      cwd: worktree,
      toolName: 'Bash',
      toolInput: { command: 'generate rescued file' }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'rescued.txt'), 'rescued content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    execSync(`git worktree add -q "${worktree}" rescued-reused-worktree`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })

    assert.equal(result.exitCode, 0)
    assert.equal(Number(execSync('git rev-list --count rescued-reused-worktree', { cwd: dir, encoding: 'utf8' }).trim()), 1)
    assert.equal(fs.existsSync(path.join(worktree, 'rescued.txt')), false)
    assert.equal(execSync(`git show ${rescue.ref}:rescued.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'rescued content')
    assert.equal(fs.existsSync(rescue.recordPath), true)
  })

  it('does not move a rescued branch checked out at a different path', () => {
    const dir = makeRepo()
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-other-checkout-parent-'))
    const worktree = path.join(parent, 'worktree')
    const replacement = path.join(parent, 'replacement')
    execSync(`git worktree add -q -b rescued-other-checkout "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the rescued file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-OTHER-CHECKOUT'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-other-checkout-write',
      cwd: worktree,
      toolName: 'Write',
      toolInput: { file_path: path.join(worktree, 'rescued.txt') }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'rescued.txt'), 'rescued content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    execSync(`git worktree add -q "${replacement}" rescued-other-checkout`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })
    const recoveredRef = `refs/turbocommit/session-end-recovered/${rescue.id}`

    assert.equal(result.exitCode, 0)
    assert.equal(execSync('git rev-parse rescued-other-checkout', { cwd: dir, encoding: 'utf8' }).trim(), rescue.head)
    assert.equal(execSync('git status --short', { cwd: replacement, encoding: 'utf8' }).trim(), '')
    assert.equal(fs.existsSync(path.join(replacement, 'rescued.txt')), false)
    assert.equal(execSync(`git show ${recoveredRef}:rescued.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'rescued content')
    assert.equal(execSync(`git show ${rescue.ref}:rescued.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'rescued content')
    assert.equal(fs.existsSync(rescue.recordPath), true)
  })

  it('keeps unrelated bytes in an existing Claude rescue worktree reachable', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-unrelated-parent-')), 'worktree')
    execSync(`git worktree add -q -b rescued-unrelated-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the owned file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-UNRELATED'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-unrelated-write',
      cwd: worktree,
      toolName: 'Write',
      toolInput: { file_path: path.join(worktree, 'owned.txt') }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'owned.txt'), 'owned content')
    fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'unrelated content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })

    assert.equal(result.exitCode, 0)
    assert.equal(execSync('git status --short', { cwd: worktree, encoding: 'utf8' }).trim(), '?? unrelated.txt')
    assert.doesNotThrow(() => execFileSync('git', ['show-ref', '--verify', '--quiet', rescue.ref], { cwd: dir }))
    assert.equal(fs.existsSync(rescue.recordPath), true)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    assert.equal(execSync(`git show ${rescue.ref}:unrelated.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'unrelated content')
  })

  it('does not overwrite a branch that advances after a Claude deadline rescue', () => {
    const dir = makeRepo()
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-advanced-parent-'))
    const worktree = path.join(parent, 'worktree')
    const advancedWorktree = path.join(parent, 'advanced-worktree')
    execSync(`git worktree add -q -b rescued-advanced-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Update the owned file', response: 'Updated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-ADVANCED'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-advanced-write',
      cwd: worktree,
      toolName: 'Write',
      toolInput: { file_path: path.join(worktree, 'owned.txt') }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'owned.txt'), 'rescued session bytes')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    execSync(`git worktree add -q "${advancedWorktree}" rescued-advanced-worktree`, { cwd: dir, stdio: 'pipe' })
    fs.writeFileSync(path.join(advancedWorktree, 'owned.txt'), 'newer committed bytes')
    execSync('git add owned.txt && git commit -q -m "Advance branch"', { cwd: advancedWorktree, stdio: 'pipe' })
    execSync(`git worktree remove --force "${advancedWorktree}"`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })

    assert.equal(result.exitCode, 0)
    assert.equal(execSync('git show rescued-advanced-worktree:owned.txt', { cwd: dir, encoding: 'utf8' }).trim(), 'newer committed bytes')
    assert.equal(execSync(`git show ${rescue.ref}:owned.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'rescued session bytes')
    assert.equal(fs.existsSync(rescue.recordPath), true)
  })

  it('keeps a recovered detached Claude rescue reachable', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-detached-parent-')), 'worktree')
    execSync(`git worktree add -q --detach "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Generate the detached file', response: 'Generated it.' }
    ])
    const sessionId = 'CLI-CLAUDE-RESCUE-DETACHED'
    handleTrack({
      sessionId,
      toolUseId: 'rescued-detached-write',
      cwd: worktree,
      toolName: 'Write',
      toolInput: { file_path: path.join(worktree, 'detached.txt') }
    }, worktree)
    fs.writeFileSync(path.join(worktree, 'detached.txt'), 'detached content')
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId,
      cwd: worktree,
      transcriptPath: transcript
    })
    assert.ok(rescue)
    assert.equal(rescue.branch, null)
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })

    const payload = Buffer.from(JSON.stringify(rescue)).toString('base64url')
    const result = cli(`session-end-rescue-worker ${payload}`, { cwd: dir })
    const recoveredRef = `refs/turbocommit/session-end-recovered/${rescue.id}`

    assert.equal(result.exitCode, 0)
    assert.equal(execSync(`git show ${recoveredRef}:detached.txt`, { cwd: dir, encoding: 'utf8' }).trim(), 'detached content')
    assert.equal(fs.existsSync(worktree), false)
    assert.doesNotThrow(() => execFileSync('git', ['show-ref', '--verify', '--quiet', rescue.ref], { cwd: dir }))
    assert.doesNotThrow(() => execFileSync('git', ['show-ref', '--verify', '--quiet', recoveredRef], { cwd: dir }))
    assert.equal(fs.existsSync(rescue.recordPath), true)
  })

  it('does not force-remove a rescue worktree that became dirty before cleanup', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-rescue-late-dirty-parent-')), 'worktree')
    execSync(`git worktree add -q -b rescued-late-dirty-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const rescue = createSessionEndRescue(worktree, {
      event: 'SessionEnd',
      harness: 'claude',
      sessionId: 'CLI-CLAUDE-RESCUE-LATE-DIRTY',
      cwd: worktree
    })
    assert.ok(rescue)
    fs.writeFileSync(path.join(worktree, 'late.txt'), 'late content')

    const cleaned = cleanupSessionEndRescue(rescue, { removeWorktree: true })

    assert.equal(cleaned, false)
    assert.equal(fs.readFileSync(path.join(worktree, 'late.txt'), 'utf8'), 'late content')
    assert.doesNotThrow(() => execFileSync('git', ['show-ref', '--verify', '--quiet', rescue.ref], { cwd: dir }))
    assert.equal(fs.existsSync(rescue.recordPath), true)
  })

  it('commits Claude SessionEnd changes before its managed worktree can be removed', () => {
    const dir = makeRepo()
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-wt-parent-')), 'worktree')
    execSync(`git worktree add -q -b session-end-worktree "${worktree}"`, { cwd: dir, stdio: 'pipe' })
    const transcript = makeClaudeTranscript([
      { prompt: 'Create the worktree file', response: 'Created it.' }
    ])
    const file = path.join(worktree, 'worktree.txt')
    let result = cli('hook pre-tool-use --harness claude', {
      cwd: worktree,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'CLI-CLAUDE-WORKTREE',
        cwd: worktree,
        tool_name: 'Write',
        tool_input: { file_path: file }
      })
    })
    assert.equal(result.exitCode, 0)
    fs.writeFileSync(file, 'content')

    result = cli('hook session-end --harness claude', {
      cwd: worktree,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'CLI-CLAUDE-WORKTREE',
        cwd: worktree,
        transcript_path: transcript
      })
    })
    execSync(`git worktree remove --force "${worktree}"`, { cwd: dir, stdio: 'pipe' })

    assert.equal(result.exitCode, 0)
    assert.equal(Number(execSync('git rev-list --count session-end-worktree', { cwd: dir, encoding: 'utf8' }).trim()), 2)
    assert.equal(execSync('git show --format= --name-only session-end-worktree', { cwd: dir, encoding: 'utf8' }).trim(), 'worktree.txt')
  })

  it('Claude Stop payloads route to the Claude parser even with hook_event_name present', () => {
    // Regression: current Claude Code hook payloads include hook_event_name.
    // Without an explicit --harness flag the Stop hook must still be treated as
    // Claude and parsed with the Claude transcript parser, not the Codex one.
    const dir = makeRepo()
    const transcript = makeClaudeTranscript([
      { prompt: 'Explain the plan', response: 'Here is the real answer.' }
    ])

    let result = cli('hook pre-tool-use', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'CLI-CLAUDE-1',
        cwd: dir,
        tool_name: 'Write',
        tool_input: { file_path: path.join(dir, 'claude.txt') }
      })
    })
    assert.equal(result.exitCode, 0)
    fs.writeFileSync(path.join(dir, 'claude.txt'), 'content')

    result = cli('hook stop', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'CLI-CLAUDE-1',
        cwd: dir,
        transcript_path: transcript
      })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(commitCount(dir), 2)
    const body = lastBody(dir)
    assert.ok(body.includes('Response:\nHere is the real answer.'), `expected real transcript body, got: ${body}`)
    assert.ok(!body.includes('(no transcript)'), 'body should not be the empty-transcript fallback')
  })

  it('recovers ready overlapping shell changes when the last owner reaches SessionEnd', () => {
    const dir = makeRepo()
    const a = {
      sessionId: 'CLI-OVERLAP-A',
      toolUseId: 'bash-a',
      cwd: dir,
      toolName: 'Bash',
      toolInput: { command: 'generate a' }
    }
    const b = {
      sessionId: 'CLI-OVERLAP-B',
      toolUseId: 'bash-b',
      cwd: dir,
      toolName: 'Bash',
      toolInput: { command: 'generate b' }
    }
    handleTrack(a, dir)
    handleTrack(b, dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    handlePostTrack(a, dir)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b')
    handlePostTrack(b, dir)

    let result = cli('hook session-end --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'CLI-OVERLAP-A',
        cwd: dir
      })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(commitCount(dir), 1)

    result = cli('hook session-end --harness codex', {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'CLI-OVERLAP-B',
        cwd: dir
      })
    })
    assert.equal(result.exitCode, 0)
    assert.equal(waitFor(() => commitCount(dir) === 2), true)
    assert.deepEqual(
      execSync('git show --format= --name-only HEAD', { cwd: dir, encoding: 'utf8' }).trim().split('\n'),
      ['a.txt', 'b.txt']
    )
  })

  it('help text mentions hook command', () => {
    const result = cli('help')
    assert.ok(result.stdout.includes('hook'))
  })
})
