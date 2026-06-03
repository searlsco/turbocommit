const fs = require('fs')
const path = require('path')
const os = require('os')
const { codexHome } = require('./harness')

function logPath (harness = 'claude') {
  const home = harness === 'codex' ? codexHome() : path.join(os.homedir(), '.claude')
  return path.join(home, 'turbocommit', 'monitor.jsonl')
}

function logEvent (event, meta = {}) {
  try {
    const entry = { event, ...meta, title: meta.title || null, at: Date.now() }
    const p = logPath(meta.harness || 'claude')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(entry) + '\n')
  } catch {}
}

module.exports = { logEvent, logPath }
