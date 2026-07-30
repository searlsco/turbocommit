const { describe, it, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync, spawnSync } = require('child_process')
const { run, runPreCompact } = require('../lib/run')
const { handleTrack } = require('../lib/track')

const realHome = process.env.HOME
const realGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL

function makeRepo (name, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tc-multi-${name}-`))
  execSync('git init -q', { cwd: root })
  if (opts.identity !== false) {
    execSync('git config user.email "test@test.com"', { cwd: root })
    execSync('git config user.name "Test"', { cwd: root })
  }
  fs.writeFileSync(path.join(root, '.turbocommit.json'), JSON.stringify({
    enabled: true,
    title: { type: 'transcript' },
    ...opts.config
  }))
  fs.writeFileSync(path.join(root, 'README.md'), name)
  if (opts.identity === false) {
    execSync('git -c user.name=Setup -c user.email=setup@test.com add -A', { cwd: root })
    execSync('git -c user.name=Setup -c user.email=setup@test.com commit -q -m Initial', { cwd: root })
  } else {
    execSync('git add -A && git commit -q -m Initial', { cwd: root })
  }
  return root
}

function makeClaudeTranscript (prompt, response = 'Done.') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-transcript-')), 'claude.jsonl')
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { content: prompt } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: response }] } })
  ].join('\n') + '\n')
  return file
}

function makeCodexTranscript (prompt, response = 'Done.') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-transcript-')), 'codex.jsonl')
  const pairs = Array.isArray(prompt) ? prompt : [{ prompt, response }]
  const lines = [JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-test' } })]
  for (const pair of pairs) {
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pair.prompt }] }
    }))
    lines.push(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pair.response }] }
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function track (anchor, sessionId, toolName, toolInput, harness = 'claude') {
  handleTrack({
    harness,
    sessionId,
    cwd: anchor,
    toolName,
    toolInput,
    raw: { cwd: anchor }
  }, anchor)
}

function stop (anchor, sessionId, transcriptPath, harness = 'claude') {
  run({
    harness,
    event: 'Stop',
    sessionId,
    transcriptPath,
    cwd: anchor,
    raw: {}
  })
}

function hook (anchor, event, harness, input) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'cli.js'), 'hook', event, '--harness', harness],
    {
      cwd: anchor,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: process.env
    }
  )
  assert.equal(result.status, 0, result.stderr)
}

function count (root) {
  return Number(execSync('git rev-list --count HEAD', { cwd: root, encoding: 'utf8' }).trim())
}

function subject (root) {
  return execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf8' }).trim()
}

function body (root) {
  return execSync('git log -1 --format=%b', { cwd: root, encoding: 'utf8' }).trim()
}

describe('multi-repository turns', () => {
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-home-'))
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  })

  after(() => {
    process.env.HOME = realHome
    if (realGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = realGitConfigGlobal
  })

  it('commits Claude Write and Edit paths in two enabled repositories', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const aFile = path.join(a, 'a.txt')
    const bFile = path.join(b, 'b.txt')
    const transcript = makeClaudeTranscript('Update both repositories')

    hook(a, 'pre-tool-use', 'claude', {
      session_id: 'CLAUDE-MULTI',
      cwd: a,
      tool_name: 'Write',
      tool_input: { file_path: aFile }
    })
    hook(a, 'pre-tool-use', 'claude', {
      session_id: 'CLAUDE-MULTI',
      cwd: a,
      tool_name: 'Edit',
      tool_input: { file_path: bFile }
    })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    hook(a, 'stop', 'claude', {
      session_id: 'CLAUDE-MULTI',
      transcript_path: transcript,
      cwd: a
    })

    assert.equal(count(a), 2)
    assert.equal(count(b), 2)
    assert.ok(body(a).includes('Prompt:\nUpdate both repositories'))
    assert.ok(body(b).includes('Prompt:\nUpdate both repositories'))
    assert.ok(body(a).includes('Turbocommit-Session: CLAUDE-MULTI'))
    assert.ok(body(b).includes('Turbocommit-Session: CLAUDE-MULTI'))
  })

  it('commits Codex apply_patch paths in two enabled repositories', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const aFile = path.join(a, 'codex-a.txt')
    const bFile = path.join(b, 'codex-b.txt')
    const transcript = makeCodexTranscript('Patch both repositories')
    const command = [
      '*** Begin Patch',
      `*** Add File: ${aFile}`,
      '+a',
      `*** Add File: ${bFile}`,
      '+b',
      '*** End Patch'
    ].join('\n')

    hook(a, 'pre-tool-use', 'codex', {
      hook_event_name: 'PreToolUse',
      session_id: 'CODEX-MULTI',
      cwd: a,
      tool_name: 'apply_patch',
      tool_input: { command }
    })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    hook(a, 'stop', 'codex', {
      hook_event_name: 'Stop',
      session_id: 'CODEX-MULTI',
      transcript_path: transcript,
      cwd: a
    })

    assert.equal(count(a), 2)
    assert.equal(count(b), 2)
    assert.ok(body(a).includes('Prompt:\nPatch both repositories'))
    assert.ok(body(b).includes('Prompt:\nPatch both repositories'))
    assert.ok(body(a).includes('Co-Authored-By: gpt-test <noreply@openai.com>'))
  })

  it('preserves Codex PreCompact planning in every repository commit', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const planning = makeCodexTranscript('Plan both repositories', 'Planning details.')
    runPreCompact({
      harness: 'codex',
      event: 'PreCompact',
      sessionId: 'CODEX-COMPACT',
      transcriptPath: planning,
      cwd: a,
      raw: {}
    })

    const aFile = path.join(a, 'compact-a.txt')
    const bFile = path.join(b, 'compact-b.txt')
    track(a, 'CODEX-COMPACT', 'apply_patch', {
      command: `*** Begin Patch\n*** Add File: ${aFile}\n+a\n*** Add File: ${bFile}\n+b\n*** End Patch`
    }, 'codex')
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    const implementation = makeCodexTranscript([
      { prompt: 'Plan both repositories', response: 'Planning details.' },
      { prompt: 'Implement both repositories', response: 'Implemented.' }
    ])
    stop(a, 'CODEX-COMPACT', implementation, 'codex')

    for (const root of [a, b]) {
      assert.ok(body(root).includes('## Planning\n\nPrompt:\nPlan both repositories'))
      assert.ok(body(root).includes('## Implementation\n\nPrompt:\nImplement both repositories'))
    }
  })

  it('uses repository-specific bounded diff context for title agents', () => {
    const command = "sh -c 'if grep -q a-only.txt; then echo Update A; else echo Update B; fi'"
    const a = makeRepo('a', { config: { title: { command } } })
    const b = makeRepo('b', { config: { title: { command } } })
    const aFile = path.join(a, 'a-only.txt')
    const bFile = path.join(b, 'b-only.txt')

    track(a, 'TITLES', 'Write', { file_path: aFile })
    track(a, 'TITLES', 'Write', { file_path: bFile })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    stop(a, 'TITLES', makeClaudeTranscript('Make changes'))

    assert.equal(subject(a), 'Update A')
    assert.equal(subject(b), 'Update B')
  })

  it('ignores a touched repository whose own config disables turbocommit', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    fs.writeFileSync(path.join(b, '.turbocommit.json'), JSON.stringify({ enabled: false }))
    execSync('git add -A && git commit -q -m Disable', { cwd: b })
    const aFile = path.join(a, 'a.txt')
    const bFile = path.join(b, 'b.txt')

    track(a, 'DISABLED', 'Write', { file_path: aFile })
    track(a, 'DISABLED', 'Write', { file_path: bFile })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    stop(a, 'DISABLED', makeClaudeTranscript('Update enabled work'))

    assert.equal(count(a), 2)
    assert.equal(count(b), 2)
    assert.equal(fs.existsSync(bFile), true)
  })

  it('commits one explicitly touched sibling without adding a session trailer', () => {
    const anchor = makeRepo('anchor')
    const sibling = makeRepo('sibling')
    const siblingFile = path.join(sibling, 'only.txt')

    track(anchor, 'ONE-SIBLING', 'Write', { file_path: siblingFile })
    fs.writeFileSync(siblingFile, 'only sibling changed')
    stop(anchor, 'ONE-SIBLING', makeClaudeTranscript('Update the sibling'))

    assert.equal(count(anchor), 1)
    assert.equal(count(sibling), 2)
    assert.ok(!body(sibling).includes('Turbocommit-Session:'))
  })

  it('requires the starting repository to be enabled', () => {
    const anchor = makeRepo('anchor')
    const sibling = makeRepo('sibling')
    fs.writeFileSync(path.join(anchor, '.turbocommit.json'), JSON.stringify({ enabled: false }))
    execSync('git add -A && git commit -q -m Disable', { cwd: anchor })
    const siblingFile = path.join(sibling, 'blocked.txt')

    track(anchor, 'DISABLED-ANCHOR', 'Write', { file_path: siblingFile })
    fs.writeFileSync(siblingFile, 'not committed')
    stop(anchor, 'DISABLED-ANCHOR', makeClaudeTranscript('Try the sibling'))

    assert.equal(count(sibling), 1)
  })

  it('commits two worktree checkouts independently', () => {
    const main = makeRepo('worktree')
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-worktree-'))
    fs.rmdirSync(worktree)
    execSync(`git worktree add -q -b other "${worktree}"`, { cwd: main })
    const mainFile = path.join(main, 'main.txt')
    const worktreeFile = path.join(worktree, 'other.txt')

    track(main, 'WORKTREES', 'Write', { file_path: mainFile })
    track(main, 'WORKTREES', 'Write', { file_path: worktreeFile })
    fs.writeFileSync(mainFile, 'main')
    fs.writeFileSync(worktreeFile, 'other')
    stop(main, 'WORKTREES', makeClaudeTranscript('Update both worktrees'))

    assert.equal(count(main), 2)
    assert.equal(count(worktree), 2)
    assert.equal(subject(main), 'Update both worktrees')
    assert.equal(subject(worktree), 'Update both worktrees')
  })

  it('commits an enabled submodule before its enabled parent', () => {
    const source = makeRepo('source')
    const parent = makeRepo('parent')
    execSync(`git -c protocol.file.allow=always submodule add -q "${source}" sub`, { cwd: parent })
    execSync('git commit -q -am "Add submodule"', { cwd: parent })
    const child = path.join(parent, 'sub')
    execSync('git config user.email "test@test.com"', { cwd: child })
    execSync('git config user.name "Test"', { cwd: child })
    const childFile = path.join(child, 'child.txt')
    const parentBefore = count(parent)
    const childBefore = count(child)

    track(parent, 'SUBMODULE', 'Write', { file_path: childFile })
    fs.writeFileSync(childFile, 'child')
    stop(parent, 'SUBMODULE', makeClaudeTranscript('Update the submodule'))

    assert.equal(count(child), childBefore + 1)
    assert.equal(count(parent), parentBefore + 1)
    const gitlink = execSync('git rev-parse HEAD:sub', { cwd: parent, encoding: 'utf8' }).trim()
    const childHead = execSync('git rev-parse HEAD', { cwd: child, encoding: 'utf8' }).trim()
    assert.equal(gitlink, childHead)
  })

  it('accumulates failed work and keeps attempting other repositories', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const c = makeRepo('c')
    execSync('git config commit.gpgsign true', { cwd: b })
    execSync('git config gpg.program false', { cwd: b })
    const aFile = path.join(a, 'first-a.txt')
    const bFile = path.join(b, 'first-b.txt')

    track(a, 'SESSION-ONE', 'Write', { file_path: aFile })
    track(a, 'SESSION-ONE', 'Write', { file_path: bFile })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    stop(a, 'SESSION-ONE', makeClaudeTranscript('First multi turn'))

    assert.equal(count(a), 2)
    assert.equal(count(b), 1)

    execSync('git config --unset commit.gpgsign', { cwd: b })
    execSync('git config --unset gpg.program', { cwd: b })
    const secondB = path.join(b, 'second-b.txt')
    const cFile = path.join(c, 'second-c.txt')
    track(a, 'SESSION-TWO', 'Write', { file_path: secondB })
    track(a, 'SESSION-TWO', 'Write', { file_path: cFile })
    fs.writeFileSync(secondB, 'b2')
    fs.writeFileSync(cFile, 'c')
    stop(a, 'SESSION-TWO', makeClaudeTranscript('Second multi turn'))

    assert.equal(count(b), 2)
    assert.equal(count(c), 2)
    assert.ok(body(b).includes('Prompt:\nFirst multi turn'))
    assert.ok(body(b).includes('Prompt:\nSecond multi turn'))
    assert.ok(body(b).includes('Turbocommit-Session: SESSION-ONE'))
    assert.ok(body(b).includes('Turbocommit-Session: SESSION-TWO'))
    assert.ok(!body(c).includes('Turbocommit-Session: SESSION-ONE'))
  })

  it('commits every repository before pushing every configured repository', () => {
    const a = makeRepo('push-a', { config: { push: true } })
    const b = makeRepo('push-b', { config: { push: true } })
    const remoteA = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-remote-a-'))
    const remoteB = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-multi-remote-b-'))
    execSync('git init -q --bare', { cwd: remoteA })
    execSync('git init -q --bare', { cwd: remoteB })
    execSync(`git remote add origin "${remoteA}" && git push -q -u origin HEAD`, { cwd: a })
    execSync(`git remote add origin "${remoteB}" && git push -q -u origin HEAD`, { cwd: b })
    const aFile = path.join(a, 'push-a.txt')
    const bFile = path.join(b, 'push-b.txt')

    track(a, 'PUSH-ALL', 'Write', { file_path: aFile })
    track(a, 'PUSH-ALL', 'Write', { file_path: bFile })
    fs.writeFileSync(aFile, 'a')
    fs.writeFileSync(bFile, 'b')
    stop(a, 'PUSH-ALL', makeClaudeTranscript('Commit and push both'))

    assert.equal(
      execSync('git rev-parse HEAD', { cwd: remoteA, encoding: 'utf8' }).trim(),
      execSync('git rev-parse HEAD', { cwd: a, encoding: 'utf8' }).trim()
    )
    assert.equal(
      execSync('git rev-parse HEAD', { cwd: remoteB, encoding: 'utf8' }).trim(),
      execSync('git rev-parse HEAD', { cwd: b, encoding: 'utf8' }).trim()
    )
  })
})
