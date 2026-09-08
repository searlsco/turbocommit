const { describe, it, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')
const { shellCheckouts } = require('../lib/shell')

const realHome = process.env.HOME

function makeRepo (parent, name, config = { enabled: true }) {
  const root = path.join(parent, name)
  fs.mkdirSync(root, { recursive: true })
  execSync('git init -q', { cwd: root })
  fs.writeFileSync(path.join(root, '.turbocommit.json'), JSON.stringify(config))
  fs.mkdirSync(path.join(root, 'Core'))
  fs.writeFileSync(path.join(root, 'Core', 'Package.swift'), '// package')
  return fs.realpathSync(root)
}

describe('shellCheckouts', () => {
  let home, anchor, other

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shell-home-'))
    process.env.HOME = home
    anchor = makeRepo(path.join(home, 'code'), 'anchor')
    other = makeRepo(path.join(home, 'code'), 'other')
  })

  after(() => { process.env.HOME = realHome })

  it('finds a checkout from an absolute path inside it and scopes it to that path', () => {
    const command = `sed -i '' 's/0.7.2/0.7.3/' ${other}/Core/Package.swift`
    assert.deepEqual(shellCheckouts(command, anchor, anchor), [
      { root: other, paths: [path.join(other, 'Core', 'Package.swift')] }
    ])
  })

  it('expands a tilde path to the home directory', () => {
    assert.deepEqual(shellCheckouts('cd ~/code/other && swift package update', anchor, anchor), [
      { root: other, paths: [other] }
    ])
  })

  it('resolves relative words against absolute directories the command names', () => {
    const third = makeRepo(path.join(home, 'code'), 'third')
    const command = `cd ${path.join(home, 'code')} && for r in other/Core third/Core; do (cd $r && swift package update); done`
    assert.deepEqual(shellCheckouts(command, anchor, anchor), [
      { root: other, paths: [path.join(other, 'Core')] },
      { root: third, paths: [path.join(third, 'Core')] }
    ])
  })

  it('resolves relative words against the working directory', () => {
    assert.deepEqual(shellCheckouts('cd ../other && npm install', anchor, anchor), [{ root: other, paths: [other] }])
  })

  it('ignores bare words that happen to match a sibling checkout name', () => {
    makeRepo(path.join(home, 'code'), 'docs')
    const command = `cd ${path.join(home, 'code')} && echo "remember to check the other docs later"`
    assert.deepEqual(shellCheckouts(command, anchor, anchor), [])
  })

  it('ignores a checkout with a merge in progress', () => {
    fs.writeFileSync(path.join(other, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n')
    assert.deepEqual(shellCheckouts(`cat ${other}/Core/Package.swift`, anchor, anchor), [])
  })

  it('ignores the anchor, disabled checkouts, and paths that do not exist', () => {
    const disabled = makeRepo(path.join(home, 'code'), 'disabled', { enabled: false })
    const command = `cat ${anchor}/Core/Package.swift ${disabled}/Core/Package.swift ${home}/code/missing/file`
    assert.deepEqual(shellCheckouts(command, anchor, anchor), [])
  })

  it('returns nothing for a command that names no other checkout', () => {
    assert.deepEqual(shellCheckouts('npm test 2>/dev/null', anchor, anchor), [])
  })
})
