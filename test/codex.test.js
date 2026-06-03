const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { resolveCodexTranscriptPath } = require('../lib/codex')

describe('resolveCodexTranscriptPath', () => {
  let realCodexHome

  beforeEach(() => {
    realCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-home-'))
  })

  afterEach(() => {
    if (realCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = realCodexHome
    }
  })

  it('uses transcript_path when present', () => {
    assert.equal(resolveCodexTranscriptPath({ transcriptPath: '/tmp/rollout.jsonl' }), '/tmp/rollout.jsonl')
  })

  it('looks up rollout path from CODEX_HOME catalog by session id', () => {
    const catalogDir = path.join(process.env.CODEX_HOME, 'sessions', 'index')
    fs.mkdirSync(catalogDir, { recursive: true })
    fs.writeFileSync(path.join(catalogDir, 'catalog.jsonl'), JSON.stringify({
      session_id: 'S1',
      rollout_path: 'sessions/2026/06/03/rollout.jsonl'
    }) + '\n')

    const result = resolveCodexTranscriptPath({ sessionId: 'S1' })

    assert.equal(result, path.join(process.env.CODEX_HOME, 'sessions/2026/06/03/rollout.jsonl'))
  })

  it('uses absolute rollout path from Codex catalog as-is', () => {
    const catalogDir = path.join(process.env.CODEX_HOME, 'sessions', 'index')
    fs.mkdirSync(catalogDir, { recursive: true })
    const rolloutPath = path.join(os.tmpdir(), 'rollout-S2.jsonl')
    fs.writeFileSync(path.join(catalogDir, 'catalog.jsonl'), JSON.stringify({
      session_id: 'S2',
      rollout_path: rolloutPath
    }) + '\n')

    const result = resolveCodexTranscriptPath({ sessionId: 'S2' })

    assert.equal(result, rolloutPath)
  })
})
