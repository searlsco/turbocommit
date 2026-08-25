const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  renderPrompt,
  runAgent,
  runTitleAgent,
  runBodyAgent
} = require('../lib/agent')

describe('renderPrompt', () => {
  it('replaces {{transcript}} with the transcript', () => {
    const result = renderPrompt('Before {{transcript}} after', 'my transcript')
    assert.equal(result, 'Before my transcript after')
  })

  it('replaces multiple occurrences', () => {
    const result = renderPrompt('{{transcript}} and {{transcript}}', 'X')
    assert.equal(result, 'X and X')
  })

  it('leaves template unchanged when no placeholder', () => {
    const result = renderPrompt('no placeholder here', 'X')
    assert.equal(result, 'no placeholder here')
  })

  it('preserves $$ in transcript without corruption', () => {
    const result = renderPrompt('T: {{transcript}}', 'used $$ for replacement')
    assert.equal(result, 'T: used $$ for replacement')
  })

  it('preserves $& and $` and $\' in transcript', () => {
    const transcript = "text with $& and $` and $' patterns"
    const result = renderPrompt('{{transcript}}', transcript)
    assert.equal(result, transcript)
  })
})

describe('runAgent', () => {
  it('runs a command and returns trimmed stdout', () => {
    const result = runAgent('/tmp', 'echo "Fix the auth bug"', 'ignored')
    assert.equal(result, 'Fix the auth bug')
  })

  it('returns null for missing binary', () => {
    const result = runAgent('/tmp', 'nonexistent_binary_xyz123', 'ignored')
    assert.equal(result, null)
  })

  it('returns null on non-zero exit', () => {
    // Use bash -c so `which bash` succeeds, then the exit code path is exercised
    const result = runAgent('/tmp', 'bash -c "exit 1"', 'ignored')
    assert.equal(result, null)
  })

  it('sets TURBOCOMMIT_DISABLED in child env', () => {
    const result = runAgent('/tmp', 'echo $TURBOCOMMIT_DISABLED', 'ignored')
    assert.equal(result, '1')
  })

  it('clears CLAUDECODE in child env', () => {
    process.env.CLAUDECODE = 'something'
    try {
      const cmd = 'echo "CLAUDECODE=${CLAUDECODE:-empty}"' // eslint-disable-line no-template-curly-in-string
      const result = runAgent('/tmp', cmd, 'ignored')
      assert.equal(result, 'CLAUDECODE=empty')
    } finally {
      delete process.env.CLAUDECODE
    }
  })

  it('passes prompt on stdin', () => {
    const result = runAgent('/tmp', 'cat', 'hello from stdin')
    assert.equal(result, 'hello from stdin')
  })

  it('falls back to stderr when stdout is empty', () => {
    const result = runAgent('/tmp', 'bash -c "echo oops >&2"', 'ignored')
    assert.equal(result, 'oops')
  })

  it('returns null when command times out', () => {
    // runAgent defaults to a 45s timeout; we can't wait that long in tests.
    // Instead, verify the tryRun timeout plumbing works end-to-end.
    const { tryRun } = require('../lib/io')
    const r = tryRun('sleep 10', { timeout: 100 })
    assert.notEqual(r.code, 0)
    assert.equal(r.signal, 'SIGTERM')
  })

  it('caps command time to an absolute lifecycle deadline', () => {
    const startedAt = Date.now()
    const result = runAgent('/tmp', 'sleep 10', 'ignored', { deadline: startedAt + 100 })

    assert.equal(result, null)
    assert.ok(Date.now() - startedAt < 2000)
  })
})

describe('runTitleAgent', () => {
  it('uses the configured command', () => {
    const result = runTitleAgent('/tmp', { command: 'echo "Add user auth"' }, 'transcript')
    assert.equal(result, 'Add user auth')
  })

  it('truncates to 72 characters', () => {
    const longLine = 'A'.repeat(100)
    const result = runTitleAgent('/tmp', { command: `echo "${longLine}"` }, 'transcript')
    assert.equal(result.length, 72)
  })

  it('takes only the first line', () => {
    const result = runTitleAgent('/tmp', { command: 'printf "Line one\\nLine two"' }, 'transcript')
    assert.equal(result, 'Line one')
  })

  it('returns null when agent fails', () => {
    const result = runTitleAgent('/tmp', { command: 'bash -c "exit 1"' }, 'transcript')
    assert.equal(result, null)
  })

  it('falls back to null for missing default command', () => {
    const result = runTitleAgent('/tmp', { command: 'nonexistent_cmd_12345' }, 'transcript')
    assert.equal(result, null)
  })

  it('uses custom prompt template', () => {
    const result = runTitleAgent('/tmp', {
      command: 'cat',
      prompt: 'Custom: {{transcript}}'
    }, 'my transcript')
    assert.equal(result, 'Custom: my transcript')
  })

  it('uses default prompt template when none configured', () => {
    // cat returns full prompt on stdout; runTitleAgent takes first line (72 chars)
    // Verify it returns a non-null string derived from the default template
    const result = runTitleAgent('/tmp', { command: 'cat' }, 'my transcript')
    assert.ok(typeof result === 'string')
    assert.ok(result.length > 0)
    assert.ok(result.length <= 72)
  })
})

describe('runBodyAgent', () => {
  it('uses the configured command', () => {
    const result = runBodyAgent('/tmp', { command: 'echo "Body text"' }, 'transcript')
    assert.equal(result, 'Body text')
  })

  it('returns null when agent fails', () => {
    const result = runBodyAgent('/tmp', { command: 'bash -c "exit 1"' }, 'transcript')
    assert.equal(result, null)
  })

  it('uses custom prompt template', () => {
    const result = runBodyAgent('/tmp', {
      command: 'cat',
      prompt: 'Summarize: {{transcript}}'
    }, 'the transcript')
    assert.equal(result, 'Summarize: the transcript')
  })

  it('uses default prompt template when none configured', () => {
    const result = runBodyAgent('/tmp', { command: 'cat' }, 'the transcript')
    assert.ok(result.includes('the transcript'))
    assert.ok(result.includes('concise'))
  })
})
