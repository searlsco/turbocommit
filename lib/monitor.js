const fs = require('fs')
const { logPath } = require('./log')
const { existingHarnesses } = require('./harness')

const COLORS = {
  start: '\x1b[36m',
  success: '\x1b[32m',
  fail: '\x1b[31m',
  skip: '\x1b[33m',
  reset: '\x1b[0m',
  dim: '\x1b[2m'
}

function formatSize (bytes) {
  if (bytes < 1024) return bytes + 'B'
  return Math.round(bytes / 1024) + 'KB'
}

function formatTime (ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

function formatEntry (entry, cols) {
  const time = formatTime(entry.at)
  const event = entry.event.padEnd(7)
  const project = (entry.project || '').padEnd(12)
  const branch = (entry.branch || '').padEnd(10)
  const size = formatSize(entry.context || 0).padEnd(6)
  const color = COLORS[entry.event] || ''

  // Fixed columns: time(8) + 2 + event(7) + 2 + project(12) + 2 + branch(10) + 2 + size(6) = 51
  const fixedWidth = 51
  const maxTitle = Math.max(0, (cols || 80) - fixedWidth)
  let title = entry.title || ''
  if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + '\u2026'

  return `${COLORS.dim}${time}${COLORS.reset}  ${color}${event}${COLORS.reset}  ${project}  ${branch}  ${size}${title}`
}

function readEntries (filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8')
    return data.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function monitor (harness) {
  harness = resolveHarness(harness)
  if (!harness) return false
  const cols = process.stdout.columns || 80
  const lp = logPath(harness)
  const entries = readEntries(lp)
  for (const entry of entries) {
    process.stdout.write(formatEntry(entry, cols) + '\n')
  }

  let offset = 0
  try { offset = fs.statSync(lp).size } catch {}

  fs.watchFile(lp, { interval: 500 }, () => {
    let data
    try {
      const stat = fs.statSync(lp)
      if (stat.size < offset) offset = 0 // File was truncated/recreated
      if (stat.size === offset) return
      const fd = fs.openSync(lp, 'r')
      const buf = Buffer.alloc(stat.size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      fs.closeSync(fd)
      offset = stat.size
      data = buf.toString('utf8')
    } catch {
      return
    }
    const lines = data.split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        process.stdout.write(formatEntry(entry, process.stdout.columns || cols) + '\n')
      } catch {}
    }
  })

  process.on('SIGINT', () => {
    fs.unwatchFile(lp)
    process.exit(0)
  })
  return true
}

function resolveHarness (harness) {
  if (harness) return harness
  const harnesses = existingHarnesses()
  if (harnesses.length === 1) return harnesses[0]
  if (harnesses.length === 0) return 'claude'
  process.stderr.write('Multiple harnesses installed. Run: turbocommit monitor --harness claude|codex\n')
  return null
}

module.exports = { monitor, formatEntry, readEntries, formatSize, formatTime, resolveHarness }
