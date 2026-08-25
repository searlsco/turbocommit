const { tryRun } = require('./io')

const DEFAULT_COMMAND = 'claude -p --model haiku'
const DEFAULT_CODEX_COMMAND = 'codex exec --ephemeral -'

const DEFAULT_TITLE_PROMPT = `You have 10 seconds. Write a single-line git commit headline (max 72 chars) from this coding session transcript. Speed over perfection — a rough title beats no title.

Rules:
- Imperative mood ("Add", "Fix", "Update")
- Specific about what changed
- No trailing period
- No conventional commit prefixes unless clearly a fix/feat

Transcript:
{{transcript}}

Respond with ONLY the headline, nothing else. Do not deliberate.`

const DEFAULT_BODY_PROMPT = `Given this transcript of a coding session, write a concise git commit body.

Rules:
- Summarize what was done and why
- Be concise — a few sentences or bullet points
- Focus on the "why" more than the "what"

Transcript:
{{transcript}}

Respond with ONLY the commit body, nothing else.`

function renderPrompt (template, transcript) {
  return template.replace(/\{\{transcript\}\}/g, () => transcript)
}

function runAgent (root, command, prompt, opts = {}) {
  const binary = command.split(/\s+/)[0]
  const whichResult = tryRun(`which ${binary}`, {})
  if (whichResult.code !== 0) return null
  const timeout = Number.isFinite(opts.deadline)
    ? Math.min(45000, Math.max(0, opts.deadline - Date.now()))
    : 45000
  if (timeout <= 0) return null

  const result = tryRun(command, {
    cwd: root,
    timeout,
    input: prompt,
    env: { ...process.env, TURBOCOMMIT_DISABLED: '1', CLAUDECODE: '' }
  })

  if (result.code !== 0) return null

  const output = (result.stdout.trim() || result.stderr.trim())
  return output || null
}

function defaultCommand (harness) {
  return harness === 'codex' ? DEFAULT_CODEX_COMMAND : DEFAULT_COMMAND
}

function runTitleAgent (root, titleCfg, transcript, harness, opts) {
  const command = titleCfg.command || defaultCommand(harness)
  const template = titleCfg.prompt || DEFAULT_TITLE_PROMPT
  const prompt = renderPrompt(template, transcript)
  const result = runAgent(root, command, prompt, opts)
  if (!result) return null
  // Take only first line and enforce 72 char limit
  return result.split('\n')[0].slice(0, 72) || null
}

function runBodyAgent (root, bodyCfg, transcript, harness, opts) {
  const command = bodyCfg.command || defaultCommand(harness)
  const template = bodyCfg.prompt || DEFAULT_BODY_PROMPT
  const prompt = renderPrompt(template, transcript)
  return runAgent(root, command, prompt, opts)
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_BODY_PROMPT,
  defaultCommand,
  renderPrompt,
  runAgent,
  runTitleAgent,
  runBodyAgent
}
