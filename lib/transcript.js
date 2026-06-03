const fs = require('fs')

/**
 * Parse a JSONL transcript file into prompt/response pairs.
 * Returns array of { prompt, response } objects.
 */
function parseTranscript (filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const state = { pairs: [], prompt: null, response: '' }

  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      if (state.prompt !== null) {
        state.pairs.push({ prompt: state.prompt, response: state.response })
      }
      state.prompt = entry.message.content
      state.response = ''
    } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const hasToolUse = entry.message.content.some(b => b.type === 'tool_use')
      if (hasToolUse) continue
      const texts = entry.message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
      state.response += texts.join('')
    }
  }

  if (state.prompt !== null) {
    state.pairs.push({ prompt: state.prompt, response: state.response })
  }

  return state.pairs
}

function parseCodexTranscript (filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const state = { pairs: [], prompt: null, response: '' }

  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const payload = entry.payload
    if (entry.type !== 'response_item' || payload?.type !== 'message') continue

    if (payload.role === 'user') {
      const prompt = visibleText(payload.content)
      if (isCodexSystemStatus(prompt)) continue
      if (state.prompt !== null) {
        state.pairs.push({ prompt: state.prompt, response: state.response })
      }
      state.prompt = prompt
      state.response = ''
    } else if (payload.role === 'assistant' && state.prompt !== null) {
      state.response += visibleText(payload.content)
    }
  }

  if (state.prompt !== null) {
    state.pairs.push({ prompt: state.prompt, response: state.response })
  }

  return state.pairs.filter(p => p.prompt)
}

function visibleText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
    .map(block => block.text)
    .filter(Boolean)
    .join('')
}

function isCodexSystemStatus (text) {
  return text.startsWith('== System Status ==\n') && text.includes('[automatic message added by system]')
}

/**
 * Format a single prompt/response pair.
 */
function formatPair (p) {
  return `Prompt:\n${p.prompt}\n\nResponse:\n${p.response}`
}

/**
 * Format prompt/response pairs into a commit body.
 */
function formatBody (pairs) {
  if (pairs.length === 0) return '(no transcript)'
  return pairs.map(formatPair).join('\n\n---\n\n')
}

/**
 * Format a condensed transcript for title generation.
 * Returns the full transcript when it fits within budget, otherwise
 * samples the first, middle, and last pairs with gap markers.
 * Individual prompts and responses are capped to keep the sample compact.
 */
function formatTitleTranscript (pairs, budget) {
  budget = budget || 20000
  if (pairs.length === 0) return '(no transcript)'

  const full = formatBody(pairs)
  if (full.length <= budget) return full

  const sep = '\n\n---\n\n'
  const cap = (text, max) => text.length > max ? text.slice(0, max) + '...' : text
  const fmt = p => `Prompt:\n${cap(p.prompt, 500)}\n\nResponse:\n${cap(p.response, 2000)}`

  // Pick first, middle, and last — deduplicated and in order
  const indices = [...new Set([0, Math.floor(pairs.length / 2), pairs.length - 1])]

  const parts = []
  let prev = -1
  for (const i of indices) {
    const skipped = i - prev - 1
    if (skipped > 0) parts.push(`[... ${skipped} turns omitted ...]`)
    parts.push(fmt(pairs[i]))
    prev = i
  }

  return parts.join(sep)
}

/**
 * Extract a headline from the last user prompt.
 * Falls back to a timestamped default.
 */
function extractHeadline (pairs) {
  if (pairs.length === 0) return fallbackHeadline()
  const lastPrompt = pairs[pairs.length - 1].prompt
  if (!lastPrompt) return fallbackHeadline()
  const firstLine = lastPrompt.split('\n')[0]
  return firstLine.slice(0, 72) || fallbackHeadline()
}

function fallbackHeadline () {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `auto-commit ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * Extract the model ID from the first assistant entry in a JSONL transcript.
 * Returns null if not found.
 */
function extractModel (filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'assistant' && entry.message?.model) {
      return entry.message.model
    }
  }
  return null
}

function extractCodexModel (filePath, hookModel) {
  if (hookModel) return hookModel
  if (!filePath || !fs.existsSync(filePath)) return null

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'session_meta' && entry.payload?.model) return entry.payload.model
    if (entry.type === 'session_meta' && entry.payload?.model_slug) return entry.payload.model_slug
  }
  return null
}

module.exports = {
  parseTranscript,
  parseCodexTranscript,
  formatPair,
  formatBody,
  formatTitleTranscript,
  extractHeadline,
  fallbackHeadline,
  extractModel,
  extractCodexModel,
  visibleText,
  isCodexSystemStatus
}
