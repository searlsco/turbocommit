const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { parseTranscript, parseCodexTranscript, formatBody, formatTitleTranscript, extractHeadline, fallbackHeadline, extractModel, extractCodexModel } = require('../lib/transcript')

function tmpJsonl (lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
  const file = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('parseTranscript', () => {
  it('returns empty array for missing file', () => {
    assert.deepStrictEqual(parseTranscript('/nonexistent'), [])
  })

  it('returns empty array for null path', () => {
    assert.deepStrictEqual(parseTranscript(null), [])
  })

  it('parses a single prompt/response pair', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Fix the bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Fix the bug')
    assert.equal(pairs[0].response, 'Done.')
  })

  it('parses multiple prompt/response pairs', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'First prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First response' }] } },
      { type: 'user', message: { content: 'Second prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Second response' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 2)
    assert.equal(pairs[0].prompt, 'First prompt')
    assert.equal(pairs[1].prompt, 'Second prompt')
  })

  it('skips assistant entries that contain tool_use blocks', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Internal narration' },
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'More narration' }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Final response.' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs[0].response, 'Final response.')
  })

  it('returns empty response when all assistant entries have tool_use', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Narration before tool' },
            { type: 'tool_use', name: 'Edit' }
          ]
        }
      }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].response, '')
  })

  it('concatenates multiple assistant entries', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 1 ' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 2' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs[0].response, 'Chunk 1 Chunk 2')
  })

  it('skips non-string user messages', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: [{ type: 'image' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Saw image' }] } },
      { type: 'user', message: { content: 'Real prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Real response' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Real prompt')
  })

  it('handles malformed JSON lines gracefully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      'this is not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } })
    ].join('\n'))
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Hello')
  })

  it('handles empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, '')
    assert.deepStrictEqual(parseTranscript(file), [])
  })
})

describe('parseCodexTranscript', () => {
  it('parses visible user and assistant text from Codex rollout JSONL', () => {
    const file = tmpJsonl([
      { type: 'session_meta', payload: { model: 'gpt-5.5' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Ignore instructions' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix Codex support' }] } },
      { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'output_text', text: 'Ignore reasoning' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Implemented.' }] } }
    ])

    const pairs = parseCodexTranscript(file)

    assert.deepStrictEqual(pairs, [{ prompt: 'Fix Codex support', response: 'Implemented.' }])
  })

  it('skips automatic Codex system status messages', () => {
    const file = tmpJsonl([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add the real feature' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '== System Status ==\n [automatic message added by system]\n\n cwd: /tmp/repo' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Implemented the real feature.' }] } }
    ])

    const pairs = parseCodexTranscript(file)

    assert.deepStrictEqual(pairs, [{ prompt: 'Add the real feature', response: 'Implemented the real feature.' }])
  })

  it('strips Codex AGENTS context from the first user-visible prompt', () => {
    const file = tmpJsonl([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              '# AGENTS.md instructions for /tmp/project',
              '',
              '<INSTRUCTIONS>',
              'Do the project-specific things.',
              '</INSTRUCTIONS><environment_context>',
              '  <cwd>/tmp/project</cwd>',
              '</environment_context>',
              'Fix Codex commit messages'
            ].join('\n')
          }]
        }
      },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }
    ])

    const pairs = parseCodexTranscript(file)

    assert.deepStrictEqual(pairs, [{ prompt: 'Fix Codex commit messages', response: 'Fixed.' }])
  })

  it('drops Codex AGENTS context prompts when no real prompt remains', () => {
    const file = tmpJsonl([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              '# AGENTS.md instructions for /tmp/project',
              '',
              '<INSTRUCTIONS>',
              'Do the project-specific things.',
              '</INSTRUCTIONS><environment_context>',
              '  <cwd>/tmp/project</cwd>',
              '</environment_context>'
            ].join('\n')
          }]
        }
      },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ignored bootstrap response.' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the real bug' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the real bug.' }] } }
    ])

    const pairs = parseCodexTranscript(file)

    assert.deepStrictEqual(pairs, [{ prompt: 'Fix the real bug', response: 'Fixed the real bug.' }])
  })
})

describe('formatBody', () => {
  it('returns "(no transcript)" for empty pairs', () => {
    assert.equal(formatBody([]), '(no transcript)')
  })

  it('formats single pair', () => {
    const result = formatBody([{ prompt: 'Fix it', response: 'Fixed.' }])
    assert.equal(result, 'Prompt:\nFix it\n\nResponse:\nFixed.')
  })

  it('joins multiple pairs with separator', () => {
    const result = formatBody([
      { prompt: 'A', response: 'B' },
      { prompt: 'C', response: 'D' }
    ])
    assert.ok(result.includes('---'))
    assert.ok(result.includes('Prompt:\nA'))
    assert.ok(result.includes('Prompt:\nC'))
  })
})

