const SAFE_NAMES = new Set([
  // Shell / OS
  'HOME', 'USER', 'SHELL', 'PATH', 'PWD', 'OLDPWD', 'LANG', 'TERM',
  'EDITOR', 'VISUAL', 'PAGER', 'HOSTNAME', 'LOGNAME', 'DISPLAY', 'TZ',
  'TMPDIR', 'SHLVL', '_', 'BROWSER', 'COMMAND_MODE', 'COLUMNS', 'LINES',
  'MANPATH', 'INFOPATH',

  // Terminal
  'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
  'ITERM_SESSION_ID', 'ITERM_PROFILE', 'APPLE_TERMINAL_ID',

  // Locale
  'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY',
  'LC_NUMERIC', 'LC_TIME',

  // XDG
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_CLASS', 'XDG_SESSION_ID', 'XDG_SEAT',
  'XDG_VTNR', 'XDG_MENU_PREFIX',

  // Dev environment
  'NODE_ENV', 'RAILS_ENV', 'RACK_ENV', 'GO_ENV', 'MIX_ENV', 'FLASK_ENV',
  'DEBUG', 'VERBOSE', 'LOG_LEVEL', 'PORT', 'HOST', 'CI',
  'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'NVM_CD_FLAGS',
  'VOLTA_HOME', 'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY',
  'HOMEBREW_SHELLENV_PREFIX',

  // SSH / GPG (socket paths, not keys)
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'GPG_TTY',

  // Git
  'GIT_EDITOR', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT'
])

// Values that are common English words, config toggles, or well-known
// non-secret defaults. Checked case-insensitively.
const SAFE_VALUES = new Set([
  // Boolean-like
  'true', 'false', 'yes', 'no', 'on', 'off',

  // Environment modes
  'development', 'production', 'staging', 'test', 'testing',
  'dev', 'prod', 'local', 'ci', 'qa', 'sandbox', 'preview',
  'canary', 'demo', 'benchmark', 'profile', 'uat', 'integration',
  'preprod', 'pre-production', 'stage', 'deployment',

  // Log levels
  'trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal',
  'critical', 'notice', 'verbose', 'silent', 'quiet', 'off',

  // Common toggles/modes
  'enabled', 'disabled', 'always', 'never', 'auto', 'default',
  'manual', 'none', 'null', 'undefined', 'inherit', 'unset',
  'strict', 'lax', 'permissive', 'enforcing', 'noninteractive',

  // Editors, pagers, browsers (bare names)
  'vim', 'vi', 'nano', 'emacs', 'nvim', 'code', 'subl', 'mate',
  'micro', 'ed', 'pico', 'gedit', 'kate', 'hx', 'kak', 'kakoune',
  'joe', 'emacsclient', 'less', 'more', 'most', 'cat',
  'open', 'firefox', 'chromium', 'links', 'lynx', 'w3m', 'safari', 'opera',

  // Common English words that appear as env values
  'allow', 'deny', 'block', 'drop', 'accept', 'reject',
  'public', 'private', 'master', 'main', 'release',
  'read', 'write', 'root', 'latest', 'stable', 'edge',
  'screen', 'random', 'node', 'ruby', 'python', 'go', 'java',
  'rust', 'php', 'slim', 'alpine',
  'localhost',

  // Platform/architecture identifiers
  'linux', 'darwin', 'win32', 'windows', 'freebsd', 'openbsd',
  'netbsd', 'sunos', 'aix', 'android', 'cygwin', 'msys',
  'x86_64', 'amd64', 'x64', 'arm64', 'aarch64', 'i386', 'i686',
  'ia32', 'armv7l', 'arm', 'ppc64le', 's390x', 'riscv64',

  // TERM values
  'xterm', 'xterm-256color', 'xterm-color', 'xterm-16color',
  'screen', 'screen-256color', 'tmux', 'tmux-256color',
  'linux', 'vt100', 'vt220', 'dumb', 'ansi', 'rxvt',
  'rxvt-unicode', 'rxvt-unicode-256color', 'alacritty', 'kitty',
  'wezterm', 'eterm-color', 'foot', 'foot-extra',
  'gnome-256color', 'konsole-256color', 'st-256color',
  'putty', 'putty-256color',

  // COLORTERM
  'truecolor', '24bit',

  // TERM_PROGRAM
  'apple_terminal', 'iterm.app', 'vscode', 'hyper',

  // Docker/CI identifiers
  'bullseye', 'bookworm', 'jammy', 'lts',
  'travis-ci', 'circleci', 'codeship', 'github-actions',
  'gitlab-ci', 'jenkins', 'buildkite',

  // System users
  'nobody', 'www-data', 'daemon', 'nonroot', 'appuser',
  'nginx', 'postgres', 'mysql', 'redis',

  // XDG session types
  'x11', 'wayland', 'tty',

  // Metasyntactic / genuinely-never-a-credential values
  'todo', 'fixme', 'tbd', 'n/a',
  'xxx', 'yyy', 'zzz', 'foo', 'bar', 'baz',
  'lorem', 'temp', 'tmp', 'blah'
])

// Pattern-based rules for values that match known non-secret formats
const SAFE_VALUE_PATTERNS = [
  /^\d+$/, // pure numeric
  /^(.)\1+$/, // repeated single char (xxxx, ****, ....)
  /^\d+\.\d+\.\d+(-[\w.]+)?$/, // semver (18.17.1, 1.0.0-beta.1)
  /^[a-z]{2}_[A-Z]{2}([.\w-]*)?$/, // locale (en_US.UTF-8)
  /^(C|POSIX)(\.UTF-8)?$/, // C/POSIX locale
  /^[A-Z][a-z]+\/[A-Za-z_]+$/, // timezone (America/New_York)
  /^(UTC|Etc\/UTC|US\/\w+)$/, // timezone shorthand
  /^\/[a-z][\w/.-]*$/, // unix path (/usr/local/bin)
  /^(https?|redis|mongodb|postgres(ql)?|mysql|amqp|smtp|memcached|elasticsearch):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)/, // localhost URLs
  /^(xterm|screen|tmux|linux|vt\d+|dumb|ansi|rxvt|alacritty|kitty|wezterm|foot)(-[\w]+)*$/, // TERM identifiers
  /^(localhost)?:\d+(\.\d+)?$/, // X11 DISPLAY (:0, :0.0)
  /^wayland-\d+$/, // Wayland display
  /^sqlite:(\/\/\/)?(:\w+:|[\w./]+)$/ // sqlite URLs
]

function isSafeValue (value) {
  if (!value || value.length <= 3) return true
  if (SAFE_VALUES.has(value.toLowerCase())) return true
  for (const pattern of SAFE_VALUE_PATTERNS) {
    if (pattern.test(value)) return true
  }
  return false
}

function buildRedactions (env) {
  env = env || process.env
  const entries = []
  for (const [name, value] of Object.entries(env)) {
    if (SAFE_NAMES.has(name)) continue
    if (isSafeValue(value)) continue
    entries.push({ name, value })
  }
  entries.sort((a, b) => b.value.length - a.value.length)
  return entries
}

function redact (text, redactions) {
  if (!text) return text
  for (const { name, value } of redactions) {
    text = text.replaceAll(value, '[REDACTED:' + name + ']')
  }
  return text
}

module.exports = { buildRedactions, redact }
