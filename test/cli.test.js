const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

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

    let result = cli('hook pre-tool-use', {
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

    result = cli('hook stop', {
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

  it('help text mentions hook command', () => {
    const result = cli('help')
    assert.ok(result.stdout.includes('hook'))
  })
})
