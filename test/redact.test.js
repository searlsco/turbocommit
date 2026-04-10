const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { buildRedactions, redact } = require('../lib/redact')

describe('buildRedactions', () => {
  it('excludes safelisted names', () => {
    const env = {
      HOME: '/Users/someone',
      PATH: '/usr/bin:/usr/local/bin',
      SECRET_KEY: 'my-secret-key-value'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('HOME'))
    assert.ok(!names.includes('PATH'))
    assert.ok(names.includes('SECRET_KEY'))
  })

  it('excludes empty values', () => {
    const result = buildRedactions({ EMPTY: '', REAL: 'something-real' })
    const names = result.map(r => r.name)
    assert.ok(!names.includes('EMPTY'))
    assert.ok(names.includes('REAL'))
  })

  it('excludes values with 1-3 characters', () => {
    const env = {
      A: 'x',
      B: 'xy',
      C: 'xyz',
      D: 'wxyz'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('A'))
    assert.ok(!names.includes('B'))
    assert.ok(!names.includes('C'))
    assert.ok(names.includes('D'))
  })

  it('excludes pure numeric values', () => {
    const env = {
      COUNT: '42',
      BIG_NUM: '123456789',
      API_KEY: 'abc12345'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('COUNT'))
    assert.ok(!names.includes('BIG_NUM'))
    assert.ok(names.includes('API_KEY'))
  })

  it('excludes boolean-like values case-insensitively', () => {
    const env = {
      FLAG1: 'true',
      FLAG2: 'FALSE',
      FLAG3: 'Yes',
      FLAG4: 'no',
      FLAG5: 'On',
      FLAG6: 'off',
      REAL: 'not-a-boolean'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.deepStrictEqual(names, ['REAL'])
  })

  it('sorts by value length descending', () => {
    const env = {
      SHORT: 'abcd',
      MEDIUM: 'abcdefgh',
      LONG: 'abcdefghijklmnop'
    }
    const result = buildRedactions(env)
    assert.equal(result[0].name, 'LONG')
    assert.equal(result[1].name, 'MEDIUM')
    assert.equal(result[2].name, 'SHORT')
  })

  it('excludes common English words used as env values', () => {
    const env = {
      LOG_LEVEL: 'error',
      NODE_ENV: 'test',
      PAGER: 'less',
      EDITOR: 'code',
      BROWSER: 'open',
      REAL_SECRET: 'xK9mP2vL7qR4wN8j'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('LOG_LEVEL'))
    assert.ok(!names.includes('NODE_ENV'))
    assert.ok(!names.includes('PAGER'))
    assert.ok(!names.includes('EDITOR'))
    assert.ok(!names.includes('BROWSER'))
    assert.ok(names.includes('REAL_SECRET'))
  })

  it('excludes environment mode values', () => {
    const env = {
      APP_ENV: 'development',
      DEPLOY_ENV: 'production',
      MY_ENV: 'staging',
      SECRET: 'not-an-env-mode'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('APP_ENV'))
    assert.ok(!names.includes('DEPLOY_ENV'))
    assert.ok(!names.includes('MY_ENV'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes log level values', () => {
    const env = {
      LEVEL: 'debug',
      OTHER: 'verbose',
      CRIT: 'critical',
      SECRET: 'ghp_abc123def456'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('LEVEL'))
    assert.ok(!names.includes('OTHER'))
    assert.ok(!names.includes('CRIT'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes locale-pattern values', () => {
    const env = {
      MY_LANG: 'en_US.UTF-8',
      OTHER_LANG: 'ja_JP.UTF-8',
      CHARSET: 'C.UTF-8',
      SECRET: 'real-secret-token'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('MY_LANG'))
    assert.ok(!names.includes('OTHER_LANG'))
    assert.ok(!names.includes('CHARSET'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes unix path values', () => {
    const env = {
      MY_SHELL: '/bin/bash',
      MY_DIR: '/usr/local/bin',
      TOOL_HOME: '/opt/homebrew',
      SECRET: 'sk_live_abc123xyz'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('MY_SHELL'))
    assert.ok(!names.includes('MY_DIR'))
    assert.ok(!names.includes('TOOL_HOME'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes localhost URL values', () => {
    const env = {
      DB_URL: 'postgres://localhost:5432',
      REDIS: 'redis://127.0.0.1:6379',
      API: 'http://localhost',
      SECRET: 'real-api-key-value'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('DB_URL'))
    assert.ok(!names.includes('REDIS'))
    assert.ok(!names.includes('API'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes repeated single-character values', () => {
    const env = {
      MASK1: 'xxxxxxxx',
      MASK2: '****',
      MASK3: '........',
      SECRET: 'mixed-chars-here'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('MASK1'))
    assert.ok(!names.includes('MASK2'))
    assert.ok(!names.includes('MASK3'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes semantic version strings', () => {
    const env = {
      VERSION: '18.17.1',
      PRE: '1.0.0-beta.1',
      SECRET: 'actual-secret-val'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('VERSION'))
    assert.ok(!names.includes('PRE'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes metasyntactic values but redacts default-credential placeholders', () => {
    const env = {
      META1: 'foo',
      META2: 'lorem',
      META3: 'blah',
      UNSAFE1: 'changeme',
      UNSAFE2: 'password',
      UNSAFE3: 'your-api-key-here',
      UNSAFE4: 'hunter2'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    // Metasyntactic names are genuinely never credentials
    assert.ok(!names.includes('META1'))
    assert.ok(!names.includes('META2'))
    assert.ok(!names.includes('META3'))
    // Default-credential placeholders imply someone failed to change them
    assert.ok(names.includes('UNSAFE1'))
    assert.ok(names.includes('UNSAFE2'))
    assert.ok(names.includes('UNSAFE3'))
    assert.ok(names.includes('UNSAFE4'))
  })

  it('excludes TERM identifier values', () => {
    const env = {
      MY_TERM: 'xterm-256color',
      OTHER: 'screen-256color',
      ALSO: 'tmux-256color',
      SECRET: 'Bearer eyJhbGci'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('MY_TERM'))
    assert.ok(!names.includes('OTHER'))
    assert.ok(!names.includes('ALSO'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes common toggle/mode values', () => {
    const env = {
      FEAT: 'enabled',
      MODE: 'disabled',
      RESTART: 'always',
      POLICY: 'strict',
      FRONTEND: 'noninteractive',
      SECRET: 'a-real-secret-key'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('FEAT'))
    assert.ok(!names.includes('MODE'))
    assert.ok(!names.includes('RESTART'))
    assert.ok(!names.includes('POLICY'))
    assert.ok(!names.includes('FRONTEND'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes timezone values', () => {
    const env = {
      MY_TZ: 'America/New_York',
      OTHER_TZ: 'Europe/London',
      SHORT_TZ: 'UTC',
      US_TZ: 'US/Eastern',
      ETC_TZ: 'Etc/UTC',
      SECRET: 'tok_9x8y7z6w5v4u'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('MY_TZ'))
    assert.ok(!names.includes('OTHER_TZ'))
    assert.ok(!names.includes('US_TZ'))
    assert.ok(!names.includes('ETC_TZ'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes X11 and Wayland display values', () => {
    const env = {
      DISPLAY: ':0.0',
      DISPLAY2: 'localhost:10.0',
      WAYLAND: 'wayland-0',
      SECRET: 'real-secret-here!'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('DISPLAY'))
    assert.ok(!names.includes('DISPLAY2'))
    assert.ok(!names.includes('WAYLAND'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes sqlite URL values', () => {
    const env = {
      DB1: 'sqlite:///db.sqlite3',
      DB2: 'sqlite:///:memory:',
      SECRET: 'ghp_a1b2c3d4e5f6'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('DB1'))
    assert.ok(!names.includes('DB2'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes POSIX and bare C locale values', () => {
    const env = {
      L1: 'POSIX',
      L2: 'C.UTF-8',
      SECRET: 'secret-value-1234'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('L1'))
    assert.ok(!names.includes('L2'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes TERM pattern variants not in SAFE_VALUES', () => {
    const env = {
      T1: 'vt200',
      T2: 'rxvt-unicode-new',
      T3: 'foot-extra',
      SECRET: 'my-actual-api-key'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('T1'))
    assert.ok(!names.includes('T2'))
    assert.ok(!names.includes('T3'))
    assert.ok(names.includes('SECRET'))
  })

  it('excludes platform and architecture identifiers', () => {
    const env = {
      PLAT: 'darwin',
      ARCH: 'aarch64',
      OTHER: 'x86_64',
      SECRET: 'my-actual-secret!'
    }
    const result = buildRedactions(env)
    const names = result.map(r => r.name)
    assert.ok(!names.includes('PLAT'))
    assert.ok(!names.includes('ARCH'))
    assert.ok(!names.includes('OTHER'))
    assert.ok(names.includes('SECRET'))
  })

  it('returns empty array for empty env', () => {
    assert.deepStrictEqual(buildRedactions({}), [])
  })
})

describe('redact', () => {
  it('replaces env var values with redaction marker', () => {
    const redactions = [{ name: 'API_KEY', value: 'sk-12345678' }]
    const text = 'My key is sk-12345678 here'
    assert.equal(redact(text, redactions), 'My key is [REDACTED:API_KEY] here')
  })

  it('replaces multiple occurrences of the same value', () => {
    const redactions = [{ name: 'TOKEN', value: 'tok_abcdef' }]
    const text = 'first tok_abcdef then tok_abcdef again'
    assert.equal(
      redact(text, redactions),
      'first [REDACTED:TOKEN] then [REDACTED:TOKEN] again'
    )
  })

  it('handles multiple different env vars', () => {
    const redactions = [
      { name: 'LONG_ONE', value: 'longer-secret-value' },
      { name: 'SHORT_ONE', value: 'short-val' }
    ]
    const text = 'a longer-secret-value and short-val here'
    assert.equal(
      redact(text, redactions),
      'a [REDACTED:LONG_ONE] and [REDACTED:SHORT_ONE] here'
    )
  })

  it('processes longest values first to avoid partial replacement', () => {
    const redactions = [
      { name: 'FULL_URL', value: 'https://secret-host.com/path' },
      { name: 'HOST', value: 'secret-host.com' }
    ]
    const text = 'connecting to https://secret-host.com/path now'
    assert.equal(
      redact(text, redactions),
      'connecting to [REDACTED:FULL_URL] now'
    )
  })

  it('returns text unchanged when no values match', () => {
    const redactions = [{ name: 'KEY', value: 'not-in-text' }]
    assert.equal(redact('hello world', redactions), 'hello world')
  })

  it('returns falsy input unchanged', () => {
    const redactions = [{ name: 'KEY', value: 'whatever' }]
    assert.equal(redact(null, redactions), null)
    assert.equal(redact('', redactions), '')
    assert.equal(redact(undefined, redactions), undefined)
  })

  it('handles values containing regex special characters', () => {
    const redactions = [{ name: 'WEBHOOK', value: 'https://hooks.example.com/t?id=123&key=abc' }]
    const text = 'posting to https://hooks.example.com/t?id=123&key=abc done'
    assert.equal(
      redact(text, redactions),
      'posting to [REDACTED:WEBHOOK] done'
    )
  })

  it('handles values that contain the string [REDACTED', () => {
    const redactions = [{ name: 'WEIRD', value: '[REDACTED:FAKE]' }]
    const text = 'value is [REDACTED:FAKE] here'
    assert.equal(
      redact(text, redactions),
      'value is [REDACTED:WEIRD] here'
    )
  })
})
