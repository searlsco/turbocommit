const fs = require('fs')
const path = require('path')
const { codexHome } = require('./harness')

function resolveCodexTranscriptPath (hookInput) {
  if (hookInput.transcriptPath) return hookInput.transcriptPath
  if (!hookInput.sessionId) return null

  const catalog = path.join(codexHome(), 'sessions', 'index', 'catalog.jsonl')
  let lines
  try {
    lines = fs.readFileSync(catalog, 'utf8').split('\n')
  } catch {
    return null
  }

  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.session_id === hookInput.sessionId && entry.rollout_path) {
      return path.isAbsolute(entry.rollout_path)
        ? entry.rollout_path
        : path.join(codexHome(), entry.rollout_path)
    }
  }
  return null
}

module.exports = { resolveCodexTranscriptPath }