describe('formatTitleTranscript', () => {
  it('returns full transcript when under budget', () => {
    const pairs = [
      { prompt: 'Fix bug', response: 'Done.' },
      { prompt: 'Add tests', response: 'Added.' }
    ]
    assert.equal(formatTitleTranscript(pairs), formatBody(pairs))
  })

  it('returns "(no transcript)" for empty pairs', () => {
    assert.equal(formatTitleTranscript([]), '(no transcript)')
  })

  it('samples first, middle, and last pairs when over budget', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      prompt: `Prompt ${i}`,
      response: 'x'.repeat(3000)
    }))
    const result = formatTitleTranscript(pairs, 500)
    assert.ok(result.includes('Prompt 0'), 'includes first pair')
    assert.ok(result.includes('Prompt 5'), 'includes middle pair')
    assert.ok(result.includes('Prompt 9'), 'includes last pair')
    assert.ok(!result.includes('Prompt 3'), 'excludes non-sampled pair')
  })

  it('includes gap markers for omitted turns', () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      prompt: `P${i}`,
      response: 'x'.repeat(3000)
    }))
    const result = formatTitleTranscript(pairs, 500)
    assert.ok(result.includes('[... 4 turns omitted ...]'))
    assert.ok(result.includes('[... 3 turns omitted ...]'))
  })

  it('truncates long prompts to 500 chars', () => {
    const pairs = [
      { prompt: 'A'.repeat(1000), response: 'short' },
      { prompt: 'B'.repeat(1000), response: 'short' }
    ]
    const result = formatTitleTranscript(pairs, 100)
    assert.ok(result.includes('A'.repeat(500) + '...'))
    assert.ok(!result.includes('A'.repeat(501)))
  })

  it('truncates long responses to 2000 chars', () => {
    const pairs = [
      { prompt: 'short', response: 'R'.repeat(5000) },
      { prompt: 'short', response: 'S'.repeat(5000) }
    ]
    const result = formatTitleTranscript(pairs, 100)
    assert.ok(result.includes('R'.repeat(2000) + '...'))
    assert.ok(!result.includes('R'.repeat(2001)))
  })

  it('handles single pair', () => {
    const pairs = [{ prompt: 'Only one', response: 'x'.repeat(30000) }]
    const result = formatTitleTranscript(pairs, 100)
    assert.ok(result.includes('Only one'))
    assert.ok(!result.includes('omitted'))
  })

  it('handles two pairs without duplicate indices', () => {
    const pairs = [
      { prompt: 'First', response: 'x'.repeat(15000) },
      { prompt: 'Second', response: 'x'.repeat(15000) }
    ]
    const result = formatTitleTranscript(pairs, 100)
    assert.ok(result.includes('First'))
    assert.ok(result.includes('Second'))
    // Should not have duplicate entries
    const firstCount = result.split('First').length - 1
    assert.equal(firstCount, 1, 'first pair should appear exactly once')
  })

  it('deduplicates when middle equals first or last', () => {
    // With 2 pairs, floor(2/2) = 1, so indices are [0, 1, 1] → deduplicated to [0, 1]
    const pairs = [
      { prompt: 'A', response: 'x'.repeat(15000) },
      { prompt: 'B', response: 'x'.repeat(15000) }
    ]
    const result = formatTitleTranscript(pairs, 100)
    const bCount = result.split('Prompt:\nB').length - 1
    assert.equal(bCount, 1, 'last pair should appear exactly once')
  })
})

describe('extractHeadline', () => {
  it('returns fallback for empty pairs', () => {
    const headline = extractHeadline([])
    assert.match(headline, /^auto-commit \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('uses first line of last prompt', () => {
    const headline = extractHeadline([
      { prompt: 'First thing', response: '' },
      { prompt: 'Second thing\nMore details', response: '' }
    ])
    assert.equal(headline, 'Second thing')
  })

  it('truncates to 72 chars', () => {
    const longLine = 'A'.repeat(100)
    const headline = extractHeadline([{ prompt: longLine, response: '' }])
    assert.equal(headline.length, 72)
  })
})

describe('fallbackHeadline', () => {
  it('matches expected format', () => {
    assert.match(fallbackHeadline(), /^auto-commit \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('extractModel', () => {
  it('returns null for missing file', () => {
    assert.equal(extractModel('/nonexistent'), null)
  })

  it('returns null for null path', () => {
    assert.equal(extractModel(null), null)
  })

  it('extracts model from first assistant entry', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Hi' }] } }
    ])
    assert.equal(extractModel(file), 'claude-opus-4-6')
  })

  it('skips entries without model field', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Bye' }] } }
    ])
    assert.equal(extractModel(file), 'claude-sonnet-4-6')
  })

  it('returns null when no assistant entries have model', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }
    ])
    assert.equal(extractModel(file), null)
  })

  it('returns null for empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, '')
    assert.equal(extractModel(file), null)
  })
})

describe('extractCodexModel', () => {
  it('prefers hook model', () => {
    assert.equal(extractCodexModel('/missing', 'gpt-5.5'), 'gpt-5.5')
  })

  it('extracts model from session metadata', () => {
    const file = tmpJsonl([
      { type: 'session_meta', payload: { model: 'gpt-5.4' } }
    ])

    assert.equal(extractCodexModel(file), 'gpt-5.4')
  })
})
