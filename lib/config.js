const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')

function xdgConfigPath () {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'turbocommit', 'config.json')
}

function legacyGlobalConfigPath () {
  return path.join(os.homedir(), '.claude', 'turbocommit.json')
}

function globalConfigPath () {
  return loadJson(xdgConfigPath()) ? xdgConfigPath() : legacyGlobalConfigPath()
}

function neutralProjectConfigPath (root) {
  return path.join(root, '.turbocommit.json')
}

function legacyProjectConfigPath (root) {
  return path.join(root, '.claude', 'turbocommit.json')
}

function projectConfigPath (root) {
  return loadJson(neutralProjectConfigPath(root)) ? neutralProjectConfigPath(root) : legacyProjectConfigPath(root)
}

function activeConfig (root) {
  const globalPath = globalConfigPath()
  const projectPath = root ? projectConfigPath(root) : null
  const globalCfg = loadJson(globalPath)
  const projectCfg = projectPath ? loadJson(projectPath) : null
  return {
    globalPath,
    projectPath,
    globalCfg,
    projectCfg,
    config: mergeConfig(globalCfg || {}, projectCfg || {})
  }
}

module.exports = {
  xdgConfigPath,
  legacyGlobalConfigPath,
  globalConfigPath,
  neutralProjectConfigPath,
  legacyProjectConfigPath,
  projectConfigPath,
  activeConfig
}
